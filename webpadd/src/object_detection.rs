//! On-demand object detection from the existing media frame socket.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use axum::extract::{
    State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use axum::response::IntoResponse;
use serde::Serialize;
use tokio::sync::watch;
use uyvy::{Turn, letterbox_from_uyvy_with_pad};

use crate::AppState;
use duck_detect::{onnx, rknn};
use crate::frame_prefetch::{FramePrefetch, camera_recoverable, media_socket, source_root};

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
        objects: Vec<Object>,
    },
}

#[derive(Clone, Serialize)]
pub(super) struct Object {
    pub(super) class: usize,
    pub(super) score: f32,
    pub(super) bounds: [f32; 4],
}

#[derive(Clone)]
pub struct Detector {
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
    pub fn new(record_path: Option<PathBuf>) -> Self {
        let shared = Arc::new((Mutex::new(Subscribers::default()), Condvar::new()));
        let (events, _) = watch::channel(Event::Waiting);
        let recorder = record_path.and_then(|path| match crate::vision_record::Recorder::start(&path) {
            Ok(recorder) => Some(recorder),
            Err(error) => {
                tracing::error!(path = %path.display(), %error, "cannot start person vision recording");
                None
            }
        });
        Self { shared, events, recorder }
    }

    pub(super) fn recorder(&self) -> Option<crate::vision_record::Recorder> {
        self.recorder.clone()
    }

    fn subscribe(&self) -> Subscription {
        let (lock, wake) = &*self.shared;
        let mut state = lock.lock().expect("object subscriber lock poisoned");
        state.count += 1;
        if !state.running {
            state.running = true;
            self.events.send_replace(Event::Waiting);
            let shared = self.shared.clone();
            let events = self.events.clone();
            let recorder = self.recorder.clone();
            std::thread::Builder::new()
                .name("object-detection".into())
                .spawn(move || {
                    worker(shared, events, recorder);
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

pub async fn upgrade(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| session(socket, state))
}

async fn session(mut socket: WebSocket, state: AppState) {
    let id = state.next_session.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let detector = state.objects.clone();
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

fn paths() -> Result<(PathBuf, PathBuf)> {
    let executable = std::env::current_exe()?;
    Ok((media_socket()?, model_path_from(&executable)?))
}

fn model_path_from(executable: &Path) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("WONDERDUCK_OBJECT_MODEL") {
        return Ok(PathBuf::from(path));
    }
    Ok(source_root(executable)?.join("models/object-detection.rknn"))
}


fn worker(shared: Arc<(Mutex<Subscribers>, Condvar)>, events: watch::Sender<Event>,
    recorder: Option<crate::vision_record::Recorder>) {
    let (lock, wake) = &*shared;
    if let Some(recorder) = &recorder { recorder.status("started", None); }
    loop {
        let result = run(&shared, &events, recorder.as_ref());
        let mut state = lock.lock().expect("object subscriber lock poisoned");
        if let Err(error) = result {
            tracing::warn!(error = %format!("{error:#}"), "object detection stopped");
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
}

impl Model {
    fn open(path: &Path) -> Result<Self> {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("onnx") => {
                let model = onnx::Model::open(path)?;
                tracing::info!(path = %path.display(), "ONNX object detector started");
                Ok(Self::Onnx(model))
            }
            Some("rknn") => {
                let runtime = path.with_file_name("librknnrt.so");
                let model = rknn::Model::open_outputs_with_library(path, 2, Some(&runtime))?;
                tracing::info!(api = %model.api_version, driver = %model.driver_version, "RKNN object detector started");
                Ok(Self::Rockchip(model))
            }
            _ => anyhow::bail!("expected an .onnx or .rknn object model: {}", path.display()),
        }
    }

    fn infer_with<T>(&mut self, rgb: &[u8], decode: impl FnOnce(&[&[f32]]) -> Result<T>) -> Result<T> {
        match self {
            Self::Rockchip(model) => model.infer_with(rgb, decode),
            Self::Onnx(model) => model.infer_with(rgb, decode),
        }
    }
}

fn run(shared: &Arc<(Mutex<Subscribers>, Condvar)>, events: &watch::Sender<Event>,
    recorder: Option<&crate::vision_record::Recorder>) -> Result<()> {
    let (socket, path) = paths()?;
    let mut model = Model::open(&path)?;
    let (input, outputs) = match &model {
        Model::Rockchip(model) => (model.input, model.output_shapes.iter().map(|shape| {
            shape.iter().map(|&dimension| dimension as i64).collect::<Vec<_>>()
        }).collect::<Vec<_>>()),
        Model::Onnx(model) => (model.input, model.output_shapes.clone()),
    };
    ensure!(input == (640, 640, 3), "model input is not 640×640 RGB");
    let score_index = outputs.iter().position(|shape| shape == &[1, 80, 8400])
        .context("missing class score tensor [1,80,8400]")?;
    let box_index = outputs.iter().position(|shape| shape == &[1, 4, 8400])
        .context("missing box tensor [1,4,8400]")?;
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
    let mut frames = FramePrefetch::camera(&socket)?;
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
                frames = FramePrefetch::camera(&socket)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let turn = Turn::from_degrees(header.rotate).context("invalid camera rotation")?;
        let (width, height) = turn.upright(header.width as usize, header.height as usize);
        let width_raw = header.width as usize;
        let height_raw = header.height as usize;
        let fit = if let Some(converter) = &mut rga {
            match converter.convert(&data, width_raw, height_raw, 640, turn, &mut rgb) {
                Ok(fit) => fit,
                Err(error) => {
                    tracing::warn!(error = %format!("{error:#}"), "RGA conversion failed; using CPU frame conversion");
                    rga = None;
                    letterbox_from_uyvy_with_pad(
                        &data, width_raw, height_raw, 640, turn, 0, &mut rgb,
                    )
                }
            }
        } else {
            letterbox_from_uyvy_with_pad(&data, width_raw, height_raw, 640, turn, 0, &mut rgb)
        };
        let objects = model
            .infer_with(&rgb, |outputs| {
                duck_detect::objects::decode(
                    outputs[score_index],
                    outputs[box_index],
                    fit,
                    width,
                    height,
                    0.25,
                )
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
            objects,
        };
        if let (Some(recorder), Event::Frame { width, height, captured_at_unix_us, took_ms, objects }) =
            (recorder, &event)
        {
            recorder.frame(*captured_at_unix_us, *width, *height, *took_ms, objects);
        }
        events.send_replace(event);
    }
}
