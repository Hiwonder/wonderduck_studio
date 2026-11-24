//! On-demand object detection from the existing media frame socket.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use axum::extract::{
    RawQuery, State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::{Deserialize, Serialize, de::IntoDeserializer};
use tokio::sync::watch;
use uyvy::{Turn, letterbox_rect_from_uyvy_with_pad};

use crate::AppState;
use duck_detect::{onnx, rknn};
use crate::frame_prefetch::{CameraFrames, camera_recoverable, media_socket, source_root};
use crate::object_detection_ncnn;
use crate::person_models::{PersonDecoder, Yolov6nDecoder};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(super) enum Event {
    Waiting,
    Recovering,
    Error {
        message: String,
    },
    Frame {
        width: usize,
        height: usize,
        captured_at_unix_us: u128,
        took_ms: f64,
        processing_ms: f64,
        objects: Vec<Object>,
    },
}

#[derive(Clone, Serialize)]
pub(super) struct Object {
    pub(super) class: usize,
    pub(super) score: f32,
    pub(super) bounds: [f32; 4],
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(super) enum PersonModel {
    #[serde(rename = "yolov5s-relu-640x384")]
    Yolov5sReluWide,
    #[serde(rename = "yolo26n")]
    Yolo26n,
    #[serde(rename = "yolov6n-512")]
    Yolov6n512,
}

fn board_compatible(compatible: &[u8]) -> bool {
    std::fs::read("/proc/device-tree/compatible").is_ok_and(|data| {
        data.split(|&value| value == 0).any(|value| value == compatible)
    })
}

impl PersonModel {
    const ALL: [Self; 3] = [Self::Yolov5sReluWide, Self::Yolo26n, Self::Yolov6n512];

    fn supported(uno_q: bool) -> &'static [Self] {
        if uno_q {
            &[Self::Yolov6n512]
        } else {
            &[Self::Yolov5sReluWide, Self::Yolo26n]
        }
    }

    fn select(uno_q: bool, requested: Option<Self>, installed: impl Fn(Self) -> bool) -> Option<Self> {
        Self::supported(uno_q).iter().copied().find(|&model| {
            requested.is_none_or(|requested| model == requested) && installed(model)
        })
    }

    pub(super) fn input(self) -> (usize, usize, usize) {
        match self {
            Self::Yolov5sReluWide => (384, 640, 3),
            Self::Yolo26n => (640, 640, 3),
            Self::Yolov6n512 => (512, 512, 3),
        }
    }

    fn path(self, executable: &Path) -> Result<PathBuf> {
        let stem = match self {
            Self::Yolo26n => {
                if let Some(path) = std::env::var_os("WONDERDUCK_OBJECT_MODEL") {
                    return Ok(PathBuf::from(path));
                }
                "object-detection"
            }
            Self::Yolov5sReluWide => "person-yolov5s-relu-640x384",
            Self::Yolov6n512 => "person-yolov6n-512",
        };
        let path = source_root(executable)?.join("models").join(stem);
        if self == Self::Yolov6n512 {
            return Ok(path.with_extension("param"));
        }
        if board_compatible(b"rockchip,rk3566") {
            return Ok(path.with_extension("rknn"));
        }
        Ok(path.with_extension("onnx"))
    }

    fn installed(self, executable: &Path) -> bool {
        self.path(executable).is_ok_and(|path| {
            if object_detection_ncnn::configured_runner(&path).is_some() {
                return true;
            }
            path.is_file() && match path.extension().and_then(|extension| extension.to_str()) {
                Some("onnx") => true,
                Some("rknn") => board_compatible(b"rockchip,rk3566") && path.with_file_name("librknnrt.so").is_file(),
                _ => false,
            }
        })
    }
}

#[derive(Clone)]
pub(super) struct Detectors(Arc<[Detector; PersonModel::ALL.len()]>);

impl Detectors {
    pub(super) fn new(record_path: Option<PathBuf>) -> Self {
        let recorder = record_path.and_then(|path| match crate::vision_record::Recorder::start(&path) {
            Ok(recorder) => Some(recorder),
            Err(error) => {
                tracing::error!(path = %path.display(), %error, "cannot start person vision recording");
                None
            }
        });
        Self(Arc::new(PersonModel::ALL.map(|model| Detector::new(model, recorder.clone()))))
    }

