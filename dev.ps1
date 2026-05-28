param(
    [switch]$NoTailscale = $false,
    [int]$Port = 9595,
    [string]$HostAddress = "127.0.0.1",
    [switch]$NoNgrok = $false
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# ---- helpers ----

function Get-TailscaleIPv4 {
    try {
        $ts = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -match '^100\.' } |
            Where-Object { $_.InterfaceAlias -match 'Tailscale' } |
            Select-Object -First 1
        if ($ts) { return $ts.IPAddress }
    } catch { }
    return $null
}

function Stop-PortProcess([int]$targetPort) {
    $conns = Get-NetTCPConnection -LocalPort $targetPort -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
            Write-Host "Stopping process $($c.OwningProcess) on port $targetPort..."
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
}

function Wait-ForPort([int]$targetPort, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    do {
        $listening = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue
        if ($listening) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

# ---- port cleanup ----

Stop-PortProcess -targetPort $Port

# ---- tailscale ----

if (-not $NoTailscale) {
    $tsAddr = Get-TailscaleIPv4
    if ($tsAddr) {
        $HostAddress = "0.0.0.0"
        Write-Host "Tailscale detected: $tsAddr (binding to 0.0.0.0)"
    } else {
        Write-Warning "No Tailscale IPv4 found. Binding to loopback. Use -NoTailscale to skip detection."
    }
}

# ---- logs ----

$logDir = Join-Path $PSScriptRoot ".tmp"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logOut = Join-Path $logDir "ngrok-dashboard-dev-$timestamp.out.log"
$logErr = Join-Path $logDir "ngrok-dashboard-dev-$timestamp.err.log"

# ---- env ----

$env:SWITCHER_PORT  = $Port
$env:SWITCHER_HOST  = $HostAddress
if ($NoNgrok) {
    $env:NO_NGROK = "1"
}

# ---- dispatch ----

Write-Host "Starting ngrok tunnel switcher on ${HostAddress}:$Port..."
if ($NoNgrok) { Write-Host "(ngrok disabled -- local access only)" }

$proc = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
    "-NoProfile",
    "-Command",
    "node `"$PSScriptRoot\server.js`" 1>`"$logOut`" 2>`"$logErr`""
)

Write-Host "Server PID: $($proc.Id)  |  Logs: $logOut"

# ---- wait for port ----

Write-Host "Waiting for port $Port..."
$ready = Wait-ForPort -targetPort $Port -timeoutSec 30

if (-not $ready) {
    Write-Host "=== SERVER FAILED TO START (last 40 stderr lines) ===" -ForegroundColor Red
    Get-Content -Path $logErr -Tail 40
    Write-Host "=== last 40 stdout lines ===" -ForegroundColor Red
    Get-Content -Path $logOut -Tail 40
    throw "Server did not start on port $Port within 30 seconds"
}

# ---- ngrok URL capture ----

Write-Host "Switcher is running on http://${HostAddress}:$Port"
if (-not $NoNgrok) {
    Write-Host "Waiting for ngrok URL (up to 20s)..."
    Start-Sleep -Seconds 3

    $deadline = (Get-Date).AddSeconds(20)
    $ngrokUrl = $null
    do {
        $ngrokUrl = Select-String -Path $logOut -Pattern 'ngrok tunnel: (https://\S+)' |
            ForEach-Object { $_.Matches.Groups[1].Value } |
            Select-Object -First 1
        if ($ngrokUrl) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    if ($ngrokUrl) {
        Write-Host "ngrok tunnel: $ngrokUrl" -ForegroundColor Green
        Write-Host "Open $ngrokUrl in your browser." -ForegroundColor Green
    } else {
        Write-Warning "ngrok URL not found in logs within 20s (may need auth or network)"
        Write-Host "Check logs: $logOut"
    }
}

Write-Host "Press Ctrl+C to stop."
try {
    $proc.WaitForExit()
} finally {
    Write-Host "Server stopped."
}
