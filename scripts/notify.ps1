# Claude Code confirmation notifier: shows a Windows tray balloon (no sound).
# Message (Chinese ok) is read as UTF-8 from stdin JSON {"message":"..."} so it is
# decoding-safe regardless of the console code page. ASCII-only script body avoids
# the PS5.1 GBK-decoding pitfall for .ps1 files.
#
# Usage (self-invoked):  echo '{"message":"需要你确认:删 store.ts"}' | powershell -NoProfile -ExecutionPolicy Bypass -File scripts/notify.ps1
# As a Claude Code Notification hook: stdin already carries the event JSON with .message
param([string]$Message = "")

if ([string]::IsNullOrWhiteSpace($Message)) {
    try {
        $stdin = [Console]::OpenStandardInput()
        $reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $obj = $raw | ConvertFrom-Json
            if ($obj.message) { $Message = [string]$obj.message }
        }
    } catch { }
}
if ([string]::IsNullOrWhiteSpace($Message)) { $Message = "Claude Code needs your confirmation" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Visible = $true
$ni.BalloonTipTitle = "Claude Code"
$ni.BalloonTipText = $Message
$ni.ShowBalloonTip(8000)
Start-Sleep -Milliseconds 6000
$ni.Dispose()
