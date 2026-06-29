Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$venvDir = Join-Path $repoRoot ".venv-win-build"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"
$requirementsFile = Join-Path $repoRoot "requirements-windows-build.txt"
$distPath = Join-Path $repoRoot "runtime\windows\python"
$workPath = Join-Path $repoRoot "build\pyinstaller\work"
$specPath = Join-Path $repoRoot "build\pyinstaller\spec"
$samCheckpoint = Join-Path $repoRoot "models\sam_vit_b_01ec64.pth"

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Windows 打包需要可用的 py 启动器，请先安装 Python 3。"
}

if (-not (Test-Path $venvDir)) {
  Write-Host "Creating build virtual environment..."
  & py -3 -m venv $venvDir
}

if (-not (Test-Path $pythonExe)) {
  throw "未找到构建虚拟环境中的 python.exe：$pythonExe"
}

Write-Host "Installing Python build dependencies..."
& $pythonExe -m pip install --upgrade pip setuptools wheel
& $pythonExe -m pip install --upgrade -r $requirementsFile

if (-not (Test-Path $samCheckpoint)) {
  Write-Host "Downloading SAM checkpoint..."
  & {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest `
      -Uri "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth" `
      -OutFile $samCheckpoint
  }
}

New-Item -ItemType Directory -Force -Path $distPath, $workPath, $specPath | Out-Null

foreach ($target in @("cell_segmenter", "droplet_segmenter")) {
  $targetDir = Join-Path $distPath $target
  if (Test-Path $targetDir) {
    Remove-Item -Recurse -Force $targetDir
  }
}

Write-Host "Building cell_segmenter.exe..."
& $pythonExe -m PyInstaller `
  --clean `
  --noconfirm `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  (Join-Path $scriptDir "cell_segmenter.spec")

Write-Host "Building droplet_segmenter.exe..."
& $pythonExe -m PyInstaller `
  --clean `
  --noconfirm `
  --distpath $distPath `
  --workpath $workPath `
  --specpath $specPath `
  (Join-Path $scriptDir "droplet_segmenter.spec")

Write-Host "Python runtimes are ready under: $distPath"
