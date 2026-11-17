//! Fetch camera frames concurrently with inference, keeping only the latest result.

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

pub(super) struct FramePrefetch {
    shared: Shared,
    thread: Option<JoinHandle<()>>,
}

impl FramePrefetch {
    pub(super) fn camera(path: &Path) -> Result<Self> {
        let path = path.to_owned();
        let mut client = None;
        // Connect on the producer thread so startup failures use the same outer recovery
        // loop as read failures. A failed producer exits; it never reconnects internally.
        Self::start(move || match &mut client {
            Some(client) => FrameClient::next(client),
            None => client.insert(FrameClient::connect(&path)?).next(),
        })
    }

    pub(super) fn start(mut fetch: impl FnMut() -> Result<Frame> + Send + 'static) -> Result<Self> {
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
    ensure!(
        line.len() <= 4096 && line.ends_with(b"\n"),
        "invalid camera response"
    );
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
