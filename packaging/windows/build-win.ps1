Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
$builderCmd = Join-Path $repoRoot "node_modules\.bin\electron-builder.cmd"

& (Join-Path $scriptDir "build-python.ps1")

if (-not (Test-Path $builderCmd)) {
  throw "未找到 electron-builder，请先在 Windows 环境执行 npm install。"
}

Push-Location $repoRoot
try {
  Write-Host "Building Windows Electron package..."
  & $builderCmd --win portable --x64
} finally {
  Pop-Location
}
