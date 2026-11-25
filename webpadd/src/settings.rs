//! Page preferences owned by this process, separate from robot startup configuration.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{MAX_ANGULAR, MAX_LINEAR, proto};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TrackingScope {
    #[default]
    Target,
    Person,
    PickupAfter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    pub(super) linear_speed: f64,
    pub(super) turn_speed: f64,
    pub(super) maze: MazeSettings,
    pub(super) tracking: TrackingSettings,
    pub(super) color_threshold: f64,
    pub(super) color_reference: Option<ColorReference>,
    pub(super) object_label: Option<u8>,
    pub(super) obstacle: proto::ObstacleParams,
    pub(super) low_voltage: proto::LowVoltageParams,
    pub(super) audio_volume: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct MazeSettings {
    pub(super) threshold_mm: u32,
    pub(super) head_step_deg: f64,
    pub(super) settle_ms: u64,
    pub(super) sample_ms: u64,
    pub(super) turn_initial_ms: u64,
    pub(super) turn_final_ms: u64,
    pub(super) restore_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct TrackingSettings {
    pub(super) reference_area: Option<f64>,
    #[serde(default = "default_line_speed")]
    pub(super) line_speed: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) line_target_x: Option<f64>,
    pub(super) deadzone: [f64; 2],
    pub(super) gains: [[f64; 3]; 2],
}

