//! Forward the owning page's native detector results directly to robotd.

use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::watch;

use crate::{AppState, ControlState, RobotCommand, proto};

// The stamp is supplied by mediad on this same machine. Do not turn a slow
// inference result into a fresh command merely because it arrived late.
const MAX_FRAME_AGE_US: u64 = 350_000;
const MAX_FUTURE_US: u64 = 50_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Source { Color, Person }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Binding { pub session: u64, pub id: u64, pub source: Source }

#[derive(Clone, Debug)]
pub(super) struct Frame {
    pub binding: Binding,
    pub captured: u64,
    pub width: u32,
    pub height: u32,
    pub rotate: Option<u16>,
    pub target: Option<proto::VisualTrackingTarget>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BindRequest {
    #[serde(rename = "type")]
    kind: String,
    token: String,
}

pub(super) fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) async fn bind(state: &AppState, id: u64, source: Source, text: &str) -> bool {
    let Ok(request) = serde_json::from_str::<BindRequest>(text) else { return false };
    if request.kind != "bind_tracking" { return false; }
    let mut control = state.control.lock().await;
    let Some(session) = control.owner else { return false };
    if control.vision_token.as_deref() != Some(request.token.as_str()) { return false; }
    control.vision_binding = Some(Binding { session, id, source });
    control.vision_latest = None;
    control.vision_pending = None;
    true
}

pub(super) async fn unbind(state: &AppState, id: u64) {
    let mut control = state.control.lock().await;
    if control.vision_binding.is_some_and(|binding| binding.id == id) {
        control.vision_binding = None;
        control.vision_latest = None;
        control.vision_pending = None;
    }
}

async fn invalidate(state: &AppState, id: u64) {
    let mut control = state.control.lock().await;
    if control.vision_binding.is_some_and(|binding| binding.id == id) {
        control.vision_latest = None;
        control.vision_pending = None;
    }
}

fn fresh(captured: u64, now: u64) -> bool {
    captured > 0 && captured <= now.saturating_add(MAX_FUTURE_US)
        && now.saturating_sub(captured) <= MAX_FRAME_AGE_US
}

fn wall_us() -> Option<u64> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_micros().try_into().ok()
}

fn compatible(frame: &Frame, params: &proto::CoordinatedTrackingParams) -> bool {
    let Some(camera) = params.camera else { return false };
    let source = if params.stop_area_px.is_some() { Source::Person } else { Source::Color };
    if frame.binding.source != source { return false; }
    match frame.binding.source {
        Source::Color => frame.width == camera.width && frame.height == camera.height
            && frame.rotate == Some(camera.rotate),
        Source::Person => {
            let (width, height) = if camera.rotate == 90 || camera.rotate == 270 {
                (camera.height, camera.width)
            } else { (camera.width, camera.height) };
            frame.width == width && frame.height == height
        }
    }
}

pub(super) fn current_frame<'a>(control: &'a ControlState, params: &proto::CoordinatedTrackingParams)
    -> Option<&'a Frame> {
    let frame = control.vision_latest.as_ref()?;
    let now = wall_us()?;
    if control.vision_binding != Some(frame.binding) || !fresh(frame.captured, now)
        || !compatible(frame, params) { return None; }
    Some(frame)
}

fn frame_valid(frame: &Frame) -> bool {
    frame.width > 0 && frame.height > 0 && frame.target.is_none_or(|target|
        target.captured_at_unix_us == frame.captured && target.point.iter().all(|v| v.is_finite() && v.abs() <= 1.0)
            && target.area.is_finite() && target.area > 0.0 && target.area <= 1.0
            && (frame.binding.source != Source::Person || target.area_px.is_some()))
}

pub(super) async fn publish(state: &AppState, frame: Frame) {
    let Some(now) = wall_us() else { return };
    if !frame_valid(&frame) || !fresh(frame.captured, now) { return; }
    let mut control = state.control.lock().await;
    if control.vision_binding != Some(frame.binding) || control.owner != Some(frame.binding.session)
        || control.vision_latest.as_ref().is_some_and(|old| frame.captured <= old.captured) { return; }
    let binding = frame.binding;
    control.vision_latest = Some(frame);
    if !control.coordinated_tracking_started || control.coordinated_tracking_closing
        || !control.connected || !control.fresh(std::time::Instant::now()) { return; }
    let Some(params) = &control.coordinated_params else { return };
    if !compatible(control.vision_latest.as_ref().unwrap(), params) { return; }
    let marker = (binding.session, binding.id, control.coordinated_tracking_generation);
    if control.vision_pending.is_some() { return; }
    if state.commands.try_send(RobotCommand::VisionUpdate {
        session: marker.0, binding: marker.1, generation: marker.2,
    }).is_ok() { control.vision_pending = Some(marker); }
}

