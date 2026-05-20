param(
    [switch]$SkipBuild,
    [switch]$NoBundledPython
)

$ErrorActionPreference = "Stop"

function Copy-MinimalPythonRuntime {
    param([Parameter(Mandatory = $true)][string]$Destination)

    $pythonCommand = Get-Command python -ErrorAction Stop
    $pythonRoot = Split-Path -Parent $pythonCommand.Source
    $required = @("python.exe", "pythonw.exe", "python3.dll", "vcruntime140.dll", "vcruntime140_1.dll")

    if (Test-Path $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    foreach ($file in $required) {
        $src = Join-Path $pythonRoot $file
        if (Test-Path $src) {
            Copy-Item -LiteralPath $src -Destination $Destination -Force
        }
    }
    Get-ChildItem -Path $pythonRoot -Filter "python*.dll" -File |
        Copy-Item -Destination $Destination -Force
    if (Test-Path (Join-Path $pythonRoot "LICENSE.txt")) {
        Copy-Item -LiteralPath (Join-Path $pythonRoot "LICENSE.txt") -Destination $Destination -Force
    }

    Copy-Item -LiteralPath (Join-Path $pythonRoot "DLLs") -Destination (Join-Path $Destination "DLLs") -Recurse -Force

    $libSource = Join-Path $pythonRoot "Lib"
    $libDestination = Join-Path $Destination "Lib"
    New-Item -ItemType Directory -Force -Path $libDestination | Out-Null
    $excludedLibDirs = @("site-packages", "test", "idlelib", "turtledemo", "ensurepip", "venv", "__pycache__")
    Get-ChildItem -Path $libSource -Force |
        Where-Object { $excludedLibDirs -notcontains $_.Name } |
        Copy-Item -Destination $libDestination -Recurse -Force

    Get-ChildItem -Path $Destination -Recurse -Directory -Filter "__pycache__" |
        Remove-Item -Recurse -Force
    Get-ChildItem -Path $Destination -Recurse -Filter "*.pyc" |
        Remove-Item -Force
}

$root = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $root "dist"
$appDist = Join-Path $distRoot "ResinSlicer"
$packageRoot = Join-Path $distRoot "ResinSlicer-Windows-Portable"
$zipPath = Join-Path $distRoot "ResinSlicer-Windows-Portable.zip"

if (!$SkipBuild) {
    & (Join-Path $PSScriptRoot "build_electron_portable.ps1")
}

if (!(Test-Path $appDist)) {
    throw "Portable app folder does not exist: $appDist"
}

if (!$NoBundledPython) {
    Copy-MinimalPythonRuntime -Destination (Join-Path $appDist "python")
}

if (Test-Path $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

Copy-Item -LiteralPath $appDist -Destination (Join-Path $packageRoot "ResinSlicer") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $packageRoot "README.md") -Force
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $packageRoot "LICENSE") -Force

$launcher = @"
@echo off
cd /d "%~dp0ResinSlicer"
start "" "ResinSlicer.exe"
"@
Set-Content -LiteralPath (Join-Path $packageRoot "Run ResinSlicer.bat") -Value $launcher -Encoding ASCII

if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -Force

Write-Host "Packaged shareable build:"
Write-Host $packageRoot
Write-Host $zipPath
