//! Capture the robot microphone, save the result, and replay it on the robot.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};

use super::{voice, AppState};

const MAX_SECONDS: u64 = 120;
static NEXT_PROBE: AtomicU64 = AtomicU64::new(0);

pub(super) fn recording_directory() -> PathBuf {
    if let Some(directory) = std::env::var_os("WONDERDUCK_AUDIO_RECORD_DIR") {
        let directory = PathBuf::from(directory);
        if directory.is_absolute() { return directory; }
        tracing::warn!(path = %directory.display(), "ignoring relative recording directory");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        .join("records/audio/system-test")
}

fn storage_error(context: &str, error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(libc::EROFS) => "录音存储位置为只读，请检查存储卡或服务设置".into(),
        Some(libc::ENOSPC) => "存储空间不足，无法保存录音".into(),
        _ if error.kind() == std::io::ErrorKind::PermissionDenied =>
            "录音存储权限不足，请检查服务设置".into(),
        _ => format!("{context}：{error}"),
    }
}

fn prepare_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| storage_error("无法创建录音目录", &error))?;
    // Check an existing directory too: mkdir succeeds on a read-only filesystem
    // if the directory is already there. Do this before capturing any audio.
    let probe = directory.join(format!(".recording-check-{}-{}", std::process::id(),
        NEXT_PROBE.fetch_add(1, Ordering::Relaxed)));
    let file = OpenOptions::new().write(true).create_new(true).open(&probe)
        .map_err(|error| storage_error("无法写入录音目录", &error))?;
    drop(file);
    fs::remove_file(&probe).map_err(|error| storage_error("无法清理录音目录", &error))
}

struct Capture {
    child: Child,
    samples: File,
    diagnostics: File,
    started: Instant,
    stopping: Option<Instant>,
}

enum Phase {
    Idle,
    Recording(Capture),
    Saving,
    Playing,
    Failed(String),
}

struct RecorderState {
    phase: Phase,
    latest: Option<PathBuf>,
}

pub(super) struct Recorder {
    device: String,
    capture_program: PathBuf,
    directory: PathBuf,
    player: Arc<voice::VoicePlayer>,
    state: Mutex<RecorderState>,
}

#[derive(Serialize)]
pub(super) struct RecordingStatus {
    state: &'static str,
    error: Option<String>,
    elapsed_ms: Option<u64>,
    path: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct DeleteRecording {
    path: String,
}

impl Recorder {
    pub(super) fn new(device: String, player: Arc<voice::VoicePlayer>, directory: PathBuf) -> Self {
        let latest = latest_recording(&directory);
        Self { device, capture_program: "arecord".into(), directory, player,
            state: Mutex::new(RecorderState { phase: Phase::Idle, latest }) }
    }

    fn status(&self) -> RecordingStatus {
        let state = self.state.lock().expect("audio recorder mutex poisoned");
        let (phase, error, elapsed_ms) = match &state.phase {
            Phase::Idle => ("idle", None, None),
            Phase::Recording(capture) => {
                let end = capture.stopping.unwrap_or_else(Instant::now);
                (if capture.stopping.is_some() { "stopping" } else { "recording" }, None,
                    Some(end.saturating_duration_since(capture.started).as_millis().min((MAX_SECONDS * 1000) as u128) as u64))
            },
            Phase::Saving => ("saving", None, None),
            Phase::Playing => ("playing", None, None),
            Phase::Failed(error) => ("error", Some(error.clone()), None),
        };
        RecordingStatus { state: phase, error, elapsed_ms,
            path: state.latest.as_ref().map(|path| path.to_string_lossy().into_owned()) }
    }

    fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "录音状态异常".to_owned())?;
        if matches!(state.phase, Phase::Recording(_) | Phase::Saving | Phase::Playing) {
            return Err("录音或播放正在进行".into());
        }
        prepare_directory(&self.directory)?;
        let samples = voice::memory_file(&[]).map_err(|error| format!("无法准备录音：{error}"))?;
        let diagnostics = voice::memory_file(&[]).map_err(|error| format!("无法准备录音：{error}"))?;
        let child = Command::new(&self.capture_program)
            .args(["-q", "-D", &self.device, "-t", "raw", "-f", "S16_LE", "-r", "48000", "-c", "2", "-d", &MAX_SECONDS.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::from(samples.try_clone().map_err(|error| error.to_string())?))
            .stderr(Stdio::from(diagnostics.try_clone().map_err(|error| error.to_string())?))
            .spawn().map_err(|error| format!("无法启动录音：{error}"))?;
        state.phase = Phase::Recording(Capture { child, samples, diagnostics, started: Instant::now(), stopping: None });
        drop(state);
        let recorder = Arc::clone(self);
        tokio::spawn(async move { recorder.monitor().await; });
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "录音状态异常".to_owned())?;
        let Phase::Recording(capture) = &mut state.phase else { return Err("当前没有正在进行的录音".into()); };
        if capture.stopping.is_none() {
            signal_stop(&mut capture.child)?;
            capture.stopping = Some(Instant::now());
        }
        Ok(())
    }

    fn delete(&self, expected_path: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "录音状态异常".to_owned())?;
        if matches!(state.phase, Phase::Recording(_) | Phase::Saving | Phase::Playing) {
            return Err("录音或播放正在进行，请稍后删除".into());
        }
        let Some(path) = &state.latest else { return Err("没有可删除的录音".into()); };
        if path.to_string_lossy() != expected_path {
            return Err("录音已更新，请刷新后重试".into());
        }
        match fs::remove_file(path) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("删除录音失败：{error}")),
        }
        state.latest = None;
        Ok(())
    }

    async fn monitor(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let completed = {
                let mut state = self.state.lock().expect("audio recorder mutex poisoned");
                let Phase::Recording(capture) = &mut state.phase else { return; };
                if capture.stopping.is_none() && capture.started.elapsed() > Duration::from_secs(MAX_SECONDS + 5) {
                    let _ = signal_stop(&mut capture.child);
                    capture.stopping = Some(Instant::now());
                }
                if capture.stopping.is_some_and(|at| at.elapsed() > Duration::from_secs(3)) {
                    let _ = capture.child.kill();
                }
                match capture.child.try_wait() {
                    Ok(None) => None,
                    Ok(Some(status)) => {
                        let Phase::Recording(capture) = std::mem::replace(&mut state.phase, Phase::Saving) else { unreachable!() };
                        Some((capture, Ok(status)))
                    }
                    Err(error) => {
                        let Phase::Recording(mut capture) = std::mem::replace(&mut state.phase, Phase::Saving) else { unreachable!() };
                        let _ = capture.child.kill();
                        let _ = capture.child.wait();
                        Some((capture, Err(error)))
                    }
                }
            };
            let Some((capture, status)) = completed else { continue; };
            let directory = self.directory.clone();
            let saved = tokio::task::spawn_blocking(move || finish(capture, status, &directory)).await
                .unwrap_or_else(|error| Err(format!("录音任务失败：{error}")));
            let (path, samples) = match saved {
                Ok(saved) => saved,
                Err(error) => {
                    self.state.lock().expect("audio recorder mutex poisoned").phase = Phase::Failed(error);
                    return;
                }
            };
            {
                let mut state = self.state.lock().expect("audio recorder mutex poisoned");
                state.latest = Some(path);
                state.phase = Phase::Playing;
            }
            let player = Arc::clone(&self.player);
            let result = tokio::task::spawn_blocking(move || player.play_robot_recording(samples)).await
                .unwrap_or_else(|error| Err(format!("播放任务失败：{error}")));
            self.state.lock().expect("audio recorder mutex poisoned").phase = match result {
                Ok(()) => Phase::Idle, Err(error) => Phase::Failed(error),
            };
            return;
        }
    }
}

fn latest_recording(directory: &Path) -> Option<PathBuf> {
    fs::read_dir(directory).ok()?.filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("record-") && name.ends_with(".wav")) && path.is_file())
        .max()
}

