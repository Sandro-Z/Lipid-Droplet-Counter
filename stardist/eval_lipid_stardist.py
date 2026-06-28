#!/usr/bin/env python3
"""Evaluate lipid-droplet StarDist model with count error, matching metrics, and overlays."""
from __future__ import annotations

import argparse
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pandas as pd
import tifffile
from csbdeep.utils import normalize
from skimage.exposure import rescale_intensity
from skimage.segmentation import find_boundaries
from stardist.matching import matching
from stardist.models import StarDist2D


def read_gray(path: str | Path) -> np.ndarray:
    img = iio.imread(path)
    if img.ndim == 2:
        x = img.astype(np.float32)
    elif img.ndim == 3:
        arr = img[..., :3].astype(np.float32)
        x = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    else:
        raise ValueError(f"Unsupported image shape {img.shape}: {path}")
    return normalize(x, 1, 99.8).astype(np.float32)


def load_eval_rows(prepared_dir: Path, split: str) -> pd.DataFrame:
    split_path = prepared_dir / "splits.csv"
    if split_path.exists():
        df = pd.read_csv(split_path)
    else:
        df = pd.read_csv(prepared_dir / "manifest.csv")
        df["split"] = "all"
    if split != "all" and "split" in df.columns:
        sub = df[df["split"] == split]
        if not sub.empty:
            return sub.reset_index(drop=True)
    return df.reset_index(drop=True)


def save_overlay(x_norm: np.ndarray, pred: np.ndarray, out_path: Path) -> None:
    base = rescale_intensity(x_norm, in_range="image", out_range=(0, 255)).astype(np.uint8)
    rgb = np.stack([base, base, base], axis=-1)
    b = find_boundaries(pred, mode="outer")
    rgb[b] = (64, 255, 64)
    iio.imwrite(out_path, rgb)


def parse_float_list(s: str) -> list[float]:
    return [float(v) for v in s.split(",") if v.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prepared_dir", required=True, type=Path)
    ap.add_argument("--model_dir", default="models", type=Path)
    ap.add_argument("--model_name", default="lipid_droplet_stardist")
    ap.add_argument("--split", default="val", choices=["train", "val", "test", "all"])
    ap.add_argument("--out_dir", default="eval_out", type=Path)
    ap.add_argument("--prob_thresholds", default="0.15,0.2,0.25,0.3,0.35,0.4,0.5,0.6")
    ap.add_argument("--nms_thresholds", default="0.2,0.3,0.4")
    ap.add_argument("--iou_thresh", type=float, default=0.3, help="0.3 is practical for point-derived circular GT masks")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    overlay_dir = args.out_dir / "overlays"
    overlay_dir.mkdir(exist_ok=True)

    df = load_eval_rows(args.prepared_dir, args.split)
    model = StarDist2D(None, name=args.model_name, basedir=args.model_dir.as_posix())
    prob_values = parse_float_list(args.prob_thresholds)
    nms_values = parse_float_list(args.nms_thresholds)

    rows = []
    preds_cache = {}
    for prob in prob_values:
        for nms in nms_values:
            for r in df.itertuples(index=False):
                x = read_gray(r.image)
                y_true = tifffile.imread(r.label)
                y_pred, details = model.predict_instances(x, prob_thresh=prob, nms_thresh=nms)
                gt_count = int(y_true.max())
                pred_count = int(y_pred.max())
                m = matching(y_true, y_pred, thresh=args.iou_thresh)
                rows.append({
                    "image_name": getattr(r, "image_name", Path(r.image).name),
                    "split": getattr(r, "split", "all"),
                    "prob_thresh": prob,
                    "nms_thresh": nms,
                    "gt_count": gt_count,
                    "pred_count": pred_count,
                    "count_error": pred_count - gt_count,
                    "abs_count_error": abs(pred_count - gt_count),
                    "abs_pct_error": abs(pred_count - gt_count) / max(gt_count, 1),
                    "precision_iou": float(m.precision),
                    "recall_iou": float(m.recall),
                    "f1_iou": float(m.f1),
                })
                preds_cache[(prob, nms, r.image)] = (x, y_pred)

    result = pd.DataFrame(rows)
    result_path = args.out_dir / "per_image_metrics.csv"
    result.to_csv(result_path, index=False)

    summary = (result.groupby(["prob_thresh", "nms_thresh"])
               .agg(mean_abs_error=("abs_count_error", "mean"),
                    mean_abs_pct_error=("abs_pct_error", "mean"),
                    mean_precision_iou=("precision_iou", "mean"),
                    mean_recall_iou=("recall_iou", "mean"),
                    mean_f1_iou=("f1_iou", "mean"))
               .reset_index()
               .sort_values(["mean_abs_error", "mean_abs_pct_error"], ascending=True))
    summary_path = args.out_dir / "threshold_sweep_summary.csv"
    summary.to_csv(summary_path, index=False)
    best = summary.iloc[0]
    print("Best thresholds by count MAE:")
    print(best.to_string())
    print(f"Wrote: {result_path}")
    print(f"Wrote: {summary_path}")

    best_prob = float(best["prob_thresh"])
    best_nms = float(best["nms_thresh"])
    for r in df.itertuples(index=False):
        x, pred = preds_cache[(best_prob, best_nms, r.image)]
        out_path = overlay_dir / f"{Path(r.image).stem}_pred_prob{best_prob}_nms{best_nms}.png"
        save_overlay(x, pred, out_path)
    print(f"Wrote overlays to: {overlay_dir}")


if __name__ == "__main__":
    main()