    pub(super) fn recorder(&self) -> Option<crate::vision_record::Recorder> {
        self.0[0].recorder.clone()
    }

    fn get(&self, model: PersonModel) -> &Detector {
        let index = match model {
            PersonModel::Yolov5sReluWide => 0,
            PersonModel::Yolo26n => 1,
            PersonModel::Yolov6n512 => 2,
        };
        &self.0[index]
    }
}

#[derive(Clone)]
struct Detector {
    model: PersonModel,
    shared: Arc<(Mutex<Subscribers>, Condvar)>,
    events: watch::Sender<Event>,
    recorder: Option<crate::vision_record::Recorder>,
}

#[derive(Default)]
struct Subscribers {
    count: usize,
    running: bool,
}

impl Detector {
    fn new(model: PersonModel, recorder: Option<crate::vision_record::Recorder>) -> Self {
        let shared = Arc::new((Mutex::new(Subscribers::default()), Condvar::new()));
        let (events, _) = watch::channel(Event::Waiting);
        Self { model, shared, events, recorder }
    }

    fn subscribe(&self) -> Subscription {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().expect("object subscriber lock poisoned");
        state.count += 1;
        if !state.running {
            state.running = true;
            self.events.send_replace(Event::Waiting);
            let detector = self.clone();
            std::thread::Builder::new()
                .name("object-detection".into())
                .spawn(move || {
                    worker(detector);
                })
                .expect("cannot start object detection worker");
        }
        wake.notify_one();
        Subscription(self.shared.clone())
    }
}

struct Subscription(Arc<(Mutex<Subscribers>, Condvar)>);
impl Drop for Subscription {
    fn drop(&mut self) {
        let (lock, wake) = &*self.0;
        let mut state = lock.lock().expect("object subscriber lock poisoned");
        state.count -= 1;
        wake.notify_one();
    }
}

pub(super) async fn available_models() -> Json<Vec<PersonModel>> {
    let executable = std::env::current_exe();
    let uno_q = board_compatible(b"arduino,imola");
    Json(PersonModel::supported(uno_q).iter().copied().filter(|model| {
        executable.as_ref().is_ok_and(|exe| model.installed(exe))
    }).collect())
}

