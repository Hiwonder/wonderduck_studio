use anyhow::{Context, Result, ensure};
use duck_detect::{Letterbox, objects::Object};

pub(super) const DEFAULT_PERSON_CONFIDENCE: f32 = 0.5;
const YOLOV6N_CANDIDATES: usize = 5376;
const NMS_THRESHOLD: f32 = 0.45;
const MAX_DETECTIONS: usize = 300;

const YOLOV5S_RELU_ANCHORS: [[[f32; 2]; 3]; 3] = [
    [[10.0, 13.0], [16.0, 30.0], [33.0, 23.0]],
    [[30.0, 61.0], [62.0, 45.0], [59.0, 119.0]],
    [[116.0, 90.0], [156.0, 198.0], [373.0, 326.0]],
];

pub(super) struct YoloV5Head {
    index: usize,
    columns: usize,
    rows: usize,
    channels_first: bool,
}

pub(super) struct PersonDecoder([YoloV5Head; 3]);

pub(super) struct Yolov6nDecoder {
    scores: usize,
    boxes: usize,
}

impl Yolov6nDecoder {
    pub(super) fn new(shapes: &[Vec<i64>]) -> Result<Self> {
        let candidates = YOLOV6N_CANDIDATES as i64;
        let scores = shapes
            .iter()
            .position(|shape| shape == &[1, 1, candidates])
            .context("missing YOLOv6n person scores [1, 1, 5376]")?;
        let boxes = shapes
            .iter()
            .position(|shape| shape == &[1, candidates, 4])
            .context("missing YOLOv6n person boxes [1, 5376, 4]")?;
        Ok(Self { scores, boxes })
    }

    pub(super) fn decode(
        &self,
        outputs: &[&[f32]],
        fit: Letterbox,
        width: usize,
        height: usize,
        threshold: f32,
    ) -> Result<Vec<Object>> {
        let scores = outputs.get(self.scores).context("missing YOLOv6n scores")?;
        let boxes = outputs.get(self.boxes).context("missing YOLOv6n boxes")?;
        ensure!(
            scores.len() == YOLOV6N_CANDIDATES && boxes.len() == 4 * YOLOV6N_CANDIDATES,
            "invalid YOLOv6n person tensor lengths"
        );
        let limit = [width as f32, height as f32];
        let pad = [fit.pad_x, fit.pad_y];
        let mut candidates = Vec::new();
        for (&score, coords) in scores.iter().zip(boxes.chunks_exact(4)) {
            if !score.is_finite()
                || score < threshold
                || !coords.iter().all(|val| val.is_finite())
            {
                continue;
            }
            let bounds: [f32; 4] = std::array::from_fn(|axis| {
                let dimension = axis % 2;
                ((coords[axis] - pad[dimension]) / fit.scale).clamp(0.0, limit[dimension])
            });
            if bounds[2] > bounds[0] && bounds[3] > bounds[1] {
                candidates.push(Object {
                    class: 0,
                    score,
                    bounds,
                });
            }
        }
        Ok(suppress(candidates))
    }
}

impl PersonDecoder {
    pub(super) fn yolov5s_relu(
        shapes: &[Vec<i64>],
        (width, height): (usize, usize),
    ) -> Result<Self> {
        ensure!(
            shapes.len() == 3,
            "YOLOv5s-ReLU requires three output tensors"
        );
        let head = |stride: usize| {
            let (columns, rows) = (width / stride, height / stride);
            let (w, h) = (columns as i64, rows as i64);
            shapes
                .iter()
                .enumerate()
                .find_map(|(index, shape)| {
                    let channels_first = shape == &[1, 18, h, w];
                    (channels_first || shape == &[1, h, w, 18]).then_some(YoloV5Head {
                        index,
                        columns,
                        rows,
                        channels_first,
                    })
                })
                .with_context(|| format!("missing YOLOv5s-ReLU {columns}×{rows} output"))
        };
        Ok(Self([head(8)?, head(16)?, head(32)?]))
    }

    pub(super) fn decode(
        &self,
        outputs: &[&[f32]],
        fit: Letterbox,
        width: usize,
        height: usize,
        threshold: f32,
    ) -> Result<Vec<Object>> {
        ensure!(
            fit.scale.is_finite()
                && fit.scale > 0.0
                && fit.pad_x.is_finite()
                && fit.pad_y.is_finite()
                && width > 0
                && height > 0,
            "invalid frame geometry"
        );
        let limit = [width as f32, height as f32];
        let pad = [fit.pad_x, fit.pad_y];
        let mut candidates = Vec::new();
        let mut add = |score, xyxy: [f32; 4]| {
            if !xyxy.iter().all(|value| value.is_finite()) {
                return;
            }
            let bounds: [f32; 4] = std::array::from_fn(|axis| {
                let dimension = axis % 2;
                ((xyxy[axis] - pad[dimension]) / fit.scale).clamp(0.0, limit[dimension])
            });
            if bounds[2] > bounds[0] && bounds[3] > bounds[1] {
                candidates.push(Object {
                    class: 0,
                    score,
                    bounds,
                });
            }
        };

        for (level, (head, anchors)) in self.0.iter().zip(YOLOV5S_RELU_ANCHORS).enumerate() {
            let stride = (8 << level) as f32;
            let cells = head.columns * head.rows;
            let values = outputs
                .get(head.index)
                .context("missing YOLOv5s-ReLU output")?;
            ensure!(
                values.len() == cells * 18,
                "invalid YOLOv5s-ReLU output length"
            );
            for cell in 0..cells {
                for (anchor, [anchor_width, anchor_height]) in anchors.into_iter().enumerate() {
                    // Each anchor holds x, y, w, h, objectness and person probability.
                    let value = |field| {
                        let channel = anchor * 6 + field;
                        if head.channels_first {
                            values[channel * cells + cell]
                        } else {
                            values[cell * 18 + channel]
                        }
                    };
                    let score = value(4) * value(5);
                    if !score.is_finite() || score < threshold {
                        continue;
                    }
                    let x = (value(0) * 2.0 - 0.5 + (cell % head.columns) as f32) * stride;
                    let y = (value(1) * 2.0 - 0.5 + (cell / head.columns) as f32) * stride;
                    let half_width = (value(2) * 2.0).powi(2) * anchor_width * 0.5;
                    let half_height = (value(3) * 2.0).powi(2) * anchor_height * 0.5;
                    add(
                        score,
                        [
                            x - half_width,
                            y - half_height,
                            x + half_width,
                            y + half_height,
                        ],
                    );
                }
            }
        }

        Ok(suppress(candidates))
    }
}

