#!/usr/bin/env python3
"""Persistent native colour detection worker for raw camera frames.

Each stdin record is one JSON line containing ``header`` and ``settings``,
followed immediately by exactly ``header.bytes`` UYVY bytes. Each request gets
one JSON response line. Coordinates stay in the unrotated camera image.
Import, decoding and protocol errors intentionally terminate the worker.
"""

import json
import math
import sys
import time

import cv2
import numpy as np


COLOR_BOUNDARY_MARGIN = 1e-6
LINE_REGIONS = ((0.90, 0.92, 0.7), (0.78, 0.80, 0.2), (0.66, 0.68, 0.1))
DISPLAY_ROTATIONS = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180,
                     270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def _integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a nonnegative integer")
    return value


def _number(value, name):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value)):
        raise ValueError(f"{name} must be finite")
    return value


def _vector(value, size, name):
    if not isinstance(value, (list, tuple)) or len(value) != size:
        raise ValueError(f"{name} must have {size} components")
    return [_number(component, name) for component in value]


def _frame_geometry(header):
    width = _integer(header["width"], "width")
    height = _integer(header["height"], "height")
    size = _integer(header["bytes"], "bytes")
    _integer(header["captured_at_unix_us"], "captured_at_unix_us")
    rotation = _integer(header["rotate"], "rotate")
    if width == 0 or width % 2 or height == 0:
        raise ValueError("UYVY requires a positive even width and positive height")
    if header["format"] != "UYVY":
        raise ValueError("frame format must be UYVY")
    if rotation not in (0, 90, 180, 270):
        raise ValueError("invalid camera rotation")
    if size != width * height * 2:
        raise ValueError("header.bytes does not match UYVY geometry")
    return width, height, size


def _upper_median(values):
    """Match the browser's sorted[Math.floor(length / 2)], including even sets."""
    values = np.asarray(values)
    middle = values.shape[0] // 2
    return np.partition(values, middle, axis=0)[middle]


def _upright_strip(uyvy, rotation, first, last):
    """Convert only the raw pixels that map to an upright horizontal strip."""
    if rotation in (0, 180):
        height = uyvy.shape[0]
        raw = uyvy[first:last] if rotation == 0 else uyvy[height-last:height-first]
        rgb = cv2.cvtColor(raw, cv2.COLOR_YUV2RGB_UYVY)
    else:
        width = uyvy.shape[1]
        left, right = (first, last) if rotation == 90 else (width-last, width-first)
        aligned_left, aligned_right = left & ~1, (right + 1) & ~1
        aligned = cv2.cvtColor(uyvy[:, aligned_left:aligned_right], cv2.COLOR_YUV2RGB_UYVY)
        rgb = aligned[:, left-aligned_left:right-aligned_left]
    return cv2.rotate(rgb, DISPLAY_ROTATIONS[rotation]) if rotation else rgb


