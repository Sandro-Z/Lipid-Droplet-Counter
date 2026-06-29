#!/usr/bin/env python3
"""Train a StarDist2D model for lipid droplets from prepared images + labels."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import imageio.v3 as iio
import numpy as np
import pandas as pd
import tifffile
from csbdeep.utils import normalize
from skimage.filters import gaussian
from skimage.transform import resize
from stardist import fill_label_holes
from stardist.matching import matching
from stardist.models import Config2D, StarDist2D


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


def load_manifest(prepared_dir: Path) -> pd.DataFrame:
    manifest = prepared_dir / "manifest.csv"
    if manifest.exists():
        df = pd.read_csv(manifest)
    else:
        rows = []
        for img in sorted((prepared_dir / "images").iterdir()):
            if img.suffix.lower() not in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}:
                continue
            lab = prepared_dir / "labels" / f"{img.stem}.tif"
            if lab.exists():
                rows.append({"image": img.as_posix(), "label": lab.as_posix(), "image_name": img.name})
        df = pd.DataFrame(rows)
    if df.empty:
        raise SystemExit(f"No image/label pairs found in {prepared_dir}")
    return df


def density_per_100k(df: pd.DataFrame) -> np.ndarray:
    if {"n_labels", "height", "width"}.issubset(df.columns):
        area = np.maximum(df["height"].to_numpy(dtype=np.float32) * df["width"].to_numpy(dtype=np.float32), 1.0)
        counts = df["n_labels"].to_numpy(dtype=np.float32)
        return counts / area * 100000.0
    if "n_labels" in df.columns:
        return df["n_labels"].to_numpy(dtype=np.float32)
    return np.arange(len(df), dtype=np.float32)


def quantile_bins(values: np.ndarray, n_bins: int) -> np.ndarray:
    if len(values) == 0:
        return np.empty(0, dtype=np.int32)
    n_bins = max(1, min(int(n_bins), len(values)))
    order = np.argsort(values, kind="stable")
    bins = np.empty(len(values), dtype=np.int32)
    for rank, idx in enumerate(order):
        bins[idx] = min(n_bins - 1, (rank * n_bins) // len(values))
    return bins


def assign_group_splits(
    group_index: np.ndarray,
    val_fraction: float,
    test_fraction: float,
    rng: np.random.Generator,
) -> tuple[np.ndarray, np.ndarray]:
    order = group_index.copy()
    rng.shuffle(order)
    split = np.array(["train"] * len(order), dtype=object)
    if len(order) >= 6:
        n_test = max(1, round(len(order) * test_fraction))
        n_val = max(1, round(len(order) * val_fraction))
        if n_test + n_val >= len(order):
            n_test = min(n_test, 1)
            n_val = min(n_val, 1)
        split[:n_test] = "test"
        split[n_test:n_test + n_val] = "val"
    elif len(order) >= 3:
        split[0] = "val"
    return order, split


def make_split(
    df: pd.DataFrame,
    val_fraction: float,
    test_fraction: float,
    seed: int,
    out_csv: Path,
    density_bins: int,
    reuse_existing: bool,
) -> pd.DataFrame:
    if reuse_existing and out_csv.exists():
        return pd.read_csv(out_csv)

    rng = np.random.default_rng(seed)
    split = np.array(["train"] * len(df), dtype=object)

    if len(df) >= 5:
        density = density_per_100k(df)
        bins = quantile_bins(density, density_bins)
        for bin_id in np.unique(bins):
            group_index = np.flatnonzero(bins == bin_id)
            group_order, group_split = assign_group_splits(group_index, val_fraction, test_fraction, rng)
            split[group_order] = group_split
    elif len(df) >= 3:
        idx = np.arange(len(df))
        rng.shuffle(idx)
        split[idx[0]] = "val"
    else:
        # Smoke-test mode only. This is not a valid generalization estimate.
        split[:] = "train"

    out = df.copy()
    out["split"] = split
    out.to_csv(out_csv, index=False)
    return out


def rebalance_training_rows(train_df: pd.DataFrame, seed: int, density_bins: int, dense_bin_boost: float) -> pd.DataFrame:
    if len(train_df) < max(10, density_bins * 2):
        return train_df.reset_index(drop=True)

    work = train_df.copy()
    work["_density_bin"] = quantile_bins(density_per_100k(work), density_bins)
    rng = np.random.default_rng(seed)
    groups = []
    grouped = list(work.groupby("_density_bin", sort=True))
    max_count = max(len(group) for _, group in grouped)
    n_groups = len(grouped)
    for rank, (_, group) in enumerate(grouped):
        if n_groups == 1:
            boost = 1.0 + dense_bin_boost
        else:
            boost = 1.0 + dense_bin_boost * (rank / (n_groups - 1))
        target = int(np.ceil(max_count * boost))
        parts = [group]
        need = target - len(group)
        if need > 0:
            sample_idx = rng.choice(group.index.to_numpy(), size=need, replace=True)
            parts.append(group.loc[sample_idx].copy())
        groups.append(pd.concat(parts, ignore_index=True))
    out = pd.concat(groups, ignore_index=True)
    out = out.sample(frac=1.0, random_state=seed).reset_index(drop=True)
    return out.drop(columns="_density_bin")


def crop_or_pad(arr: np.ndarray, out_shape: tuple[int, int], pad_mode: str, constant_values: int | float = 0) -> np.ndarray:
    y, x = arr.shape[:2]
    out_y, out_x = out_shape

    if y < out_y or x < out_x:
        pad_top = max(0, (out_y - y) // 2)
        pad_bottom = max(0, out_y - y - pad_top)
        pad_left = max(0, (out_x - x) // 2)
        pad_right = max(0, out_x - x - pad_left)
        if pad_mode == "constant":
            arr = np.pad(arr, ((pad_top, pad_bottom), (pad_left, pad_right)), mode=pad_mode, constant_values=constant_values)
        else:
            arr = np.pad(arr, ((pad_top, pad_bottom), (pad_left, pad_right)), mode=pad_mode)

    y, x = arr.shape[:2]
    start_y = max(0, (y - out_y) // 2)
    start_x = max(0, (x - out_x) // 2)
    return arr[start_y:start_y + out_y, start_x:start_x + out_x]


def random_zoom(x: np.ndarray, y: np.ndarray, scale: float) -> tuple[np.ndarray, np.ndarray]:
    if abs(scale - 1.0) < 1e-3:
        return x, y
    new_shape = (
        max(16, int(round(x.shape[0] * scale))),
        max(16, int(round(x.shape[1] * scale))),
    )
    x_zoom = resize(
        x,
        new_shape,
        order=1,
        mode="reflect",
        preserve_range=True,
        anti_aliasing=True,
    ).astype(np.float32)
    y_zoom = resize(
        y,
        new_shape,
        order=0,
        mode="constant",
        preserve_range=True,
        anti_aliasing=False,
    ).astype(y.dtype)
    x_zoom = crop_or_pad(x_zoom, x.shape, pad_mode="edge").astype(np.float32)
    y_zoom = crop_or_pad(y_zoom, y.shape, pad_mode="constant", constant_values=0).astype(y.dtype)
    return x_zoom, y_zoom


def augmenter(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    # Lipid droplets are roughly circular, so orientation and local scale are not semantically meaningful.
    if np.random.rand() < 0.5:
        x = np.flip(x, axis=0)
        y = np.flip(y, axis=0)
    if np.random.rand() < 0.5:
        x = np.flip(x, axis=1)
        y = np.flip(y, axis=1)
    k = np.random.randint(0, 4)
    x = np.rot90(x, k)
    y = np.rot90(y, k)

    if np.random.rand() < 0.40:
        if np.random.rand() < 0.65:
            scale = np.random.uniform(1.02, 1.35)
        else:
            scale = np.random.uniform(0.93, 1.03)
        x, y = random_zoom(x, y, scale)

    if np.random.rand() < 0.30:
        sigma = np.random.uniform(0.35, 1.0)
        x = gaussian(x, sigma=sigma, preserve_range=True).astype(np.float32)

    mean = float(np.mean(x))
    x = (x - mean) * np.random.uniform(0.85, 1.2) + mean
    x = np.power(np.clip(x, 0, 1), np.random.uniform(0.85, 1.2))
    x = x + np.random.uniform(-0.05, 0.05)
    x = x + np.random.normal(0, np.random.uniform(0.01, 0.03), x.shape).astype(np.float32)
    x = np.clip(x, 0, 1).astype(np.float32)
    return x, y


def parse_float_list(s: str) -> list[float]:
    return [float(v) for v in s.split(",") if v.strip()]


def optimize_thresholds_for_counts(
    model: StarDist2D,
    x_val: list[np.ndarray],
    y_val: list[np.ndarray],
    out_dir: Path,
    prob_values: list[float],
    nms_values: list[float],
    iou_thresh: float,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for prob in prob_values:
        for nms in nms_values:
            count_errors = []
            abs_errors = []
            abs_pct_errors = []
            f1s = []
            precisions = []
            recalls = []
            for x, y_true in zip(x_val, y_val):
                y_pred, _ = model.predict_instances(x, prob_thresh=prob, nms_thresh=nms)
                gt_count = int(y_true.max())
                pred_count = int(y_pred.max())
                m = matching(y_true, y_pred, thresh=iou_thresh)
                count_error = pred_count - gt_count
                count_errors.append(count_error)
                abs_errors.append(abs(pred_count - gt_count))
                abs_pct_errors.append(abs(pred_count - gt_count) / max(gt_count, 1))
                precisions.append(float(m.precision))
                recalls.append(float(m.recall))
                f1s.append(float(m.f1))
            rows.append({
                "prob_thresh": prob,
                "nms_thresh": nms,
                "mean_count_bias": float(np.mean(count_errors)),
                "abs_mean_count_bias": float(np.mean(np.abs(count_errors))),
                "mean_under_count": float(np.mean([max(-err, 0) for err in count_errors])),
                "mean_over_count": float(np.mean([max(err, 0) for err in count_errors])),
                "mean_abs_error": float(np.mean(abs_errors)),
                "mean_abs_pct_error": float(np.mean(abs_pct_errors)),
                "mean_precision_iou": float(np.mean(precisions)),
                "mean_recall_iou": float(np.mean(recalls)),
                "mean_f1_iou": float(np.mean(f1s)),
            })

    summary = pd.DataFrame(rows).sort_values(
        ["mean_abs_error", "abs_mean_count_bias", "mean_under_count", "mean_abs_pct_error", "mean_f1_iou"],
        ascending=[True, True, True, True, False],
    )
    summary_path = out_dir / "val_threshold_sweep.csv"
    summary.to_csv(summary_path, index=False)

    best = summary.iloc[0]
    thresholds = {
        "prob": float(best["prob_thresh"]),
        "nms": float(best["nms_thresh"]),
    }
    thresholds_path = out_dir / "thresholds.json"
    thresholds_path.write_text(json.dumps(thresholds), encoding="utf-8")
    print("Best validation thresholds by count error:")
    print(best.to_string())
    print(f"Wrote threshold sweep: {summary_path}")
    print(f"Wrote thresholds: {thresholds_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prepared_dir", required=True, type=Path)
    ap.add_argument("--model_dir", default="models", type=Path)
    ap.add_argument("--model_name", default="lipid_droplet_stardist")
    ap.add_argument("--epochs", type=int, default=220)
    ap.add_argument("--steps", type=int, default=180)
    ap.add_argument("--batch_size", type=int, default=4)
    ap.add_argument("--patch_size", type=int, default=224)
    ap.add_argument("--n_rays", type=int, default=32)
    ap.add_argument("--grid", type=int, default=1)
    ap.add_argument("--val_fraction", type=float, default=0.15)
    ap.add_argument("--test_fraction", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--density_bins", type=int, default=5)
    ap.add_argument("--reuse_existing_split", action="store_true")
    ap.add_argument("--disable_density_rebalance", action="store_true")
    ap.add_argument("--dense_bin_boost", type=float, default=0.6)
    ap.add_argument("--foreground_fraction", type=float, default=0.82)
    ap.add_argument("--background_reg", type=float, default=3e-4)
    ap.add_argument("--learning_rate", type=float, default=6e-5)
    ap.add_argument("--unet_depth", type=int, default=3)
    ap.add_argument("--unet_filters", type=int, default=32)
    ap.add_argument("--distance_loss_weight", type=float, default=0.35)
    ap.add_argument("--prob_thresholds", default="0.3,0.35,0.4,0.45,0.5,0.55")
    ap.add_argument("--nms_thresholds", default="0.2,0.25,0.3")
    ap.add_argument("--iou_thresh", type=float, default=0.3)
    ap.add_argument("--init_weights", type=Path, default=None)
    args = ap.parse_args()

    df = load_manifest(args.prepared_dir)
    split_path = args.prepared_dir / "splits.csv"
    df = make_split(
        df,
        args.val_fraction,
        args.test_fraction,
        args.seed,
        split_path,
        density_bins=args.density_bins,
        reuse_existing=args.reuse_existing_split,
    )
    df["density_per_100k"] = density_per_100k(df)

    train_df_unique = df[df["split"] == "train"].copy()
    train_df = train_df_unique
    if not args.disable_density_rebalance:
        train_df = rebalance_training_rows(train_df_unique, args.seed, args.density_bins, args.dense_bin_boost)
    val_df = df[df["split"] == "val"].copy()
    if val_df.empty:
        print("WARNING: no validation image available; using training images as validation for smoke testing only.")
        val_df = train_df_unique

    X_train = [read_gray(p) for p in train_df["image"]]
    Y_train = [fill_label_holes(tifffile.imread(p).astype(np.uint16)) for p in train_df["label"]]
    X_val = [read_gray(p) for p in val_df["image"]]
    Y_val = [fill_label_holes(tifffile.imread(p).astype(np.uint16)) for p in val_df["label"]]

    print(f"Training images: unique={len(train_df_unique)}, sampled={len(X_train)}, validation={len(X_val)}")
    print("Split density per 100k px:")
    print(df.groupby("split")["density_per_100k"].agg(["count", "mean", "median", "min", "max"]).round(3))
    print(f"Train object counts: {[int(y.max()) for y in Y_train]}")
    print(f"Val object counts: {[int(y.max()) for y in Y_val]}")

    conf = Config2D(
        n_rays=args.n_rays,
        grid=(args.grid, args.grid),
        n_channel_in=1,
        unet_n_depth=args.unet_depth,
        unet_n_filter_base=args.unet_filters,
        train_patch_size=(args.patch_size, args.patch_size),
        train_batch_size=args.batch_size,
        train_epochs=args.epochs,
        train_steps_per_epoch=args.steps,
        train_learning_rate=args.learning_rate,
        train_foreground_only=args.foreground_fraction,
        train_background_reg=args.background_reg,
        train_loss_weights=(1, args.distance_loss_weight),
        train_sample_cache=True,
        train_tensorboard=True,
        train_reduce_lr={"factor": 0.5, "patience": max(15, args.epochs // 10), "min_delta": 0},
    )
    print(conf)

    model = StarDist2D(conf, name=args.model_name, basedir=args.model_dir.as_posix())
    if args.init_weights is not None:
        print(f"Loading initial weights from: {args.init_weights}")
        model.keras_model.load_weights(args.init_weights.as_posix())
    model.train(X_train, Y_train, validation_data=(X_val, Y_val), augmenter=augmenter)

    model_out_dir = args.model_dir / args.model_name
    try:
        optimize_thresholds_for_counts(
            model,
            X_val,
            Y_val,
            model_out_dir,
            prob_values=parse_float_list(args.prob_thresholds),
            nms_values=parse_float_list(args.nms_thresholds),
            iou_thresh=args.iou_thresh,
        )
    except Exception as e:
        print(f"Custom threshold optimization skipped/failed: {e}")
        try:
            model.optimize_thresholds(X_val, Y_val)
        except Exception as fallback_e:
            print(f"Built-in threshold optimization skipped/failed: {fallback_e}")

    print(f"Model saved in: {model_out_dir}")
    print(f"Split file saved in: {split_path}")


if __name__ == "__main__":
    main()