fn signal_stop(child: &mut Child) -> Result<(), String> {
    // The child is not reaped here, so its PID cannot be reused before the monitor collects it.
    if unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGINT) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) { return Err(format!("无法停止录音：{error}")); }
    }
    Ok(())
}

fn finish(mut capture: Capture, status: Result<ExitStatus, std::io::Error>, directory: &Path) -> Result<(PathBuf, File), String> {
    let status = status.map_err(|error| format!("录音进程异常：{error}"))?;
    if !status.success() && capture.stopping.is_none() {
        let mut detail = String::new();
        let _ = capture.diagnostics.seek(SeekFrom::Start(0));
        let _ = capture.diagnostics.take(2048).read_to_string(&mut detail);
        return Err(format!("录音失败：{}", if detail.trim().is_empty() { status.to_string() } else { detail.trim().to_owned() }));
    }
    let length = capture.samples.metadata().map_err(|error| format!("无法读取录音：{error}"))?.len();
    let aligned = length - length % 4;
    if aligned == 0 { return Err("录音为空，请重试".into()); }
    let length = u32::try_from(aligned).ok().filter(|length| *length <= u32::MAX - 36)
        .ok_or_else(|| "录音过大，无法保存".to_owned())?;
    capture.samples.set_len(aligned).map_err(|error| format!("无法整理录音：{error}"))?;
    fs::create_dir_all(directory).map_err(|error| storage_error("无法创建录音目录", &error))?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| format!("系统时间异常：{error}"))?.as_nanos();
    let path = directory.join(format!("record-{stamp:020}-{}-{}.wav", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let temporary = path.with_extension("wav.part");
    let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|error| storage_error("无法创建录音文件", &error))?;
    let result = (|| -> std::io::Result<()> {
        output.write_all(b"RIFF")?;
        output.write_all(&(36 + length).to_le_bytes())?;
        output.write_all(b"WAVEfmt ")?;
        output.write_all(&16u32.to_le_bytes())?;
        output.write_all(&1u16.to_le_bytes())?;
        output.write_all(&2u16.to_le_bytes())?;
        output.write_all(&48_000u32.to_le_bytes())?;
        output.write_all(&192_000u32.to_le_bytes())?;
        output.write_all(&4u16.to_le_bytes())?;
        output.write_all(&16u16.to_le_bytes())?;
        output.write_all(b"data")?;
        output.write_all(&length.to_le_bytes())?;
        capture.samples.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut capture.samples, &mut output)?;
        output.flush()
    })();
    drop(output);
    let result = result.and_then(|()| fs::hard_link(&temporary, &path));
    if let Err(error) = fs::remove_file(&temporary) {
        tracing::warn!(path = %temporary.display(), %error, "cannot remove temporary recording");
    }
    if let Err(error) = result {
        return Err(storage_error("保存录音失败", &error));
    }
    Ok((path, capture.samples))
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Ok(RecorderState { phase: Phase::Recording(capture), .. }) = self.state.get_mut() {
            let _ = capture.child.kill();
            let _ = capture.child.wait();
        }
    }
}

pub(super) async fn get(State(state): State<AppState>) -> Json<RecordingStatus> {
    Json(state.recorder.status())
}

pub(super) async fn start(State(state): State<AppState>) -> Result<Json<RecordingStatus>, (StatusCode, String)> {
    state.recorder.start().map_err(|error| (StatusCode::CONFLICT, error))?;
    Ok(Json(state.recorder.status()))
}

pub(super) async fn stop(State(state): State<AppState>) -> Result<Json<RecordingStatus>, (StatusCode, String)> {
    state.recorder.stop().map_err(|error| (StatusCode::CONFLICT, error))?;
    Ok(Json(state.recorder.status()))
}

pub(super) async fn delete(State(state): State<AppState>, Json(request): Json<DeleteRecording>) -> Result<Json<RecordingStatus>, (StatusCode, String)> {
    state.recorder.delete(&request.path).map_err(|error| (StatusCode::CONFLICT, error))?;
    Ok(Json(state.recorder.status()))
}