pub(super) async fn upgrade(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
) -> impl IntoResponse {
    let requested = match query.as_deref().into_iter().flat_map(|query| query.split('&'))
        .find_map(|pair| pair.strip_prefix("model="))
        .map(|value| PersonModel::deserialize(
            IntoDeserializer::<serde::de::value::Error>::into_deserializer(value)
        )).transpose()
    {
        Ok(model) => model,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let Ok(executable) = std::env::current_exe() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let uno_q = board_compatible(b"arduino,imola");
    let model = PersonModel::select(uno_q, requested, |model| model.installed(&executable));
    let Some(model) = model else {
        return StatusCode::NOT_FOUND.into_response();
    };
    upgrade.on_upgrade(move |socket| session(socket, state, model))
}

async fn session(mut socket: WebSocket, state: AppState, model: PersonModel) {
    let id = state.next_session.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let detector = state.objects.get(model);
    let _subscription = detector.subscribe();
    let mut events = detector.events.subscribe();
    let relay = tokio::spawn(crate::vision_relay::relay_objects(state.clone(), id, detector.events.subscribe()));
    loop {
        let current = events.borrow_and_update().clone();
        let Ok(message) = serde_json::to_string(&current) else {
            break;
        };
        if socket.send(Message::Text(message.into())).await.is_err() {
            break;
        }
        tokio::select! {
            result = events.changed() => if result.is_err() { break },
            result = socket.recv() => match result {
                Some(Ok(Message::Text(text))) => {
                    let accepted = crate::vision_relay::bind(&state, id, crate::vision_relay::Source::Person, &text).await;
                    let reply = serde_json::json!({"type":"tracking_bound", "accepted":accepted});
                    if socket.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                    continue;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => continue,
            }
        }
    }
    crate::vision_relay::unbind(&state, id).await;
    relay.abort();
}

fn worker(Detector { model, shared, events, recorder }: Detector) {
    let (lock, wake) = &*shared;
    if let Some(recorder) = &recorder { recorder.status("started", None); }
    loop {
        let result = run(model, &shared, &events, recorder.as_ref());
        let mut state = lock.lock().expect("object subscriber lock poisoned");
        if let Err(error) = result {
            tracing::warn!(?model, error = %format!("{error:#}"), "object detection stopped");
            if let Some(recorder) = &recorder { recorder.status("error", Some(format!("{error:#}"))); }
            events.send_replace(Event::Error {
                message: format!("物体检测不可用：{error:#}"),
            });
            while state.count > 0 {
                state = wake.wait(state).expect("object subscriber lock poisoned");
            }
        }
        if state.count == 0 {
            state.running = false;
            events.send_replace(Event::Waiting);
            if let Some(recorder) = &recorder { recorder.status("stopped", None); }
            return;
        }
    }
}

enum Model {
    Rockchip(rknn::Model),
    Onnx(onnx::Model),
    Ncnn(object_detection_ncnn::Model),
}

impl Model {
    fn open(path: &Path, kind: PersonModel) -> Result<Self> {
        if let Some(runner) = object_detection_ncnn::configured_runner(path) {
            return Ok(Self::Ncnn(object_detection_ncnn::Model::open(&runner, path, kind)?));
        }
        ensure!(kind != PersonModel::Yolov6n512, "YOLOv6n requires the ncnn runner and both model files");
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("onnx") => {
                let model = onnx::Model::open(path)?;
                tracing::info!(path = %path.display(), "ONNX object detector started");
                Ok(Self::Onnx(model))
            }
            Some("rknn") => {
                let runtime = path.with_file_name("librknnrt.so");
                let outputs = if kind == PersonModel::Yolov5sReluWide { 3 } else { 2 };
                let model = rknn::Model::open_outputs_with_library(path, outputs, Some(&runtime))?;
                tracing::info!(?kind, api = %model.api_version, driver = %model.driver_version, "RKNN object detector started");
                Ok(Self::Rockchip(model))
            }
            _ => anyhow::bail!("expected an .onnx or .rknn object model: {}", path.display()),
        }
    }

    fn infer_with<T>(&mut self, rgb: &[u8], decode: impl FnOnce(&[&[f32]]) -> Result<T>) -> Result<T> {
        match self {
            Self::Rockchip(model) => model.infer_with(rgb, decode),
            Self::Onnx(model) => model.infer_with(rgb, decode),
            Self::Ncnn(model) => model.infer_with(rgb, decode),
        }
    }
}

fn run(kind: PersonModel, shared: &Arc<(Mutex<Subscribers>, Condvar)>, events: &watch::Sender<Event>,
    recorder: Option<&crate::vision_record::Recorder>) -> Result<()> {
    let socket = media_socket()?;
    let path = kind.path(&std::env::current_exe()?)?;
    let mut model = Model::open(&path, kind)?;
    let (input, outputs) = match &model {
        Model::Rockchip(model) => (model.input, model.output_shapes.iter().map(|shape| {
            shape.iter().map(|&dimension| dimension as i64).collect::<Vec<_>>()
        }).collect::<Vec<_>>()),
        Model::Onnx(model) => (model.input, model.output_shapes.clone()),
        Model::Ncnn(model) => (kind.input(), model.output_shapes()),
    };
    let (model_height, model_width, _) = kind.input();
    let model_size = (model_width, model_height);
    ensure!(
        input == kind.input(),
        "model input is not {model_width}×{model_height} RGB"
    );
    let decoder = match kind {
        PersonModel::Yolo26n => {
            let scores = outputs.iter().position(|shape| shape == &[1, 80, 8400])
                .context("missing class score tensor [1,80,8400]")?;
            let boxes = outputs.iter().position(|shape| shape == &[1, 4, 8400])
                .context("missing box tensor [1,4,8400]")?;
            DetectionDecoder::Objects { scores, boxes }
        }
        PersonModel::Yolov5sReluWide => {
            DetectionDecoder::Person(PersonDecoder::yolov5s_relu(&outputs, model_size)?)
        }
        PersonModel::Yolov6n512 => DetectionDecoder::Yolov6n(Yolov6nDecoder::new(&outputs)?),
    };
    let mut rgb = Vec::new();
    let mut rga = if matches!(&model, Model::Rockchip(_)) {
        match duck_detect::rga::Converter::open() {
            Ok(converter) => Some(converter),
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "RGA unavailable; using CPU frame conversion");
                None
            }
        }
    } else {
        None
    };
    let mut frames = CameraFrames::camera(&socket, false)?;
    let mut recovering = false;
    loop {
        if shared
            .0
            .lock()
            .expect("object subscriber lock poisoned")
            .count
            == 0
        {
            return Ok(());
        }
        let start = Instant::now();
        let (header, data) = match frames.next() {
            Ok(frame) => {
                if recovering {
                    tracing::info!("camera frames recovered");
                    if let Some(recorder) = recorder { recorder.status("recovered", None); }
                    recovering = false;
                }
                frame
            }
            Err(error) if camera_recoverable(&error) => {
                if !recovering {
                    tracing::warn!(error = %format!("{error:#}"), "camera frames unavailable; retrying");
                    if let Some(recorder) = recorder { recorder.status("recovering", Some(format!("{error:#}"))); }
                    events.send_replace(Event::Recovering);
                    recovering = true;
                }
                drop(frames);
                let (lock, wake) = &**shared;
                let state = lock.lock().expect("object subscriber lock poisoned");
                if state.count == 0 {
                    return Ok(());
                }
                let (state, _) = wake
                    .wait_timeout(state, Duration::from_millis(250))
                    .expect("object subscriber lock poisoned");
                if state.count == 0 {
                    return Ok(());
                }
                drop(state);
                frames = CameraFrames::camera(&socket, false)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let processing_start = Instant::now();
        let turn = Turn::from_degrees(header.rotate).context("invalid camera rotation")?;
        let (width, height) = turn.upright(header.width as usize, header.height as usize);
        let width_raw = header.width as usize;
        let height_raw = header.height as usize;
        let fit = if let Some(converter) = &mut rga {
            match converter.convert_rect(&data, width_raw, height_raw, model_size, turn, &mut rgb) {
                Ok(fit) => fit,
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "RGA conversion failed; using CPU frame conversion");
                    rga = None;
                    letterbox_rect_from_uyvy_with_pad(
                        &data, width_raw, height_raw, model_size, turn, 0, &mut rgb,
                    )
                }
            }
        } else {
            letterbox_rect_from_uyvy_with_pad(&data, width_raw, height_raw, model_size, turn, 0, &mut rgb)
        };
        let objects = model
            .infer_with(&rgb, |outputs| {
                match &decoder {
                    DetectionDecoder::Objects { scores, boxes } => {
                        duck_detect::objects::decode(outputs[*scores], outputs[*boxes], fit, width, height, 0.25)
                    }
                    DetectionDecoder::Person(decoder) => decoder.decode(outputs, fit, width, height),
                    DetectionDecoder::Yolov6n(decoder) => decoder.decode(outputs, fit, width, height),
                }
            })?
            .into_iter()
            .map(|object| Object {
                class: object.class,
                score: object.score,
                bounds: object.bounds,
            })
            .collect();
        let event = Event::Frame {
            width,
            height,
            captured_at_unix_us: header.captured_at_unix_us,
            took_ms: start.elapsed().as_secs_f64() * 1000.0,
            processing_ms: processing_start.elapsed().as_secs_f64() * 1000.0,
            objects,
        };
        if let (Some(recorder), Event::Frame { width, height, captured_at_unix_us, took_ms, objects, .. }) =
            (recorder, &event)
        {
            recorder.frame(*captured_at_unix_us, *width, *height, *took_ms, objects);
        }
        events.send_replace(event);
    }
}

enum DetectionDecoder {
    Objects { scores: usize, boxes: usize },
    Person(PersonDecoder),
    Yolov6n(Yolov6nDecoder),
}

#[cfg(test)]
mod tests {
    use super::PersonModel::{self, Yolo26n, Yolov5sReluWide, Yolov6n512};

    #[test]
    fn uno_q_advertises_and_selects_only_yolov6n() {
        assert_eq!(PersonModel::supported(true), &[Yolov6n512]);
        assert_eq!(PersonModel::select(true, None, |_| true), Some(Yolov6n512));
        assert_eq!(PersonModel::select(true, Some(Yolov6n512), |_| true), Some(Yolov6n512));
        assert_eq!(PersonModel::select(true, Some(Yolo26n), |_| true), None);
        assert_eq!(PersonModel::select(true, Some(Yolov5sReluWide), |_| true), None);
        assert_eq!(PersonModel::select(true, None, |model| model != Yolov6n512), None);
        assert_eq!(PersonModel::select(false, None, |_| true), Some(Yolov5sReluWide));
        assert_eq!(PersonModel::select(false, Some(Yolov6n512), |_| true), None);
    }
}
