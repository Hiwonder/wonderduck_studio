//! Fetch camera frames on demand or keep the latest frame available during inference.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, anyhow, bail, ensure};
use duck_ipc_proto::{self as proto, MediaFrameHeader};
use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

type Frame = (MediaFrameHeader, Vec<u8>);

#[derive(Default)]
struct Slot {
    item: Option<Result<Frame>>,
    stopped: bool,
    finished: bool,
}

type Shared = Arc<(Mutex<Slot>, Condvar)>;

pub(super) enum CameraFrames {
    OnDemand { path: PathBuf, client: Option<FrameClient> },
    Prefetched(FramePrefetch),
}

impl CameraFrames {
    pub(super) fn camera(path: &Path, on_demand: bool) -> Result<Self> {
        if on_demand {
            return Ok(Self::OnDemand { path: path.to_owned(), client: None });
        }
        Ok(Self::Prefetched(FramePrefetch::camera(path)?))
    }

    pub(super) fn next(&mut self) -> Result<Frame> {
        match self {
            Self::OnDemand { path, client } => FrameClient::next_from(client, path),
            Self::Prefetched(prefetch) => prefetch.next(),
        }
    }
}

pub(super) struct FramePrefetch {
    shared: Shared,
    thread: Option<JoinHandle<()>>,
}

impl FramePrefetch {
    pub(super) fn camera(path: &Path) -> Result<Self> {
        let path = path.to_owned();
        let mut client = None;
        Self::start(move || FrameClient::next_from(&mut client, &path))
    }

    fn start(mut fetch: impl FnMut() -> Result<Frame> + Send + 'static) -> Result<Self> {
        let shared: Shared = Arc::new((Mutex::new(Slot::default()), Condvar::new()));
        let producer_shared = shared.clone();
        let thread = thread::Builder::new()
            .name("detection-frames".into())
            .spawn(move || {
                let (lock, wake) = &*producer_shared;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    loop {
                        if lock.lock().expect("frame slot lock poisoned").stopped {
                            break;
                        }
                        let item = fetch();
                        let failed = item.is_err();
                        let mut slot = lock.lock().expect("frame slot lock poisoned");
                        if slot.stopped {
                            break;
                        }
                        slot.item = Some(item);
                        wake.notify_one();
                        if failed {
                            break;
                        }
                    }
                }));
                let mut slot = lock.lock().expect("frame slot lock poisoned");
                if result.is_err() && !slot.stopped {
                    slot.item = Some(Err(anyhow!("camera frame worker panicked")));
                }
                slot.finished = true;
                wake.notify_all();
            })?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    pub(super) fn next(&self) -> Result<Frame> {
        let (lock, wake) = &*self.shared;
        let mut slot = lock.lock().expect("frame slot lock poisoned");
        while slot.item.is_none() && !slot.finished {
            slot = wake.wait(slot).expect("frame slot lock poisoned");
        }
        slot.item
            .take()
            .unwrap_or_else(|| Err(anyhow!("camera frame worker stopped")))
    }
}

impl Drop for FramePrefetch {
    fn drop(&mut self) {
        let (lock, wake) = &*self.shared;
        lock.lock().expect("frame slot lock poisoned").stopped = true;
        wake.notify_all();
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("camera frame worker could not be joined");
        }
    }
}


#[derive(Debug)]
struct CameraNoFrame;

impl std::fmt::Display for CameraNoFrame {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("camera: no frame arrived within the capture timeout")
    }
}

impl std::error::Error for CameraNoFrame {}

pub(super) fn camera_recoverable(error: &anyhow::Error) -> bool {
    error.is::<CameraNoFrame>()
        || error.downcast_ref::<io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                io::ErrorKind::TimedOut
                    | io::ErrorKind::WouldBlock
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::NotFound
                    | io::ErrorKind::UnexpectedEof
            )
        })
}

pub(super) fn source_root(executable: &Path) -> Result<&Path> {
    executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context("cannot locate source directory from webpadd")
}

fn media_socket_from(executable: &Path, runtime_override: Option<&OsStr>) -> Result<PathBuf> {
    let source = source_root(executable)?;
    let runtime = runtime_override
        .map(PathBuf::from)
        .unwrap_or_else(|| source.join("media-runtime-candidate"));
    Ok(runtime.join("webpadd-media.sock"))
}

pub(super) fn media_socket() -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    media_socket_from(&executable, std::env::var_os("MEDIA_RUNTIME_DIR").as_deref())
}

pub(super) struct FrameClient {
    reader: BufReader<UnixStream>,
}

impl FrameClient {
    // A connection error goes through the detector's normal recovery and cancellation path.
    fn next_from(client: &mut Option<Self>, path: &Path) -> Result<Frame> {
        match client {
            Some(client) => client.next(),
            None => client.insert(Self::connect(path)?).next(),
        }
    }