class ColorDetectionEngine:
    """One independent sampling/detection session, reused across requests."""

    def __init__(self):
        self.generation = None
        self.mode = None
        self.point = None
        self.reference = None
        self.samples_rgb = []
        self.samples_lab = []
        self.sample_timestamps = set()
        self.kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        self.line_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        self.lookup_key = None
        self.lookup = None
        self.precise_lookup = None
        self.sum_channels = np.ones((1, 3), dtype=np.float32)

    def _configure(self, settings):
        generation = _integer(settings["generation"], "generation")
        if generation > 2**64 - 1:
            raise ValueError("generation must fit u64")
        threshold = _number(settings["threshold"], "threshold")
        if not 0 <= threshold <= 1:
            raise ValueError("threshold must be in [0, 1]")
        mode = settings["type"]
        if mode == "sample":
            point = _vector(settings["point"], 2, "point")
            if any(not 0 <= component < 1 for component in point):
                raise ValueError("point must be normalized raw image coordinates in [0, 1)")
            reference = None
        elif mode == "configure":
            reference = settings["reference"]
            rgb = _vector(reference["rgb"], 3, "reference.rgb")
            if any(type(value) is not int or not 0 <= value <= 255 for value in rgb):
                raise ValueError("reference.rgb must contain u8 values")
            lab = _vector(reference["lab"], 3, "reference.lab")
            if any(not 0 <= component <= 255 for component in lab):
                raise ValueError("reference.lab must use 8-bit Lab coordinates in [0, 255]")
            reference = {"rgb": rgb, "lab": lab}
            point = None
        else:
            raise ValueError(f"unknown colour settings type: {mode!r}")

        if (generation != self.generation
                or (mode == "sample" and (mode != self.mode or point != self.point))):
            self.generation = generation
            self.reference = None
            self.samples_rgb.clear()
            self.samples_lab.clear()
            self.sample_timestamps.clear()
        self.mode = mode
        self.point = point
        if mode == "configure":
            self.reference = reference
        return threshold

    def _sample(self, uyvy, timestamp):
        if timestamp in self.sample_timestamps:
            return
        height, width = uyvy.shape[:2]
        x = min(width - 1, math.floor(self.point[0] * width))
        y = min(height - 1, math.floor(self.point[1] * height))
        left, right = max(0, x - 2), min(width, x + 3)
        # A UYVY chroma pair starts at an even column. Convert the aligned crop,
        # then select the original sampling pixels.
        aligned_left = left & ~1
        aligned_right = (right + 1) & ~1
        crop = uyvy[max(0, y - 2):min(height, y + 3), aligned_left:aligned_right]
        rgb = cv2.cvtColor(crop, cv2.COLOR_YUV2RGB_UYVY)
        patch = rgb[:, left - aligned_left:right - aligned_left]
        lab = cv2.cvtColor(patch, cv2.COLOR_RGB2Lab)
        self.samples_rgb.append(_upper_median(patch.reshape(-1, 3)))
        self.samples_lab.append(_upper_median(lab.reshape(-1, 3)))
        self.sample_timestamps.add(timestamp)
        if len(self.samples_rgb) == 10:
            self.reference = {
                "rgb": _upper_median(self.samples_rgb).tolist(),
                "lab": _upper_median(self.samples_lab).tolist(),
            }

    def _color_mask(self, lab, threshold):
        lookup_key = (tuple(self.reference["lab"]), threshold)
        if lookup_key != self.lookup_key:
            delta = np.maximum(0.01, np.array([140.0, 60.0, 60.0]) * threshold)
            distance = (np.arange(256, dtype=np.float64)[:, None]
                        - self.reference["lab"]) / delta
            self.precise_lookup = (distance * distance).reshape(256, 1, 3)
            self.lookup = self.precise_lookup.astype(np.float32)
            self.lookup_key = lookup_key
        squared = cv2.LUT(lab, self.lookup)
        distance = cv2.transform(squared, self.sum_channels)
        # Sum of nonnegative terms. Near the decision boundary, recompute
        # using the original double-precision calculation to preserve equality.
        near_boundary = cv2.inRange(distance, 1.0 - COLOR_BOUNDARY_MARGIN, 1.0 + COLOR_BOUNDARY_MARGIN)
        if cv2.countNonZero(near_boundary):
            squared = cv2.LUT(lab, self.precise_lookup)
            distance = cv2.transform(squared, self.sum_channels)
        return cv2.compare(distance, 1.0, cv2.CMP_LE)

    def _detect(self, rgb, threshold):
        height, width = rgb.shape[:2]
        detection_width = 320
        # JavaScript Math.round rounds a positive half upward, unlike round().
        detection_height = max(1, math.floor(detection_width * height / width + 0.5))
        resized = cv2.resize(rgb, (detection_width, detection_height),
                             interpolation=cv2.INTER_LINEAR)
        lab = cv2.cvtColor(resized, cv2.COLOR_RGB2Lab)
        blurred = cv2.GaussianBlur(lab, (3, 3), 0.8)
        mask = self._color_mask(blurred, threshold)
        opened = cv2.dilate(cv2.erode(mask, self.kernel), self.kernel)
        contours, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL,
                                      cv2.CHAIN_APPROX_SIMPLE)
        selected = None
        selected_area = 40.0
        for contour in contours:
            area = cv2.contourArea(contour)
            if area > selected_area:
                selected, selected_area = contour, area
        if selected is None:
            return None, None
        x, y, box_width, box_height = cv2.boundingRect(selected)
        scale_x = width / detection_width
        scale_y = height / detection_height
        return ([x * scale_x, y * scale_y,
                 box_width * scale_x, box_height * scale_y],
                selected_area / (detection_width * detection_height))

    def _detect_line(self, uyvy, rotation, threshold):
        height, width = uyvy.shape[:2]
        if rotation in (90, 270):
            width, height = height, width
        detection_width = min(640, width)
        detection_height = max(1, round(height * detection_width / width))
        minimum_area = 30 * detection_width * detection_height / (640 * 360)
        regions = []
        weighted_center = weight_sum = 0.0
        for top, bottom, weight in LINE_REGIONS:
            center = None
            box = None
            rows = int(bottom * detection_height) - int(top * detection_height)
            if rows >= 3:
                first, last = int(top * height), int(bottom * height)
                rgb = _upright_strip(uyvy, rotation, first, last)
                strip = cv2.resize(rgb, (detection_width, rows), interpolation=cv2.INTER_AREA)
                lab = cv2.cvtColor(strip, cv2.COLOR_RGB2Lab)
                blurred = cv2.GaussianBlur(lab, (3, 3), 0.8)
                mask = self._color_mask(blurred, threshold)
                opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self.line_kernel)
                contours, _ = cv2.findContours(opened, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                contour = max(contours, key=cv2.contourArea, default=None)
                if contour is not None and cv2.contourArea(contour) > minimum_area:
                    rectangle = cv2.minAreaRect(contour)
                    (x, _), _, _ = rectangle
                    center = max(0.0, min(1.0, (x + 0.5) / detection_width))
                    corners = cv2.boxPoints(rectangle).astype(np.float64) + 0.5
                    corners[:, 0] /= detection_width
                    corners[:, 1] = (first + corners[:, 1] * (last - first) / rows) / height
                    box = corners.clip(0, 1).tolist()
                    weighted_center += center * weight
                    weight_sum += weight
            regions.append({"top": top, "bottom": bottom, "center": center, "box": box})
        center = weighted_center / weight_sum if weight_sum else None
        return {"center": center, "aspect": width / height, "regions": regions}

    def process_frame(self, header, data, settings):
        """Consume one raw frame and return one JSON-serializable event.

        Sampling requests with the same generation retain progress, even when
        threshold changes. A duplicate capture timestamp never counts twice.
        After sample ten, subsequent sample requests detect with that reference.
        Line following uses the upright image. Object bounds remain in raw coordinates.
        """
        started = time.perf_counter()
        width, height, size = _frame_geometry(header)
        if memoryview(data).nbytes != size:
            raise ValueError("raw frame byte length does not match header.bytes")
        threshold = self._configure(settings)
        uyvy = np.frombuffer(data, dtype=np.uint8).reshape(height, width, 2)
        if self.reference is None:
            self._sample(uyvy, header["captured_at_unix_us"])
            if self.reference is None:
                return {
                    "type": "sampling", "generation": self.generation,
                    "width": width, "height": height,
                    "point": self.point, "count": len(self.samples_rgb),
                }
        line = None
        if settings.get("line"):
            line = self._detect_line(uyvy, header["rotate"], threshold)
            bounds, area = None, None
        else:
            rgb = cv2.cvtColor(uyvy, cv2.COLOR_YUV2RGB_UYVY)
            bounds, area = self._detect(rgb, threshold)
        return {
            "type": "frame", "generation": self.generation,
            "width": width, "height": height,
            "captured_at_unix_us": header["captured_at_unix_us"],
            "took_ms": (time.perf_counter() - started) * 1000,
            "reference": self.reference, "bounds": bounds, "area": area,
            **({"line": line} if line is not None else {}),
        }


def run(input_stream, output_stream):
    """Read sequential length-prefixed records until a clean record boundary EOF."""
    engine = ColorDetectionEngine()
    payload = bytearray()
    while True:
        line = input_stream.readline()
        if not line:
            return
        request = json.loads(line)
        _, _, size = _frame_geometry(request["header"])
        if len(payload) != size:
            payload = bytearray(size)
        with memoryview(payload) as view:
            offset = 0
            while offset < size:
                count = input_stream.readinto(view[offset:])
                if not count:
                    raise EOFError("truncated raw UYVY frame")
                offset += count
        response = engine.process_frame(request["header"], payload, request["settings"])
        output_stream.write(json.dumps(response, allow_nan=False, separators=(",", ":")) + "\n")
        output_stream.flush()


if __name__ == "__main__":
    # At this image size, OpenCV's worker pool costs more CPU than it saves.
    cv2.setNumThreads(1)
    # OpenCV initializes its RGB-to-Lab lookup on the first conversion.
    cv2.cvtColor(np.zeros((5, 5, 3), dtype=np.uint8), cv2.COLOR_RGB2Lab)
    print('{"type":"ready"}', flush=True)
    run(sys.stdin.buffer, sys.stdout)
