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
# The two libraries the DM picks from. They stay in the repo rather than moving
# under the data directory: picking copies into uploads, so what is backed up
# there is still every map and portrait the room has actually used.
$mapsDir = Join-Path $repoRoot 'maps'
$portraitsDir = Join-Path $repoRoot 'portraits'

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
    # Letters, digits, - and _ only: this is pasted raw into the DM URL's query
    # string and sent raw as a header value, and neither is encoded on the way
    # out, so a space or a character like & or # would corrupt one or the other.
    if ($dmSecret -notmatch '^[A-Za-z0-9_-]+$') {
        throw "The DM secret in $secretPath must be letters, digits, - and _ only (got: $dmSecret)."
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
$env:SLATE_MAPS = $mapsDir
$env:SLATE_PORTRAITS = $portraitsDir
$env:SLATE_DM_SECRET = $dmSecret

Write-Host ''
Write-Host 'Slate session host' -ForegroundColor Cyan
Write-Host "  Player URL: $localUrl/"
Write-Host "  DM URL:     $localUrl/?dm=$dmSecret"
Write-Host "  Data:       $dataDir"
Write-Host "  Maps:       $mapsDir"
Write-Host "  Portraits:  $portraitsDir"
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
