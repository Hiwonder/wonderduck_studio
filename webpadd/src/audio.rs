//! Playback volume for the configured ALSA hardware device.
use std::process::Command;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use super::AppState;

const UNOQ_CARD: &str = "ArduinoImolaHPH";
const UNOQ_GAIN: &str = "name=RX_RX0 Digital Volume";
// The QCM2290 gain starts at -84 dB (mute). Keep the upper setting at unity gain.
const UNOQ_UNITY_GAIN: u32 = 84;

#[derive(Clone)]
pub(super) struct AudioVolume {
    card: Result<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[derive(Debug)]
pub(super) struct Volume {
    volume: u8,
}

impl AudioVolume {
    pub(super) fn new(device: &str) -> Self {
        let card = device
            .strip_prefix("plughw:")
            .or_else(|| device.strip_prefix("hw:"))
            .and_then(|value| value.split(',').next())
            .map(|value| value.strip_prefix("CARD=").unwrap_or(value))
            .filter(|value| {
                !value.is_empty()
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
            .map(str::to_owned)
            .ok_or_else(|| format!("无法确定播放设备 {device} 的声卡"));
        Self { card }
    }

    fn mixer(&self, args: &[&str]) -> Result<String, String> {
        let card = self.card.as_ref().map_err(Clone::clone)?;
        let result = Command::new("amixer")
            .env("LC_ALL", "C")
            .args(["-c", card])
            .args(args)
            .output()
            .map_err(|error| format!("无法运行 amixer: {error}"))?;
        if !result.status.success() {
            return Err(format!(
                "声卡音量操作失败: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        String::from_utf8(result.stdout).map_err(|error| format!("声卡返回无效文本: {error}"))
    }

    fn read(&self) -> Result<Volume, String> {
        if self.card.as_deref() == Ok(UNOQ_CARD) {
            let gain = self.mixer(&["cget", UNOQ_GAIN])?;
            let [raw] = values(&gain)?[..] else {
                return Err("无法读取声卡音量".into());
            };
            let raw: u32 = raw.parse().map_err(|_| "无效声卡音量")?;
            return Ok(Volume {
                volume: ((raw.min(UNOQ_UNITY_GAIN) * 100 + UNOQ_UNITY_GAIN / 2) / UNOQ_UNITY_GAIN) as u8,
            });
        }
        let line = self.mixer(&["cget", "name=Line Playback Switch"])?;
        let switches = values(&line)?;
        if switches
            .iter()
            .any(|value| *value != "on" && *value != "off")
        {
            return Err("无法读取声卡静音状态".into());
        }
        if switches.iter().all(|value| *value == "off") {
            return Ok(Volume { volume: 0 });
        }
        if switches.iter().any(|value| *value == "off") {
            return Err("声卡左右声道静音状态不一致".into());
        }
        let pcm = self.mixer(&["cget", "name=PCM Playback Volume"])?;
        let limits = pcm
            .lines()
            .find(|line| line.contains("min=") && line.contains("max="))
            .ok_or("无法读取声卡音量范围")?;
        let parse_limit = |name: &str| -> Result<i32, String> {
            limits
                .split(',')
                .find_map(|part| part.trim().strip_prefix(name))
                .ok_or_else(|| format!("缺少声卡音量 {name}"))?
                .parse()
                .map_err(|_| format!("无效声卡音量 {name}"))
        };
        let min = parse_limit("min=")?;
        let max = parse_limit("max=")?;
        let channels = values(&pcm)?;
        let first: i32 = channels
            .first()
            .ok_or("缺少声卡音量")?
            .parse()
            .map_err(|_| "无效声卡音量")?;
        if max <= min
            || !(min..=max).contains(&first)
            || channels
                .iter()
                .any(|value| value.parse::<i32>().ok() != Some(first))
        {
            return Err("声卡音量范围或声道值无效".into());
        }
        Ok(Volume {
            volume: (((first - min) * 100 + (max - min) / 2) / (max - min)) as u8,
        })
    }

    pub(super) fn set(&self, volume: u8) -> Result<Volume, String> {
        if volume > 100 {
            return Err("音量必须在 0 到 100 之间".into());
        }
        if self.card.as_deref() == Ok(UNOQ_CARD) {
            let gain = (u32::from(volume) * UNOQ_UNITY_GAIN + 50) / 100;
            self.mixer(&["cset", UNOQ_GAIN, &gain.to_string()])?;
        } else if volume == 0 {
            self.mixer(&["cset", "name=Line Playback Switch", "off,off"])?;
        } else {
            self.mixer(&["cset", "name=PCM Playback Volume", &format!("{volume}%,{volume}%")])?;
            self.mixer(&["cset", "name=Line Playback Switch", "on,on"])?;
        }
        self.read()
    }
}

fn values(output: &str) -> Result<Vec<&str>, String> {
    let line = output
        .lines()
        .find_map(|line| line.trim().strip_prefix(": values="))
        .ok_or("无法解析声卡状态")?;
    let values: Vec<_> = line.split(',').map(str::trim).collect();
    if values.is_empty() || values.iter().any(|value| value.is_empty()) {
        return Err("声卡状态为空".into());
    }
    Ok(values)
}

async fn operation(
    state: AppState,
    value: Option<u8>,
) -> Result<Json<Volume>, (StatusCode, String)> {
    let guard = state.audio.lock().await;
    let audio = guard.clone();
    let result = tokio::task::spawn_blocking(move || match value {
        Some(volume) => audio.set(volume),
        None => audio.read(),
    })
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("音量任务失败: {error}"),
        )
    })?;
    drop(guard);
    result
        .map(Json)
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))
}

pub(super) async fn get_volume(
    State(state): State<AppState>,
) -> Result<Json<Volume>, (StatusCode, String)> {
    operation(state, None).await
}

pub(super) async fn set_volume(
    State(state): State<AppState>,
    Json(volume): Json<Volume>,
) -> Result<Json<Volume>, (StatusCode, String)> {
    if volume.volume > 100 {
        return Err((StatusCode::BAD_REQUEST, "音量必须在 0 到 100 之间".into()));
    }
    operation(state, Some(volume.volume)).await
}
