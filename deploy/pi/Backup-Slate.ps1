<#
.SYNOPSIS
    Pulls /var/lib/slate off the Pi to this machine as a timestamped archive.

.DESCRIPTION
    Everything under /opt/slate is reproducible from a build. /var/lib/slate is
    not: it holds the saved room and every map and portrait the DM has uploaded,
    and it exists nowhere else. This is the only thing on that box worth keeping.

    It pulls rather than pushing, for three reasons. The Pi never holds a
    credential to this machine, which matters because the Pi is the box facing
    the tunnel. This machine already has the SSH key. And this machine is the one
    that is often off, so a push would be the half that fails silently.
#>
[CmdletBinding()]
param(
    # Passwordless sudo is a Pi OS default for the first user, and reading
    # /var/lib/slate needs it: the directory is mode 750 owned by `slate`.
    [ValidateNotNullOrEmpty()]
    [string]$PiHost = 'hunter@slate.local',

    # Anywhere this machine can write. Point it at a synced folder or an
    # external drive if you want the copy to survive this machine as well.
    [ValidateNotNullOrEmpty()]
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Slate\pi-backups'),

    # At ~5MB a run this is cheap; a month of nights costs about 150MB.
    [ValidateRange(1, 3650)]
    [int]$Keep = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$null = New-Item -ItemType Directory -Path $Destination -Force

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$final = Join-Path $Destination "slate-$stamp.tar.gz"
# Downloaded to .part and renamed only once it has been verified, which is the
# same trick `Store::save` uses on the Pi: an interrupted run leaves something
# that cannot be mistaken for a good backup.
$part = "$final.part"

# --exclude drops each save's own temp file. It is renamed over the real one
# atomically, so the copy here is always a whole save -- but a .tmp caught
# mid-write would restore as a truncated file sitting next to a good one.
#
# A glob rather than `slate-state.json.tmp` by name: there is one save file per
# room now and each writes its own temp beside it, so naming one would let every
# other room's slip in. tar's --exclude is a pattern, and the leading ./ matches
# how the members are listed from `-C /var/lib/slate .`.
$remote = 'sudo -n tar -czf - -C /var/lib/slate --exclude=./*.json.tmp .'
$ssh = "ssh -o BatchMode=yes -o ConnectTimeout=10 $PiHost ""$remote"""

Write-Host "Pulling /var/lib/slate from $PiHost ..."

# Routed through cmd because PowerShell's own > re-encodes a native command's
# stdout as text. Measured on this data: the naive redirect yielded 9,527,080
# bytes of something that is not gzip at all, against 5,248,529 that are.
# cmd hands the process an untouched file handle.
cmd /c "$ssh > ""$part"""
if ($LASTEXITCODE -ne 0) {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    throw "The pull failed with exit code $LASTEXITCODE. Nothing was written."
}

# Verify before rotating anything out. Inflating proves the gzip is whole, and
# finding the save's name in the inflated bytes proves the archive is the room
# rather than an empty tar or an error message that happened to compress.
$inflated = 0
$found = $false
# Declared before the try so the finally can test them under Set-StrictMode,
# which treats reading a never-assigned variable as an error.
$in = $null
$gz = $null
try {
    $in = [System.IO.File]::OpenRead($part)
    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $buffer = New-Object byte[] 65536
    while (($read = $gz.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $inflated += $read
        # Tar writes each filename in plain ASCII at the head of its 512-byte
        # block, so the name is simply present in the stream.
        if (-not $found) {
            $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            if ($text.Contains('slate-state.json')) { $found = $true }
        }
    }
}
catch {
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    throw "The archive did not inflate, so it is not a backup: $($_.Exception.Message)"
}
finally {
    if ($null -ne $gz) { $gz.Dispose() }
    if ($null -ne $in) { $in.Dispose() }
}

if (-not $found) {
    Remove-Item -LiteralPath $part -Force
    throw 'The archive inflated but holds no slate-state.json. Refusing to keep it.'
}

Move-Item -LiteralPath $part -Destination $final -Force

$compressed = (Get-Item -LiteralPath $final).Length
Write-Host ("  {0}" -f $final)
Write-Host ("  {0:N0} bytes, {1:N0} inflated" -f $compressed, $inflated) -ForegroundColor Green

# Rotate only now. A run that failed above has already thrown, so the old
# backups are never the thing that gets cleaned up after a bad night.
$stale = Get-ChildItem -LiteralPath $Destination -Filter 'slate-*.tar.gz' -File |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep
foreach ($old in $stale) {
    Remove-Item -LiteralPath $old.FullName -Force
    Write-Host "  rotated out $($old.Name)"
}

$kept = @(Get-ChildItem -LiteralPath $Destination -Filter 'slate-*.tar.gz' -File)
Write-Host ("  {0} backup(s) kept in {1}" -f $kept.Count, $Destination)
