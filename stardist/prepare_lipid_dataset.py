#!/usr/bin/env python3
"""Convert Lipid-Droplet-Counter CSV point annotations into StarDist label masks.

Input layout:
  dataset_raw/images/*.png|jpg|tif
  dataset_raw/csv/*-lipid-droplets.csv

Output layout:
  prepared/images/<image_name>
  prepared/labels/<image_stem>.tif   # integer instance labels: 0 background, 1..N droplets
  prepared/qc/<image_stem>_overlay.png
  prepared/manifest.csv
"""
from __future__ import annotations

import argparse
import io
import shutil
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pandas as pd
import tifffile
from skimage.draw import disk
from skimage.exposure import rescale_intensity
from skimage.segmentation import find_boundaries

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp")


def read_droplet_table(csv_path: Path) -> pd.DataFrame:
    text = csv_path.read_text(encoding="utf-8-sig", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    header_idx = None
    for i, line in enumerate(lines):
        if line.startswith("image,id,object_uid"):
            header_idx = i
            break
    if header_idx is None:
        raise ValueError(f"Cannot find droplet_coordinate_table header in {csv_path}")
    df = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    required = ["image", "center_x_px", "center_y_px", "diameter_px"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"{csv_path} is missing columns: {missing}")

    for c in ["center_x_px", "center_y_px", "diameter_px", "counted_in_cell"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    if "counted_in_cell" in df.columns:
        df = df[df["counted_in_cell"].fillna(1).astype(int) == 1]
    df = df.dropna(subset=["center_x_px", "center_y_px"])
    df = df[df["diameter_px"].fillna(0) > 0]
    return df.reset_index(drop=True)


def find_image_for_csv(csv_path: Path, df: pd.DataFrame, image_dir: Path) -> Path:
    candidates = []
    if len(df) and "image" in df.columns:
        candidates.append(str(df["image"].iloc[0]))
    # fallback: 1-1-lipid-droplets.csv -> 1-1.*
    stem = csv_path.stem.replace("-lipid-droplets", "").replace("_lipid_droplets", "")
    candidates.extend([stem + ext for ext in IMAGE_EXTS])

    for name in candidates:
        p = image_dir / Path(name).name
        if p.exists():
            return p
    raise FileNotFoundError(f"No matching image for {csv_path.name}. Tried: {candidates}")


def make_label(shape_hw: tuple[int, int], df: pd.DataFrame, radius_factor: float, min_radius: float, max_radius: float | None) -> np.ndarray:
    h, w = shape_hw
    dtype = np.uint16 if len(df) < np.iinfo(np.uint16).max else np.uint32
    label = np.zeros((h, w), dtype=dtype)

    work = df.copy()
    work["diameter_px"] = pd.to_numeric(work["diameter_px"], errors="coerce")
    work = work.sort_values("diameter_px", ascending=False).reset_index(drop=True)

    for obj_id, row in enumerate(work.itertuples(index=False), start=1):
        x = float(getattr(row, "center_x_px"))
        y = float(getattr(row, "center_y_px"))
        d = float(getattr(row, "diameter_px"))
        r = max(min_radius, d * radius_factor)
        if max_radius is not None:
            r = min(max_radius, r)
        rr, cc = disk((y, x), r, shape=(h, w))
        # Do not overwrite previous objects. This prevents two close droplets from becoming one label.
        empty = label[rr, cc] == 0
        label[rr[empty], cc[empty]] = obj_id
    return label


def to_gray_float(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        gray = img.astype(np.float32)
    elif img.ndim == 3:
        arr = img[..., :3].astype(np.float32)
        gray = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    else:
        raise ValueError(f"Unsupported image shape: {img.shape}")
    return gray


def save_qc_overlay(img: np.ndarray, label: np.ndarray, out_path: Path) -> None:
    gray = to_gray_float(img)
    base = rescale_intensity(gray, in_range="image", out_range=(0, 255)).astype(np.uint8)
    rgb = np.stack([base, base, base], axis=-1)
    b = find_boundaries(label, mode="outer")
    rgb[b] = (255, 64, 64)
    iio.imwrite(out_path, rgb)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image_dir", required=True, type=Path)
    ap.add_argument("--csv_dir", required=True, type=Path)
    ap.add_argument("--out_dir", required=True, type=Path)
    ap.add_argument("--radius_factor", type=float, default=0.45, help="label radius = diameter_px * radius_factor; 0.45 avoids many overlaps")
    ap.add_argument("--min_radius", type=float, default=2.0)
    ap.add_argument("--max_radius", type=float, default=8.0)
    args = ap.parse_args()

    out_images = args.out_dir / "images"
    out_labels = args.out_dir / "labels"
    out_qc = args.out_dir / "qc"
    for d in (out_images, out_labels, out_qc):
        d.mkdir(parents=True, exist_ok=True)

    records = []
    csv_files = sorted(args.csv_dir.glob("*.csv"))
    if not csv_files:
        raise SystemExit(f"No CSV files found in {args.csv_dir}")

    for csv_path in csv_files:
        df = read_droplet_table(csv_path)
        img_path = find_image_for_csv(csv_path, df, args.image_dir)
        img = iio.imread(img_path)
        h, w = img.shape[:2]
        label = make_label((h, w), df, args.radius_factor, args.min_radius, args.max_radius)

        copied_img = out_images / img_path.name
        if img_path.resolve() != copied_img.resolve():
            shutil.copy2(img_path, copied_img)
        label_path = out_labels / f"{img_path.stem}.tif"
        tifffile.imwrite(label_path, label)
        qc_path = out_qc / f"{img_path.stem}_overlay.png"
        save_qc_overlay(img, label, qc_path)

        records.append({
            "image": copied_img.as_posix(),
            "label": label_path.as_posix(),
            "csv": csv_path.as_posix(),
            "image_name": img_path.name,
            "n_annotations": int(len(df)),
            "n_labels": int(label.max()),
            "height": int(h),
            "width": int(w),
            "qc_overlay": qc_path.as_posix(),
        })
        print(f"OK {img_path.name}: {len(df)} annotations -> {label.max()} labels")

    pd.DataFrame(records).to_csv(args.out_dir / "manifest.csv", index=False)
    print(f"Wrote manifest: {args.out_dir / 'manifest.csv'}")


if __name__ == "__main__":
    main()
