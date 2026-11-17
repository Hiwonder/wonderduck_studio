//! Classic control semantics; this module has no hardware or socket access.

use super::*;
use robotd_params::{PadDriveParams, PadParams};

const DRIVE_AXIS_LOCK_ANGLE: f64 = 20.0 * std::f64::consts::PI / 180.0;

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Input {
    pub left_x: f64,
    pub left_y: f64,
    pub right_x: f64,
    pub right_y: f64,
    pub left_trigger: f64,
    pub right_trigger: f64,
    pub buttons: u16,
}

impl Input {
    pub fn valid(self) -> bool {
        [self.left_x, self.left_y, self.right_x, self.right_y]
            .into_iter()
            .all(|v| v.is_finite() && (-1.0..=1.0).contains(&v))
            && [self.left_trigger, self.right_trigger]
                .into_iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(&v))
    }
    pub fn neutral(self) -> bool {
        self.buttons == 0
            && self.left_trigger < 0.05
            && self.right_trigger < 0.05
            && [self.left_x, self.left_y, self.right_x, self.right_y]
                .into_iter()
                .all(|v| v.abs() < 0.05)
    }
    fn held(self, button: Button) -> bool {
        self.buttons & button.bit() != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Button {
    A,
    B,
    X,
    Y,
    Lb,
    Rb,
    Start,
    Select,
    L3,
    R3,
    Up,
    Right,
    Left,
    Down,
}
impl Button {
    pub fn bit(self) -> u16 {
        1 << self as u16
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum MotionMode {
    #[default]
    Drive,
    Head,
    HeadDrive,
    BodyPose,
}
impl MotionMode {
    fn poses_head(self) -> bool {
        self != Self::Drive
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum BrowserMessage {
    StudioLeave {
        request_id: u64,
        // Keep the existing wire field for embedded pages from earlier versions.
        #[serde(default, rename = "person_follow")]
        return_tracking_head_home: bool,
    },
    Input {
        seq: u64,
        left_x: f64,
        left_y: f64,
        right_x: f64,
        right_y: f64,
        left_trigger: f64,
        right_trigger: f64,
        buttons: Vec<Button>,
        active: bool,
    },
    SetSpeed {
        linear_speed: f64,
        turn_speed: f64,
    },
    SaveSettings {
        request_id: u64,
        settings: settings::Settings,
    },
    SaveHeadSettings {
        request_id: u64,
        settings: settings::HeadTrackingSettings,
    },
    SaveCoordinatedSettings {
        request_id: u64,
        #[serde(default)]
        scope: settings::TrackingScope,
        settings: settings::CoordinatedTrackingSettings,
    },
    SaveTrackingPhases {
        request_id: u64,
        #[serde(default)]
        scope: settings::TrackingScope,
        settings: settings::TrackingPhaseSettings,
    },
    SaveMouthSound {
        request_id: u64,
        sound: String,
    },
    SaveColorPreset {
        request_id: u64,
        name: String,
        preset: settings::ColorPreset,
    },
    DeleteColorPreset {
        request_id: u64,
        name: String,
    },
    SetObstacle {
        enabled: bool,
        threshold_mm: u32,
        clear_delay_ms: u32,
    },
    SetLowVoltage {
        threshold_v: f64,
        duration_s: u64,
    },
    MotionTracking {
        action: proto::MotionTrackingAction,
        initial_pitch: Option<u16>,
        target: Option<[f64; 2]>,
        reference_area: f64,
        deadzone: [f64; 2],
        gains: [[f64; 3]; 2],
    },
    HeadPosition {
        action: proto::MotionTrackingAction,
        position: Option<u16>,
    },
    HeadTracking {
        action: proto::MotionTrackingAction,
        target: Option<[f64; 2]>,
        #[serde(default)]
        pitch_position: Option<u16>,
        deadzone: [f64; 2],
        gains: [[f64; 3]; 2],
    },
    CoordinatedTracking {
        action: proto::MotionTrackingAction,
        initial_pitch: Option<u16>,
        target: Option<proto::VisualTrackingTarget>,
        camera: Option<proto::TrackingCamera>,
        head_deadzone: [f64; 2],
        head_gains: [[f64; 3]; 2],
        body_gains: [f64; 3],
        final_body_gains: [f64; 3],
        approach_linear_limit: Option<f64>,
        final_linear_limit: f64,
        final_lateral_limit: f64,
        final_point: [f64; 2],
        final_tolerance: [f64; 2],
        stop_area_px: Option<u64>,
        stop_area_deadzone_px: u64,
        stop_distance_mm: Option<u32>,
        stop_distance_deadzone_mm: u32,
        arrival_delay_s: f64,
        arrival_skill: String,
        mouth_before: proto::TimedMouthPosition,
        mouth_after: proto::TimedMouthPosition,
    },
    Maze {
        action: proto::MotionTrackingAction,
        threshold_mm: u32,
        head_step_deg: f64,
        settle_ms: u64,
        sample_ms: u64,
        turn_initial_ms: u64,
        turn_final_ms: u64,
        restore_ms: u64,
        linear_speed: f64,
        angular_speed: f64,
    },
    Action {
        name: Action,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Action {
    Init,
    PrepareDrive,
    /// A user pressed Start, so a recovered low-voltage lock may be rearmed.
    ManualPrepareDrive,
    TogglePolicy,
    DriveMode,
    HeadMode,
    HeadDriveMode,
    BodyPoseMode,
    A,
    B,
    X,
    Y,
    Lb,
    Rb,
    Home,
    Rest,
    Shutdown,
    #[serde(skip_deserializing)]
    SitOnLoss,
    Stop,
    Relax,
}
impl Action {
    pub fn mode(self) -> Option<MotionMode> {
        match self {
            Self::DriveMode => Some(MotionMode::Drive),
            Self::HeadMode => Some(MotionMode::Head),
            Self::HeadDriveMode => Some(MotionMode::HeadDrive),
            Self::BodyPoseMode => Some(MotionMode::BodyPose),
            _ => None,
        }
    }
    pub fn calls(self, bindings: &PadParams) -> Vec<proto::Call> {
        let button = match self {
            Self::A => Some("a"),
            Self::B => Some("b"),
            Self::X => Some("x"),
            Self::Y => Some("y"),
            Self::Lb => Some("lb"),
            Self::Rb => Some("rb"),
            _ => None,
        };
        if let Some(button) = button {
            return bindings
                .skill(button)
                .filter(|name| !name.is_empty())
                .map(|name| vec![skill(name)])
                .unwrap_or_default();
        }
        match self {
            Self::Init => vec![proto::Call::RobotInit],
            Self::PrepareDrive => vec![
                proto::Call::RobotInit,
                proto::Call::RobotEnable(proto::EnableParams {
                    on: true,
                    toggle: false,
                }),
            ],
            Self::ManualPrepareDrive => vec![],
            Self::TogglePolicy => vec![proto::Call::RobotEnable(proto::EnableParams {
                on: false,
                toggle: true,
            })],
            Self::Home => vec![
                proto::Call::RobotEnable(proto::EnableParams {
                    on: false,
                    toggle: false,
                }),
                proto::Call::RobotInit,
            ],
            Self::Rest => vec![proto::Call::RobotRest],
            Self::Shutdown => vec![proto::Call::RobotShutdown],
            Self::Stop => vec![proto::Call::RobotStop],
            Self::Relax => vec![proto::Call::RobotRelax],
            _ => vec![],
        }
    }
}
fn skill(name: &str) -> proto::Call {
    proto::Call::RobotDo(proto::DoParams {
        skill: name.to_owned(),
    })
}

#[derive(Debug, Clone, Copy, Default)]
struct Hold {
    since: Option<Instant>,
    fired: bool,
}
impl Hold {
    fn seconds(self, now: Instant) -> f64 {
        self.since
            .map(|at| now.saturating_duration_since(at).as_secs_f64())
            .unwrap_or(0.0)
    }
    fn update(&mut self, down: bool, now: Instant, threshold: f64) -> (bool, Option<f64>) {
        if down {
            self.since.get_or_insert(now);
            if !self.fired && self.seconds(now) >= threshold {
                self.fired = true;
                return (true, None);
            }
            (false, None)
        } else {
            let seconds = self
                .since
                .map(|at| now.saturating_duration_since(at).as_secs_f64());
            let reached = !self.fired && seconds.is_some_and(|seconds| seconds >= threshold);
            let released = if self.fired || reached { None } else { seconds };
            *self = Self::default();
            (reached, released)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct ControlsView {
    pub mode: MotionMode,
    pub linear_speed: f64,
    pub turn_speed: f64,
    pub armed: bool,
    pub start_seconds: f64,
    pub select_seconds: f64,
    pub bindings: PadParams,
    pub obstacle: Option<proto::ObstacleParams>,
    pub human_owner: Option<proto::HumanControlSource>,
    pub human_busy: bool,
    pub human_connected: bool,
}

#[derive(Debug)]
pub(super) struct ControlState {
    pub owner: Option<u64>,
    pub input: Input,
    pub last_input: Option<Instant>,
    pub mode: MotionMode,
    pub linear_speed: f64,
    pub turn_speed: f64,
    pub bindings: PadParams,
    pub drive: PadDriveParams,
    pub up: bool,
    pub active: bool,
    pub armed: bool,
    pub connected: bool,
    pub roller: bool,
    pub obstacle: Option<proto::ObstacleParams>,
    pub human_owner: Option<proto::HumanControlSource>,
    pub human_held: bool,
    pub human_blocked: bool,
    pub human_acquiring: bool,
    pub human_actions: usize,
    pub maze_active: bool,
    pub head_tracking_started: bool,
    pub head_position: Option<u16>,
    // A sent start needs cleanup even when its response is lost.
    pub head_tracking_dirty: bool,
    pub head_tracking_closing: bool,
    pub coordinated_tracking_started: bool,
    pub coordinated_tracking_dirty: bool,
    pub coordinated_tracking_closing: bool,
    pub coordinated_tracking_generation: u64,
    pub vision_token: Option<String>,
    pub vision_binding: Option<crate::vision_relay::Binding>,
    pub vision_latest: Option<crate::vision_relay::Frame>,
    pub vision_pending: Option<(u64, u64, u64)>,
    pub coordinated_params: Option<proto::CoordinatedTrackingParams>,
    pub person_vision_record: Option<crate::vision_record::Recorder>,
    pub target_vision_record: Option<crate::vision_record::Recorder>,
    pub mouth_sound: String,
    pub human_generation: u64,
    previous: Input,
    start: Hold,
    select: Hold,
    had_input: bool,
    lost_at: Option<Instant>,
    sit_queued: bool,
    pending_calls: Vec<proto::Call>,
    pending_actions: Vec<Action>,
}
impl Default for ControlState {
    fn default() -> Self {
        Self {
            owner: None,
            input: Input::default(),
            last_input: None,
            mode: MotionMode::Drive,
            linear_speed: MAX_LINEAR,
            turn_speed: MAX_ANGULAR,
            bindings: PadParams::default(),
            drive: PadDriveParams::default(),
            up: false,
            active: true,
            armed: false,
            connected: false,
            roller: false,
            obstacle: None,
            human_owner: None,
            human_held: false,
            human_blocked: true,
            human_acquiring: false,
            human_actions: 0,
            maze_active: false,
            head_tracking_started: false,
            head_position: None,
            head_tracking_dirty: false,
            head_tracking_closing: false,
            coordinated_tracking_started: false,
            coordinated_tracking_dirty: false,
            coordinated_tracking_closing: false,
            coordinated_tracking_generation: 0,
            vision_token: None,
            vision_binding: None,
            vision_latest: None,
            vision_pending: None,
            coordinated_params: None,
            person_vision_record: None,
            target_vision_record: None,
            mouth_sound: String::new(),
            human_generation: 0,
            previous: Input::default(),
            start: Hold::default(),
            select: Hold::default(),
            had_input: false,
            lost_at: None,
            sit_queued: false,
            pending_calls: vec![],
            pending_actions: vec![],
        }
    }
}
impl ControlState {
    pub fn set_mouth_sound(&mut self, sound: String) {
        self.mouth_sound = sound;
    }

    /// Preserve short press/release edges between 50 Hz output ticks.
    pub fn receive(&mut self, input: Input, active: bool, now: Instant) {
        self.active = active;
        if active {
            self.input = input;
        } else {
            self.cancel();
        }
        self.last_input = Some(now);
        let (mut calls, actions) = self.tick(now, self.connected);
        // Continuous intents are emitted only by the periodic control task.
        calls.truncate(calls.len() - control_frame(self, now).len());
        self.pending_calls = calls;
        self.pending_actions = actions;
    }
    pub fn view(&self, now: Instant) -> ControlsView {
        ControlsView {
            mode: self.mode,
            linear_speed: self.linear_speed,
            turn_speed: self.turn_speed,
            armed: self.armed,
            start_seconds: (self.start.seconds(now) * 10.0).floor() / 10.0,
            select_seconds: (self.select.seconds(now) * 10.0).floor() / 10.0,
            bindings: self.bindings.clone(),
            obstacle: self.obstacle,
            human_owner: self.human_owner,
            human_busy: self.human_blocked,
            human_connected: self.connected,
        }
    }
    pub fn cancel(&mut self) {
        self.input = Input::default();
        self.start = Hold::default();
        self.select = Hold::default();
        self.armed = false;
    }
    pub fn lose_human_control(&mut self) {
        self.human_generation = self.human_generation.wrapping_add(1);
        self.coordinated_tracking_started = false;
        self.vision_pending = None;
        if let Some(recorder) = &self.person_vision_record { recorder.set_following(false); }
        if let Some(recorder) = &self.target_vision_record { recorder.set_following(false); }
        self.human_held = false;
        self.maze_active = false;
        if self.head_position.take().is_some() { self.head_tracking_started = false; }
        self.human_blocked = true;
        self.cancel();
        self.previous = Input::default();
        self.pending_calls.clear();
        self.pending_actions.clear();
        self.had_input = false;
        self.lost_at = None;
        self.sit_queued = false;
    }
    pub fn set_mode(&mut self, mode: MotionMode) -> Vec<proto::Call> {
        let mut calls = vec![];
        if self.mode == MotionMode::BodyPose && mode != MotionMode::BodyPose {
            calls.push(proto::Call::RobotPose(proto::PoseParams {
                active: false,
                ..Default::default()
            }));
        }
        if self.mode.poses_head() && !mode.poses_head() {
            calls.push(proto::Call::RobotHead(proto::HeadParams::default()));
        }
        self.mode = mode;
        calls
    }
    pub fn fresh(&self, now: Instant) -> bool {
        self.owner.is_some()
            && self.active
            && self
                .last_input
                .is_some_and(|at| now.saturating_duration_since(at) <= INPUT_TTL)
    }
    pub fn tick(&mut self, now: Instant, connected: bool) -> (Vec<proto::Call>, Vec<Action>) {
        let mut calls = std::mem::take(&mut self.pending_calls);
        let mut actions = std::mem::take(&mut self.pending_actions);
        if connected != self.connected {
            calls.clear();
            actions.clear();
            self.cancel();
            self.previous = Input::default();
            self.last_input = None;
            self.up = false;
            self.had_input = false;
            self.lost_at = None;
            self.sit_queued = false;
            calls.extend(self.set_mode(MotionMode::Drive));
            self.connected = connected;
        }
        let fresh = connected && self.fresh(now);
        if !fresh {
            if self.had_input && self.head_position.is_none() {
                let lost = *self.lost_at.get_or_insert(now);
                if !self.sit_queued && now.saturating_duration_since(lost) >= Duration::from_secs(1)
                {
                    self.sit_queued = true;
                    actions.push(Action::SitOnLoss);
                }
            }
            self.cancel();
            self.previous = Input::default();
            calls.extend(self.set_mode(MotionMode::Drive));
        } else {
            if !self.armed && self.input.neutral() {
                self.armed = true;
            }
            if self.armed {
                self.had_input = true;
                self.lost_at = None;
                self.sit_queued = false;
                let rising = self.input.buttons & !self.previous.buttons;
                for (button, mode) in [
                    (Button::Up, MotionMode::Head),
                    (Button::Right, MotionMode::HeadDrive),
                    (Button::Left, MotionMode::Drive),
                    (Button::Down, MotionMode::BodyPose),
                ] {
                    if rising & button.bit() != 0 {
                        calls.extend(self.set_mode(mode));
                    }
                }
                for (button, action) in [
                    (Button::A, Action::A),
                    (Button::B, Action::B),
                    (Button::X, Action::X),
                    (Button::Y, Action::Y),
                    (Button::Lb, Action::Lb),
                    (Button::Rb, Action::Rb),
                ] {
                    if rising & button.bit() != 0 {
                        actions.push(action);
                    }
                }
                if self.input.held(Button::X) && rising & Button::X.bit() == 0 {
                    if let Some(name) = self.bindings.skill("x").filter(|s| !s.is_empty()) {
                        calls.push(skill(name));
                    }
                }
                let delta = i8::from(rising & Button::R3.bit() != 0)
                    - i8::from(rising & Button::L3.bit() != 0);
                if self.input.held(Button::Left) {
                    self.turn_speed = stepped(self.turn_speed, delta, 0.1, MAX_ANGULAR);
                } else {
                    self.linear_speed = stepped(self.linear_speed, delta, 0.01, MAX_LINEAR);
                }
                let (home, tap) = self.start.update(self.input.held(Button::Start), now, 1.5);
                if home {
                    calls.extend(self.set_mode(MotionMode::Drive));
                    actions.push(Action::Home);
                }
                if tap.is_some() {
                    actions.push(if self.up {
                        Action::TogglePolicy
                    } else {
                        Action::Init
                    });
                }
                let (shutdown, release) =
                    self.select
                        .update(self.input.held(Button::Select), now, 4.0);
                if shutdown {
                    actions.push(Action::Shutdown);
                }
                if release.is_some_and(|seconds| (2.0..4.0).contains(&seconds)) {
                    actions.push(Action::Rest);
                }
                self.previous = self.input;
            }
        }
        calls.extend(control_frame(self, now));
        (calls, actions)
    }
}
fn stepped(current: f64, delta: i8, step: f64, maximum: f64) -> f64 {
    ((current + f64::from(delta) * step).clamp(0.0, maximum) * 100.0).round() / 100.0
}
fn lock_drive_axis(forward: f64, sideways: f64) -> (f64, f64) {
    let angle_from_forward = sideways.abs().atan2(forward.abs());
    if angle_from_forward <= DRIVE_AXIS_LOCK_ANGLE {
        (forward, 0.0)
    } else if angle_from_forward >= std::f64::consts::FRAC_PI_2 - DRIVE_AXIS_LOCK_ANGLE {
        (0.0, sideways)
    } else {
        (forward, sideways)
    }
}

pub(super) fn control_frame(control: &ControlState, now: Instant) -> Vec<proto::Call> {
    let input = if control.fresh(now) && control.armed {
        control.input
    } else {
        Input::default()
    };
    let drive = &control.drive;
    let walk = |forward: f64, sideways: f64, yaw: f64| {
        if control.roller {
            return proto::Call::RobotMove(proto::MoveParams {
                vx: forward * if forward >= 0.0 { 0.6 } else { 0.5 },
                vy: 0.0,
                vyaw: -yaw * 0.3,
            });
        }
        proto::Call::RobotMove(proto::MoveParams {
            vx: PadDriveParams::scale(
                forward,
                drive
                    .vx_min
                    .max(-control.linear_speed.min(MAX_LINEAR_BACKWARD)),
                drive.vx_max.min(control.linear_speed),
            ),
            vy: PadDriveParams::scale(
                -sideways,
                drive.vy_min.max(-control.linear_speed),
                drive.vy_max.min(control.linear_speed),
            ),
            vyaw: PadDriveParams::scale(
                -yaw,
                drive.vyaw_min.max(-control.turn_speed),
                drive.vyaw_max.min(control.turn_speed),
            ),
        })
    };
    let look = || {
        proto::Call::RobotHead(proto::HeadParams {
            head_pitch: -input.right_y * MAX_HEAD,
            head_yaw: -input.right_x * MAX_HEAD,
            ..Default::default()
        })
    };
    let mut calls = match control.mode {
        MotionMode::Drive => {
            let (forward, sideways) = lock_drive_axis(input.left_y, input.left_x);
            vec![walk(forward, sideways, input.right_x)]
        }
        MotionMode::HeadDrive => vec![walk(input.left_y, 0.0, input.left_x), look()],
        MotionMode::Head => vec![
            proto::Call::RobotMove(proto::MoveParams::default()),
            proto::Call::RobotHead(proto::HeadParams {
                neck_pitch: input.right_y * MAX_HEAD,
                head_pitch: -input.left_y * MAX_HEAD,
                head_yaw: -input.left_x * MAX_HEAD,
                head_roll: input.right_x * MAX_HEAD,
            }),
        ],
        MotionMode::BodyPose => vec![
            proto::Call::RobotMove(proto::MoveParams::default()),
            proto::Call::RobotPose(proto::PoseParams {
                z: input.left_y
                    * if input.left_y >= 0.0 {
                        BODY_MAX_Z_UP
                    } else {
                        BODY_MAX_Z_DOWN
                    },
                pitch: 0.0,
                roll: input.left_x * BODY_MAX_ANGLE,
                active: true,
            }),
            look(),
        ],
    };
    calls.push(proto::Call::RobotMouth(proto::MouthParams {
        open: input.left_trigger.max(input.right_trigger),
    }));
    calls
}