    pub(super) fn connect(path: &Path) -> Result<Self> {
        let mut stream = UnixStream::connect(path)
            .with_context(|| format!("camera socket {}", path.display()))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let hello = proto::Request::call(
            proto::Id::Number(1),
            &proto::Call::Hello(proto::HelloParams {
                api_version: proto::API_VERSION,
            }),
        );
        serde_json::to_writer(&mut stream, &hello)?;
        stream.write_all(b"\n")?;
        let mut reader = BufReader::new(stream);
        let hello: proto::HelloResult = serde_json::from_value(response(&mut reader, 1)?)?;
        if hello.api_version != proto::API_VERSION {
            tracing::warn!(local = proto::API_VERSION, camera = hello.api_version,
                "camera API versions differ; validating the frame request and response");
        }
        Ok(Self { reader })
    }

    pub(super) fn video(&mut self) -> Result<serde_json::Value> {
        let request = proto::Request {
            jsonrpc: "2.0".into(),
            id: Some(proto::Id::Number(3)),
            method: "media.video".into(),
            params: None,
        };
        serde_json::to_writer(self.reader.get_mut(), &request)?;
        self.reader.get_mut().write_all(b"\n")?;
        response(&mut self.reader, 3)
    }

    pub(super) fn next(&mut self) -> Result<Frame> {
        let request = proto::Request {
            jsonrpc: "2.0".into(),
            id: Some(proto::Id::Number(2)),
            method: proto::method::MEDIA_FRAME.into(),
            params: None,
        };
        serde_json::to_writer(self.reader.get_mut(), &request)?;
        self.reader.get_mut().write_all(b"\n")?;
        let header: proto::MediaFrameHeader =
            serde_json::from_value(response(&mut self.reader, 2)?)?;
        ensure!(header.valid_uyvy(), "invalid camera frame");
        let mut data = vec![0; header.bytes];
        self.reader.read_exact(&mut data)?;
        Ok((header, data))
    }
}

fn response(reader: &mut BufReader<UnixStream>, id: u64) -> Result<serde_json::Value> {
    let mut line = Vec::new();
    reader.take(4097).read_until(b'\n', &mut line)?;
    ensure!(line.len() <= 4096, "invalid camera response");
    if !line.ends_with(b"\n") {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "camera closed before its response").into());
    }
    let response: proto::Response = serde_json::from_slice(&line)?;
    ensure!(
        response.jsonrpc == "2.0" && response.id == Some(proto::Id::Number(id)),
        "unexpected camera response"
    );
    if let Some(error) = response.error {
        if id == 2
            && error.code == proto::code::INTERNAL_ERROR
            && error.message == "no frame arrived within the capture timeout"
        {
            return Err(CameraNoFrame.into());
        }
        bail!("camera: {}", error.message);
    }
    response.result.context("camera response has no result")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_demand_camera_only_reads_for_the_next_inference() {
        let (client, server) = UnixStream::pair().unwrap();
        let mut frames = CameraFrames::OnDemand {
            path: PathBuf::new(),
            client: Some(FrameClient { reader: BufReader::new(client) }),
        };
        let server = thread::spawn(move || {
            let mut server = BufReader::new(server);
            let mut line = String::new();
            server.read_line(&mut line).unwrap();
            let request: proto::Request = serde_json::from_str(&line).unwrap();
            assert_eq!(request.method, proto::method::MEDIA_FRAME);
            let header = MediaFrameHeader {
                width: 2, height: 1, format: "UYVY".into(), bytes: 4,
                captured_at_unix_us: 42, rotate: 0,
            };
            let reply = proto::Response::ok(request.id, &header);
            serde_json::to_writer(server.get_mut(), &reply).unwrap();
            server.get_mut().write_all(b"\n1234").unwrap();
            server
        });
        let (header, data) = frames.next().unwrap();
        assert_eq!(header.captured_at_unix_us, 42);
        assert_eq!(data, b"1234");
        let mut server = server.join().unwrap();
        server.get_mut().set_nonblocking(true).unwrap();
        assert_eq!(server.read(&mut [0]).unwrap_err().kind(), io::ErrorKind::WouldBlock);
    }

    #[test]
    fn both_camera_modes_retry_after_connection_loss() {
        let missing = std::env::temp_dir().join(format!("wd-camera-{}-absent.sock", std::process::id()));
        for on_demand in [true, false] {
            let mut frames = CameraFrames::camera(&missing, on_demand).unwrap();
            assert!(camera_recoverable(&frames.next().unwrap_err()));
        }
        let (client, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let error = response(&mut BufReader::new(client), 2).unwrap_err();
        assert!(camera_recoverable(&error));
    }
}
