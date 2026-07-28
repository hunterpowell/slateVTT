[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir '..\..')).Path
$clientDir = Join-Path $repoRoot 'client'
$serverDir = Join-Path $repoRoot 'server'
$serverExe = Join-Path $serverDir 'target\release\slate-server.exe'

Write-Host 'Installing the locked client dependencies...'
Push-Location -LiteralPath $clientDir
try {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci exited with code $LASTEXITCODE"
    }

    npm.cmd run check
    if ($LASTEXITCODE -ne 0) {
        throw "npm run check exited with code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host 'Testing and building the release server...'
Push-Location -LiteralPath $serverDir
try {
    cargo.exe test
    if ($LASTEXITCODE -ne 0) {
        throw "cargo test exited with code $LASTEXITCODE"
    }

    cargo.exe build --release
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build --release exited with code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Slate is ready to run:' -ForegroundColor Green
Write-Host "  $serverExe"