fn suppress(mut candidates: Vec<Object>) -> Vec<Object> {
    candidates.sort_unstable_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Object> = Vec::new();
    for candidate in candidates {
        if kept
            .iter()
            .all(|prior| overlap(prior.bounds, candidate.bounds) <= NMS_THRESHOLD)
        {
            kept.push(candidate);
            if kept.len() == MAX_DETECTIONS {
                break;
            }
        }
    }
    kept
}

fn overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let width = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let height = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let intersection = width * height;
    let area_a = (a[2] - a[0]) * (a[3] - a[1]);
    let area_b = (b[2] - b[0]) * (b[3] - b[1]);
    intersection / (area_a + area_b - intersection)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIT: Letterbox = Letterbox {
        scale: 0.5,
        pad_x: 0.0,
        pad_y: 140.0,
    };

    #[test]
    fn yolov5s_relu_decodes_both_head_layouts() {
        let grid = 40;
        let cell = 12 * grid + 10;
        let anchor = 1;
        let fields = [0.5, 0.5, 0.5, 0.5, 0.5, 0.6];
        let small = vec![0.0; 20 * 20 * 18];
        let large = vec![0.0; 80 * 80 * 18];
        for channels_first in [false, true] {
            let shape = if channels_first {
                vec![1, 18, 40, 40]
            } else {
                vec![1, 40, 40, 18]
            };
            let decoder = PersonDecoder::yolov5s_relu(
                &[vec![1, 20, 20, 18], shape, vec![1, 80, 80, 18]],
                (640, 640),
            )
            .unwrap();
            let mut medium = vec![0.0; grid * grid * 18];
            for (field, value) in fields.into_iter().enumerate() {
                let channel = anchor * 6 + field;
                let index = if channels_first {
                    channel * grid * grid + cell
                } else {
                    cell * 18 + channel
                };
                medium[index] = value;
            }
            assert!(decoder.decode(&[&small, &medium, &large], FIT, 1280, 720, DEFAULT_PERSON_CONFIDENCE)
                .unwrap().is_empty());
            let objects = decoder
                .decode(&[&small, &medium, &large], FIT, 1280, 720, 0.26)
                .unwrap();
            assert_eq!(
                objects,
                [Object {
                    class: 0,
                    score: 0.3,
                    bounds: [274.0, 75.0, 398.0, 165.0]
                }]
            );
        }
    }

    #[test]
    fn yolov5s_relu_wide_maps_detections_to_the_full_frame() {
        let decoder = PersonDecoder::yolov5s_relu(
            &[
                vec![1, 48, 80, 18],
                vec![1, 24, 40, 18],
                vec![1, 12, 20, 18],
            ],
            (640, 384),
        )
        .unwrap();
        let large = vec![0.0; 48 * 80 * 18];
        let mut medium = vec![0.0; 24 * 40 * 18];
        let small = vec![0.0; 12 * 20 * 18];
        let anchor_start = (6 * 40 + 10) * 18 + 6;
        medium[anchor_start..anchor_start + 6].copy_from_slice(&[0.5, 0.5, 0.5, 0.5, 1.0, 0.6]);
        let (fit, _, _) = uyvy::letterbox_rect_layout(1280, 720, (640, 384), uyvy::Turn::None);
        let objects = decoder
            .decode(&[&large, &medium, &small], fit, 1280, 720, DEFAULT_PERSON_CONFIDENCE)
            .unwrap();

        assert_eq!(
            objects,
            [Object {
                class: 0,
                score: 0.6,
                bounds: [274.0, 139.0, 398.0, 229.0],
            }]
        );
    }

    #[test]
    fn yolov6n_decodes_and_suppresses_overlapping_person_boxes() {
        let decoder = Yolov6nDecoder::new(&[vec![1, 5376, 4], vec![1, 1, 5376]]).unwrap();
        let mut boxes = vec![0.0; 4 * YOLOV6N_CANDIDATES];
        boxes[..12].copy_from_slice(&[
            80.0, 152.0, 240.0, 272.0, 82.0, 154.0, 242.0, 274.0, 320.0, 152.0, 400.0, 272.0,
        ]);
        let mut scores = vec![0.0; YOLOV6N_CANDIDATES];
        scores[..3].copy_from_slice(&[0.9, 0.8, 0.39]);
        let fit = Letterbox {
            scale: 0.8,
            pad_x: 0.0,
            pad_y: 112.0,
        };
        let objects = decoder.decode(&[&boxes, &scores], fit, 640, 360, DEFAULT_PERSON_CONFIDENCE).unwrap();
        assert_eq!(
            objects,
            [Object {
                class: 0,
                score: 0.9,
                bounds: [100.0, 50.0, 300.0, 200.0]
            }]
        );
    }
}
