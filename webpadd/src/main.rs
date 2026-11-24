//! `webpadd` is the lightweight LAN browser control surface.
//!
//! It is intentionally only an intent client: the browser can send normalized sticks and a small
//! allowlist of actions, while `robotd` remains the only process that owns hardware and policy
//! state.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{RawQuery, State, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use clap::Parser;
use duck_ipc_proto as proto;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot, watch};
use tokio::time::{MissedTickBehavior, timeout};

mod commands;
mod browser_session;
mod telemetry;
mod control;
mod ipc;
mod audio;
mod audio_record;
mod voice;
mod frame_prefetch;
mod color_detection;
mod object_detection;
mod person_models;
mod vision_relay;
mod vision_record;
mod settings;
use commands::*;
use telemetry::*;
use control::*;
use ipc::*;

const PAGE: &str = include_str!("../web/index.html");
const CONTROL_PERIOD: Duration = Duration::from_millis(20);
const INPUT_TTL: Duration = Duration::from_millis(150);
const CONTROL_IDLE_RELEASE: Duration = Duration::from_millis(250);
const ACTION_TIMEOUT: Duration = Duration::from_secs(1);
const BROWSER_SEND_TIMEOUT: Duration = Duration::from_secs(2);
const BROWSER_PING_INTERVAL: Duration = Duration::from_millis(500);
const BROWSER_PONG_TIMEOUT: Duration = Duration::from_secs(5);
const BROWSER_HOLD_PONG_TIMEOUT: Duration = Duration::from_millis(1500);
const REARM_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY: Duration = Duration::from_secs(1);
const HEALTH_PERIOD: Duration = Duration::from_secs(1);
const STATUS_STREAM_HZ: u32 = 10;
const OBSTACLE_PERIOD: Duration = Duration::from_millis(200);
const LEASE_PERIOD: Duration = Duration::from_millis(100);
const MIN_LINEAR_SPEED: f64 = 0.0;
const MAX_LINEAR: f64 = 0.30;
const MAX_LATERAL: f64 = 0.25;
const MAX_ANGULAR: f64 = 1.0;
const MAX_HEAD: f64 = 2.5;
const BODY_MAX_Z_UP: f64 = 0.010;
const BODY_MAX_Z_DOWN: f64 = 0.025;
const BODY_MAX_ANGLE: f64 = 0.2618;

fn studio_source_revision(marker: &str) -> Option<String> {
    let data: serde_json::Value = serde_json::from_str(marker).ok()?;
    if data.get("install_status")?.as_str()? != "installed" {
        return None;
    }
    let revision = data.get("studio_revision")?.as_str()?;
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    Some(revision.to_owned())
}

#[derive(Parser, Debug)]
#[command(
    name = "webpadd",
    about = "Drive the robot from a LAN browser",
    version
)]
struct Args {
    /// Address on which to serve the browser page and its control websocket.
    #[arg(long, default_value = "0.0.0.0:8081")]
    listen: SocketAddr,

    /// `robotd`'s Unix socket.
    #[arg(long, default_value = proto::socket::ROBOT)]
    socket: PathBuf,

    /// Classic button bindings and drive ranges.
    #[arg(long, default_value = "/etc/robot/robotd.toml")]
    config: PathBuf,

    /// Port of the local media signalling server.
    #[arg(long, default_value_t = 8443, value_parser = clap::value_parser!(u16).range(1..))]
    media_port: u16,
}

#[derive(Clone)]
struct AppState {
    socket: PathBuf,
    control: Arc<Mutex<ControlState>>,
    commands: mpsc::Sender<RobotCommand>,
    status: watch::Receiver<BrowserStatus>,
    obstacle_lock: Arc<Mutex<()>>,
    low_voltage_lock: Arc<Mutex<()>>,
    audio: Arc<Mutex<audio::AudioVolume>>,
    voice: Arc<voice::VoicePlayer>,
    recorder: Arc<audio_record::Recorder>,
    next_session: Arc<AtomicU64>,
    views: watch::Receiver<ControlsView>,
    feedback: broadcast::Sender<(u64, ServerMessage)>,
    objects: object_detection::Detectors,
    colors: Arc<color_detection::ColorRuntime>,
    settings: Arc<Mutex<settings::Store>>,
    color_presets: Arc<Mutex<settings::ColorStore>>,
    head_settings: Arc<Mutex<settings::HeadStore>>,
    coordinated_settings: Arc<Mutex<settings::CoordinatedStore>>,
    tracking_phases: Arc<Mutex<settings::TrackingPhaseStore>>,
    person_coordinated_settings: Arc<Mutex<settings::CoordinatedStore>>,
    person_tracking_phases: Arc<Mutex<settings::TrackingPhaseStore>>,
    pickup_after_settings: Arc<Mutex<settings::CoordinatedStore>>,
    pickup_after_phases: Arc<Mutex<settings::TrackingPhaseStore>>,
    mouth_settings: Arc<Mutex<settings::MouthStore>>,
    mouth_sound_directory: PathBuf,
}

