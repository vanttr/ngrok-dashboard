# dev.ps1 - Dummy test server for e2e screenshot testing
# Starts a simple HTTP server on port 57123.
$Port = 57123

$conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    if ($c.OwningProcess -and $c.OwningProcess -ne $PID) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

$logDir = Join-Path $PSScriptRoot ".tmp"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$serverJsFile = Join-Path $logDir "dummy-server.js"
Set-Content -LiteralPath $serverJsFile -Value @"
const http = require('http');
const s = http.createServer((req, res) => {
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Dummy server running on port $Port');
});
s.listen($Port, '0.0.0.0', () => console.log('Dummy server listening on port $Port'));
"@ -Encoding UTF8

$proc = Start-Process -FilePath "node" -ArgumentList $serverJsFile -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(10)
do {
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        Write-Host "Dummy server started on port $Port (PID: $($proc.Id))"
        exit 0
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Write-Error "Dummy server failed to start on port $Port within 10 seconds"
exit 1
