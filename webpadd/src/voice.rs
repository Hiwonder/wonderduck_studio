//! Decode browser recordings in memory and play them through the configured audio adapter.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use axum::{body::Bytes, extract::State, http::StatusCode};

use super::AppState;

pub(super) struct VoicePlayer {
    device: String,
    player: PathBuf,
    decoder: PathBuf,
    playing: Mutex<()>,
}

#[derive(Debug)]
enum VoiceError {
    Input(String),
    Output(String),
}

impl VoicePlayer {
    pub(super) fn new(device: String, player: PathBuf) -> Self {
        Self {
            device,
            player,
            decoder: "ffmpeg".into(),
            playing: Mutex::new(()),
        }
    }

    /// Play audio captured on the robot through the same output and amplifier as other sounds.
    pub(super) fn play_robot_recording(&self, mut input: File) -> Result<(), String> {
        let _guard = self.playing.lock().map_err(|_| "音频播放任务异常".to_owned())?;
        input.seek(SeekFrom::Start(0)).map_err(|error| format!("无法读取录音：{error}"))?;
        let output = Command::new(&self.player)
            .args(["-q", "-D", &self.device, "-t", "raw", "-f", "S16_LE", "-c", "2", "-r", "48000"])
            .stdin(Stdio::from(input))
            .output()
            .map_err(|error| format!("无法启动实机音频播放：{error}"))?;
        if !output.status.success() {
            return Err(format!("实机播放失败：{}", diagnostic(&output.stderr, output.status)));
        }
        Ok(())
    }

    fn play(&self, bytes: &[u8]) -> Result<(), VoiceError> {
        if bytes.is_empty() {
            return Err(VoiceError::Input("录音为空，请重新录制".into()));
        }
        let _guard = self
            .playing
            .lock()
            .map_err(|_| VoiceError::Output("音频播放任务异常，请重试".into()))?;
        let input = memory_file(bytes)
            .map_err(|error| VoiceError::Output(format!("无法准备录音：{error}")))?;
        // A seekable anonymous file also supports MP4 recordings whose index is at the end.
        // It has no path on disk, so process exit automatically discards the recording.
        let path = format!("/proc/{}/fd/{}", std::process::id(), input.as_raw_fd());
        let output = Command::new(&self.decoder)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                &path,
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "48000",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| VoiceError::Output(format!("无法启动录音解码器：{error}")))?;
        if !output.status.success() {
            return Err(VoiceError::Input(format!(
                "录音解码失败：{}",
                diagnostic(&output.stderr, output.status)
            )));
        }
        if output.stdout.is_empty() {
            return Err(VoiceError::Input("录音没有可播放的声音，请重新录制".into()));
        }

        let mut child = Command::new(&self.player)
            .args([
                "-q",
                "-D",
                &self.device,
                "-t",
                "raw",
                "-f",
                "S16_LE",
                "-c",
                "1",
                "-r",
                "48000",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| VoiceError::Output(format!("无法启动实机音频播放：{error}")))?;
        let mut stdin = child.stdin.take().expect("piped player input");
        let mut stderr = child.stderr.take().expect("piped player diagnostics");
        let diagnostics = std::thread::spawn(move || {
            let mut data = Vec::new();
            stderr.read_to_end(&mut data).map(|_| data)
        });
        let write_result = stdin.write_all(&output.stdout);
        drop(stdin);
        let status = child
            .wait()
            .map_err(|error| VoiceError::Output(format!("无法等待实机播放结束：{error}")))?;
        let errors = diagnostics
            .join()
            .map_err(|_| VoiceError::Output("读取实机播放错误信息失败".into()))?
            .map_err(|error| VoiceError::Output(format!("读取实机播放错误信息失败：{error}")))?;
        if !status.success() {
            return Err(VoiceError::Output(format!(
                "实机播放失败：{}",
                diagnostic(&errors, status)
            )));
        }
        write_result
            .map_err(|error| VoiceError::Output(format!("发送录音到实机扬声器失败：{error}")))
    }
}

pub(super) fn memory_file(bytes: &[u8]) -> std::io::Result<File> {
    // SAFETY: memfd_create returns an owned descriptor, which File takes ownership of.
    let descriptor = unsafe { libc::memfd_create(c"voice-message".as_ptr(), libc::MFD_CLOEXEC) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_fd(descriptor) };
    file.write_all(bytes)?;
    Ok(file)
}

fn diagnostic(stderr: &[u8], status: std::process::ExitStatus) -> String {
    let detail = String::from_utf8_lossy(stderr);
    if detail.trim().is_empty() {
        status.to_string()
    } else {
        detail.trim().to_owned()
    }
}

pub(super) async fn post_message(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let player: Arc<VoicePlayer> = Arc::clone(&state.voice);
    let result = tokio::task::spawn_blocking(move || player.play(&body))
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("喊话任务失败：{error}"),
            )
        })?;
    result
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|error| match error {
            VoiceError::Input(message) => (StatusCode::BAD_REQUEST, message),
            VoiceError::Output(message) => (StatusCode::SERVICE_UNAVAILABLE, message),
        })
}
