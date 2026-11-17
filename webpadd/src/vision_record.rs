//! Optional, non-blocking detector evidence accompanying robotd's `--record` file.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::time::Duration;

use serde::Serialize;

use crate::object_detection::Object;

const QUEUE_CAPACITY: usize = 128;

#[derive(Clone, Debug)]
pub(super) struct Recorder {
    tx: SyncSender<Envelope>,
    dropped: Arc<AtomicU64>,
    following: Arc<Mutex<Option<u64>>>,
}

#[derive(Serialize)]
struct Envelope {
    dropped_total: u64,
    #[serde(flatten)]
    event: RecordEvent,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RecordEvent {
    Frame {
        captured_at_unix_us: u128,
        emitted_at_unix_us: u64,
        emitted_t_ns: u64,
        width: usize,
        height: usize,
        cycle_elapsed_ms: f64,
        persons: Vec<Person>,
        selected_index: Option<usize>,
    },
    #[serde(rename = "frame")]
    TargetFrame {
        captured_at_unix_us: u128,
        emitted_at_unix_us: u64,
        emitted_t_ns: u64,
        width: usize,
        height: usize,
        rotate: u32,
        cycle_elapsed_ms: f64,
        processing_ms: Option<f64>,
        generation: Option<u64>,
        threshold: f64,
        reference: serde_json::Value,
        bounds: serde_json::Value,
        area: serde_json::Value,
    },
    Status { at_unix_us: u64, at_t_ns: u64, state: &'static str, detail: Option<String> },
}

#[derive(Serialize)]
struct Person {
    score: f32,
    bounds: [f32; 4],
    area_px: f64,
}

impl Recorder {
    pub(super) fn start(path: &Path) -> io::Result<Self> {
        Self::start_with_schema(path, "person-follow-vision-v1")
    }

    pub(super) fn start_target(path: &Path) -> io::Result<Self> {
        Self::start_with_schema(path, "target-follow-vision-v1")
    }

    fn start_with_schema(path: &Path, schema: &'static str) -> io::Result<Self> {
        let mut file = File::create(path)?;
        write_line(&mut file, &serde_json::json!({
            "type": "metadata", "schema": schema,
            "started_at_unix_us": duck_ipc_proto::clock::realtime_ns() / 1000,
            "started_t_ns": duck_ipc_proto::clock::monotonic_ns(),
        }))?;
        let (tx, rx) = mpsc::sync_channel::<Envelope>(QUEUE_CAPACITY);
        std::thread::Builder::new().name("vision-record".into()).spawn(move || {
            let mut writer = BufWriter::with_capacity(64 * 1024, file);
            let mut dirty = false;
            loop {
                let result = match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(entry) => {
                        let stopped = matches!(&entry.event, RecordEvent::Status { state: "following_stopped", .. });
                        write_line(&mut writer, &entry).and_then(|()| {
                            dirty = true;
                            if stopped { writer.flush()?; dirty = false; }
                            Ok(())
                        })
                    }
                    Err(RecvTimeoutError::Timeout) if dirty => {
                        dirty = false;
                        writer.flush()
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => { let _ = writer.flush(); break; }
                };
                if let Err(error) = result {
                    tracing::error!(%error, schema, "vision recording stopped");
                    break;
                }
            }
        })?;
        tracing::info!(path = %path.display(), schema, "vision recording ready");
        Ok(Self { tx, dropped: Arc::new(AtomicU64::new(0)), following: Arc::new(Mutex::new(None)) })
    }

    fn send(&self, event: RecordEvent) {
        let entry = Envelope { dropped_total: self.dropped.load(Ordering::Relaxed), event };
        if let Err(TrySendError::Full(_)) = self.tx.try_send(entry) {
            let count = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if count == 1 || count % 100 == 0 {
                tracing::warn!(dropped = count, "vision recording queue full");
            }
        }
    }

    pub(super) fn set_following(&self, active: bool) {
        let mut following = self.following.lock().expect("vision recording lock poisoned");
        if following.is_some() == active { return; }
        let now = duck_ipc_proto::clock::realtime_ns() / 1000;
        *following = active.then_some(now);
        self.send(RecordEvent::Status {
            at_unix_us: now,
            at_t_ns: duck_ipc_proto::clock::monotonic_ns(),
            state: if active { "following_started" } else { "following_stopped" },
            detail: None,
        });
    }

    pub(super) fn frame(&self, captured_at_unix_us: u128, width: usize, height: usize,
        cycle_elapsed_ms: f64, objects: &[Object])
    {
        // Serialize transitions and non-blocking enqueue only; disk IO is on the writer thread.
        let following = self.following.lock().expect("vision recording lock poisoned");
        // A detection that finished just after start may have captured its frame before start.
        if following.is_none_or(|started| captured_at_unix_us < u128::from(started)) { return; }
        let emitted_at_unix_us = duck_ipc_proto::clock::realtime_ns() / 1000;
        let emitted_t_ns = duck_ipc_proto::clock::monotonic_ns();
        let persons: Vec<Person> = objects.iter().filter(|object| object.class == 0).map(|object| {
            let [left, top, right, bottom] = object.bounds.map(f64::from);
            Person { score: object.score, bounds: object.bounds,
                area_px: (right - left) * (bottom - top) }
        }).collect();
        // The browser chooses the first person when two boxes have the same area.
        let mut selected_index: Option<usize> = None;
        for (index, person) in persons.iter().enumerate() {
            if selected_index.is_none_or(|previous| person.area_px > persons[previous].area_px) {
                selected_index = Some(index);
            }
        }
        self.send(RecordEvent::Frame { captured_at_unix_us, emitted_at_unix_us, emitted_t_ns,
            width, height, cycle_elapsed_ms, persons, selected_index });
    }

    pub(super) fn target_frame(&self, captured_at_unix_us: u128, width: usize, height: usize,
        rotate: u32, cycle_elapsed_ms: f64, threshold: f64, event: &serde_json::Value)
    {
        let following = self.following.lock().expect("vision recording lock poisoned");
        if following.is_none_or(|started| captured_at_unix_us < u128::from(started))
            || event["type"].as_str() != Some("frame") { return; }
        self.send(RecordEvent::TargetFrame {
            captured_at_unix_us, emitted_at_unix_us: duck_ipc_proto::clock::realtime_ns() / 1000,
            emitted_t_ns: duck_ipc_proto::clock::monotonic_ns(), width, height, rotate, cycle_elapsed_ms,
            processing_ms: event["took_ms"].as_f64(), generation: event["generation"].as_u64(), threshold,
            reference: event["reference"].clone(), bounds: event["bounds"].clone(), area: event["area"].clone(),
        });
    }

    pub(super) fn status(&self, state: &'static str, detail: Option<String>) {
        let following = self.following.lock().expect("vision recording lock poisoned");
        if following.is_none() { return; }
        self.send(RecordEvent::Status { at_unix_us: duck_ipc_proto::clock::realtime_ns() / 1000,
            at_t_ns: duck_ipc_proto::clock::monotonic_ns(), state, detail });
    }
}

fn write_line(file: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer(&mut *file, value).map_err(io::Error::other)?;
    file.write_all(b"\n")
}
