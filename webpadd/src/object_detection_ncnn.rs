//! The persistent ncnn runner for the person detector.

use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, ensure};

use super::object_detection::PersonModel;

const YOLO26_OUTPUTS: &[&[i64]] = &[&[1, 80, 8400], &[1, 4, 8400]];
const YOLOV5_OUTPUTS: &[&[i64]] = &[&[1, 48, 80, 18], &[1, 24, 40, 18], &[1, 12, 20, 18]];
const YOLOV6_OUTPUTS: &[&[i64]] = &[&[1, 5376, 4], &[1, 1, 5376]];
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn configured_runner(model: &Path) -> Option<PathBuf> {
    let runner = std::env::var_os("WONDERDUCK_OBJECT_GPU_RUNNER")?;
    let has_assets =
        model.with_extension("param").is_file() && model.with_extension("bin").is_file();
    has_assets.then(|| PathBuf::from(runner))
}

pub(super) struct Model {
    child: Child,
    stream: UnixStream,
    kind: PersonModel,
    output_shapes: &'static [&'static [i64]],
    output_sizes: Vec<usize>,
    output_bytes: Vec<u8>,
    output: Vec<f32>,
}

impl Model {
    pub(super) fn open(runner: &Path, model: &Path, kind: PersonModel) -> Result<Self> {
        let param = model.with_extension("param");
        let bin = model.with_extension("bin");
        ensure!(param.is_file(), "missing ncnn model {}", param.display());
        ensure!(bin.is_file(), "missing ncnn weights {}", bin.display());

        // The runner accepts no model argument for YOLO26n to support earlier installations.
        let (model_argument, output_shapes) = match kind {
            PersonModel::Yolo26n => (None, YOLO26_OUTPUTS),
            PersonModel::Yolov5sReluWide => (Some("yolov5s-relu-640x384"), YOLOV5_OUTPUTS),
            PersonModel::Yolov6n512 => (Some("yolov6n-512x512"), YOLOV6_OUTPUTS),
        };
        let output_sizes: Vec<usize> = output_shapes
            .iter()
            .map(|shape| shape.iter().map(|&dimension| dimension as usize).product())
            .collect();
        let output_count = output_sizes.iter().sum();

        let cpu = kind == PersonModel::Yolov6n512;
        let backend = if cpu { "CPU" } else { "Vulkan" };

        // One socket pair supplies the runner's stdin and stdout.
        let (stream, child_stream) = UnixStream::pair().context("create ncnn runner socket")?;
        stream.set_read_timeout(Some(STARTUP_TIMEOUT))?;
        stream.set_write_timeout(Some(FRAME_TIMEOUT))?;
        let child = Command::new(runner)
            .arg(&param)
            .arg(&bin)
            .args(model_argument)
            .args(cpu.then_some("--cpu"))
            .stdin(OwnedFd::from(child_stream.try_clone()?))
            .stdout(OwnedFd::from(child_stream))
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("start ncnn runner {}", runner.display()))?;
        let mut model = Self {
            child,
            stream,
            kind,
            output_shapes,
            output_sizes,
            output_bytes: vec![0; output_count * size_of::<f32>()],
            output: vec![0.0; output_count],
        };
        let mut ready = [0; 6];
        model.stream.read_exact(&mut ready).with_context(|| {
            format!("wait for ncnn runner {} to initialize", runner.display())
        })?;
        ensure!(
            &ready == b"READY\n",
            "ncnn runner sent an invalid startup response"
        );
        model.stream.set_read_timeout(Some(FRAME_TIMEOUT))?;
        tracing::info!(?kind, backend, runner = %runner.display(), model = %param.display(), "ncnn object detector started");
        Ok(model)
    }

    pub(super) fn output_shapes(&self) -> Vec<Vec<i64>> {
        self.output_shapes
            .iter()
            .map(|shape| shape.to_vec())
            .collect()
    }

    pub(super) fn infer_with<T>(
        &mut self,
        rgb: &[u8],
        decode: impl FnOnce(&[&[f32]]) -> Result<T>,
    ) -> Result<T> {
        let (height, width, channels) = self.kind.input();
        ensure!(
            rgb.len() == width * height * channels,
            "ncnn runner expects {width}×{height} RGB input"
        );
        self.stream
            .write_all(rgb)
            .context("send RGB frame to ncnn runner")?;
        self.stream
            .read_exact(&mut self.output_bytes)
            .context("read detection tensors from ncnn runner")?;
        for (value, bytes) in self
            .output
            .iter_mut()
            .zip(self.output_bytes.as_chunks::<4>().0)
        {
            *value = f32::from_le_bytes(*bytes);
        }
        let mut remaining = self.output.as_slice();
        let mut outputs = [&[][..]; 3];
        for (output, &size) in outputs.iter_mut().zip(&self.output_sizes) {
            (*output, remaining) = remaining.split_at(size);
        }
        decode(&outputs[..self.output_sizes.len()])
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
