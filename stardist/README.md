# Lipid droplet StarDist starter

## 1. Environment

```bash
conda create -n lipid-stardist python=3.10 -y
conda activate lipid-stardist
pip install -r requirements.txt
```

## 2. Raw dataset layout

```text
dataset_raw/
  images/
    1-1.png
    1-2.png
  csv/
    1-1-lipid-droplets.csv
    1-2-lipid-droplets.csv
```

Use the unmarked raw microscope images, not `*-marked.png` overlays.

## 3. Convert CSV points to StarDist instance labels

```bash
python prepare_lipid_dataset.py \
  --image_dir dataset_raw/images \
  --csv_dir dataset_raw/csv \
  --out_dir prepared_lipid \
  --radius_factor 0.45
```

Check every image under `prepared_lipid/qc`. Red circles should cover droplets without merging neighbors.

## 4. Train

```bash
python train_lipid_stardist.py \
  --prepared_dir prepared_lipid \
  --model_dir models \
  --model_name lipid_droplet_stardist \
  --epochs 80 \
  --steps 100 \
  --patch_size 128 \
  --grid 1
```

## 5. Evaluate and tune thresholds

```bash
python eval_lipid_stardist.py \
  --prepared_dir prepared_lipid \
  --model_dir models \
  --model_name lipid_droplet_stardist \
  --split val \
  --out_dir eval_val
```

Inspect:

- `eval_val/threshold_sweep_summary.csv`
- `eval_val/per_image_metrics.csv`
- `eval_val/overlays/*.png`

Pick the threshold pair with the lowest count error and acceptable visual overlays.

## 6. Predict one image

```bash
python predict_one_lipid.py \
  --image dataset_raw/images/1-1.png \
  --model_dir models \
  --model_name lipid_droplet_stardist \
  --prob_thresh 0.30 \
  --nms_thresh 0.30 \
  --out_csv 1-1-stardist-prediction.csv
```
