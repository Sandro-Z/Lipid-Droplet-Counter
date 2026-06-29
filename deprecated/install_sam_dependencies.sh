#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_MODULE_DIR="${SAM_PYTHON_MODULE_DIR:-$SCRIPT_DIR/python_modules}"

if ! python3 -m pip install --no-cache-dir --upgrade --target "$PYTHON_MODULE_DIR" -r "$SCRIPT_DIR/requirements.txt"; then
  echo "GitHub install failed. Trying PyPI fallback..."
  python3 -m pip install --no-cache-dir --upgrade --target "$PYTHON_MODULE_DIR" \
    segment-anything numpy Pillow torch torchvision
fi

MODEL_DIR="${SAM_MODEL_DIR:-$SCRIPT_DIR/models}"
mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_DIR/sam_vit_b_01ec64.pth" ]; then
  curl -L \
    https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth \
    -o "$MODEL_DIR/sam_vit_b_01ec64.pth"
fi

echo "SAM dependencies installed. Checkpoint: $MODEL_DIR/sam_vit_b_01ec64.pth"
