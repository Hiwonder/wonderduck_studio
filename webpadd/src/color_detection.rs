//! Native color recognition runs outside the control and HTTP executor threads.

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use axum::extract::{
    State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::frame_prefetch::{FramePrefetch, camera_recoverable, media_socket};
use crate::settings::ColorReference;

const WORKER: &str = include_str!("../worker/color_detection.py");

#[derive(Default)]
struct RuntimeState {
    standby: Option<NativeProcess>,
    active: usize,
}

#[derive(Default)]
pub(crate) struct ColorRuntime {
    state: Mutex<RuntimeState>,
    recorder: Option<crate::vision_record::Recorder>,
}

impl ColorRuntime {
    pub(crate) fn new(record_path: Option<std::path::PathBuf>) -> Self {
        let recorder = record_path.and_then(|path| match crate::vision_record::Recorder::start_target(&path) {
            Ok(recorder) => Some(recorder),
            Err(error) => { tracing::error!(%error, path = %path.display(), "cannot start target vision recording"); None }
        });
        let runtime = Self { recorder, ..Self::default() };
        runtime.refill();
        runtime
    }

    pub(super) fn recorder(&self) -> Option<crate::vision_record::Recorder> { self.recorder.clone() }

    fn refill(&self) {
        let mut state = self.state.lock().expect("color runtime lock poisoned");
        if state.active != 0 || state.standby.is_some() {
            return;
        }
        match NativeProcess::start_script(Arc::new(ProcessControl::default()), WORKER) {
            Ok(process) => state.standby = Some(process),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "cannot prewarm color recognition")
            }
        }
    }

    fn acquire(&self) -> Option<NativeProcess> {
        let mut state = self.state.lock().expect("color runtime lock poisoned");
        state.active += 1;
        state.standby.take()
    }

    fn release(&self) {
        {
            let mut state = self.state.lock().expect("color runtime lock poisoned");
            state.active -= 1;
        }
        self.refill();
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Settings {
    Prepare {
        generation: u64,
    },
    Sample {
        generation: u64,
        point: [f64; 2],
        threshold: f64,
        #[serde(default)]
        line: bool,
    },
    Configure {
        generation: u64,
        reference: ColorReference,
        threshold: f64,
        #[serde(default)]
        line: bool,
    },
}

impl Settings {
    fn valid(&self) -> bool {
        let threshold = match self {
            Self::Prepare { .. } => return true,
            Self::Sample {
                point, threshold, ..
            } => {
                if !point
                    .iter()
                    .all(|v| v.is_finite() && (0.0..1.0).contains(v))
                {
                    return false;
                }
                *threshold
            }
            Self::Configure {
                reference,
                threshold,
                ..
            } => {
                if !reference
                    .lab
                    .iter()
                    .all(|v| v.is_finite() && (0.0..=255.0).contains(v))
                {
                    return false;
                }
                *threshold
            }
        };
        threshold.is_finite() && (0.0..=1.0).contains(&threshold)
    }

    fn generation(&self) -> u64 {
        match self {
            Self::Prepare { generation }
            | Self::Sample { generation, .. }
            | Self::Configure { generation, .. } => *generation,
        }
    }

    fn threshold(&self) -> Option<f64> {
        match self { Self::Prepare { .. } => None,
            Self::Sample { threshold, .. } | Self::Configure { threshold, .. } => Some(*threshold) }
    }
}

pub async fn upgrade(
    State(state): State<crate::AppState>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| session(socket, state))
}

async fn send(socket: &mut WebSocket, event: &Value) -> Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(event)?.into()))
        .await?;
    Ok(())
}

