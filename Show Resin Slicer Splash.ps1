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

$hint = New-Object System.Windows.Forms.Label
$hint.AutoSize = $false
$hint.Location = [System.Drawing.Point]::new(135, 166)
$hint.Size = [System.Drawing.Size]::new(235, 20)
$hint.Font = [System.Drawing.Font]::new("Segoe UI", 8)
$hint.ForeColor = [System.Drawing.Color]::FromArgb(143, 155, 166)
$hint.Text = "Click to dismiss"
$hint.Cursor = [System.Windows.Forms.Cursors]::Hand
$card.Controls.Add($hint)

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
    $elapsed = [Math]::Min(5000, $stopwatch.ElapsedMilliseconds)
    $bar.Width = [int]($barBack.Width * ($elapsed / 5000.0))
    $script:ownerHandle = Set-SplashOwner -Form $form -CurrentOwner $script:ownerHandle
    if ($elapsed -ge 5000) {
        $timer.Stop()
        $form.Close()
    }
})

$dismiss = {
    $timer.Stop()
    $form.Close()
}

foreach ($control in @($form, $card, $picture, $title, $subtitle, $barBack, $bar, $hint)) {
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
        return $nextOwner
    }
    return $CurrentOwner
}

$script:ownerHandle = [IntPtr]::Zero

$form.Add_Shown({
    $script:ownerHandle = Set-SplashOwner -Form $form -CurrentOwner $script:ownerHandle
    $timer.Start()
})

[void]$form.ShowDialog()

if ($picture.Image) {
    $picture.Image.Dispose()
}
$timer.Dispose()
