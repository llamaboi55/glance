# One-command install for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/llamaboi55/glance/main/scripts/install.ps1 | iex
# Downloads the latest release from GitHub and installs it for your user only, so it
# needs no admin rights. Run it again to update.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster

$release = Invoke-RestMethod 'https://api.github.com/repos/llamaboi55/glance/releases/latest'
$asset = $release.assets | Where-Object { $_.name -like '*_x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw 'No Windows build in the latest release yet.' }

$file = Join-Path $env:TEMP $asset.name
Write-Host "==> Downloading $($asset.name)" -ForegroundColor Green
Invoke-WebRequest $asset.browser_download_url -OutFile $file

Get-Process Glance -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host '==> Installing for your user' -ForegroundColor Green
Start-Process $file -ArgumentList '/S' -Wait
Remove-Item $file -Force

$exe = Join-Path $env:LOCALAPPDATA 'Glance\glance.exe'
if (Test-Path $exe) { Start-Process $exe }
Write-Host '==> Done. Glance is running: look for the little pill in the corner. It is in your Start menu too.' -ForegroundColor Green
