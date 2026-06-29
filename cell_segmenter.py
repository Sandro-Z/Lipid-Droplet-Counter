#!/usr/bin/env python3
import base64
import io
import json
import os
import sys
import traceback
from contextlib import suppress
from pathlib import Path

SCRIPT_ROOT = Path(__file__).resolve().parent
RESOURCE_ROOT = Path(os.environ.get("LDC_RESOURCE_ROOT") or SCRIPT_ROOT)


def user_data_dir():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Lipid Droplet Counter")
    if sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        return os.path.join(base, "Lipid Droplet Counter")
    return os.path.join(home, ".local", "share", "Lipid Droplet Counter")


def add_dependency_paths():
    candidates = [
        os.environ.get("SAM_PYTHONPATH"),
        os.path.join(SCRIPT_ROOT, "python_modules"),
        os.path.join(RESOURCE_ROOT, "python_modules"),
        os.path.join(os.getcwd(), "python_modules"),
        os.path.join(user_data_dir(), "python_modules"),
    ]
    for path in reversed([item for item in candidates if item]):
        if os.path.isdir(path) and path not in sys.path:
            sys.path.insert(0, path)


add_dependency_paths()

try:
    import numpy as np
    import torch
    from PIL import Image
    from segment_anything import SamPredictor, sam_model_registry
except Exception as exc:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "需要安装 Meta segment-anything、torch、Pillow 和 numpy 后才能运行 SAM 分割",
                "detail": repr(exc),
            },
            ensure_ascii=False,
        )
    )
    sys.exit(0)


def main():
    payload = json.load(sys.stdin)
    image = decode_image(payload["imagePng"])
    checkpoint = resolve_checkpoint(payload)
    model_type = payload.get("modelType") or os.environ.get("SAM_MODEL_TYPE", "vit_b")

    if not checkpoint or not os.path.exists(checkpoint):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "未找到 SAM checkpoint。请设置 SAM_CHECKPOINT，或将 sam_vit_b_01ec64.pth 放到项目的 models/ 目录。",
                    "detail": checkpoint or "",
                },
                ensure_ascii=False,
            )
        )
        return

    point_coords, point_labels = build_points(payload.get("points", []))
    box = build_box(payload.get("box"))
    if point_coords is None and box is None:
        print(json.dumps({"ok": False, "error": "SAM 至少需要一个点或一个框选区域"}, ensure_ascii=False))
        return

    try:
        result = run_sam_inference(
            image=image,
            checkpoint=checkpoint,
            model_type=model_type,
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            payload=payload,
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "SAM 分割失败",
                    "detail": f"{type(exc).__name__}: {exc}",
                },
                ensure_ascii=False,
            )
        )
        return

    print(
        json.dumps(
            {
                "ok": True,
                "width": int(result["mask"].shape[1]),
                "height": int(result["mask"].shape[0]),
                "score": float(result["score"]),
                "maskStart": int(result["mask"].ravel()[0]),
                "maskRle": encode_rle(result["mask"].ravel()),
                "device": result["device"],
                "warning": result.get("warning", ""),
            },
            ensure_ascii=False,
        )
    )


def run_sam_inference(image, checkpoint, model_type, point_coords, point_labels, box, payload):
    last_error = None
    warning = ""

    for device in preferred_devices(payload):
        try:
            mask, score = predict_mask(
                image=image,
                checkpoint=checkpoint,
                model_type=model_type,
                point_coords=point_coords,
                point_labels=point_labels,
                box=box,
                device=device,
            )
            return {
                "mask": mask,
                "score": score,
                "device": device,
                "warning": warning,
            }
        except Exception as exc:
            last_error = exc
            if device == "cuda" and should_retry_on_cpu(exc):
                warning = f"检测到 CUDA 运行异常，已自动切换到 CPU：{type(exc).__name__}"
                release_device_cache(device)
                continue
            raise

    if last_error is not None:
        raise last_error
    raise RuntimeError("SAM 未执行任何推理尝试")


def predict_mask(image, checkpoint, model_type, point_coords, point_labels, box, device):
    sam = sam_model_registry[model_type](checkpoint=checkpoint)
    sam.to(device=device)
    sam.eval()
    predictor = SamPredictor(sam)

    try:
        predictor.set_image(image)
        masks, scores, _ = predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            multimask_output=True,
        )
        best_index = choose_mask(masks, scores, point_coords, point_labels, box)
        return masks[best_index].astype(np.uint8), float(scores[best_index])
    finally:
        del predictor
        del sam
        release_device_cache(device)