/// The small status snapshot sent to a browser. The full `robot.state` contains joint and
/// kinematic arrays that are useful to specialized tools but unnecessary on a control page.
#[derive(Debug, Clone, Default, Serialize)]
struct BrowserStatus {
    robotd_connected: bool,
    #[serde(skip)]
    head_feedback: Option<(u16, u16)>,
    #[serde(skip)]
    head_feedback_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    head_positions: Option<[u16; 2]>,
    #[serde(skip)]
    head_positions_at: Option<Instant>,
    skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_skill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_skill_timeout: Option<proto::SkillTimeout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    healthy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_degraded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_volts: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    battery_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_id: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motor_temp_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_temp_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    robot_mode: Option<String>,
    #[serde(skip)]
    last_robot_mode: Option<String>,
    #[serde(skip)]
    mode_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rest_phase: Option<proto::RestPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motion_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    motion_homed: Option<bool>,
    power_status_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tracking_phase: Option<proto::CoordinatedTrackingPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pickup_stage: Option<proto::PickupStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_unavailable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loop_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loop_missed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_loop_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    health_loop_missed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bus_read_timeouts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imu_gyro: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imu_quat: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    limp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_velocity: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tof_distance_mm: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tof_sensor_status: Option<proto::DistanceSensorStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    obstacle_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    low_voltage: Option<proto::LowVoltageParams>,
}

impl BrowserStatus {
    fn uses_roller(&self) -> bool {
        self.last_robot_mode.as_deref() == Some("roller")
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    StudioLeaveResult {
        request_id: u64,
        accepted: bool,
        reason: Option<String>,
    },
    Lease {
        vision_token: String,
        controls: ControlsView,
        settings: Option<settings::Settings>,
        defaults: settings::Settings,
        head_settings: settings::HeadTrackingSettings,
        head_defaults: settings::HeadTrackingSettings,
        head_home_pitch_raw: u16,
        coordinated_settings: settings::CoordinatedTrackingSettings,
        coordinated_defaults: settings::CoordinatedTrackingSettings,
        tracking_phases: settings::TrackingPhaseSettings,
        tracking_phase_defaults: settings::TrackingPhaseSettings,
        person_coordinated_settings: settings::CoordinatedTrackingSettings,
        person_coordinated_defaults: settings::CoordinatedTrackingSettings,
        person_tracking_phases: settings::TrackingPhaseSettings,
        person_tracking_phase_defaults: settings::TrackingPhaseSettings,
        pickup_after_settings: settings::CoordinatedTrackingSettings,
        pickup_after_phases: settings::TrackingPhaseSettings,
        color_presets: std::collections::BTreeMap<String, settings::ColorPreset>,
        mouth_sound: String,
        mouth_sound_default: String,
        mouth_sound_clips: Vec<String>,
    },
    SettingsResult {
        request_id: u64,
        accepted: bool,
        reason: Option<String>,
    },
    Controls {
        controls: ControlsView,
    },
    Status {
        status: BrowserStatus,
    },
    ObstacleSettings {
        settings: proto::ObstacleParams,
    },
    MotionTrackingResult {
        action: proto::MotionTrackingAction,
        accepted: bool,
        reason: Option<String>,
    },
    HeadPositionResult {
        action: proto::MotionTrackingAction,
        accepted: bool,
        reason: Option<String>,
    },
    HeadTrackingResult {
        action: proto::MotionTrackingAction,
        accepted: bool,
        reason: Option<String>,
    },
    CoordinatedTrackingResult {
        action: proto::MotionTrackingAction,
        accepted: bool,
        reason: Option<String>,
    },
    MazeResult {
        action: proto::MotionTrackingAction,
        accepted: bool,
        reason: Option<String>,
    },
    ActionResult {
        name: Action,
        accepted: bool,
        reason: Option<String>,
    },
    Error {
        message: String,
    },
}

enum SettingsSave {
    Page(u64, settings::Settings),
    Head(u64, settings::HeadTrackingSettings),
    Coordinated(u64, settings::TrackingScope, settings::CoordinatedTrackingSettings),
    Phases(u64, settings::TrackingScope, settings::TrackingPhaseSettings),
    Mouth(u64, String),
    Color(u64, String, settings::ColorPreset),
    DeleteColor(u64, String),
}

enum RobotCommand {
    VisionUpdate {
        session: u64,
        binding: u64,
        generation: u64,
    },
    Notify {
        calls: Vec<proto::Call>,
        generation: Option<u64>,
        created: Instant,
    },
    Request {
        calls: Vec<proto::Call>,
        sit_on_loss: bool,
        generation: Option<u64>,
        created: Instant,
        reply: oneshot::Sender<Result<proto::IntentResult, String>>,
    },
    ManualStart {
        session: u64,
        generation: u64,
        calls: Vec<proto::Call>,
        created: Instant,
        reply: oneshot::Sender<Result<proto::IntentResult, String>>,
    },
    Lease {
        session: u64,
        generation: u64,
        action: proto::HumanControlAction,
        reply: oneshot::Sender<Result<HumanControlResult, String>>,
    },
}

#[derive(Clone)]
struct RealtimeFrame {
    calls: Vec<proto::Call>,
    generation: u64,
    created: Instant,
}

type HumanControlResult = proto::HumanControlResult;

type RobotConnection = (BufReader<OwnedReadHalf>, OwnedWriteHalf);

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    duck_ipc_proto::log_startup_identity!("webpadd");

