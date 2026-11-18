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
use axum::extract::{State, WebSocketUpgrade};
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
mod telemetry;
mod control;
mod ipc;
mod audio;
mod audio_record;
mod voice;
mod frame_prefetch;
mod color_detection;
mod object_detection;
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
const MAX_LINEAR: f64 = 0.4;
const MAX_LINEAR_BACKWARD: f64 = 0.4;
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
    feedback: broadcast::Sender<ServerMessage>,
    objects: object_detection::Detector,
    colors: Arc<color_detection::ColorRuntime>,
    settings: Arc<Mutex<settings::Store>>,
    color_presets: Arc<Mutex<settings::ColorStore>>,
    head_settings: Arc<Mutex<settings::HeadStore>>,
    coordinated_settings: Arc<Mutex<settings::CoordinatedStore>>,
    tracking_phases: Arc<Mutex<settings::TrackingPhaseStore>>,
    person_coordinated_settings: Arc<Mutex<settings::CoordinatedStore>>,
    person_tracking_phases: Arc<Mutex<settings::TrackingPhaseStore>>,
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
    skills: Vec<String>,
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
        action: proto::HumanControlAction,
        final_calls: Vec<proto::Call>,
        reply: oneshot::Sender<Result<HumanControlResult, String>>,
    },
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
    control.bindings = params.pad;
    control.drive = params.pad_drive;
    let (view_tx, views) = watch::channel(control.view(Instant::now()));
    let (feedback, _) = broadcast::channel(32);
    let (connected_tx, connected_rx) = watch::channel(false);
    let objects = object_detection::Detector::new(
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
        mouth_settings: Arc::new(Mutex::new(mouth_settings)),
        mouth_sound_directory: PathBuf::from(proto::SOUND_CLIPS_DIR),
    };

    tokio::spawn(robotd_worker(
        args.socket.clone(),
        command_rx,
        connected_tx,
        state.control.clone(),
        state.settings.clone(),
        state.feedback.clone(),
    ));
    tokio::spawn(control_loop(state.clone(), connected_rx, view_tx));
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

