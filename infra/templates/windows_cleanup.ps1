#Requires -RunAsAdministrator

Write-Host "=== Windows template cleanup ===" -ForegroundColor Cyan

# ── Stop services that hold files we're about to delete ───────────────────────
Write-Host "Stopping services..."
Stop-Service -Name wuauserv, bits, cryptsvc, msiserver -Force -ErrorAction SilentlyContinue

# ── Clear Windows Event Logs ──────────────────────────────────────────────────
Write-Host "Clearing event logs..."
Get-WinEvent -ListLog * -ErrorAction SilentlyContinue |
    Where-Object { $_.RecordCount -gt 0 } |
    ForEach-Object {
        [System.Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession.ClearLog($_.LogName)
    }

# ── Clear temp directories ────────────────────────────────────────────────────
Write-Host "Clearing temp files..."
$tempPaths = @(
    $env:TEMP,
    $env:TMP,
    "C:\Windows\Temp",
    "C:\Windows\Prefetch"
)
foreach ($path in $tempPaths) {
    if (Test-Path $path) {
        Get-ChildItem -Path $path -Recurse -Force -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── Clear Windows Update cache ────────────────────────────────────────────────
Write-Host "Clearing Windows Update cache..."
Remove-Item -Path "C:\Windows\SoftwareDistribution\Download\*" -Recurse -Force -ErrorAction SilentlyContinue

# ── Clear user profile clutter ────────────────────────────────────────────────
Write-Host "Clearing user profile clutter..."
$profileClutter = @(
    "AppData\Roaming\Microsoft\Windows\Recent\*",
    "AppData\Local\Temp\*",
    "AppData\Local\Microsoft\Windows\INetCache\*",
    "AppData\Local\Microsoft\Windows\History\*"
)
foreach ($rel in $profileClutter) {
    Get-Item "C:\Users\*\$rel" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Clear Recycle Bin ─────────────────────────────────────────────────────────
Write-Host "Emptying Recycle Bin..."
Clear-RecycleBin -Force -ErrorAction SilentlyContinue

# ── Flush DNS cache ───────────────────────────────────────────────────────────
Write-Host "Flushing DNS cache..."
ipconfig /flushdns | Out-Null

# ── Disable hibernation (saves disk space in the template) ───────────────────
Write-Host "Disabling hibernation..."
powercfg /hibernate off

# ── Reset cloudbase-init state so it runs fresh on every clone ───────────────
Write-Host "Resetting cloudbase-init..."
$cloudbaseLog = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log"
$cloudbaseConf = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf"
if (Test-Path $cloudbaseLog) {
    Remove-Item -Path "$cloudbaseLog\*" -Force -ErrorAction SilentlyContinue
}
# Remove the instance data cache so cloudbase-init re-applies on first boot
$instanceDir = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\Cloudbase-Init\Instances"
if (Test-Path $instanceDir) {
    Remove-Item -Path "$instanceDir\*" -Recurse -Force -ErrorAction SilentlyContinue
}

# ── Remove RDP certificates so each clone gets a unique one ──────────────────
Write-Host "Removing RDP certificates..."
Remove-Item -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\RCM\GracePeriod" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "C:\ProgramData\Microsoft\Crypto\RSA\MachineKeys\*" -Force -ErrorAction SilentlyContinue

# ── Clear PowerShell history ──────────────────────────────────────────────────
Write-Host "Clearing shell history..."
Remove-Item -Path (Get-PSReadLineOption).HistorySavePath -Force -ErrorAction SilentlyContinue
Remove-Item -Path "C:\Users\*\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\*" -Force -ErrorAction SilentlyContinue

# ── Sysprep — generalize and shut down ───────────────────────────────────────
# This removes the SID, machine GUID, and activation state so each clone gets
# a unique identity. The VM will shut down — do NOT reboot.
Write-Host "Running Sysprep (generalize + shutdown)..." -ForegroundColor Yellow
& "$env:SystemRoot\System32\Sysprep\sysprep.exe" /generalize /oobe /shutdown /quiet
