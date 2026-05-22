param(
    [string]$ReadyFile = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class SplashNative {
    public const int GWLP_HWNDPARENT = -8;

    [DllImport("user32.dll", EntryPoint="SetWindowLongPtr", SetLastError=true)]
    public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", EntryPoint="SetWindowLong", SetLastError=true)]
    public static extern IntPtr SetWindowLongPtr32(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    public static IntPtr SetWindowOwner(IntPtr hWnd, IntPtr owner) {
        if (IntPtr.Size == 8) {
            return SetWindowLongPtr64(hWnd, GWLP_HWNDPARENT, owner);
        }
        return SetWindowLongPtr32(hWnd, GWLP_HWNDPARENT, owner);
    }

    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static void PlaceAboveOwner(IntPtr hWnd, IntPtr owner) {
        SetWindowPos(hWnd, owner, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}
"@

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) {
    $root = (Get-Location).Path
}

$iconPath = Join-Path $PSScriptRoot "assets\resin-slicer.ico"
$pngPath = Join-Path $PSScriptRoot "assets\resin-slicer-icon-256.png"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Resin Slicer"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $false
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(21, 26, 32)
$form.ClientSize = [System.Drawing.Size]::new(420, 220)
$form.Cursor = [System.Windows.Forms.Cursors]::Hand

if (Test-Path $iconPath) {
    $form.Icon = New-Object System.Drawing.Icon -ArgumentList $iconPath
}

$card = New-Object System.Windows.Forms.Panel
$card.Dock = [System.Windows.Forms.DockStyle]::Fill
$card.BackColor = [System.Drawing.Color]::FromArgb(21, 26, 32)
$card.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Controls.Add($card)

$picture = New-Object System.Windows.Forms.PictureBox
$picture.Size = [System.Drawing.Size]::new(86, 86)
$picture.Location = [System.Drawing.Point]::new(28, 42)
$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$picture.Cursor = [System.Windows.Forms.Cursors]::Hand
if (Test-Path $pngPath) {
    $picture.Image = [System.Drawing.Image]::FromFile($pngPath)
}
$card.Controls.Add($picture)

$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false
$title.Location = [System.Drawing.Point]::new(132, 50)
$title.Size = [System.Drawing.Size]::new(250, 34)
$title.Font = [System.Drawing.Font]::new("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(238, 242, 245)
$title.Text = "Resin Slicer"
$title.Cursor = [System.Windows.Forms.Cursors]::Hand
$card.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.AutoSize = $false
$subtitle.Location = [System.Drawing.Point]::new(135, 91)
$subtitle.Size = [System.Drawing.Size]::new(245, 46)
$subtitle.Font = [System.Drawing.Font]::new("Segoe UI", 10)
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(170, 181, 191)
$subtitle.Text = "Loading the 3D workspace..."
$subtitle.Cursor = [System.Windows.Forms.Cursors]::Hand
$card.Controls.Add($subtitle)

$barBack = New-Object System.Windows.Forms.Panel
$barBack.Location = [System.Drawing.Point]::new(135, 148)
$barBack.Size = [System.Drawing.Size]::new(235, 6)
$barBack.BackColor = [System.Drawing.Color]::FromArgb(43, 51, 61)
$barBack.Cursor = [System.Windows.Forms.Cursors]::Hand
$card.Controls.Add($barBack)

$bar = New-Object System.Windows.Forms.Panel
$bar.Location = [System.Drawing.Point]::new(0, 0)
$bar.Size = [System.Drawing.Size]::new(0, 6)
$bar.BackColor = [System.Drawing.Color]::FromArgb(122, 236, 224)
$bar.Cursor = [System.Windows.Forms.Cursors]::Hand
$barBack.Controls.Add($bar)

$script:splashControls = @($form, $card, $picture, $title, $subtitle, $barBack, $bar)
$script:ownerHandle = [IntPtr]::Zero
$script:mainWindowLoaded = $false

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
    $elapsed = [Math]::Min(5000, $stopwatch.ElapsedMilliseconds)
    $bar.Width = [int]($barBack.Width * ($elapsed / 5000.0))
    $script:ownerHandle = Set-SplashOwner -Form $form -CurrentOwner $script:ownerHandle
    Ensure-SplashAboveOwner -Form $form -Owner $script:ownerHandle
    if ($elapsed -ge 5000) {
        $timer.Stop()
        $form.Close()
    }
})

$dismiss = {
    if (-not $script:mainWindowLoaded) {
        return
    }
    $timer.Stop()
    $form.Close()
}

foreach ($control in $script:splashControls) {
    $control.Add_Click($dismiss)
}

function Get-ResinSlicerWindowHandle {
    $windows = @(Get-Process -Name "electron" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "Resin Slicer" })

    foreach ($window in $windows) {
        try {
            if ($window.Path -and $window.Path.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $window.MainWindowHandle
            }
        } catch {
            # Some process metadata can be unavailable; fall back to the title match below.
        }
    }

    if ($windows.Count -gt 0) {
        return $windows[0].MainWindowHandle
    }
    return [IntPtr]::Zero
}

function Set-SplashOwner {
    param(
        [Parameter(Mandatory = $true)][System.Windows.Forms.Form]$Form,
        [Parameter(Mandatory = $true)][IntPtr]$CurrentOwner
    )

    $nextOwner = Get-ResinSlicerWindowHandle
    if ($nextOwner -ne [IntPtr]::Zero -and $nextOwner -ne $CurrentOwner) {
        [SplashNative]::SetWindowOwner($Form.Handle, $nextOwner) | Out-Null
        [SplashNative]::PlaceAboveOwner($Form.Handle, $nextOwner)
        Set-SplashDismissEnabled -Enabled $true
        return $nextOwner
    }
    if ($nextOwner -ne [IntPtr]::Zero) {
        Set-SplashDismissEnabled -Enabled $true
    }
    return $CurrentOwner
}

function Ensure-SplashAboveOwner {
    param(
        [Parameter(Mandatory = $true)][System.Windows.Forms.Form]$Form,
        [Parameter(Mandatory = $true)][IntPtr]$Owner
    )

    if ($Owner -ne [IntPtr]::Zero) {
        [SplashNative]::PlaceAboveOwner($Form.Handle, $Owner)
    }
}

function Set-SplashDismissEnabled {
    param([Parameter(Mandatory = $true)][bool]$Enabled)

    $script:mainWindowLoaded = $Enabled
    $cursor = if ($Enabled) {
        [System.Windows.Forms.Cursors]::Hand
    } else {
        [System.Windows.Forms.Cursors]::AppStarting
    }
    foreach ($control in $script:splashControls) {
        $control.Cursor = $cursor
    }
}

Set-SplashDismissEnabled -Enabled $false

$form.Add_Shown({
    if ($ReadyFile) {
        try {
            Set-Content -LiteralPath $ReadyFile -Value "ready" -Encoding ASCII
        } catch {
            # The splash should still work even if the launcher readiness marker cannot be written.
        }
    }
    $script:ownerHandle = Set-SplashOwner -Form $form -CurrentOwner $script:ownerHandle
    $timer.Start()
})

[void]$form.ShowDialog()

if ($picture.Image) {
    $picture.Image.Dispose()
}
$timer.Dispose()