fn router(state: AppState, media_port: u16) -> Router {
    Router::new()
        .route(
            "/",
            get(move || async move {
                Html(PAGE.replace("{{MEDIA_PORT}}", &media_port.to_string())
                    .replace("{{APP_VERSION}}", env!("CARGO_PKG_VERSION")))
            }),
        )
        .route("/control", get(control_upgrade))
        .route("/objects", get(object_detection::upgrade))
        .route("/colors", get(color_detection::upgrade))
        .route("/console.css", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")], include_str!("../web/console.css")) }))
        .route("/console.js", get(|| async { ([(axum::http::header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../web/console.js")) }))
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

async fn control_upgrade(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| control_session(socket, state))
}

async fn control_session(mut socket: WebSocket, state: AppState) {
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
    let mut feedback = state.feedback.subscribe();
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
    let color_presets = state.color_presets.lock().await.value.clone();
    let mouth_sound = state.mouth_settings.lock().await.value.clone();
    let controls = {
        let mut control = state.control.lock().await;
        if control.owner.is_some() {
            drop(control);
            drop(settings_guard);
            let _ = send_message(
                &mut socket,
                &ServerMessage::Error {
                    message: "已有其他网页正在控制，请关闭其他控制页面后重试".to_owned(),
                },
            )
            .await;
            return;
        }
        control.owner = Some(session);
        control.vision_token = Some(vision_token.clone());
        control.vision_binding = None;
        control.vision_latest = None;
        control.vision_pending = None;
        control.coordinated_params = None;
        control.head_tracking_started = false;
        control.head_position = None;
        control.head_tracking_dirty = false;
        control.head_tracking_closing = false;
        control.coordinated_tracking_started = false;
        control.coordinated_tracking_dirty = false;
        control.coordinated_tracking_closing = false;
        control.input = Input::default();
        control.last_input = Some(Instant::now());
        control.cancel();
        if let Some(saved) = settings.as_ref() {
            control.linear_speed = saved.linear_speed;
            control.turn_speed = saved.turn_speed;
        }
        control.view(Instant::now())
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

    // Persist accepted snapshots in order without delaying control messages.
    // The worker drains its queue even when the browser closes immediately.
    let (save_tx, mut save_rx) = mpsc::unbounded_channel();
    let save_state = state.clone();
    let save_worker = tokio::spawn(async move {
        while let Some(requested) = save_rx.recv().await {
            let reply = match requested {
                SettingsSave::Page(request_id, requested) => dispatch_save_settings(request_id, requested, &save_state).await,
                SettingsSave::Head(request_id, requested) => dispatch_save_head_settings(request_id, requested, &save_state).await,
                SettingsSave::Coordinated(request_id, scope, requested) => dispatch_save_coordinated_settings(request_id, scope, requested, &save_state).await,
                SettingsSave::Phases(request_id, scope, requested) => dispatch_save_tracking_phases(request_id, scope, requested, &save_state).await,
                SettingsSave::Mouth(request_id, sound) => dispatch_save_mouth_sound(request_id, sound, &save_state).await,
                SettingsSave::Color(request_id, name, preset) => dispatch_save_color(request_id, name, preset, &save_state).await,
                SettingsSave::DeleteColor(request_id, name) => dispatch_delete_color(request_id, name, &save_state).await,
            };
            if let ServerMessage::SettingsResult { accepted: false, reason: Some(reason), .. } = &reply {
                tracing::warn!(%reason, "page settings were not saved");
            }
            if save_state.control.lock().await.owner == Some(session) {
                let _ = save_state.feedback.send(reply);
            }
        }
    });

    let mut last_seq = None;
    // An IPC lease request may take longer than the input deadline. Continue
    // receiving heartbeats while it is in flight; never replay the old input.
    let mut input_acquire: Option<tokio::task::JoinHandle<Result<(), String>>> = None;
    let mut input_acquire_failed = false;
    let mut input_requested = false;
    let mut browser_ping = tokio::time::interval(BROWSER_PING_INTERVAL);
    browser_ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_browser_pong = Instant::now();
    loop {
        tokio::select! {
            result = async { input_acquire.as_mut().expect("guarded").await }, if input_acquire.is_some() => {
                input_acquire = None;
                if let Err(reason) = result.unwrap_or_else(|error| Err(format!("控制权请求失败：{error}"))) {
                    input_acquire_failed = input_requested;
                    if input_requested && send_message(&mut socket, &ServerMessage::Error { message: reason }).await.is_err() { break; }
                }
            }
            _ = browser_ping.tick() => {
                let holding = state.control.lock().await.head_position.is_some();
                let pong_timeout = if holding { BROWSER_HOLD_PONG_TIMEOUT } else { BROWSER_PONG_TIMEOUT };
                if last_browser_pong.elapsed() > pong_timeout {
                    tracing::warn!(session, holding, "browser connection timed out");
                    break;
                }
                if send_frame(&mut socket, Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            changed = views.changed() => {
                if changed.is_err() { break; }
                views.borrow_and_update();
                let controls = state.control.lock().await.view(Instant::now());
                if send_message(&mut socket, &ServerMessage::Controls { controls }).await.is_err() { break; }
            }
            result = feedback.recv() => {
                match result {
                    Ok(message) => if send_message(&mut socket, &message).await.is_err() { break; },
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_message(&mut socket, &ServerMessage::Error { message: "动作反馈丢失，请检查机器人状态".into() }).await.is_err() { break; }
                    }
                    Err(_) => break,
                }
            }
            changed = status_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let status = { status_rx.borrow_and_update().clone() };
                if send_message(&mut socket, &ServerMessage::Status { status }).await.is_err() {
                    break;
                }
            }
            message = socket.recv() => match message {
            Some(Ok(Message::Text(text))) => {
                let message = match serde_json::from_str::<BrowserMessage>(&text.to_string()) {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::warn!(session, %error, "invalid browser control message");
                        if send_message(
                            &mut socket,
                            &ServerMessage::Error {
                                message: format!("invalid control message: {error}"),
                            },
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                };

                match message {
                    BrowserMessage::StudioLeave { request_id, return_tracking_head_home } => {
                        let reply = leave_studio_workspace(session, request_id, return_tracking_head_home, &state).await;
                        // Returning the head can take several seconds. Pongs cannot be read
                        // while this request is in flight, so start a new heartbeat window.
                        last_browser_pong = Instant::now();
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::Input {
                        seq,
                        left_x,
                        left_y,
                        right_x,
                        right_y, left_trigger, right_trigger, buttons, active,
                    } => {
                        let input = Input {
                            left_x,
                            left_y,
                            right_x,
                            right_y, left_trigger, right_trigger,
                            buttons: buttons.into_iter().fold(0, |bits, button| bits | button.bit()),
                        };
                        if !input.valid() {
                            if send_message(
                                &mut socket,
                                &ServerMessage::Error {
                                    message: "input axes must be finite numbers in [-1, 1]".to_owned(),
                                },
                            )
                            .await
                            .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                        if last_seq.is_some_and(|previous| seq <= previous) {
                            tracing::debug!(session, seq, "discarded stale browser input");
                            continue;
                        }
                        last_seq = Some(seq);
                        let received = Instant::now();
                        input_requested = active && !input.neutral();
                        if !input_requested { input_acquire_failed = false; }
                        if active && !input.neutral() {
                            let (held, acquiring) = {
                                let mut control = state.control.lock().await;
                                let held = control.human_held;
                                if !held && control.owner == Some(session) && control.connected
                                    && control.armed && control.fresh(received)
                                {
                                    // Preserve only liveness until the lease is granted; a later
                                    // fresh frame supplies the actual movement or button edge.
                                    control.last_input = Some(received);
                                }
                                (held, control.human_acquiring)
                            };
                            if !held {
                                if !acquiring && input_acquire.is_none() && !input_acquire_failed {
                                    let state = state.clone();
                                    input_acquire = Some(tokio::spawn(async move { acquire_human(session, &state).await }));
                                }
                                continue;
                            }
                        }
                        let mut control = state.control.lock().await;
                        if control.owner == Some(session) && received.elapsed() <= INPUT_TTL {
                            if active && input.neutral() && !control.human_held {
                                control.human_blocked = false;
                            }
                            if input.neutral() || control.human_held || !active {
                                control.receive(input, active, received);
                            }
                        }
                    }
                    BrowserMessage::SetSpeed { linear_speed, turn_speed } => {
                        let reply = dispatch_speed(session, linear_speed, turn_speed, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() {
                            break;
                        }
                    }
                    BrowserMessage::SaveSettings { request_id, settings } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，参数未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Page(request_id, settings)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("参数保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SaveHeadSettings { request_id, settings } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，参数未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Head(request_id, settings)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("参数保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SaveCoordinatedSettings { request_id, scope, settings } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，参数未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Coordinated(request_id, scope, settings)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false, reason: Some("参数保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SaveTrackingPhases { request_id, scope, settings } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false, reason: Some("页面已失去控制连接，参数未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Phases(request_id, scope, settings)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false, reason: Some("参数保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SaveMouthSound { request_id, sound } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，参数未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Mouth(request_id, sound)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("参数保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SaveColorPreset { request_id, name, preset } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，颜色未保存".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::Color(request_id, name, preset)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false, reason: Some("颜色保存服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::DeleteColorPreset { request_id, name } => {
                        if state.control.lock().await.owner != Some(session) {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false,
                                reason: Some("页面已失去控制连接，颜色未删除".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        } else if save_tx.send(SettingsSave::DeleteColor(request_id, name)).is_err() {
                            let reply = ServerMessage::SettingsResult {
                                request_id, accepted: false, reason: Some("颜色删除服务不可用".into()),
                            };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                        }
                    }
                    BrowserMessage::SetObstacle { enabled, threshold_mm, clear_delay_ms } => {
                        let params = proto::ObstacleParams { enabled, threshold_mm, clear_delay_ms };
                        let reply = dispatch_obstacle(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::SetLowVoltage { threshold_v, duration_s } => {
                        let params = proto::LowVoltageParams { threshold_v, duration_s };
                        let reply = dispatch_low_voltage(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::MotionTracking { action, initial_pitch, target, reference_area, deadzone, gains } => {
                        let params = proto::MotionTrackingParams { action, initial_pitch, target, reference_area, deadzone, gains };
                        let reply = dispatch_motion_tracking(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::HeadPosition { action, position } => {
                        if action != proto::MotionTrackingAction::Stop && position.is_none() {
                            let reply = ServerMessage::HeadPositionResult { action, accepted: false, reason: Some("请填写头部位置".into()) };
                            if send_message(&mut socket, &reply).await.is_err() { break; }
                            continue;
                        }
                        let params = proto::HeadTrackingParams {
                            action, target: None, pitch_position: position,
                            deadzone: [0.0; 2], gains: [[0.0; 3]; 2],
                        };
                        let reply = match dispatch_head_tracking(session, params, &state).await {
                            ServerMessage::HeadTrackingResult { action, accepted, reason } =>
                                ServerMessage::HeadPositionResult { action, accepted, reason },
                            _ => unreachable!("head tracking dispatch result"),
                        };
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::HeadTracking { action, target, pitch_position, deadzone, gains } => {
                        let params = proto::HeadTrackingParams { action, target, pitch_position, deadzone, gains };
                        let reply = dispatch_head_tracking(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::CoordinatedTracking {
                        action, initial_pitch, target, camera,
                        head_deadzone, head_gains, body_gains, final_body_gains, approach_linear_limit,
                        final_linear_limit, final_lateral_limit, final_point, final_tolerance, stop_area_px, stop_area_deadzone_px,
                        stop_distance_mm, stop_distance_deadzone_mm,
                        arrival_delay_s, arrival_skill, mouth_before, mouth_after,
                    } => {
                        let params = proto::CoordinatedTrackingParams {
                            action, initial_pitch, target, camera,
                            head_deadzone, head_gains, body_gains, final_body_gains, approach_linear_limit,
                            final_linear_limit, final_lateral_limit, final_point, final_tolerance, stop_area_px, stop_area_deadzone_px,
                            stop_distance_mm, stop_distance_deadzone_mm,
                            arrival_delay_s, arrival_skill, mouth_before, mouth_after,
                        };
                        let reply = dispatch_coordinated_tracking(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::Maze { action, threshold_mm, head_step_deg, settle_ms, sample_ms, turn_initial_ms, turn_final_ms, restore_ms, linear_speed, angular_speed } => {
                        let params = proto::MazeParams { action, threshold_mm, head_step_deg, settle_ms, sample_ms, turn_initial_ms, turn_final_ms, restore_ms, linear_speed, angular_speed };
                        let reply = dispatch_maze(session, params, &state).await;
                        if send_message(&mut socket, &reply).await.is_err() { break; }
                    }
                    BrowserMessage::Action { name } => {
                        let state = state.clone();
                        tokio::spawn(async move {
                            let reply = dispatch_action(session, name, &state).await;
                            let _ = state.feedback.send(reply);
                        });
                    }
                }
            }
            Some(Ok(Message::Pong(_))) => last_browser_pong = Instant::now(),
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => {}
            }
        }
    }
    // Stop stale input immediately; keep the lease until accepted saves finish.
    {
        let mut control = state.control.lock().await;
        if control.owner == Some(session) {
            control.last_input = None;
            control.maze_active = false;
            control.coordinated_tracking_started = false;
            control.vision_pending = None;
        }
    }
    if let Some(task) = input_acquire.take() { let _ = task.await; }
    finish_head_tracking(session, &state).await;
    finish_coordinated_tracking(session, &state).await;
    drop(save_tx);
    if let Err(error) = save_worker.await {
        tracing::error!(%error, "page settings worker failed");
    }
    release_session(session, &state).await;
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
) {
    let mut ticker = tokio::time::interval(CONTROL_PERIOD);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let (actions, generation, final_calls) = {
            let mut control = state.control.lock().await;
            control.roller = state.status.borrow().uses_roller();
            let now = Instant::now();
            let (mut calls, actions) = control.tick(now, *connected.borrow());
            if !control.human_held || control.maze_active {
                calls.clear();
            }
            let view = control.view(now);
            views.send_if_modified(|old| {
                if *old == view {
                    false
                } else {
                    *old = view;
                    true
                }
            });
            enqueue_notifications(&state.commands, calls, Some(control.human_generation));
            let release = control.human_held && !control.maze_active && control.head_position.is_none()
                && !control.human_acquiring
                && control.human_actions == 0
                && !control.fresh(now);
            let final_calls = if release {
                let input = control.input;
                control.input = Input::default();
                let zero = control_frame(&control, now);
                control.input = input;
                Some(zero)
            } else {
                None
            };
            (
                if control.human_held && !control.maze_active { actions } else { vec![] },
                control.human_generation,
                final_calls,
            )
        };
        for action in actions {
            let result = perform_action(action, generation, &state).await;
            let _ = state.feedback.send(result);
        }
        if let Some(final_calls) = final_calls {
            if let Err(error) =
                lease_request(&state, proto::HumanControlAction::Release, final_calls).await
            {
                tracing::warn!(%error, "human-control release failed");
                state.control.lock().await.lose_human_control();
            }
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
                control.bindings = params.pad;
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