    let listener = match tokio::net::TcpListener::bind(args.listen).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(address = %args.listen, error = %error, "cannot listen for browser control");
            return ExitCode::FAILURE;
        }
    };
    let (commands, command_rx) = mpsc::channel(128);
    let (status_tx, status_rx) = watch::channel(BrowserStatus::default());
    let params = match robotd_params::Params::load(&args.config, false) {
        Ok(params) => params,
        Err(error) => {
            tracing::error!(%error, "invalid controller configuration");
            return ExitCode::FAILURE;
        }
    };
    let mut control = ControlState::default();
    let audio = audio::AudioVolume::new(&params.audio.device);
    let settings = match settings::Store::load(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load saved browser settings");
            return ExitCode::FAILURE;
        }
    };
    let color_presets = match settings::ColorStore::load(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load saved colors");
            return ExitCode::FAILURE;
        }
    };
    let head_settings = match settings::HeadStore::load(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load head tracking settings");
            return ExitCode::FAILURE;
        }
    };
    let coordinated_settings = match settings::CoordinatedStore::load(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load coordinated tracking settings");
            return ExitCode::FAILURE;
        }
    };
    let tracking_phases = match settings::TrackingPhaseStore::load(&args.config, coordinated_settings.value.body_gains) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load tracking phase settings");
            return ExitCode::FAILURE;
        }
    };
    let person_coordinated_settings = match settings::CoordinatedStore::load_person(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load person following settings");
            return ExitCode::FAILURE;
        }
    };
    let person_tracking_phases = match settings::TrackingPhaseStore::load_person(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load person following speed settings");
            return ExitCode::FAILURE;
        }
    };
    let (pickup_after_settings, pickup_after_phases) = match settings::CoordinatedStore::load_pickup_after(&args.config)
        .and_then(|settings| settings::TrackingPhaseStore::load_pickup_after(&args.config)
            .map(|phases| (settings, phases)))
    {
        Ok(stores) => stores,
        Err(error) => {
            tracing::error!(%error, "cannot load pickup after-action settings");
            return ExitCode::FAILURE;
        }
    };
    let mouth_settings = match settings::MouthStore::load(&args.config) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!(%error, "cannot load mouth sound setting");
            return ExitCode::FAILURE;
        }
    };
    control.mouth_sound = mouth_settings.value.clone();
    if let Some(saved) = settings.value.as_ref() {
        control.linear_speed = saved.linear_speed;
        control.turn_speed = saved.turn_speed;
    }
    control.drive = params.pad_drive;
    let (view_tx, views) = watch::channel(control.view_for(None, Instant::now()));
    let (feedback, _) = broadcast::channel(32);
    let (connected_tx, connected_rx) = watch::channel(false);
    let objects = object_detection::Detectors::new(
        std::env::var_os("WONDERDUCK_PERSON_VISION_RECORD").map(PathBuf::from));
    control.person_vision_record = objects.recorder();
    let colors = Arc::new(color_detection::ColorRuntime::new(
        std::env::var_os("WONDERDUCK_TARGET_VISION_RECORD").map(PathBuf::from)));
    control.target_vision_record = colors.recorder();
    let voice = Arc::new(voice::VoicePlayer::new(params.audio.device.clone(), params.audio.player.clone()));
    let recording_dir = audio_record::recording_directory();
    let recorder = Arc::new(audio_record::Recorder::new(params.audio.capture_device(), Arc::clone(&voice), recording_dir));
    let state = AppState {
        socket: args.socket.clone(),
        control: Arc::new(Mutex::new(control)),
        commands: commands.clone(),
        status: status_rx,
        obstacle_lock: Arc::new(Mutex::new(())),
        low_voltage_lock: Arc::new(Mutex::new(())),
        audio: Arc::new(Mutex::new(audio)),
        voice,
        recorder,
        next_session: Arc::new(AtomicU64::new(1)),
        views,
        feedback,
        objects,
        colors,
        settings: Arc::new(Mutex::new(settings)),
        color_presets: Arc::new(Mutex::new(color_presets)),
        head_settings: Arc::new(Mutex::new(head_settings)),
        coordinated_settings: Arc::new(Mutex::new(coordinated_settings)),
        tracking_phases: Arc::new(Mutex::new(tracking_phases)),
        person_coordinated_settings: Arc::new(Mutex::new(person_coordinated_settings)),
        person_tracking_phases: Arc::new(Mutex::new(person_tracking_phases)),
        pickup_after_settings: Arc::new(Mutex::new(pickup_after_settings)),
        pickup_after_phases: Arc::new(Mutex::new(pickup_after_phases)),
        mouth_settings: Arc::new(Mutex::new(mouth_settings)),
        mouth_sound_directory: PathBuf::from(proto::SOUND_CLIPS_DIR),
    };

    let (frames, latest_frame) = watch::channel(None);
    tokio::spawn(robotd_worker(
        args.socket.clone(),
        command_rx,
        latest_frame,
        connected_tx,
        state.control.clone(),
        state.settings.clone(),
        state.feedback.clone(),
    ));
    tokio::spawn(control_loop(state.clone(), connected_rx, view_tx, frames));
    tokio::spawn(config_worker(args.config, state.control.clone()));
    tokio::spawn(status_stream_worker(args.socket.clone(), status_tx.clone()));
    tokio::spawn(policy_status_worker(args.socket.clone(), status_tx.clone()));
    tokio::spawn(obstacle_status_worker(
        args.socket.clone(),
        status_tx.clone(),
        state.control.clone(),
        state.obstacle_lock.clone(),
    ));
    tokio::spawn(low_voltage_status_worker(args.socket.clone(), status_tx.clone(), state.low_voltage_lock.clone()));
    tokio::spawn(health_worker(args.socket, status_tx));

    tracing::info!(address = %args.listen, "serving LAN browser control");
    let server = axum::serve(listener, router(state, args.media_port))
        .with_graceful_shutdown(shutdown_signal());
    match server.await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(error = %error, "browser listener stopped");
            ExitCode::FAILURE
        }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("interrupt received; browser control stopped");
}