def preferred_devices(payload):
    explicit_device = str(payload.get("device") or os.environ.get("SAM_DEVICE") or "").strip().lower()
    if explicit_device == "cpu":
        return ["cpu"]
    if explicit_device == "cuda":
        return ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]

    if explicit_device in {"cpu", "cuda"}:
        return [explicit_device]

    use_gpu_override = str(os.environ.get("SAM_USE_GPU", "")).strip().lower()
    if use_gpu_override in {"0", "false", "no", "off"}:
        return ["cpu"]
    if use_gpu_override in {"1", "true", "yes", "on"}:
        return ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]

    if torch.cuda.is_available():
        return ["cuda", "cpu"]
    return ["cpu"]


def should_retry_on_cpu(exc):
    message = f"{type(exc).__name__}: {exc}".lower()
    cuda_tokens = (
        "cuda",
        "kernel image",
        "cudnn",
        "cublas",
        "cufft",
        "curand",
        "cusolver",
        "cusparse",
        "nvrtc",
        "driver",
        "device-side",
        "tensor descriptor",
    )
    return any(token in message for token in cuda_tokens)


def release_device_cache(device):
    if device != "cuda":
        return
    if torch.cuda.is_available():
        with suppress(Exception):
            torch.cuda.empty_cache()


def resolve_checkpoint(payload):
    checkpoint = payload.get("checkpoint") or os.environ.get("SAM_CHECKPOINT")
    if checkpoint:
        return checkpoint
    user_model = Path(user_data_dir()) / "models" / "sam_vit_b_01ec64.pth"
    candidates = [
        RESOURCE_ROOT / "models" / "sam_vit_b_01ec64.pth",
        SCRIPT_ROOT / "models" / "sam_vit_b_01ec64.pth",
        user_model,
        Path(os.getcwd()) / "models" / "sam_vit_b_01ec64.pth",
    ]
    for item in candidates:
        if item.exists():
            return os.fspath(item)
    return os.fspath(candidates[0])


def decode_image(data_url):
    data = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = base64.b64decode(data)
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    return np.asarray(image)


def build_points(points):
    if not points:
        return None, None
    coords = np.asarray([[float(p["x"]), float(p["y"])] for p in points], dtype=np.float32)
    labels = np.asarray([int(p.get("label", 1)) for p in points], dtype=np.int32)
    return coords, labels


def build_box(box):
    if not box:
        return None
    x0 = min(float(box["x0"]), float(box["x1"]))
    y0 = min(float(box["y0"]), float(box["y1"]))
    x1 = max(float(box["x0"]), float(box["x1"]))
    y1 = max(float(box["y0"]), float(box["y1"]))
    return np.asarray([x0, y0, x1, y1], dtype=np.float32)


def choose_mask(masks, scores, point_coords, point_labels, box):
    height, width = masks[0].shape
    image_area = max(1, height * width)
    best_index = 0
    best_score = -1e9

    if box is not None:
        box_area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
    else:
        box_area = None

    for index, mask in enumerate(masks):
        area = float(mask.sum())
        adjusted = float(scores[index])

        if box_area is not None:
            area_ratio = area / box_area
            if area_ratio > 1.18:
                adjusted -= min(1.0, (area_ratio - 1.18) * 1.8)
            if area_ratio < 0.025:
                adjusted -= 0.45
        else:
            area_ratio = area / image_area
            if area_ratio > 0.62:
                adjusted -= min(1.1, (area_ratio - 0.62) * 2.2)
            if area_ratio < 0.008:
                adjusted -= 0.3

        if point_coords is not None and point_labels is not None:
            for point, label in zip(point_coords, point_labels):
                x = int(np.clip(round(float(point[0])), 0, width - 1))
                y = int(np.clip(round(float(point[1])), 0, height - 1))
                hit = bool(mask[y, x])
                if label == 1 and not hit:
                    adjusted -= 0.65
                if label == 0 and hit:
                    adjusted -= 0.85

        if adjusted > best_score:
            best_score = adjusted
            best_index = index

    return int(best_index)


def encode_rle(flat):
    if flat.size == 0:
        return []
    runs = []
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


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "SAM 运行异常",
                    "detail": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(limit=12),
                },
                ensure_ascii=False,
            )
        )
