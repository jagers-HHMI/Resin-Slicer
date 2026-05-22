param(
    [string]$Title = "Resin Slicer",
    [string]$Message = "",
    [string]$MessageFile = ""
)

$ErrorActionPreference = "Stop"

if ($MessageFile -and (Test-Path -LiteralPath $MessageFile)) {
    $Message = Get-Content -LiteralPath $MessageFile -Raw
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$iconPath = Join-Path $PSScriptRoot "assets\resin-slicer.ico"
$pngPath = Join-Path $PSScriptRoot "assets\resin-slicer-icon-256.png"

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 29, 35)
$form.ClientSize = [System.Drawing.Size]::new(460, 220)

if (Test-Path $iconPath) {
    $form.Icon = New-Object System.Drawing.Icon -ArgumentList $iconPath
}

$picture = New-Object System.Windows.Forms.PictureBox
$picture.Size = [System.Drawing.Size]::new(54, 54)
$picture.Location = [System.Drawing.Point]::new(22, 24)
$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
if (Test-Path $pngPath) {
    $picture.Image = [System.Drawing.Image]::FromFile($pngPath)
}
$form.Controls.Add($picture)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.AutoSize = $false
$titleLabel.Location = [System.Drawing.Point]::new(96, 24)
$titleLabel.Size = [System.Drawing.Size]::new(330, 28)
$titleLabel.Font = [System.Drawing.Font]::new("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = [System.Drawing.Color]::FromArgb(238, 242, 245)
$titleLabel.Text = $Title
$form.Controls.Add($titleLabel)

$messageBox = New-Object System.Windows.Forms.TextBox
$messageBox.Location = [System.Drawing.Point]::new(96, 62)
$messageBox.Size = [System.Drawing.Size]::new(330, 92)
$messageBox.Multiline = $true
$messageBox.ReadOnly = $true
$messageBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
$messageBox.BackColor = [System.Drawing.Color]::FromArgb(24, 29, 35)
$messageBox.ForeColor = [System.Drawing.Color]::FromArgb(205, 214, 221)
$messageBox.Font = [System.Drawing.Font]::new("Segoe UI", 9)
$messageBox.Text = $Message.Trim()
$form.Controls.Add($messageBox)

$ok = New-Object System.Windows.Forms.Button
$ok.Location = [System.Drawing.Point]::new(334, 172)
$ok.Size = [System.Drawing.Size]::new(92, 32)
$ok.Text = "OK"
$ok.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$ok.BackColor = [System.Drawing.Color]::FromArgb(43, 108, 176)
$ok.ForeColor = [System.Drawing.Color]::FromArgb(238, 242, 245)
$ok.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(60, 131, 207)
$ok.Add_Click({ $form.Close() })
$form.Controls.Add($ok)
$form.AcceptButton = $ok

[void]$form.ShowDialog()

if ($picture.Image) {
    $picture.Image.Dispose()
}
