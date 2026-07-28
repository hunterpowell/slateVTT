[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir '..\..')).Path
$clientDir = Join-Path $repoRoot 'client'
$serverExe = Join-Path $repoRoot 'server\target\release\slate-server.exe'

if (-not (Test-Path -LiteralPath $serverExe -PathType Leaf)) {
    throw 'The release server has not been built. Run .\deploy\windows\Build-Slate.ps1 first.'
}

if (-not (Test-Path -LiteralPath (Join-Path $clientDir 'dist\main.js') -PathType Leaf)) {
    throw 'The client bundle has not been built. Run .\deploy\windows\Build-Slate.ps1 first.'
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Windows did not provide a Local AppData directory.'
}

$dataDir = Join-Path $localAppData 'Slate'
$secretPath = Join-Path $dataDir 'dm-secret.txt'
$statePath = Join-Path $dataDir 'slate-state.json'
$uploadsDir = Join-Path $dataDir 'uploads'

$null = New-Item -ItemType Directory -Path $dataDir -Force
$null = New-Item -ItemType Directory -Path $uploadsDir -Force

if (Test-Path -LiteralPath $secretPath -PathType Leaf) {
    $dmSecret = (Get-Content -LiteralPath $secretPath -Raw).Trim()
    if ($dmSecret -notmatch '^[0-9a-f]{32}$') {
        throw "The DM secret in $secretPath is not a 32-character lowercase hexadecimal value."
    }
}
else {
    $dmSecret = [Guid]::NewGuid().ToString('N')
    Set-Content -LiteralPath $secretPath -Value $dmSecret -Encoding ascii -NoNewline
}

$localUrl = "http://127.0.0.1:$Port"

$env:SLATE_ADDR = "127.0.0.1:$Port"
$env:SLATE_CLIENT_DIR = $clientDir
$env:SLATE_STATE = $statePath
$env:SLATE_UPLOADS = $uploadsDir
$env:SLATE_DM_SECRET = $dmSecret

Write-Host ''
Write-Host 'Slate session host' -ForegroundColor Cyan
Write-Host "  Player URL: $localUrl/"
Write-Host "  DM URL:     $localUrl/?dm=$dmSecret"
Write-Host "  Data:       $dataDir"
Write-Host ''
Write-Host 'For a remote rehearsal, leave this running and open another terminal:'
Write-Host "  cloudflared tunnel --url $localUrl"
Write-Host ''
Write-Host 'Press Ctrl+C here to flush the room and stop Slate.'
Write-Host ''

& $serverExe
if ($LASTEXITCODE -ne 0) {
    throw "slate-server exited with code $LASTEXITCODE"
}
