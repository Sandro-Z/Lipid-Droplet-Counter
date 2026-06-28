#!/usr/bin/env python3
"""Run one-image prediction and export droplet centers/diameters plus an overlay image."""
from __future__ import annotations

import argparse
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pandas as pd
from csbdeep.utils import normalize
from PIL import Image, ImageDraw, ImageFont
from skimage.exposure import rescale_intensity
from skimage.measure import regionprops
from stardist.models import StarDist2D


def read_gray(path: Path) -> np.ndarray:
    img = iio.imread(path)
    if img.ndim == 2:
        x = img.astype(np.float32)
    else:
        arr = img[..., :3].astype(np.float32)
        x = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    return normalize(x, 1, 99.8).astype(np.float32)


def make_overlay_image(x_norm: np.ndarray, rows: list[dict], draw_ids: bool) -> Image.Image:
    base = rescale_intensity(x_norm, in_range="image", out_range=(0, 255)).astype(np.uint8)
    rgb = np.stack([base, base, base], axis=-1)
    image = Image.fromarray(rgb, mode="RGB")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    for row in rows:
        cx = float(row["center_x_px"])
        cy = float(row["center_y_px"])
        radius = max(4.0, float(row["diameter_px"]) / 2.0 + 2.0)
        line_width = max(2, int(round(radius * 0.18)))
        draw.ellipse(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            outline=(64, 255, 64),
            width=line_width,
        )
        center_radius = max(2.0, line_width * 0.7)
        draw.ellipse(
            (cx - center_radius, cy - center_radius, cx + center_radius, cy + center_radius),
            fill=(255, 96, 96),
        )
        if draw_ids:
            draw.text(
                (cx + radius + 4, max(0.0, cy - 7)),
                str(row["id"]),
                fill=(255, 230, 64),
                stroke_width=1,
                stroke_fill=(0, 0, 0),
                font=font,
            )
    return image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, type=Path)
    ap.add_argument("--model_dir", default="models", type=Path)
    ap.add_argument("--model_name", default="lipid_droplet_stardist")
    ap.add_argument("--prob_thresh", type=float, default=0.3)
    ap.add_argument("--nms_thresh", type=float, default=0.3)
    ap.add_argument("--out_csv", default="prediction.csv", type=Path)
    ap.add_argument("--out_overlay", type=Path, default=None)
    ap.add_argument("--draw_ids", action="store_true", help="draw droplet ids on the overlay image")
    args = ap.parse_args()

    out_overlay = args.out_overlay
    if out_overlay is None:
        out_overlay = args.out_csv.with_name(f"{args.out_csv.stem}-overlay.png")
    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    out_overlay.parent.mkdir(parents=True, exist_ok=True)

    model = StarDist2D(None, name=args.model_name, basedir=args.model_dir.as_posix())
    x = read_gray(args.image)
    labels, _ = model.predict_instances(x, prob_thresh=args.prob_thresh, nms_thresh=args.nms_thresh)

    rows = []
    for p in regionprops(labels):
        y, x0 = p.centroid
        area = float(p.area)
        diameter = float(2.0 * np.sqrt(area / np.pi))
        rows.append({
            "image": args.image.name,
            "id": int(p.label),
            "center_x_px": round(x0, 3),
            "center_y_px": round(y, 3),
            "area_px2": round(area, 3),
            "diameter_px": round(diameter, 3),
            "bbox_x": int(p.bbox[1]),
            "bbox_y": int(p.bbox[0]),
            "bbox_width": int(p.bbox[3] - p.bbox[1]),
            "bbox_height": int(p.bbox[2] - p.bbox[0]),
        })
    pd.DataFrame(rows).to_csv(args.out_csv, index=False)
    make_overlay_image(x, rows, draw_ids=args.draw_ids).save(out_overlay)
    print(f"Detected {len(rows)} droplets")
    print(f"Wrote {args.out_csv}")
    print(f"Wrote {out_overlay}")


if __name__ == "__main__":
    main()
