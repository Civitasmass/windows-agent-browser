[CmdletBinding()]
param(
    [ValidateRange(1, 120)]
    [int]$Seconds = 8,

    [string]$ReadyFile
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$Form = New-Object System.Windows.Forms.Form
$Form.Text = "Agent Browser Occlusion Test"
$Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$Form.WindowState = [System.Windows.Forms.FormWindowState]::Maximized
$Form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$Form.TopMost = $true
$Form.ShowInTaskbar = $false
$Form.KeyPreview = $true
$Form.BackColor = [System.Drawing.Color]::FromArgb(35, 39, 47)

$Label = New-Object System.Windows.Forms.Label
$Label.AutoSize = $true
$Label.ForeColor = [System.Drawing.Color]::White
$Label.Font = New-Object System.Drawing.Font("Segoe UI", 18)
$Label.Location = New-Object System.Drawing.Point(32, 32)
$Label.Text = "Temporary browser occlusion test"
$Form.Controls.Add($Label)

$Timer = New-Object System.Windows.Forms.Timer
$Timer.Interval = $Seconds * 1000
$Timer.Add_Tick({
    $Timer.Stop()
    $Form.Close()
})

$Form.Add_Shown({
    if (-not [string]::IsNullOrWhiteSpace($ReadyFile)) {
        [System.IO.File]::WriteAllText($ReadyFile, "ready")
    }
    $Timer.Start()
    $Form.Activate()
})

$Form.Add_KeyDown({
    param($Sender, $EventArgs)
    if ($EventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $Timer.Stop()
        $Form.Close()
    }
})

[System.Windows.Forms.Application]::Run($Form)
