Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$moduleDir = $env:SAM_PYTHON_MODULE_DIR
if (-not $moduleDir) {
  $moduleDir = Join-Path $scriptDir "python_modules"
}
py -3 -m pip install --no-cache-dir --upgrade --target $moduleDir -r (Join-Path $scriptDir "requirements.txt")
if ($LASTEXITCODE -ne 0) {
  Write-Host "GitHub install failed. Trying PyPI fallback..."
  py -3 -m pip install --no-cache-dir --upgrade --target $moduleDir segment-anything numpy Pillow torch torchvision
  if ($LASTEXITCODE -ne 0) {
    throw "SAM dependencies could not be installed. Please check network access to GitHub or PyPI."
  }
}

$modelDir = $env:SAM_MODEL_DIR
if (-not $modelDir) {
  $modelDir = Join-Path $scriptDir "models"
}
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

$checkpoint = Join-Path $modelDir "sam_vit_b_01ec64.pth"
if (-not (Test-Path $checkpoint)) {
  Invoke-WebRequest `
    -Uri "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth" `
    -OutFile $checkpoint
}

Write-Host "SAM dependencies installed. Checkpoint: $checkpoint"