async fn camera_metadata() -> Result<axum::Json<serde_json::Value>, axum::http::StatusCode> {
    tokio::task::spawn_blocking(|| {
        let path = frame_prefetch::media_socket()?;
        frame_prefetch::FrameClient::connect(&path)?.video()
    })
    .await
    .ok()
    .and_then(Result::ok)
    .map(axum::Json)
    .ok_or(axum::http::StatusCode::SERVICE_UNAVAILABLE)
}

fn router(state: AppState, media_port: u16) -> Router {
    Router::new()
        .route("/health", get(browser_control_health))
        .route(
            "/",
            get(move || async move {
                Html(PAGE.replace("{{MEDIA_PORT}}", &media_port.to_string())
                    .replace("{{APP_VERSION}}", env!("CARGO_PKG_VERSION")))
            }),
        )
        .route("/control", get(control_upgrade))
        .route("/objects", get(object_detection::upgrade))
        .route("/object-models", get(object_detection::available_models))
        .route("/colors", get(color_detection::upgrade))
        .route("/camera-metadata", get(camera_metadata))
        .route("/console.css", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")], include_str!("../web/console.css")) }))
        .route("/console.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/console.js")) }))
        .route("/control-session.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/control-session.js")) }))
        .route("/control-pages.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/control-pages.js")) }))
        .route("/motion-input.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/motion-input.js")) }))
        .route("/language.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/language.js")) }))
        .route("/action-library.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/action-library.js")) }))
        .route("/licenses/agpl-3.0.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../../LICENSE")) }))
        .route("/licenses/apache-2.0.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/apache-2.0.txt")) }))
        .route("/licenses/source-info", get(|| async {
            let revision = std::fs::read_to_string(".runtime-release.json")
                .ok()
                .and_then(|marker| studio_source_revision(&marker));
            axum::Json(serde_json::json!({ "revision": revision }))
        }))
        .route("/licenses/three.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/three.txt")) }))
        .route("/licenses/lucide.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/lucide.txt")) }))
        .route("/licenses/onnxruntime.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/onnxruntime.txt")) }))
        .route("/licenses/lgpl-3.0.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/lgpl.txt")) }))
        .route("/licenses/gpl-3.0.txt", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], include_str!("../web/licenses/gpl.txt")) }))
        .route("/theme.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/theme.js")) }))
        .route("/objects.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/objects.js")) }))
        .route("/audio-volume", get(audio::get_volume).put(audio::set_volume))
        .route("/audio-recording", get(audio_record::get).delete(audio_record::delete))
        .route("/audio-recording/start", axum::routing::post(audio_record::start))
        .route("/audio-recording/stop", axum::routing::post(audio_record::stop))
        .route("/voice-message", axum::routing::post(voice::post_message).layer(axum::extract::DefaultBodyLimit::disable()))
        .route("/voice.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/voice.js")) }))
        .route(
            "/controls.js",
            get(|| async {
                (
                    [(
                        axum::http::header::CONTENT_TYPE,
                        "text/javascript; charset=utf-8",
                    )],
                    include_str!("../web/controls.js"),
                )
            }),
        )
        .route(
            "/video.js",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../web/video.js"),
                )
            }),
        )
        .route(
            "/color-picker.js",
            get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../web/color-picker.js"),
                )
            }),
        )
        .with_state(state)
}