async fn session(mut socket: WebSocket, state: crate::AppState) {
    let runtime = state.colors.clone();
    let id = state.next_session.fetch_add(1, Ordering::Relaxed);
    let (settings_tx, settings_rx) = watch::channel(None::<Settings>);
    let (wake_tx, wake_rx) = mpsc::sync_channel::<()>(1);
    let mut wake_rx = Some(wake_rx);
    let (events_tx, mut events_rx) = watch::channel(json!({"type": "waiting"}));
    let relay = tokio::spawn(crate::vision_relay::relay_values(state.clone(), id,
        crate::vision_relay::Source::Color, events_tx.subscribe()));
    let mut worker = None;
    let process = Arc::new(ProcessControl::default());
    if send(&mut socket, &json!({"type": "waiting"}))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if serde_json::from_str::<Value>(&text).ok()
                            .is_some_and(|v| v.get("type").and_then(Value::as_str) == Some("bind_tracking")) {
                            let accepted = crate::vision_relay::bind(&state, id, crate::vision_relay::Source::Color, &text).await;
                            if send(&mut socket, &json!({"type":"tracking_bound", "accepted":accepted})).await.is_err() { break; }
                            continue;
                        }
                        let settings = match serde_json::from_str::<Settings>(&text) {
                            Ok(settings) if settings.valid() => settings,
                            result => {
                                tracing::warn!(?result, "invalid native color settings");
                                let _ = send(&mut socket, &json!({"type":"error", "message":"颜色识别参数无效"})).await;
                                break;
                            }
                        };
                        settings_tx.send_replace(Some(settings));
                        let _ = wake_tx.try_send(());
                        if worker.is_none() {
                            let settings = settings_rx.clone();
                            let events = events_tx.clone();
                            let process = Arc::clone(&process);
                            let wake = wake_rx.take().expect("color worker started once");
                            let standby = runtime.acquire();
                            let recorder = runtime.recorder();
                            match std::thread::Builder::new().name("color-detection".into()).spawn(move || {
                                if let Err(error) = run(settings, wake, &events, Arc::clone(&process), standby, recorder.as_ref()) {
                                    if process.cancelled.load(Ordering::Acquire) { return; }
                                    if let Some(recorder) = recorder.as_ref() { recorder.status("error", Some(format!("{error:#}"))); }
                                    tracing::warn!(error = %format!("{error:#}"), "native color detection stopped");
                                    events.send_replace(json!({"type":"error", "message":format!("颜色识别不可用：{error:#}")}));
                                }
                            }) {
                                Ok(handle) => worker = Some(handle),
                                Err(error) => {
                                    runtime.release();
                                    let _ = send(&mut socket, &json!({"type":"error", "message":format!("颜色识别启动失败：{error}")})).await;
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            changed = events_rx.changed() => {
                if changed.is_err() { break; }
                let event = events_rx.borrow_and_update().clone();
                if send(&mut socket, &event).await.is_err() { break; }
            }
        }
    }
    // Closing the sender stops the worker after the existing camera read finishes.
    // Joining runs away from the async executor, including native process cleanup.
    drop(settings_tx);
    drop(wake_tx);
    crate::vision_relay::unbind(&state, id).await;
    relay.abort();
    if let Some(worker) = worker {
        tokio::task::spawn_blocking(move || {
            process.cancel();
            if worker.join().is_err() {
                tracing::error!("native color worker panicked");
            }
            runtime.release();
        });
    }
}

fn run(
    settings: watch::Receiver<Option<Settings>>,
    wake: mpsc::Receiver<()>,
    events: &watch::Sender<Value>,
    process: Arc<ProcessControl>,
    standby: Option<NativeProcess>,
    recorder: Option<&crate::vision_record::Recorder>,
) -> Result<()> {
    let mut native = NativeProcess::start_with_standby(process, standby)?;
    let mut frames: Option<FramePrefetch> = None;
    let mut previous_stamp = None;
    let mut recovering = false;
    while settings.has_changed().is_ok() {
        while wake.try_recv().is_ok() {}
        let command = settings
            .borrow()
            .clone()
            .context("color worker has no settings")?;
        if let Settings::Prepare { generation } = command {
            frames = None;
            previous_stamp = None;
            recovering = false;
            events.send_replace(json!({"type":"prepared", "generation":generation}));
            if wake.recv().is_err() {
                break;
            }
            continue;
        }
        if frames.is_none() {
            frames = Some(FramePrefetch::camera(&media_socket()?)?);
        }
        let cycle_start = recorder.map(|_| Instant::now());
        let (header, data) = match frames.as_ref().expect("camera initialized").next() {
            Ok(frame) => frame,
            Err(error) if camera_recoverable(&error) => {
                if !recovering {
                    tracing::warn!(error = %format!("{error:#}"), "color camera frames unavailable");
                    if let Some(recorder) = recorder { recorder.status("recovering", Some(format!("{error:#}"))); }
                    events.send_replace(json!({"type":"recovering"}));
                    recovering = true;
                }
                frames = None;
                // Match the existing object detector's camera-recovery retry.
                std::thread::sleep(Duration::from_millis(250));
                if settings.has_changed().is_err() {
                    break;
                }
                continue;
            }
            Err(error) => return Err(error),
        };
        if settings.has_changed().is_err() {
            break;
        }
        if previous_stamp == Some(header.captured_at_unix_us) {
            continue;
        }
        previous_stamp = Some(header.captured_at_unix_us);
        if recovering {
            tracing::info!("color camera frames recovered");
            if let Some(recorder) = recorder { recorder.status("recovered", None); }
            recovering = false;
        }
        let command = settings
            .borrow()
            .clone()
            .context("color worker has no settings")?;
        if matches!(command, Settings::Prepare { .. }) {
            continue;
        }
        let mut event = native.process(&header, &data, &command)?;
        event["rotate"] = json!(header.rotate);
        // A settings update may arrive during conversion; never publish its predecessor.
        if settings
            .borrow()
            .as_ref()
            .is_some_and(|current| current == &command)
        {
            if let (Some(recorder), Some(cycle_start), Some(threshold)) = (recorder, cycle_start, command.threshold()) {
                recorder.target_frame(header.captured_at_unix_us, header.width as usize, header.height as usize,
                    header.rotate, cycle_start.elapsed().as_secs_f64() * 1000.0, threshold, &event);
            }
            events.send_replace(event);
        }
    }
    Ok(())
}

#[derive(Default)]
struct ProcessControl {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl ProcessControl {
    fn attach(&self, child: Child) -> Result<()> {
        let mut slot = self.child.lock().expect("color process lock poisoned");
        *slot = Some(child);
        if self.cancelled.load(Ordering::Acquire) {
            drop(slot);
            self.terminate();
            bail!("color session closed before OpenCV startup");
        }
        Ok(())
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.terminate();
    }

    fn terminate(&self) {
        let child = self
            .child
            .lock()
            .expect("color process lock poisoned")
            .take();
        if let Some(mut child) = child {
            match child.try_wait() {
                Ok(Some(_)) => {}
                Ok(None) => {
                    if let Err(error) = child.kill() {
                        tracing::warn!(%error, "cannot stop color OpenCV process");
                    }
                }
                Err(error) => tracing::warn!(%error, "cannot inspect color OpenCV process"),
            }
            if let Err(error) = child.wait() {
                tracing::warn!(%error, "cannot reap color OpenCV process");
            }
        }
    }
}

struct NativeProcess {
    process: Arc<ProcessControl>,
    input: BufWriter<ChildStdin>,
    output: BufReader<ChildStdout>,
}

impl NativeProcess {
    fn start_with_standby(process: Arc<ProcessControl>, standby: Option<Self>) -> Result<Self> {
        let mut native = if let Some(mut native) = standby {
            let child = native
                .process
                .child
                .lock()
                .expect("color process lock poisoned")
                .take()
                .context("prewarmed OpenCV process missing")?;
            process.attach(child)?;
            native.process = process;
            native
        } else {
            Self::start_script(process, WORKER)?
        };
        let mut line = String::new();
        ensure!(
            native.output.read_line(&mut line)? != 0,
            "OpenCV process ended during startup"
        );
        let ready: Value =
            serde_json::from_str(&line).context("invalid OpenCV startup response")?;
        ensure!(
            ready == json!({"type":"ready"}),
            "unexpected OpenCV startup response"
        );
        Ok(native)
    }

    fn start_script(process: Arc<ProcessControl>, script: &str) -> Result<Self> {
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("cannot start system Python OpenCV")?;
        let input = child.stdin.take().context("missing color worker input")?;
        let output = BufReader::new(child.stdout.take().context("missing color worker output")?);
        process.attach(child)?;
        Ok(Self {
            process,
            input: BufWriter::new(input),
            output,
        })
    }

    fn process(
        &mut self,
        header: &duck_ipc_proto::MediaFrameHeader,
        data: &[u8],
        settings: &Settings,
    ) -> Result<Value> {
        ensure!(
            header.valid_uyvy() && data.len() == header.bytes,
            "invalid color camera frame"
        );
        serde_json::to_writer(
            &mut self.input,
            &json!({"header":header,"settings":settings}),
        )?;
        self.input.write_all(b"\n")?;
        self.input.write_all(data)?;
        self.input.flush()?;
        let mut line = String::new();
        if self.output.read_line(&mut line)? == 0 {
            bail!("OpenCV process ended; check webpadd diagnostics");
        }
        let event: Value = serde_json::from_str(&line).context("invalid OpenCV result")?;
        ensure!(
            matches!(event["type"].as_str(), Some("frame" | "sampling"))
                && event["generation"].as_u64() == Some(settings.generation()),
            "unexpected OpenCV result"
        );
        Ok(event)
    }
}

impl Drop for NativeProcess {
    fn drop(&mut self) {
        self.process.terminate();
    }
}
