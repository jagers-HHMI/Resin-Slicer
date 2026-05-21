@echo off
setlocal

set "RESIN_SLICER_DIR=%~dp0"
cd /d "%RESIN_SLICER_DIR%"

if not exist "%RESIN_SLICER_DIR%package.json" (
    echo Could not find package.json in:
    echo %RESIN_SLICER_DIR%
    echo.
    pause
    exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
    echo Node.js is required to run Resin Slicer from source.
    echo Install Node.js, then run this launcher again.
    echo.
    pause
    exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo npm.cmd was not found on PATH.
    echo Reinstall Node.js with npm enabled, then run this launcher again.
    echo.
    pause
    exit /b 1
)

if not exist "%RESIN_SLICER_DIR%node_modules\electron" (
    echo First launch: installing Electron dependencies...
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

echo Launching Resin Slicer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$dir = $env:RESIN_SLICER_DIR; Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','npm.cmd start' -WorkingDirectory $dir -WindowStyle Hidden"
if errorlevel 1 (
    echo.
    echo Launch failed.
    pause
    exit /b 1
)
