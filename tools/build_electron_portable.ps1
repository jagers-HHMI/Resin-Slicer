$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$electronVersion = "33.3.0"
$runtimeName = "electron-v$electronVersion-win32-x64"
$downloadUrl = "https://github.com/electron/electron/releases/download/v$electronVersion/$runtimeName.zip"
$cacheDir = Join-Path $root ".electron-cache"
$zipPath = Join-Path $cacheDir "$runtimeName.zip"
$runtimeDir = Join-Path $cacheDir $runtimeName
$distRoot = Join-Path $root "dist"
$appDist = Join-Path $distRoot "ResinSlicer"
$nextDist = Join-Path $distRoot "ResinSlicer.next"
$resourcesApp = Join-Path $nextDist "resources\app"

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (!(Test-Path $zipPath)) {
    Write-Host "Downloading Electron $electronVersion..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath
}

if (!(Test-Path $runtimeDir)) {
    Write-Host "Extracting Electron..."
    Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir
}

if (Test-Path $nextDist) {
    Remove-Item -LiteralPath $nextDist -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $nextDist | Out-Null
New-Item -ItemType Directory -Force -Path $resourcesApp | Out-Null

Write-Host "Building renderer..."
Push-Location $root
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Host "Copying Electron runtime..."
Copy-Item -Path (Join-Path $runtimeDir "*") -Destination $nextDist -Recurse -Force

Write-Host "Copying app files..."
$items = @(
    "assets",
    "dist",
    "electron",
    "resin_slicer",
    "src",
    "package.json",
    "pyproject.toml",
    "README.md",
    "LICENSE"
)
foreach ($item in $items) {
    $src = Join-Path $root $item
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination $resourcesApp -Recurse -Force
    }
}

Get-ChildItem -Path $resourcesApp -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem -Path $resourcesApp -Recurse -Filter "*.pyc" |
    Remove-Item -Force

$electronExe = Join-Path $nextDist "electron.exe"
$resinExe = Join-Path $nextDist "ResinSlicer.exe"
if (Test-Path $resinExe) {
    Remove-Item -LiteralPath $resinExe -Force
}
Rename-Item -LiteralPath $electronExe -NewName "ResinSlicer.exe"

$oldDist = Join-Path $distRoot ("ResinSlicer.old-" + (Get-Date -Format "yyyyMMddHHmmss"))
if (Test-Path $appDist) {
    try {
        Rename-Item -LiteralPath $appDist -NewName (Split-Path -Leaf $oldDist) -ErrorAction Stop
    } catch {
        Write-Error "Could not replace the existing app. Close every running ResinSlicer window and rerun this script. The staged build is at: $nextDist"
    }
}
Rename-Item -LiteralPath $nextDist -NewName "ResinSlicer"
if (Test-Path $oldDist) {
    try {
        Remove-Item -LiteralPath $oldDist -Recurse -Force -ErrorAction Stop
    } catch {
        Write-Warning "Built the new app, but could not remove the old folder: $oldDist"
    }
}

Write-Host "Built portable Electron app:"
Write-Host (Join-Path $appDist "ResinSlicer.exe")
