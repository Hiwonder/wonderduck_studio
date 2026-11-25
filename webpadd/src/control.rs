//! Classic control semantics; this module has no hardware or socket access.

use super::*;
use duck_control::hx::MANUAL_HEAD_POSITION_LIMITS;
use robotd_params::PadDriveParams;
use std::collections::HashMap;

const DRIVE_AXIS_LOCK_ANGLE: f64 = 20.0 * std::f64::consts::PI / 180.0;
const HEAD_STEP_INTERVAL: Duration = Duration::from_millis(5);
const HEAD_STEP_COUNTS: f64 = 10.0;
const HEAD_FEEDBACK_TTL: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Input {
    pub left_x: f64,
    pub left_y: f64,
    pub right_x: f64,
    pub right_y: f64,
    pub head_stick: Option<[f64; 2]>,
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
            && self.head_stick.is_none_or(|[x, y]| {
                (-1.0..=1.0).contains(&x) && (-1.0..=1.0).contains(&y) && (x == 0.0 || y == 0.0)
            })
    }
    pub fn neutral(self) -> bool {
        self.buttons == 0
            && self.left_trigger < 0.05
            && self.right_trigger < 0.05
            && self.head_stick.is_none_or(|axes| axes == [0.0; 2])
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
        #[serde(default)]
        head_stick: Option<[f64; 2]>,
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
        #[serde(default)]
        line_speed: Option<f64>,
        #[serde(default)]
        line_target_x: Option<f64>,
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
        #[serde(default)]
        head_target_point: Option<[f64; 2]>,
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
        #[serde(default)]
        pickup_after: Option<Box<proto::CoordinatedTrackingParams>>,
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
        request_id: Option<u64>,
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
    CenterHead,
    SitToggle,
    GroundPick,
    KickLeft,
    KickRight,
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
    fn skill_name(self) -> Option<&'static str> {
        match self {
            Self::A | Self::SitToggle => Some("sit_toggle"),
            Self::B | Self::GroundPick => Some("ground_pick"),
            Self::Lb | Self::KickLeft => Some("kick_left"),
            Self::Rb | Self::KickRight => Some("kick_right"),
            _ => None,
        }
    }

    pub fn calls(self) -> Vec<proto::Call> {
        if let Some(name) = self.skill_name() {
            return vec![skill(name)];
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

#[cfg(test)]
mod action_tests {
    use super::*;

    #[test]
    fn named_web_actions_and_legacy_aliases_dispatch_the_same_skills() {
        for (name, alias) in [
            ("sit_toggle", "a"),
            ("ground_pick", "b"),
            ("kick_left", "lb"),
            ("kick_right", "rb"),
        ] {
            for command in [name, alias] {
                let action: Action = serde_json::from_value(serde_json::json!(command)).unwrap();
                assert!(matches!(action.calls().as_slice(), [proto::Call::RobotDo(p)] if p.skill == name));
            }
        }
    }
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
struct WebBindings {
    a: &'static str,
    b: &'static str,
    x: &'static str,
    y: &'static str,
    lb: &'static str,
    rb: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct ControlsView {
    pub mode: MotionMode,
    pub linear_speed: f64,
    pub turn_speed: f64,
    pub armed: bool,
    pub start_seconds: f64,
    pub select_seconds: f64,
    bindings: WebBindings,
    pub obstacle: Option<proto::ObstacleParams>,
    pub human_owner: Option<proto::HumanControlSource>,
    pub control_owner: Option<ControlOwner>,
    pub control_owned: bool,
    pub human_busy: bool,
    pub human_connected: bool,
}

#[derive(Debug, Default)]
struct HeadStick {
    goal: Option<[f64; 2]>,
    last_step: Option<Instant>,
}

impl HeadStick {
    fn center(&mut self) {
        let home = &duck_control::hx::PHYSICAL_HOME_ENCODER_TARGETS;
        self.goal = Some([f64::from(home[6]), f64::from(home[7])]);
        self.last_step = None;
    }

    fn update(&mut self, axes: [f64; 2], measured: Option<[u16; 2]>, now: Instant) {
        // Retain the last target while idle or waiting for servo feedback.
        let Some(measured) = measured.filter(|_| axes != [0.0; 2]) else {
            self.last_step = None;
            return;
        };
        let interval = self.last_step
            .map_or(HEAD_STEP_INTERVAL, |last| now.saturating_duration_since(last));
        let interval = interval.min(INPUT_TTL);
        let step_ms = HEAD_STEP_INTERVAL.as_millis();
        let steps = (interval.as_millis() / step_ms) as u32;
        if steps == 0 {
            return;
        }
        self.last_step = Some(now - (interval - HEAD_STEP_INTERVAL * steps));
        let goal = self.goal.get_or_insert_with(|| measured.map(f64::from));
        let [yaw, pitch] = axes;
        for (axis, (deflection, (min, max))) in [pitch, yaw].into_iter()
            .zip(MANUAL_HEAD_POSITION_LIMITS).enumerate()
        {
            goal[axis] = (goal[axis] + deflection * f64::from(steps) * HEAD_STEP_COUNTS)
                .clamp(f64::from(min), f64::from(max));
        }
    }

    fn raw_position(&self) -> Option<[u16; 2]> {
        self.goal.map(|goal| goal.map(|position| position.round() as u16))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ControlClient {
    App,
    Web,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ControlOwner {
    App,
    Web,
    Gamepad,
    Unknown,
}

pub(super) struct ControlPeer {
    pub client: ControlClient,
    pub token: String,
    pub vision_binding: Option<crate::vision_relay::Binding>,
    pub vision_latest: Option<crate::vision_relay::Frame>,
    neutral_at: Option<Instant>,
    input_at: Option<Instant>,
    input: Input,
    mode: MotionMode,
    reported_ready: bool,
}

impl ControlPeer {
    pub fn new(client: ControlClient, token: String) -> Self {
        Self {
            client,
            token,
            vision_binding: None,
            vision_latest: None,
            neutral_at: None,
            input_at: None,
            input: Input::default(),
            mode: MotionMode::Drive,
            reported_ready: false,
        }
    }

    pub fn receive(&mut self, active: bool, input: Input, now: Instant) {
        if !active || !self.fresh(now) {
            self.require_neutral();
        }
        self.input_at = active.then_some(now);
        self.input = input;
        if active && input.neutral() {
            self.neutral_at = Some(now);
        }
    }

    pub fn require_neutral(&mut self) {
        self.neutral_at = None;
    }

    fn fresh(&self, now: Instant) -> bool {
        self.input_at.is_some_and(|at| now.saturating_duration_since(at) <= INPUT_TTL)
    }

    fn ready(&self, now: Instant) -> bool {
        self.neutral_at.is_some() && self.fresh(now)
    }
}

pub(super) struct ControlState {
    pub owner: Option<u64>,
    pub peers: HashMap<u64, ControlPeer>,
    pub owner_closing: bool,
    pub owner_idle_since: Option<Instant>,
    pub motion_tracking: Option<proto::MotionTrackingParams>,
    pub stops_pending: usize,
    pub input: Input,
    pub last_input: Option<Instant>,
    pub mode: MotionMode,
    pub linear_speed: f64,
    pub turn_speed: f64,
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
    pub maze: Option<proto::MazeParams>,
    pub head_tracking_started: bool,
    pub head_position: Option<u16>,
    head_stick: HeadStick,
    pub coordinated_tracking_started: bool,
    pub vision_generation: u64,
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
            peers: HashMap::new(),
            owner_closing: false,
            owner_idle_since: None,
            motion_tracking: None,
            stops_pending: 0,
            input: Input::default(),
            last_input: None,
            mode: MotionMode::Drive,
            linear_speed: MAX_LINEAR,
            turn_speed: MAX_ANGULAR,
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
            maze: None,
            head_tracking_started: false,
            head_position: None,
            head_stick: HeadStick::default(),
            coordinated_tracking_started: false,
            vision_generation: 0,
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
        if active && input.neutral() {
            self.owner_idle_since.get_or_insert(now);
        } else {
            self.owner_idle_since = None;
        }
        if active {
            self.input = input;
        } else {
            self.cancel();
        }
        self.last_input = Some(now);
        let (calls, actions) = self.tick(now, self.connected);
        self.pending_calls = calls;
        self.pending_actions = actions;
    }
    pub fn update_peer_readiness(&mut self, now: Instant) -> bool {
        let mut changed = false;
        for peer in self.peers.values_mut() {
            let ready = peer.ready(now);
            changed |= peer.reported_ready != ready;
            peer.reported_ready = ready;
        }
        changed
    }

    pub fn view_for(&self, session: Option<u64>, now: Instant) -> ControlsView {
        let local_owner = session.is_some() && self.owner == session;
        let ready = session.and_then(|id| self.peers.get(&id)).is_some_and(|peer| peer.ready(now));
        let control_owner = match self.human_owner {
            Some(proto::HumanControlSource::Gamepad) => Some(ControlOwner::Gamepad),
            Some(proto::HumanControlSource::Web) => self.owner.filter(|_| self.human_held)
                .and_then(|owner| self.peers.get(&owner))
                .map(|peer| match peer.client {
                    ControlClient::App => ControlOwner::App,
                    ControlClient::Web => ControlOwner::Web,
                    ControlClient::Unknown => ControlOwner::Unknown,
                })
                .or(Some(ControlOwner::Unknown)),
            None => None,
        };
        ControlsView {
            mode: session.and_then(|id| self.peers.get(&id)).map_or(self.mode, |peer| peer.mode),
            linear_speed: self.linear_speed,
            turn_speed: self.turn_speed,
            armed: if local_owner { self.armed } else { self.connected && ready },
            start_seconds: (self.start.seconds(now) * 10.0).floor() / 10.0,
            select_seconds: (self.select.seconds(now) * 10.0).floor() / 10.0,
            // Retain the older web client's wire fields for a cached page.
            bindings: WebBindings {
                a: Action::SitToggle.skill_name().unwrap_or_default(),
                b: Action::GroundPick.skill_name().unwrap_or_default(),
                x: "",
                y: "",
                lb: Action::KickLeft.skill_name().unwrap_or_default(),
                rb: Action::KickRight.skill_name().unwrap_or_default(),
            },
            obstacle: self.obstacle,
            human_owner: self.human_owner,
            control_owner,
            control_owned: local_owner && self.human_held,
            human_busy: self.owner.is_some() && !local_owner || self.human_owner == Some(proto::HumanControlSource::Gamepad)
                || if local_owner { self.human_blocked } else { !ready },
            human_connected: self.connected,
        }
    }

    pub fn claim(&mut self, session: u64, now: Instant) -> Result<bool, &'static str> {
        if self.owner.is_some_and(|owner| owner != session) || self.owner_closing || self.stops_pending != 0 {
            return Err("控制权已被其他设备占用");
        }
        let ready = self.peers.get(&session).is_some_and(|peer| peer.ready(now));
        if !self.connected || !ready || (self.owner == Some(session) && (!self.armed || !self.fresh(now))) {
            return Err("请等待连接并松开所有控制后重新操作");
        }
        if self.human_held {
            return Ok(false);
        }
        if self.human_acquiring {
            return Err("控制权请求尚未完成");
        }
        if self.owner.is_none() {
            self.owner = Some(session);
            self.active = true;
            self.armed = true;
            self.human_blocked = false;
            let peer = &self.peers[&session];
            self.last_input = peer.input_at;
            self.mode = peer.mode;
            self.input = if peer.input.neutral() { peer.input } else { Input::default() };
            self.owner_idle_since = Some(now);
        }
        self.human_acquiring = true;
        Ok(true)
    }

    pub fn autonomous_active(&self) -> bool {
        self.maze.is_some() || self.motion_tracking.is_some() || self.head_tracking_started
            || self.coordinated_tracking_started
    }

    pub fn release_due(&self, now: Instant) -> bool {
        self.human_held && !self.owner_closing && !self.human_acquiring
            && self.human_actions == 0 && !self.autonomous_active()
            && (!self.fresh(now) || self.owner_idle_since.is_some_and(|since|
                now.saturating_duration_since(since) >= CONTROL_IDLE_RELEASE))
    }

    pub fn cancel(&mut self) {
        self.input = Input::default();
        self.head_stick = HeadStick::default();
        self.start = Hold::default();
        self.select = Hold::default();
        self.armed = false;
    }
    pub fn lose_human_control(&mut self) {
        if let Some(peer) = self.owner.and_then(|id| self.peers.get_mut(&id)) {
            peer.neutral_at = None;
        }
        self.owner = None;
        self.owner_closing = false;
        self.owner_idle_since = None;
        self.last_input = None;
        self.human_acquiring = false;
        self.head_tracking_started = false;
        self.human_generation = self.human_generation.wrapping_add(1);
        self.coordinated_tracking_started = false;
        self.coordinated_params = None;
        self.motion_tracking = None;
        self.vision_pending = None;
        if let Some(recorder) = &self.person_vision_record { recorder.set_following(false); }
        if let Some(recorder) = &self.target_vision_record { recorder.set_following(false); }
        self.human_held = false;
        self.maze = None;
        self.head_position = None;
        self.human_blocked = true;
        self.cancel();
        self.previous = Input::default();
        self.pending_calls.clear();
        self.pending_actions.clear();
        self.had_input = false;
        self.lost_at = None;
        self.sit_queued = false;
    }

    pub fn finish_idle_release(&mut self, now: Instant) {
        let peer = self.owner.zip(self.last_input).filter(|_| self.fresh(now) && self.input.neutral() && self.armed);
        self.lose_human_control();
        if let Some((id, last_input)) = peer
            && let Some(peer) = self.peers.get_mut(&id)
        {
            peer.neutral_at = Some(last_input);
        }
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
        if self.mode != mode {
            self.head_stick = HeadStick::default();
        }
        self.mode = mode;
        if let Some(peer) = self.owner.and_then(|id| self.peers.get_mut(&id)) {
            peer.mode = mode;
        }
        calls
    }
    pub fn fresh(&self, now: Instant) -> bool {
        self.input_fresh(now, INPUT_TTL)
    }

    fn input_fresh(&self, now: Instant, timeout: Duration) -> bool {
        self.owner.is_some()
            && self.active
            && self
                .last_input
                .is_some_and(|at| now.saturating_duration_since(at) <= timeout)
    }
    fn head_stick_input(&self, status: &BrowserStatus, now: Instant) -> Option<[f64; 2]> {
        let other_head_axes = match self.mode {
            MotionMode::Head => [self.input.left_x, self.input.left_y],
            MotionMode::HeadDrive => [self.input.right_x, self.input.right_y],
            _ => [0.0; 2],
        };
        if self.fresh(now) && self.human_held && self.armed
            && status.motion_enabled == Some(true) && status.motion_homed == Some(true)
            && status.limp != Some(true) && status.fallen != Some(true)
            && status.rest_phase == Some(proto::RestPhase::Idle)
            && matches!(status.policy.as_deref(), Some("walk" | "stand"))
            && self.mode != MotionMode::BodyPose && self.maze.is_none()
            && !self.head_tracking_started && !self.coordinated_tracking_started
            && let Some(axes) = self.input.head_stick
            && (axes != [0.0; 2] || other_head_axes.iter().all(|axis| axis.abs() < 0.05))
        {
            Some(axes)
        } else {
            None
        }
    }
    pub fn center_head(&mut self, status: &BrowserStatus, now: Instant) -> bool {
        if self.head_stick_input(status, now) == Some([0.0; 2])
            && fresh_head_position(status, now).is_some()
        {
            self.head_stick.center();
            true
        } else {
            false
        }
    }
    pub fn update_head_stick(&mut self, status: &BrowserStatus, now: Instant) {
        if let Some(axes) = self.head_stick_input(status, now) {
            self.head_stick.update(axes, fresh_head_position(status, now), now);
        } else {
            self.head_stick = HeadStick::default();
        }
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
            if self.owner.is_some() {
                calls.extend(self.set_mode(MotionMode::Drive));
            }
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
        (calls, actions)
    }
}

fn fresh_head_position(status: &BrowserStatus, now: Instant) -> Option<[u16; 2]> {
    status.head_positions.filter(|_| status.head_positions_at
        .is_some_and(|at| now.saturating_duration_since(at) <= HEAD_FEEDBACK_TTL))
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    #[test]
    fn inactive_manual_input_keeps_autonomous_ownership_until_disconnect() {
        let now = Instant::now();
        let mut control = ControlState {
            owner: Some(1),
            human_held: true,
            connected: true,
            armed: true,
            coordinated_tracking_started: true,
            last_input: Some(now),
            ..Default::default()
        };
        control.receive(Input::default(), false, now);
        let later = now + Duration::from_secs(10);
        assert!(!control.fresh(later));
        assert!(!control.armed);
        assert!(control.autonomous_active());
        assert!(!control.release_due(later));
        control.lose_human_control();
        assert!(!control.autonomous_active());
        assert!(!control.human_held);
    }

    #[test]
    fn neutral_peers_share_the_connection_and_keep_their_modes() {
        let now = Instant::now();
        let mut control = ControlState { connected: true, ..Default::default() };
        for (id, client) in [(1, ControlClient::Web), (2, ControlClient::App)] {
            let mut peer = ControlPeer::new(client, id.to_string());
            peer.receive(true, Input::default(), now);
            control.peers.insert(id, peer);
        }
        assert!(control.view_for(Some(1), now).armed);
        assert!(control.view_for(Some(2), now).armed);
        assert!(control.owner.is_none());

        assert_eq!(control.claim(1, now), Ok(true));
        control.human_held = true;
        control.human_acquiring = false;
        control.human_owner = Some(proto::HumanControlSource::Web);
        control.set_mode(MotionMode::HeadDrive);
        assert!(control.claim(2, now).is_err());
        assert_eq!(control.view_for(Some(2), now).control_owner, Some(ControlOwner::Web));
        assert!(!control.view_for(Some(2), now).control_owned);
        assert_eq!(control.view_for(Some(2), now).mode, MotionMode::Drive);

        let idle = now + CONTROL_IDLE_RELEASE;
        for peer in control.peers.values_mut() {
            peer.receive(true, Input::default(), idle);
        }
        control.receive(Input::default(), true, idle);
        control.coordinated_tracking_started = true;
        assert!(!control.release_due(idle));
        control.coordinated_tracking_started = false;
        assert!(control.release_due(idle));
        control.finish_idle_release(idle);
        assert_eq!(control.claim(2, idle), Ok(true));
        assert_eq!(control.mode, MotionMode::Drive);
        assert_eq!(control.view_for(Some(1), idle).mode, MotionMode::HeadDrive);
    }
}

#[cfg(test)]
mod head_stick_tests {
    use super::*;

    #[test]
    fn increments_from_feedback_at_five_millisecond_intervals() {
        let mut stick = HeadStick::default();
        let at = Instant::now();
        stick.update([0.0, 1.0], Some([1820, 2048]), at);
        assert_eq!(stick.raw_position(), Some([1830, 2048]));
        stick.update([0.0, 0.25], Some([1830, 2050]), at + Duration::from_millis(20));
        assert_eq!(stick.raw_position(), Some([1840, 2048]));
        stick.update([0.0, 0.0], Some([1820, 2060]), at + Duration::from_millis(40));
        assert_eq!(stick.raw_position(), Some([1840, 2048]));
        stick.update([-0.04, 0.0], Some([1820, 2090]), at + Duration::from_millis(100));
        assert_eq!(stick.raw_position(), Some([1840, 2048]));
        stick.update([-0.04, 0.0], Some([1820, 2090]), at + Duration::from_millis(105));
        assert_eq!(stick.raw_position(), Some([1840, 2047]));
        assert!(!Input { head_stick: Some([0.4, 0.8]), ..Input::default() }.valid());
    }

    #[test]
    fn pitch_and_yaw_cap_at_each_limit_and_can_move_back() {
        let at = Instant::now();
        for (axes, measured, limit, reversed) in [
            ([0.0, 1.0], [2298, 2048], [2300, 2048], [2280, 2048]),
            ([0.0, -1.0], [1102, 2048], [1100, 2048], [1120, 2048]),
            ([1.0, 0.0], [1820, 3070], [1820, 3072], [1820, 3052]),
            ([-1.0, 0.0], [1820, 1026], [1820, 1024], [1820, 1044]),
        ] {
            let mut stick = HeadStick::default();
            stick.update(axes, Some(measured), at);
            stick.update(axes, Some(measured), at + Duration::from_millis(20));
            assert_eq!(stick.raw_position(), Some(limit));
            stick.update(axes.map(|axis| -0.5 * axis), Some(limit), at + Duration::from_millis(40));
            assert_eq!(stick.raw_position(), Some(reversed));
        }
    }

    #[test]
    fn released_head_stick_keeps_its_target_when_servo_feedback_is_delayed() {
        let at = Instant::now();
        let mut control = ControlState {
            owner: Some(1),
            active: true,
            armed: true,
            human_held: true,
            last_input: Some(at),
            ..ControlState::default()
        };
        let mut status = BrowserStatus {
            motion_enabled: Some(true),
            motion_homed: Some(true),
            rest_phase: Some(proto::RestPhase::Idle),
            policy: Some("walk".into()),
            head_positions: Some([1820, 2200]),
            head_positions_at: Some(at),
            ..BrowserStatus::default()
        };
        control.input.head_stick = Some([1.0, 0.0]);
        control.update_head_stick(&status, at);

        let later = at + HEAD_FEEDBACK_TTL + CONTROL_PERIOD;
        control.input.head_stick = Some([0.0; 2]);
        control.last_input = Some(later);
        control.update_head_stick(&status, later);
        assert!(control_frame(&control, later).iter().any(|call| matches!(
            call, proto::Call::RobotHead(head) if head.raw_position == Some([1820, 2210])
        )));

        control.input.head_stick = Some([1.0, 0.0]);
        control.update_head_stick(&status, later + CONTROL_PERIOD);
        assert_eq!(control.head_stick.raw_position(), Some([1820, 2210]));

        let resumed = later + CONTROL_PERIOD * 2;
        status.head_positions_at = Some(resumed);
        control.update_head_stick(&status, resumed);
        assert_eq!(control.head_stick.raw_position(), Some([1820, 2220]));

        control.lose_human_control();
        assert_eq!(control.head_stick.raw_position(), None);
    }

    #[test]
    fn center_head_replaces_the_held_target_and_requires_manual_control() {
        let now = Instant::now();
        let mut control = ControlState {
            owner: Some(1),
            active: true,
            armed: true,
            human_held: true,
            last_input: Some(now),
            ..ControlState::default()
        };
        let status = BrowserStatus {
            motion_enabled: Some(true),
            motion_homed: Some(true),
            rest_phase: Some(proto::RestPhase::Idle),
            policy: Some("walk".into()),
            head_positions: Some([2270, 2100]),
            head_positions_at: Some(now),
            ..BrowserStatus::default()
        };

        control.input.head_stick = Some([1.0, 0.0]);
        control.update_head_stick(&status, now);
        assert!(!control.center_head(&status, now));
        control.input.head_stick = Some([0.0; 2]);
        assert!(control.center_head(&status, now));
        control.update_head_stick(&status, now);
        assert!(control_frame(&control, now).iter().any(|call| matches!(
            call, proto::Call::RobotHead(head) if head.raw_position == Some([1820, 2048])
        )));
        control.human_held = false;
        assert!(!control.center_head(&status, now));
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
        let lateral_speed = control.linear_speed.min(MAX_LATERAL);
        proto::Call::RobotMove(proto::MoveParams {
            vx: PadDriveParams::scale(
                forward,
                drive.vx_min.max(-control.linear_speed),
                drive.vx_max.min(control.linear_speed),
            ),
            vy: PadDriveParams::scale(
                -sideways,
                drive.vy_min.max(-lateral_speed),
                drive.vy_max.min(lateral_speed),
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
                ..Default::default()
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
    if input.head_stick.is_some() && let Some(raw_position) = control.head_stick.raw_position() {
        if let Some(proto::Call::RobotHead(head)) = calls.iter_mut()
            .find(|call| matches!(call, proto::Call::RobotHead(_)))
        {
            head.raw_position = Some(raw_position);
        } else {
            calls.push(proto::Call::RobotHead(proto::HeadParams {
                raw_position: Some(raw_position),
                ..Default::default()
            }));
        }
    }
    calls.push(proto::Call::RobotMouth(proto::MouthParams {
        open: input.left_trigger.max(input.right_trigger),
    }));
    calls
}
