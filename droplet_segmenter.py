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
from csbdeep.utils import normalize
from skimage.measure import regionprops
from stardist.models import StarDist2D

SCRIPT_ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL_NAME = "lipid_droplet_stardist_dense_ft2"
DEFAULT_MODEL_BASEDIR = SCRIPT_ROOT / "models"
DEFAULT_PROB_THRESH = 0.3
DEFAULT_NMS_THRESH = 0.2
MODEL_LABEL_PREFIX = "lipid_droplet_stardist_"


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
        resolved_path = Path(model_path)
        if not resolved_path.is_absolute():
            resolved_path = SCRIPT_ROOT / resolved_path
        if resolved_path.is_dir():
            return resolved_path.parent, resolved_path.name, resolved_path

    if model_dir:
        resolved_dir = Path(model_dir)
        if not resolved_dir.is_absolute():
            resolved_dir = SCRIPT_ROOT / resolved_dir
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


def build_objects(labels: np.ndarray, intensity_image: np.ndarray, min_diameter: float, max_diameter: float) -> list[dict]:
    objects: list[dict] = []
    for prop in regionprops(labels, intensity_image=intensity_image):
        area = float(prop.area)
        diameter = float(np.sqrt(4.0 * area / np.pi))
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
                "circularity": 1.0,
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

    gray = to_gray(rgb, payload.get("channel", "luma"))
    crop = gray[y0:y1, x0:x1]

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
            normalize(crop, 1, 99.8),
            prob_thresh=prob_thresh,
            nms_thresh=nms_thresh,
        )

    full_labels = np.zeros((height, width), dtype=np.int32)
    full_labels[y0:y1, x0:x1] = labels_crop.astype(np.int32, copy=False)
    objects = build_objects(full_labels, gray, min_diameter, max_diameter)
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