fn default_line_speed() -> f64 {
    0.15
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct HeadTrackingSettings {
    #[serde(default = "default_head_target_point")]
    pub(super) target_point: [f64; 2],
    pub(super) deadzone: [f64; 2],
    pub(super) gains: [[f64; 3]; 2],
}

fn default_head_target_point() -> [f64; 2] {
    proto::HEAD_TRACKING_DEFAULT_POINT
}

impl Default for HeadTrackingSettings {
    fn default() -> Self {
        Self { target_point: default_head_target_point(), deadzone: [0.05, 0.05],
            gains: [[1.3, 0.0, 0.1], [2.8, 0.2, 0.5]] }
    }
}

impl HeadTrackingSettings {
    pub(super) fn valid(&self) -> bool {
        proto::valid_tracking_image_point(self.target_point) && proto::HeadTrackingParams { pitch_position: None,
            action: proto::MotionTrackingAction::Update,
            target: None,
            deadzone: self.deadzone,
            gains: self.gains,
        }.valid()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct CoordinatedTrackingSettings {
    pub(super) head_deadzone: [f64; 2],
    pub(super) head_gains: [[f64; 3]; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) head_target_point: Option<[f64; 2]>,
    pub(super) body_gains: [f64; 3],
    pub(super) final_point: [f64; 2],
    pub(super) final_tolerance: [f64; 2],
    pub(super) arrival_delay_s: f64,
    pub(super) arrival_skill: String,
    pub(super) mouth_before: proto::TimedMouthPosition,
    pub(super) mouth_after: proto::TimedMouthPosition,
}

impl Default for CoordinatedTrackingSettings {
    fn default() -> Self {
        Self {
            head_target_point: Some(proto::HEAD_TRACKING_DEFAULT_POINT),
            head_deadzone: [0.1, 0.05],
            head_gains: [[0.5, 0.04, 0.01]; 2],
            body_gains: [0.2, 0.3, 1.0],
            final_point: proto::COORDINATED_TRACKING_DEFAULT_FINAL_POINT,
            final_tolerance: proto::COORDINATED_TRACKING_DEFAULT_FINAL_TOLERANCE,
            arrival_delay_s: proto::COORDINATED_TRACKING_DEFAULT_ARRIVAL_DELAY_S,
            arrival_skill: String::new(),
            mouth_before: proto::TimedMouthPosition::default(),
            mouth_after: proto::TimedMouthPosition::default(),
        }
    }
}

impl CoordinatedTrackingSettings {
    pub(super) fn person_defaults() -> Self {
        Self {
            head_target_point: None,
            head_deadzone: [0.05, 0.05],
            head_gains: [[2.0, 0.0, 0.1], [2.8, 0.2, 0.5]],
            body_gains: [2.0, 0.2, 1.0],
            final_point: [160.0, 90.0],
            final_tolerance: [40.0, 18.75],
            arrival_delay_s: 1.0,
            arrival_skill: "ground_pick".into(),
            mouth_before: proto::TimedMouthPosition { enabled: true, open: 1.0, duration_s: 0.5 },
            mouth_after: proto::TimedMouthPosition { enabled: true, open: 1.0, duration_s: 0.0 },
        }
    }

    pub(super) fn valid(&self) -> bool {
        proto::CoordinatedTrackingParams {
            action: proto::MotionTrackingAction::Update,
            initial_pitch: None,
            target: None,
            camera: None,
            head_deadzone: self.head_deadzone,
            head_gains: self.head_gains,
            head_target_point: self.head_target_point,
            body_gains: self.body_gains,
            final_body_gains: self.body_gains,
            approach_linear_limit: None,
            final_linear_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT,
            final_lateral_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT,
            final_point: self.final_point,
            final_tolerance: self.final_tolerance,
            stop_area_px: None,
            stop_area_deadzone_px: 0,
            stop_distance_mm: None,
            stop_distance_deadzone_mm: 0,
            arrival_delay_s: self.arrival_delay_s,
            arrival_skill: self.arrival_skill.clone(),
            mouth_before: self.mouth_before,
            mouth_after: self.mouth_after,
            pickup_after: None,
        }.valid()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct TrackingPhaseSettings {
    pub(super) final_body_gains: [f64; 3],
    pub(super) approach_linear_limit: Option<f64>,
    pub(super) final_linear_limit: f64,
    pub(super) final_lateral_limit: f64,
}

impl Default for TrackingPhaseSettings {
    fn default() -> Self {
        Self { final_body_gains: [0.2, 0.3, 1.0], approach_linear_limit: None,
            final_linear_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT,
            final_lateral_limit: proto::COORDINATED_TRACKING_DEFAULT_FINAL_LINEAR_LIMIT }
    }
}

impl TrackingPhaseSettings {
    pub(super) fn person_defaults() -> Self {
        Self { final_body_gains: [1.0, 1.0, 1.0], approach_linear_limit: Some(0.3),
            final_linear_limit: 0.06, final_lateral_limit: 0.07 }
    }

    fn valid(&self) -> bool {
        self.final_body_gains.iter().all(|value| value.is_finite())
            && self.approach_linear_limit.is_none_or(|value| value.is_finite() && value >= 0.0)
            && self.final_linear_limit.is_finite() && self.final_linear_limit >= 0.0
            && self.final_lateral_limit.is_finite() && self.final_lateral_limit >= 0.0
    }
}

#[derive(Debug, Clone)]
pub(super) struct TrackingPhaseStore {
    pub(super) path: PathBuf,
    pub(super) value: TrackingPhaseSettings,
}

impl TrackingPhaseStore {
    pub(super) fn load_pickup_after(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("pickup-after-phases.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<TrackingPhaseSettings>(&text)
                .map_err(|error| format!("解析搬运动作后速度参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => TrackingPhaseSettings::default(),
            Err(error) => return Err(format!("读取搬运动作后速度参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() { return Err(format!("搬运动作后速度参数 {} 包含无效值", path.display())); }
        Ok(Self { path, value })
    }

    pub(super) fn load(config: &Path, initial_gains: [f64; 3]) -> Result<Self, String> {
        let path = config.with_extension("tracking-phases.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<TrackingPhaseSettings>(&text)
                .map_err(|error| format!("解析分阶段追踪参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let initial = TrackingPhaseSettings { final_body_gains: initial_gains, ..Default::default() };
                if !initial.valid() { return Err("分阶段追踪初始参数无效".into()); }
                write_json(&path, &initial)
                    .map_err(|error| format!("初始化分阶段追踪参数 {} 失败：{error}", path.display()))?;
                initial
            }
            Err(error) => return Err(format!("读取分阶段追踪参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() { return Err(format!("分阶段追踪参数 {} 包含无效值", path.display())); }
        Ok(Self { path, value })
    }

    pub(super) fn save(&mut self, value: TrackingPhaseSettings) -> Result<(), String> {
        if !value.valid() { return Err("分阶段追踪参数无效".into()); }
        write_json(&self.path, &value)
            .map_err(|error| format!("保存分阶段追踪参数 {} 失败：{error}", self.path.display()))?;
        self.value = value;
        Ok(())
    }

    pub(super) fn load_person(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("person-follow-phases.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<TrackingPhaseSettings>(&text)
                .map_err(|error| format!("解析行人跟随速度参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let initial = TrackingPhaseSettings::person_defaults();
                if !initial.valid() { return Err("行人跟随速度初始参数无效".into()); }
                write_json(&path, &initial)
                    .map_err(|error| format!("初始化行人跟随速度参数 {} 失败：{error}", path.display()))?;
                initial
            }
            Err(error) => return Err(format!("读取行人跟随速度参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() { return Err(format!("行人跟随速度参数 {} 包含无效值", path.display())); }
        Ok(Self { path, value })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct ColorReference {
    pub(super) rgb: [u8; 3],
    /// The detector uses OpenCV's 8-bit Lab representation for all three channels.
    pub(super) lab: [f64; 3],
}

impl ColorReference {
    fn valid(&self) -> bool {
        self.lab.iter().all(|value| value.is_finite() && (0.0..=255.0).contains(value))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct ColorPreset {
    pub(super) reference: ColorReference,
    pub(super) threshold: f64,
}

impl ColorPreset {
    fn valid(&self) -> bool {
        self.reference.valid() && self.threshold.is_finite() && (0.0..=1.0).contains(&self.threshold)
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            linear_speed: MAX_LINEAR,
            turn_speed: MAX_ANGULAR,
            maze: MazeSettings {
                threshold_mm: 400, head_step_deg: 10.0, settle_ms: 1000, sample_ms: 200,
                turn_initial_ms: 400, turn_final_ms: 600, restore_ms: 1000,
            },
            tracking: TrackingSettings {
                reference_area: Some(0.0869), line_speed: default_line_speed(), line_target_x: Some(160.0), deadzone: [0.1, 0.05],
                gains: [[0.5, 0.04, 0.01], [0.5, 0.04, 0.01]],
            },
            color_threshold: 0.37, color_reference: None, object_label: Some(0),
            obstacle: proto::ObstacleParams::default(),
            low_voltage: proto::LowVoltageParams::default(),
            // The board's mixer initialization uses the full PCM playback range.
            audio_volume: Some(100),
        }
    }
}

impl Settings {
    pub(super) fn valid(&self) -> bool {
        let maze = proto::MazeParams {
            action: proto::MotionTrackingAction::Update,
            threshold_mm: self.maze.threshold_mm,
            head_step_deg: self.maze.head_step_deg,
            settle_ms: self.maze.settle_ms,
            sample_ms: self.maze.sample_ms,
            restore_ms: self.maze.restore_ms,
            turn_initial_ms: self.maze.turn_initial_ms,
            turn_final_ms: self.maze.turn_final_ms,
            linear_speed: self.linear_speed,
            angular_speed: self.turn_speed,
        };
        let tracking = proto::MotionTrackingParams {
            initial_pitch: None,
            action: proto::MotionTrackingAction::Update,
            target: None,
            line_speed: Some(self.tracking.line_speed),
            line_target_x: self.tracking.line_target_x,
            reference_area: self.tracking.reference_area.unwrap_or(0.01),
            deadzone: self.tracking.deadzone,
            gains: self.tracking.gains,
        };

        self.linear_speed.is_finite()
            && (0.0..=MAX_LINEAR).contains(&self.linear_speed)
            && self.turn_speed.is_finite()
            && (0.0..=MAX_ANGULAR).contains(&self.turn_speed)
            && maze.valid()
            && tracking.valid()
            && self.color_threshold.is_finite()
            && (0.0..=1.0).contains(&self.color_threshold)
            && self.color_reference.as_ref().is_none_or(ColorReference::valid)
            && self.object_label.is_none_or(|label| label < 80)
            && (proto::OBSTACLE_MIN_THRESHOLD_MM..=proto::OBSTACLE_MAX_THRESHOLD_MM)
                .contains(&self.obstacle.threshold_mm)
            && self.obstacle.clear_delay_ms <= proto::OBSTACLE_MAX_CLEAR_DELAY_MS
            && self.low_voltage.threshold_v.is_finite()
            && (proto::LOW_VOLTAGE_MIN_THRESHOLD_V..=proto::LOW_VOLTAGE_MAX_THRESHOLD_V)
                .contains(&self.low_voltage.threshold_v)
            && (proto::LOW_VOLTAGE_MIN_DURATION_S..=proto::LOW_VOLTAGE_MAX_DURATION_S)
                .contains(&self.low_voltage.duration_s)
            && self.audio_volume.is_none_or(|volume| volume <= 100)
    }
}

#[derive(Debug, Clone)]
pub(super) struct ColorStore {
    pub(super) path: PathBuf,
    pub(super) value: BTreeMap<String, ColorPreset>,
}

impl ColorStore {
    pub(super) fn load(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("color-presets.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<BTreeMap<String, ColorPreset>>(&text)
                .map_err(|error| format!("解析保存的颜色 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(format!("读取保存的颜色 {} 失败：{error}", path.display())),
        };
        if value.iter().any(|(name, preset)| name.trim().is_empty() || !preset.valid()) {
            return Err(format!("保存的颜色 {} 包含无效值", path.display()));
        }
        Ok(Self { path, value })
    }

    pub(super) fn save(&mut self, name: String, preset: ColorPreset) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || !preset.valid() { return Err("颜色名称或颜色参数无效".into()); }
        let mut value = self.value.clone();
        value.insert(name.to_owned(), preset);
        write_json(&self.path, &value)
            .map_err(|error| format!("保存颜色 {} 失败：{error}", self.path.display()))?;
        self.value = value;
        Ok(())
    }

    pub(super) fn delete(&mut self, name: String) -> Result<(), String> {
        if name.trim().is_empty() { return Err("颜色名称无效".into()); }
        let mut value = self.value.clone();
        // A second client may already have removed this preset. Treat that as
        // success so a stale selection is still removed from the requesting UI.
        if value.remove(&name).is_none() { return Ok(()); }
        write_json(&self.path, &value)
            .map_err(|error| format!("删除颜色 {} 失败：{error}", self.path.display()))?;
        self.value = value;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(super) struct Store {
    pub(super) path: PathBuf,
    pub(super) value: Option<Settings>,
}

impl Store {
    pub(super) fn load(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("controls.json");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self { path, value: None });
            }
            Err(error) => {
                return Err(format!("读取页面参数 {} 失败：{error}", path.display()));
            }
        };
        let mut value: Settings = serde_json::from_str(&text)
            .map_err(|error| format!("解析页面参数 {} 失败：{error}", path.display()))?;
        // Older snapshots allowed a linear speed up to 0.4 m/s.
        if (MAX_LINEAR..=0.4).contains(&value.linear_speed) {
            value.linear_speed = MAX_LINEAR;
        }
        if !value.valid() {
            return Err(format!("页面参数 {} 包含无效值", path.display()));
        }
        value.low_voltage = proto::LowVoltageParams::default();
        Ok(Self {
            path,
            value: Some(value),
        })
    }

    pub(super) fn save(&mut self, mut settings: Settings) -> Result<(), String> {
        if !settings.valid() {
            return Err("页面参数包含无效值，未保存".into());
        }
        settings.low_voltage = proto::LowVoltageParams::default();
        write_json(&self.path, &settings)
            .map_err(|error| format!("保存页面参数 {} 失败：{error}", self.path.display()))?;
        self.value = Some(settings);
        Ok(())
    }

}

#[derive(Debug, Clone)]
pub(super) struct HeadStore {
    pub(super) path: PathBuf,
    pub(super) value: HeadTrackingSettings,
}

impl HeadStore {
    pub(super) fn load(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("head-tracking.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<HeadTrackingSettings>(&text)
                .map_err(|error| format!("解析头部追踪参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HeadTrackingSettings::default(),
            Err(error) => return Err(format!("读取头部追踪参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() {
            return Err(format!("头部追踪参数 {} 包含无效值", path.display()));
        }
        Ok(Self { path, value })
    }

    pub(super) fn save(&mut self, settings: HeadTrackingSettings) -> Result<(), String> {
        if !settings.valid() {
            return Err("头部追踪参数包含无效值，未保存".into());
        }
        write_json(&self.path, &settings)
            .map_err(|error| format!("保存头部追踪参数 {} 失败：{error}", self.path.display()))?;
        self.value = settings;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(super) struct CoordinatedStore {
    pub(super) path: PathBuf,
    pub(super) value: CoordinatedTrackingSettings,
}

impl CoordinatedStore {
    pub(super) fn load(config: &Path) -> Result<Self, String> {
        Self::load_with_extension(config, "coordinated-pid.json")
    }

    pub(super) fn load_pickup_after(config: &Path) -> Result<Self, String> {
        Self::load_with_extension(config, "pickup-after-pid.json")
    }

    fn load_with_extension(config: &Path, extension: &str) -> Result<Self, String> {
        let path = config.with_extension(extension);
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<CoordinatedTrackingSettings>(&text)
                .map_err(|error| format!("解析联合追踪参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => CoordinatedTrackingSettings::default(),
            Err(error) => return Err(format!("读取联合追踪参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() {
            return Err(format!("联合追踪参数 {} 包含无效值", path.display()));
        }
        Ok(Self { path, value })
    }

    pub(super) fn save(&mut self, settings: CoordinatedTrackingSettings) -> Result<(), String> {
        if !settings.valid() {
            return Err("联合追踪参数包含无效值，未保存".into());
        }
        write_json(&self.path, &settings)
            .map_err(|error| format!("保存联合追踪参数 {} 失败：{error}", self.path.display()))?;
        self.value = settings;
        Ok(())
    }

    pub(super) fn load_person(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("person-follow-pid.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<CoordinatedTrackingSettings>(&text)
                .map_err(|error| format!("解析行人跟随参数 {} 失败：{error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let initial = CoordinatedTrackingSettings::person_defaults();
                if !initial.valid() { return Err("行人跟随初始参数无效".into()); }
                write_json(&path, &initial)
                    .map_err(|error| format!("初始化行人跟随参数 {} 失败：{error}", path.display()))?;
                initial
            }
            Err(error) => return Err(format!("读取行人跟随参数 {} 失败：{error}", path.display())),
        };
        if !value.valid() { return Err(format!("行人跟随参数 {} 包含无效值", path.display())); }
        Ok(Self { path, value })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MouthSettings {
    sound: String,
}

#[derive(Debug, Clone)]
pub(super) struct MouthStore {
    pub(super) path: PathBuf,
    pub(super) value: String,
}

impl MouthStore {
    pub(super) fn load(config: &Path) -> Result<Self, String> {
        let path = config.with_extension("mouth-sound.json");
        let value = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<MouthSettings>(&text)
                .map_err(|error| format!("解析嘴部声音设置 {} 失败：{error}", path.display()))?
                .sound,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(format!("读取嘴部声音设置 {} 失败：{error}", path.display())),
        };
        if !value.is_empty() && !(proto::SoundClipParams { name: value.clone(), hold: None }).valid() {
            return Err(format!("嘴部声音设置 {} 包含无效名称", path.display()));
        }
        Ok(Self { path, value })
    }

    pub(super) fn save(&mut self, sound: String, directory: &Path) -> Result<(), String> {
        if !sound.is_empty() && !list_mouth_sounds(directory)?.contains(&sound) {
            return Err(format!("音频 {sound} 不存在或不可用"));
        }
        write_json(&self.path, &MouthSettings { sound: sound.clone() })
            .map_err(|error| format!("保存嘴部声音设置 {} 失败：{error}", self.path.display()))?;
        self.value = sound;
        Ok(())
    }
}

pub(super) fn list_mouth_sounds(directory: &Path) -> Result<Vec<String>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取音频目录 {} 失败：{error}", directory.display())),
    };
    let mut sounds = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取音频目录失败：{error}"))?;
        let kind = entry.file_type().map_err(|error| format!("读取音频文件类型失败：{error}"))?;
        let path = entry.path();
        if !kind.is_file() || path.extension().is_none_or(|extension| extension != "wav") {
            continue;
        }
        if let Some(name) = path.file_stem().and_then(|name| name.to_str()) {
            if (proto::SoundClipParams { name: name.to_owned(), hold: None }).valid() {
                sounds.push(name.to_owned());
            }
        }
    }
    sounds.sort();
    Ok(sounds)
}

/// Lock, write, sync and replace each independent settings file.
fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    let dir = path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let lock = fs::OpenOptions::new().create(true).write(true).truncate(false)
        .open(path.with_extension("lock"))?;
    lock.lock()?;
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let temp_path = path.with_extension("tmp");
    {
        let mut temp = fs::File::create(&temp_path)?;
        temp.write_all(text.as_bytes())?;
        temp.write_all(b"\n")?;
        temp.sync_all()?;
    }
    fs::rename(&temp_path, path)?;
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}
