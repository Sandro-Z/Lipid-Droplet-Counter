#!/usr/bin/env python3
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

def configure_runtime() -> str:
    # TensorFlow/StarDist GPU inference is fragile across desktop CUDA/cuDNN setups.
    # Default to CPU for app stability; allow explicit GPU opt-in via STARDIST_USE_GPU=1.
    use_gpu = os.environ.get("STARDIST_USE_GPU", "").strip().lower() in {"1", "true", "yes", "on"}
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    os.environ.setdefault("MPLCONFIGDIR", os.path.join(tempfile.gettempdir(), "lipid-droplet-counter-mpl"))
    if use_gpu:
        os.environ.setdefault("TF_FORCE_GPU_ALLOW_GROWTH", "true")
        return "gpu"
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    return "cpu"

RUNTIME_DEVICE = configure_runtime()

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from csbdeep.utils import normalize
from skimage.feature import peak_local_max
from skimage.filters import gaussian
from skimage.measure import regionprops
from skimage.segmentation import watershed
from stardist.models import StarDist2D

SCRIPT_ROOT = Path(__file__).resolve().parent
RESOURCE_ROOT = Path(os.environ.get("LDC_RESOURCE_ROOT") or SCRIPT_ROOT)
DEFAULT_MODEL_NAME = "lipid_droplet_stardist_dense_ft2"
DEFAULT_MODEL_BASEDIR = RESOURCE_ROOT / "models"
DEFAULT_PROB_THRESH = 0.3
DEFAULT_NMS_THRESH = 0.2
MODEL_LABEL_PREFIX = "lipid_droplet_stardist_"
SPLIT_MIN_CIRCULARITY = 0.86
SPLIT_DIAMETER_RATIO = 1.6
SPLIT_SCORE_INTENSITY_WEIGHT = 1.1
SPLIT_MAX_PARTS = 6
SPLIT_SMOOTH_SIGMA = 1.0