async fn browser_control_health(State(state): State<AppState>) -> impl IntoResponse {
    let connected = state.control.lock().await.connected;
    let status = state.status.borrow();
    let ready = connected && status.robotd_connected && status.motion_enabled.is_some();
    let code = if ready { axum::http::StatusCode::OK } else { axum::http::StatusCode::SERVICE_UNAVAILABLE };
    (code, axum::Json(serde_json::json!({
        "ready": ready,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

async fn control_upgrade(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> impl IntoResponse {
    let client = query.as_deref().unwrap_or_default().split('&').find_map(|part| match part {
        "client=app" => Some(ControlClient::App),
        "client=web" => Some(ControlClient::Web),
        _ => None,
    }).unwrap_or_else(|| {
        if headers.get("sec-fetch-mode").is_some_and(|mode| mode == "websocket") {
            ControlClient::Web
        } else {
            ControlClient::Unknown
        }
    });
    upgrade.on_upgrade(move |socket| control_session(socket, state, client))
}

async fn control_session(mut socket: WebSocket, state: AppState, client: ControlClient) {
    let session = state.next_session.fetch_add(1, Ordering::Relaxed);
    let vision_token = match vision_relay::new_token() {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(%error, "cannot create vision session token");
            let _ = send_message(&mut socket, &ServerMessage::Error { message: "无法建立识别控制会话".into() }).await;
            return;
        }
    };
    let mut status_rx = state.status.clone();
    let mut views = state.views.clone();
    views.borrow_and_update();
    let feedback = state.feedback.subscribe();
    let directory = state.mouth_sound_directory.clone();
    let clips_result = tokio::task::spawn_blocking(move || settings::list_mouth_sounds(&directory)).await;
    let (mouth_sound_clips, clips_error) = match clips_result {
        Ok(Ok(clips)) => (clips, None),
        Ok(Err(error)) => (Vec::new(), Some(error)),
        Err(error) => (Vec::new(), Some(format!("读取音频目录任务失败：{error}"))),
    };
    let settings_guard = state.settings.lock().await;
    let settings = settings_guard.value.clone();
    let head_settings = state.head_settings.lock().await.value.clone();
    let coordinated_settings = state.coordinated_settings.lock().await.value.clone();
    let tracking_phases = state.tracking_phases.lock().await.value.clone();
    let person_coordinated_settings = state.person_coordinated_settings.lock().await.value.clone();
    let person_tracking_phases = state.person_tracking_phases.lock().await.value.clone();
    let pickup_after_settings = state.pickup_after_settings.lock().await.value.clone();
    let pickup_after_phases = state.pickup_after_phases.lock().await.value.clone();
    let color_presets = state.color_presets.lock().await.value.clone();
    let mouth_sound = state.mouth_settings.lock().await.value.clone();
    let controls = {
        let mut control = state.control.lock().await;
        control.peers.insert(session, ControlPeer::new(client, vision_token.clone()));
        control.view_for(Some(session), Instant::now())
    };
    drop(settings_guard);

    if send_message(&mut socket, &ServerMessage::Lease {
        vision_token, controls, settings, defaults: settings::Settings::default(), head_settings,
        head_defaults: settings::HeadTrackingSettings::default(),
        head_home_pitch_raw: duck_control::hx::PHYSICAL_HOME_ENCODER_TARGETS[6],
        coordinated_settings, coordinated_defaults: settings::CoordinatedTrackingSettings::default(),
        tracking_phases, tracking_phase_defaults: settings::TrackingPhaseSettings::default(), color_presets,
        person_coordinated_settings, person_coordinated_defaults: settings::CoordinatedTrackingSettings::person_defaults(),
        person_tracking_phases, person_tracking_phase_defaults: settings::TrackingPhaseSettings::person_defaults(),
        pickup_after_settings, pickup_after_phases,
        mouth_sound, mouth_sound_default: String::new(), mouth_sound_clips,
    })
        .await
        .is_err()
    {
        release_session(session, &state).await;
        return;
    }

    if let Some(message) = clips_error {
        tracing::error!(%message, "cannot list mouth sounds");
        if send_message(&mut socket, &ServerMessage::Error { message }).await.is_err() {
            release_session(session, &state).await;
            return;
        }
    }

    let initial_status = { status_rx.borrow_and_update().clone() };
    if send_message(
        &mut socket,
        &ServerMessage::Status {
            status: initial_status,
        },
    )
    .await
    .is_err()
    {
        release_session(session, &state).await;
        return;
    }

    browser_session::serve(socket, session, &state, status_rx, views, feedback).await;
}

async fn send_message(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let text = match serde_json::to_string(message) {
        Ok(text) => text,
        Err(error) => {
            tracing::error!(error = %error, "could not encode browser response");
            return Err(());
        }
    };
    send_frame(socket, Message::Text(text.into())).await
}

async fn send_frame(socket: &mut WebSocket, message: Message) -> Result<(), ()> {
    match timeout(BROWSER_SEND_TIMEOUT, socket.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => {
            tracing::debug!(%error, "browser connection send failed");
            Err(())
        }
        Err(_) => {
            tracing::warn!("browser connection send timed out");
            Err(())
        }
    }
}

async fn control_loop(
    state: AppState,
    connected: watch::Receiver<bool>,
    views: watch::Sender<ControlsView>,
    frames: watch::Sender<Option<RealtimeFrame>>,
) {
    let (queued_actions, actions) = mpsc::channel(8);
    tokio::spawn(run_input_actions(state.clone(), actions));
    let mut ticker = tokio::time::interval(CONTROL_PERIOD);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut release_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut release_checked: Option<Instant> = None;
    let mut previous_owner = None;
    loop {
        ticker.tick().await;
        if release_task.as_ref().is_some_and(|task| task.is_finished()) {
            release_task = None;
        }
        let (actions, generation, owner, release) = {
            let mut control = state.control.lock().await;
            control.roller = state.status.borrow().uses_roller();
            let now = Instant::now();
            control.update_head_stick(&state.status.borrow(), now);
            let (mut calls, actions) = control.tick(now, *connected.borrow());
            let manual = control.human_held && !control.autonomous_deactivated
                && !control.maze_active && !control.motion_tracking_active
                && !control.coordinated_tracking_started;
            if !manual {
                calls.clear();
            }
            let readiness_changed = control.update_peer_readiness(now);
            let owner_changed = previous_owner != control.owner;
            if owner_changed {
                release_checked = None;
                previous_owner = control.owner;
            }
            let view = control.view_for(control.owner, now);
            views.send_if_modified(|previous| {
                if !readiness_changed && !owner_changed && *previous == view {
                    return false;
                }
                *previous = view;
                true
            });
            enqueue_notifications(&state.commands, calls, Some(control.human_generation));
            let frame = manual.then(|| RealtimeFrame {
                calls: control_frame(&control, now),
                generation: control.human_generation,
                created: control.last_input.filter(|_| control.fresh(now) && control.armed)
                    .unwrap_or(now),
            });
            // The IPC worker gets the current frame after any slow request. Earlier
            // motion frames do not accumulate in the discrete-command queue.
            if let Some(frame) = frame {
                frames.send_replace(Some(frame));
            } else {
                frames.send_if_modified(|frame| frame.take().is_some());
            }
            let release = if release_task.is_none()
                && let Some(reason) = control.autonomous_stop_reason(now)
            {
                tracing::info!(session = ?control.owner, reason, "autonomous control stopped");
                control.owner_closing = true;
                Some(proto::HumanControlAction::Abandon)
            } else if release_task.is_none() && control.release_due(now)
                && release_checked.is_none_or(|at| now.saturating_duration_since(at) >= LEASE_PERIOD)
            {
                release_checked = Some(now);
                Some(proto::HumanControlAction::Release)
            } else {
                None
            };
            (
                if manual { actions } else { vec![] },
                control.human_generation,
                control.owner,
                release,
            )
        };
        for action in actions {
            if queued_actions.try_send((owner, generation, action, Instant::now())).is_err() {
                tracing::warn!(?action, "browser button action queue is full");
            }
        }
        if let Some(action) = release {
            let state = state.clone();
            release_task = Some(tokio::spawn(async move {
                let Some(owner) = owner else { return; };
                let result = lease_request(&state, owner, generation, action).await;
                if result.is_err() || action == proto::HumanControlAction::Abandon {
                    if let Err(error) = result {
                        tracing::warn!(%error, "human-control release failed");
                    }
                    let mut control = state.control.lock().await;
                    if control.human_generation == generation && control.owner == Some(owner) {
                        control.lose_human_control();
                    }
                }
            }));
        }
    }
}

async fn run_input_actions(
    state: AppState,
    mut actions: mpsc::Receiver<(Option<u64>, u64, Action, Instant)>,
) {
    while let Some((owner, generation, action, received)) = actions.recv().await {
        {
            let mut control = state.control.lock().await;
            if received.elapsed() > INPUT_TTL || control.owner != owner
                || control.human_generation != generation || !control.human_held
            {
                continue;
            }
            control.human_actions += 1;
        }
        let result = perform_action(action, generation, &state).await;
        state.control.lock().await.human_actions -= 1;
        if let Some(session) = owner {
            let _ = state.feedback.send((session, result));
        }
    }
}

fn enqueue_notifications(
    commands: &mpsc::Sender<RobotCommand>,
    calls: Vec<proto::Call>,
    generation: Option<u64>,
) {
    if calls.is_empty() {
        return;
    }
    if commands
        .try_send(RobotCommand::Notify {
            calls,
            generation,
            created: Instant::now(),
        })
        .is_err()
    {
        tracing::debug!("dropped browser control frame: command queue full");
    }
}

async fn config_worker(path: PathBuf, control: Arc<Mutex<ControlState>>) {
    let mut modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    loop {
        tokio::time::sleep(HEALTH_PERIOD).await;
        let current = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if current == modified {
            continue;
        }
        modified = current;
        match robotd_params::Params::load(&path, true) {
            Ok(params) => {
                let mut control = control.lock().await;
                control.drive = params.pad_drive;
            }
            Err(error) => {
                tracing::error!(%error, "controller config reload rejected; previous validated config remains active")
            }
        }
    }
}

#[cfg(test)]
mod license_tests {
    use super::studio_source_revision;

    #[test]
    fn source_link_uses_only_a_complete_installed_revision() {
        let revision = "1234567890abcdef1234567890abcdef12345678";
        let installed = format!(r#"{{"install_status":"installed","studio_revision":"{revision}"}}"#);
        assert_eq!(studio_source_revision(&installed).as_deref(), Some(revision));
        assert_eq!(studio_source_revision(&installed.replace("installed", "installing")), None);
        assert_eq!(studio_source_revision(&installed.replace(revision, "../../bad")), None);
        assert_eq!(studio_source_revision("not json"), None);
    }
}
