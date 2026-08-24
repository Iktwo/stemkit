$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "extras\ffmpeg-win"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$existing = Join-Path $out "ffmpeg.exe"
if (Test-Path $existing) {
    Write-Host "ffmpeg already present: $existing"
    & $existing -version | Select-Object -First 1
    exit 0
}

$zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
$tmpExtract = Join-Path $env:TEMP "ffmpeg-extract"

Write-Host "downloading static ffmpeg for Windows x64..."
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip

if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
Expand-Archive -Path $zip -DestinationPath $tmpExtract -Force

$exe = Get-ChildItem $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $exe) { throw "ffmpeg.exe not found inside archive" }

Copy-Item $exe.FullName $existing -Force
Remove-Item -Recurse -Force $tmpExtract
Remove-Item -Force $zip

& $existing -version | Select-Object -First 1
Write-Host "saved to $existing"