def resolve_resource_path(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        return candidate
    resource_candidate = RESOURCE_ROOT / candidate
    if resource_candidate.exists():
        return resource_candidate
    return SCRIPT_ROOT / candidate


def decode_image(data_url: str) -> np.ndarray:
    data = data_url.split(",", 1)[1] if "," in data_url else data_url
    image = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")
    return np.asarray(image)


def to_gray(rgb: np.ndarray, channel: str = "luma") -> np.ndarray:
    if channel == "red":
        return rgb[..., 0].astype(np.float32)
    if channel == "green":
        return rgb[..., 1].astype(np.float32)
    if channel == "blue":
        return rgb[..., 2].astype(np.float32)
    return (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.float32)


def decode_gray_image(data_url: str, channel: str = "luma") -> np.ndarray:
    return to_gray(decode_image(data_url), channel)


def encode_rle(flat: np.ndarray) -> list[int]:
    if flat.size == 0:
        return []
    runs: list[int] = []
    current = int(flat[0])
    length = 1
    for value in flat[1:]:
        value = int(value)
        if value == current:
            length += 1
        else:
            runs.append(length)
            current = value
            length = 1
    runs.append(length)
    return runs


def resolve_model(payload: dict) -> tuple[Path, str, Path]:
    model_name = payload.get("modelName") or os.environ.get("STARDIST_MODEL_NAME") or DEFAULT_MODEL_NAME
    model_dir = payload.get("modelDir") or os.environ.get("STARDIST_MODEL_DIR")
    model_path = payload.get("modelPath") or os.environ.get("STARDIST_MODEL_PATH")

    if model_path:
        resolved_path = resolve_resource_path(model_path)
        if resolved_path.is_dir():
            return resolved_path.parent, resolved_path.name, resolved_path

    if model_dir:
        resolved_dir = resolve_resource_path(model_dir)
    else:
        resolved_dir = DEFAULT_MODEL_BASEDIR

    return resolved_dir, model_name, resolved_dir / model_name


def load_thresholds(model_path: Path) -> tuple[float, float]:
    threshold_path = model_path / "thresholds.json"
    if not threshold_path.exists():
        return DEFAULT_PROB_THRESH, DEFAULT_NMS_THRESH

    try:
        data = json.loads(threshold_path.read_text(encoding="utf-8"))
    except Exception:
        return DEFAULT_PROB_THRESH, DEFAULT_NMS_THRESH

    prob_thresh = float(data.get("prob", data.get("prob_thresh", DEFAULT_PROB_THRESH)))
    nms_thresh = float(data.get("nms", data.get("nms_thresh", DEFAULT_NMS_THRESH)))
    return prob_thresh, nms_thresh


def clamp_bounds(bounds: dict | None, width: int, height: int) -> tuple[int, int, int, int]:
    bounds = bounds or {}
    x0 = max(0, min(width, int(bounds.get("x0", 0))))
    y0 = max(0, min(height, int(bounds.get("y0", 0))))
    x1 = max(0, min(width, int(bounds.get("x1", width))))
    y1 = max(0, min(height, int(bounds.get("y1", height))))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return x0, y0, x1, y1


def model_label(model_name: str) -> str:
    if model_name.startswith(MODEL_LABEL_PREFIX):
        return model_name[len(MODEL_LABEL_PREFIX):]
    return model_name


def validate_shape(image: np.ndarray, expected_hw: tuple[int, int], label: str) -> None:
    if image.shape[:2] != expected_hw:
        raise ValueError(f"{label} shape mismatch: expected {expected_hw}, got {image.shape[:2]}")


def equivalent_diameter(area: float) -> float:
    return float(np.sqrt(4.0 * area / np.pi))


def circularity(area: float, perimeter: float) -> float:
    if perimeter <= 0:
        return 1.0
    return float((4.0 * np.pi * area) / (perimeter * perimeter + 1e-6))


def should_try_split(prop, min_diameter: float) -> bool:
    diameter = equivalent_diameter(float(prop.area))
    if diameter < max(6.0, min_diameter * SPLIT_DIAMETER_RATIO):
        return False

    minr, minc, maxr, maxc = prop.bbox
    height = maxr - minr
    width = maxc - minc
    aspect_ratio = max(height, width) / max(1, min(height, width))
    return (
        circularity(float(prop.area), float(prop.perimeter)) < SPLIT_MIN_CIRCULARITY
        or float(prop.solidity) < 0.94
        or aspect_ratio > 1.35
    )


def split_instance_mask(mask: np.ndarray, intensity_image: np.ndarray, min_diameter: float) -> np.ndarray:
    if int(mask.sum()) < 12:
        return mask.astype(np.int32)

    distance = ndi.distance_transform_edt(mask)
    if float(distance.max()) < 1.5:
        return mask.astype(np.int32)

    values = intensity_image[mask]
    lo = float(np.percentile(values, 10))
    hi = float(np.percentile(values, 90))
    if hi > lo:
        intensity_norm = np.clip((intensity_image - lo) / (hi - lo), 0.0, 1.0)
    else:
        intensity_norm = np.zeros_like(intensity_image, dtype=np.float32)

    score = distance + intensity_norm * max(1.0, min_diameter * SPLIT_SCORE_INTENSITY_WEIGHT * 0.25)
    peak_threshold = max(1.0, float(distance.max()) * 0.55)
    peak_distance = max(2, int(round(max(min_diameter, 3.0) * 0.45)))
    coords = peak_local_max(
        score,
        labels=mask.astype(np.uint8),
        min_distance=peak_distance,
        threshold_abs=peak_threshold,
        exclude_border=False,
    )
    if len(coords) <= 1:
        return mask.astype(np.int32)

    min_split_area = max(4, int(round(np.pi * max(min_diameter * 0.3, 1.2) ** 2)))
    max_parts = int(np.clip(mask.sum() // max(1, min_split_area), 2, SPLIT_MAX_PARTS))
    if len(coords) > max_parts:
        peak_scores = score[coords[:, 0], coords[:, 1]]
        coords = coords[np.argsort(peak_scores)[::-1][:max_parts]]

    markers = np.zeros(mask.shape, dtype=np.int32)
    for marker_id, (row, col) in enumerate(coords, start=1):
        markers[int(row), int(col)] = marker_id

    split_labels = watershed(-score, markers, mask=mask)
    counts = np.bincount(split_labels.ravel())
    keep_ids = [label_id for label_id in range(1, len(counts)) if counts[label_id] >= min_split_area]
    if len(keep_ids) <= 1:
        return mask.astype(np.int32)

    if len(keep_ids) != int(split_labels.max()):
        keep_markers = np.zeros_like(markers)
        for new_id, old_id in enumerate(keep_ids, start=1):
            keep_markers[split_labels == old_id] = new_id
        split_labels = watershed(-score, keep_markers, mask=mask)

    return split_labels.astype(np.int32, copy=False)


def split_crowded_instances(labels: np.ndarray, intensity_image: np.ndarray, min_diameter: float) -> tuple[np.ndarray, int]:
    if int(labels.max()) == 0:
        return labels.astype(np.int32, copy=False), 0

    smooth = gaussian(intensity_image.astype(np.float32), sigma=SPLIT_SMOOTH_SIGMA, preserve_range=True).astype(np.float32)
    out = np.zeros_like(labels, dtype=np.int32)
    next_label = 1
    split_count = 0

    for prop in regionprops(labels, intensity_image=smooth):
        region_mask = labels[prop.slice] == prop.label
        local_labels = region_mask.astype(np.int32)
        if should_try_split(prop, min_diameter):
            candidate = split_instance_mask(region_mask, smooth[prop.slice], min_diameter)
            if int(candidate.max()) > 1:
                local_labels = candidate
                split_count += int(candidate.max()) - 1

        target = out[prop.slice]
        for local_id in range(1, int(local_labels.max()) + 1):
            target[local_labels == local_id] = next_label
            next_label += 1

    return out, split_count


def build_objects(labels: np.ndarray, intensity_image: np.ndarray, min_diameter: float, max_diameter: float) -> list[dict]:
    objects: list[dict] = []
    for prop in regionprops(labels, intensity_image=intensity_image):
        area = float(prop.area)
        diameter = equivalent_diameter(area)
        if diameter < min_diameter or diameter > max_diameter:
            labels[labels == prop.label] = 0
            continue

        cy, cx = prop.centroid
        minr, minc, maxr, maxc = prop.bbox
        objects.append(
            {
                "id": len(objects) + 1,
                "x": float(cx),
                "y": float(cy),
                "area": area,
                "equivalentDiameter": diameter,
                "circularity": circularity(area, float(prop.perimeter)),
                "meanSignal": float(prop.mean_intensity),
                "minX": int(minc),
                "maxX": int(maxc - 1),
                "minY": int(minr),
                "maxY": int(maxr - 1),
            }
        )
    return objects


def main() -> None:
    payload = json.load(sys.stdin)

    rgb = decode_image(payload["imagePng"])
    height, width = rgb.shape[:2]
    x0, y0, x1, y1 = clamp_bounds(payload.get("bounds"), width, height)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("ROI too small for StarDist inference")

    raw_gray = to_gray(rgb, payload.get("channel", "luma"))
    measurement_gray = decode_gray_image(payload["measurementPng"]) if payload.get("measurementPng") else raw_gray
    analysis_gray = decode_gray_image(payload["analysisPng"]) if payload.get("analysisPng") else measurement_gray
    validate_shape(measurement_gray, (height, width), "measurementPng")
    validate_shape(analysis_gray, (height, width), "analysisPng")

    crop = analysis_gray[y0:y1, x0:x1]
    crop_norm = normalize(crop, 1, 99.8).astype(np.float32)

    model_dir, model_name, model_path = resolve_model(payload)
    if not model_path.exists():
        raise FileNotFoundError(f"Model directory not found: {model_path}")

    default_prob_thresh, default_nms_thresh = load_thresholds(model_path)
    prob_thresh = float(payload.get("probThresh", default_prob_thresh))
    nms_thresh = float(payload.get("nmsThresh", default_nms_thresh))
    min_diameter = float(payload.get("minDiameter", 0))
    max_diameter = float(payload.get("maxDiameter", 99999))

    with contextlib.redirect_stdout(sys.stderr):
        model = StarDist2D(None, name=model_name, basedir=model_dir.as_posix())
        labels_crop, _ = model.predict_instances(
            crop_norm,
            prob_thresh=prob_thresh,
            nms_thresh=nms_thresh,
        )

    labels_crop, split_count = split_crowded_instances(
        labels_crop.astype(np.int32, copy=False),
        crop_norm,
        min_diameter=max(0.0, min_diameter),
    )

    full_labels = np.zeros((height, width), dtype=np.int32)
    full_labels[y0:y1, x0:x1] = labels_crop
    objects = build_objects(full_labels, measurement_gray, min_diameter, max_diameter)
    mask = (full_labels > 0).astype(np.uint8)

    print(
        json.dumps(
            {
                "ok": True,
                "width": width,
                "height": height,
                "objects": objects,
                "maskStart": int(mask.ravel()[0]),
                "maskRle": encode_rle(mask.ravel()),
                "modelName": model_name,
                "modelLabel": model_label(model_name),
                "probThresh": prob_thresh,
                "nmsThresh": nms_thresh,
                "splitCount": split_count,
                "runtimeDevice": RUNTIME_DEVICE,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "runtimeDevice": RUNTIME_DEVICE}, ensure_ascii=False))