// Called by the single ordered IPC worker immediately before it writes. A
// single pending marker represents all frames received while IPC was busy.
pub(super) fn take_update(control: &mut ControlState, session: u64, binding: u64, generation: u64)
    -> Option<proto::CoordinatedTrackingParams> {
    let marker = (session, binding, generation);
    if control.vision_pending != Some(marker) { return None; }
    control.vision_pending = None;
    if control.owner != Some(session) || !control.connected || !control.fresh(std::time::Instant::now())
        || !control.coordinated_tracking_started || control.coordinated_tracking_closing
        || control.coordinated_tracking_generation != generation
        || !control.vision_binding.is_some_and(|item| item.id == binding && item.session == session) { return None; }
    let frame = control.vision_latest.as_ref()?;
    if !fresh(frame.captured, wall_us()?) { return None; }
    let mut params = control.coordinated_params.clone()?;
    if !compatible(frame, &params) { return None; }
    params.action = proto::MotionTrackingAction::Update;
    params.initial_pitch = None;
    params.target = frame.target;
    params.valid().then_some(params)
}

pub(super) async fn relay_values(state: AppState, id: u64, source: Source, mut events: watch::Receiver<Value>) {
    while events.changed().await.is_ok() {
        let event = events.borrow_and_update().clone();
        if event.get("type").and_then(Value::as_str) != Some("frame") {
            invalidate(&state, id).await;
            continue;
        }
        if let Some(frame) = frame_from_value(&state, id, source, &event).await {
            publish(&state, frame).await;
        }
    }
}

pub(super) async fn frame_from_value(state: &AppState, id: u64, source: Source, event: &Value) -> Option<Frame> {
    let binding = state.control.lock().await.vision_binding.filter(|item| item.id == id && item.source == source)?;
    if event.get("type")?.as_str()? != "frame" { return None; }
    let width: u32 = event.get("width")?.as_u64()?.try_into().ok()?;
    let height: u32 = event.get("height")?.as_u64()?.try_into().ok()?;
    if width == 0 || height == 0 { return None; }
    let captured = event.get("captured_at_unix_us")?.as_u64()?;
    let (rotate, target) = match source {
        Source::Color => {
            let rotate: u16 = event.get("rotate")?.as_u64()?.try_into().ok()?;
            if !matches!(rotate, 0 | 90 | 180 | 270) { return None; }
            let target = if event.get("bounds")?.is_null() { None } else {
                let bounds = event.get("bounds")?.as_array()?;
                if bounds.len() != 4 { return None; }
                let [x, y, w, h] = [bounds[0].as_f64()?, bounds[1].as_f64()?, bounds[2].as_f64()?, bounds[3].as_f64()?];
                if ![x, y, w, h].iter().all(|v| v.is_finite()) || x < 0.0 || y < 0.0 || w <= 0.0 || h <= 0.0
                    || x + w > width as f64 || y + h > height as f64 { return None; }
                let (mut u, mut v) = ((x + w / 2.0) / width as f64, (y + h / 2.0) / height as f64);
                (u, v) = match rotate { 90 => (1.0-v, u), 180 => (1.0-u, 1.0-v), 270 => (v, 1.0-u), _ => (u, v) };
                Some(proto::VisualTrackingTarget { point: [2.0*u-1.0, 2.0*v-1.0],
                    area: event.get("area")?.as_f64()?, area_px: None, captured_at_unix_us: captured })
            };
            (Some(rotate), target)
        }
        Source::Person => {
            let mut selected: Option<([f64; 4], f64)> = None;
            for object in event.get("objects")?.as_array()? {
                if object.get("class")?.as_u64()? != 0 { continue; }
                let bounds = object.get("bounds")?.as_array()?;
                if bounds.len() != 4 { return None; }
                let b = [bounds[0].as_f64()?, bounds[1].as_f64()?, bounds[2].as_f64()?, bounds[3].as_f64()?];
                if !b.iter().all(|v| v.is_finite()) || b[0] < 0.0 || b[1] < 0.0
                    || b[2] <= b[0] || b[3] <= b[1] || b[2] > width as f64 || b[3] > height as f64 { return None; }
                let area = (b[2]-b[0]) * (b[3]-b[1]);
                if selected.is_none_or(|(_, old)| area > old) { selected = Some((b, area)); }
            }
            let target = selected.map(|(b, area)| proto::VisualTrackingTarget {
                point: [(b[0]+b[2])/width as f64-1.0, (b[1]+b[3])/height as f64-1.0],
                area: area/(width as f64*height as f64), area_px: Some(area.round() as u64), captured_at_unix_us: captured,
            });
            (None, target)
        }
    };
    Some(Frame { binding, captured, width, height, rotate, target })
}

pub(super) async fn relay_objects(state: AppState, id: u64, mut events: watch::Receiver<crate::object_detection::Event>) {
    while events.changed().await.is_ok() {
        let event = events.borrow_and_update().clone();
        if !matches!(event, crate::object_detection::Event::Frame { .. }) {
            invalidate(&state, id).await;
            continue;
        }
        if let Ok(value) = serde_json::to_value(event)
            && let Some(frame) = frame_from_value(&state, id, Source::Person, &value).await {
            publish(&state, frame).await;
        }
    }
}
