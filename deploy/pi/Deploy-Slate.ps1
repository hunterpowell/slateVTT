<#
.SYNOPSIS
    Builds Slate on this machine and installs it on the Pi.

.DESCRIPTION
    This is the whole of *Every deploy* in deploy/pi/README.md, in one command.
    Four phases: build here, check the artifacts here, ship them to ~/stage on
    the Pi, and hand off to install.sh which does the swap and the rollback.

    Nothing here writes to /var/lib/slate. The saved rooms, the uploads and the
    three libraries are the DM's and a deploy has nothing to say about them --
    seeding those is an install step, in the README, run once by hand.

    The failure design has one rule: refuse before the service stops. Every
    check that can be made from a file on disk -- the binary's architecture, the
    files the bundle needs, the spell index that esbuild never touches -- is made
    on this machine before a byte is uploaded, and again on the Pi before Slate
    is stopped. Past that point install.sh has already built the replacement
    tree beside the live one, so the swap is two renames, and a new build that
    will not serve is rolled back to the old one automatically.

.EXAMPLE
    .\Deploy-Slate.ps1

.EXAMPLE
    .\Deploy-Slate.ps1 -SkipBuild
    Reship the binary and bundle already on disk. Refuses if either is older
    than a source file, which is the mistake this switch exists to make possible.
#>
[CmdletBinding()]
param(
    # Passwordless sudo is a Pi OS default for the first user, and install.sh
    # needs it: /opt/slate is root-owned. Same default as Backup-Slate.ps1.
    # A name here is resolved once, in the preflight, and every command below is
    # handed the address it produced; an address is taken as it stands.
    [ValidateNotNullOrEmpty()]
    [string]$PiHost = 'hunter@slate.local',

    # Reuse the artifacts on disk instead of rebuilding. For a re-run after a
    # network failure, not for a code change.
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Under Set-StrictMode, reading this before any native command has run is an
# error, and the first thing below is a check that reads it.
$global:LASTEXITCODE = 0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir '..\..')).Path

# The build target's glibc suffix. Older than the Pi's 2.41 on purpose: old
# symbols exist on new systems and not the reverse, so building down is the safe
# direction. See *Every deploy* in the README.
$target = 'aarch64-unknown-linux-gnu.2.36'
$binRelative = 'server\target\aarch64-unknown-linux-gnu\release\slate-server'

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$What
    )
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed with exit code $LASTEXITCODE."
    }
}

function Assert-Tool {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Hint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is not on PATH. $Hint"
    }
}

function Step { param([string]$Text) Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Say  { param([string]$Text) Write-Host "  $Text" }

# `user@host` in, the two halves out. The user half keeps its `@`, so a -PiHost
# with no user in it -- ssh's own config may supply one -- rebuilds as a bare
# address rather than as a stray `@`.
function Split-Target {
    param([Parameter(Mandatory)][string]$Target)
    $at = $Target.LastIndexOf('@')
    if ($at -lt 0) { return @{ User = ''; Name = $Target } }
    return @{ User = $Target.Substring(0, $at + 1); Name = $Target.Substring($at + 1) }
}

# Every IPv4 address the name answers with, or the name itself if it is already
# an address. IPv4 only: an mDNS answer leads with a link-local IPv6 address,
# and handing ssh a scoped fe80:: literal is a fight not worth having.
function Resolve-PiAddress {
    param([Parameter(Mandatory)][string]$Name)

    $parsed = [System.Net.IPAddress]::Any
    if ([System.Net.IPAddress]::TryParse($Name, [ref]$parsed)) { return @($Name) }

    # Ask until two lookups have answered rather than one: a host on two
    # interfaces answers with one address per lookup here, so a single answer is
    # not the whole set and the probe below wants every candidate it can get.
    # The attempts are also what absorb the misses -- a failed lookup is a
    # two-second timeout and a successful one is milliseconds, so asking again
    # costs real time only when the last answer was worth having.
    $found = @()
    $answers = 0
    for ($i = 1; $i -le 6 -and $answers -lt 2; $i++) {
        $addresses = @()
        try {
            $addresses = @([System.Net.Dns]::GetHostAddresses($Name))
            $answers++
        } catch { }
        foreach ($a in $addresses) {
            if ($a.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                $found -notcontains $a.IPAddressToString) {
                $found += $a.IPAddressToString
            }
        }
    }
    return $found
}

# ---------------------------------------------------------------------------
# 1. Preflight -- the Pi, the toolchain, and whether sudo will prompt
# ---------------------------------------------------------------------------

Step 'Preflight'

Assert-Tool -Name 'ssh' -Hint 'Install the Windows OpenSSH client.'
Assert-Tool -Name 'scp' -Hint 'Install the Windows OpenSSH client.'

if (-not $SkipBuild) {
    Assert-Tool -Name 'npm'   -Hint 'Install Node.'
    Assert-Tool -Name 'cargo' -Hint 'Install Rust.'
    # A cargo subcommand is an exe named cargo-<name> in ~/.cargo/bin, so this is
    # a direct check rather than a probe of `cargo zigbuild --version`, whose
    # exit code depends on how that subcommand handles a flag it may pass
    # through. Checked before npm ci, so a missing cross-compiler costs a
    # message rather than several minutes.
    Assert-Tool -Name 'cargo-zigbuild' -Hint 'See *Once, to set up the cross-compiler* in deploy/pi/README.md.'
    Assert-Tool -Name 'zig' -Hint 'Installed with winget but only on PATH after a terminal restart.'
}

# The Pi is reached by name, and mDNS is the least reliable link in this chain:
# from the build machine about one lookup in four times out with no answer at
# all. That would cost nothing if the name were resolved once -- but every ssh
# and scp below is a separate process doing its own lookup, so a deploy rolls
# that dice seven times and dies if any single one of them misses, half way
# through the uploads, with `Could not resolve hostname`. A Pi on both ethernet
# and wifi compounds it: each successful lookup round-robins between the two
# addresses, so consecutive uploads can take different paths and an idle
# interface can stall a cold connect.
#
# So resolve here, probe what comes back, and hand every command below the one
# literal address that answered. One lookup per deploy instead of seven, and
# this check now covers the run rather than only itself.
$split = Split-Target -Target $PiHost
$piUser = $split.User
$piName = $split.Name

Say "resolving $piName..."
$candidates = @(Resolve-PiAddress -Name $piName)
if ($candidates.Count -eq 0) {
    throw "Could not resolve $piName from this machine. If it is an mDNS name the lookup is " +
          "unreliable rather than broken -- try again, or pass the address instead, as " +
          "-PiHost $piUser<address>. Nothing has been built or shipped."
}
Say ("resolved to " + ($candidates -join ', '))

# BatchMode so a missing key fails instead of prompting, and this doubles as the
# reachability check. `sudo -n true` proves install.sh will not hang on a
# password prompt over a non-interactive ssh -- which is a hang, not an error,
# and would be the worst failure mode this script has.
#
# Two passes over the candidates, because an interface that has been idle can
# time out the first connect and then answer the second one instantly. The first
# pass is what wakes it.
$PiTarget = ''
foreach ($pass in 1, 2) {
    foreach ($ip in $candidates) {
        Say "checking $piUser$ip is reachable and sudo will not prompt..."
        & ssh.exe -o BatchMode=yes -o ConnectTimeout=10 "$piUser$ip" 'sudo -n true'
        if ($LASTEXITCODE -eq 0) { $PiTarget = "$piUser$ip"; break }
        Say "no answer from $ip (exit $LASTEXITCODE)"
    }
    if ($PiTarget) { break }
}
if (-not $PiTarget) {
    throw "Could not reach $PiHost with a key at $($candidates -join ', '), or passwordless sudo " +
          "is not available there. Nothing has been built or shipped."
}
Say "ok -- the rest of this deploy uses $PiTarget"

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------

if ($SkipBuild) {
    Step 'Skipping the build'
} else {
    Step 'Building the client'
    Push-Location -LiteralPath (Join-Path $repoRoot 'client')
    try {
        Invoke-Native -Exe 'npm.cmd' -Arguments @('ci') -What 'npm ci'
        # typecheck, test and build, producing dist/main.js
        Invoke-Native -Exe 'npm.cmd' -Arguments @('run', 'check') -What 'npm run check'
    } finally { Pop-Location }

    Step 'Testing and cross-building the server'
    Push-Location -LiteralPath (Join-Path $repoRoot 'server')
    try {
        # Natively on x86 first: a cross-compiled test binary cannot run on this
        # machine, so test, then cross-build.
        Invoke-Native -Exe 'cargo.exe' -Arguments @('test') -What 'cargo test'
        Invoke-Native -Exe 'cargo.exe' -Arguments @('zigbuild', '--release', '--target', $target) -What "cargo zigbuild --target $target"
    } finally { Pop-Location }

}

# ---------------------------------------------------------------------------
# 2a. Stamp what is being shipped
# ---------------------------------------------------------------------------

# What the status page reports as the running build, written here because this
# is the only machine that knows -- the Pi has no checkout.
#
# **Repo root, not client\dist.** Anything under client\ is copied into
# /opt/slate/client, which is served statically, and this is for /api/status to
# read rather than for anyone who can reach the port. It is shipped as its own
# scp to stage/build.json, which is where install.sh looks for it.
#
# Outside the -SkipBuild branch on purpose: a reship with a stale stamp beside a
# fresh binary is the one lie this file exists to prevent. It describes the
# checkout, which with -SkipBuild is the best answer available.
Step 'Stamping the build'
$stamp = Join-Path $repoRoot 'build.json'
try {
    Push-Location -LiteralPath $repoRoot
    try {
        $sha = (& git.exe rev-parse --short HEAD 2>$null)
        $branch = (& git.exe rev-parse --abbrev-ref HEAD 2>$null)
        # Anything in the working tree at all, tracked or not. A deploy from a
        # dirty tree is exactly the one worth flagging on the page, because the
        # sha beside it is then not the whole truth.
        $dirty = [bool] (& git.exe status --porcelain 2>$null)
    } finally { Pop-Location }
    $sha = if ($sha) { "$sha".Trim() } else { 'unknown' }
    $branch = if ($branch) { "$branch".Trim() } else { 'unknown' }
} catch {
    Say "could not read git ($($_.Exception.Message)); stamping it unknown"
    $sha = 'unknown'; $branch = 'unknown'; $dirty = $false
}
# Always written, even when git said nothing useful: the upload list below is a
# fixed table and a missing source there is a failed deploy, so "unknown" is the
# answer rather than no file.
$info = [ordered] @{
    sha        = $sha
    branch     = $branch
    dirty      = [bool] $dirty
    built_unix = [int64] ((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds
}
# **No BOM, explicitly.** Windows PowerShell 5.1's `-Encoding utf8` writes one,
# and a byte order mark in front of `{` is not JSON as far as `serde_json` is
# concerned -- the stamp parsed fine in every editor and was silently dropped by
# the server. `WriteAllText` with an explicit encoding is the one form that
# means the same thing in both PowerShell editions.
[System.IO.File]::WriteAllText(
    $stamp,
    ($info | ConvertTo-Json -Compress),
    (New-Object System.Text.UTF8Encoding($false)))
Say "stamped $($info.sha)$(if ($info.dirty) { ' (dirty)' })"

# ---------------------------------------------------------------------------
# 3. Check the artifacts before uploading any of them
# ---------------------------------------------------------------------------

Step 'Checking the artifacts'

Push-Location -LiteralPath $repoRoot
try {
    $binPath = Join-Path $repoRoot $binRelative

    # Each of these is copied separately below, and each has its own way of
    # going missing. client\spells is the sharp one: esbuild never touches it,
    # so it is absent from dist and arrives only if its own copy runs.
    $needed = @(
        $binRelative
        'client\index.html'
        'client\dist\main.js'
        'client\assets'
        'client\spells\index.html'
        'client\status\index.html'
        'client\status\status.js'
        'build.json'
    )
    foreach ($rel in $needed) {
        $full = Join-Path $repoRoot $rel
        if (-not (Test-Path -LiteralPath $full)) {
            throw "Missing build artifact: $rel$(if ($SkipBuild) { ' -- drop -SkipBuild.' })"
        }
    }

    # The architecture check, here rather than only on the Pi, so a wrong
    # --target costs a message instead of an upload. The ELF header: bytes 0-3
    # are the magic, byte 4 is 02 for 64-bit, bytes 18-19 are the machine, and
    # b7 00 little-endian is EM_AARCH64.
    $header = [byte[]]::new(20)
    $fs = [System.IO.File]::OpenRead($binPath)
    try {
        if ($fs.Read($header, 0, 20) -ne 20) { throw "$binRelative is too small to be a binary." }
    } finally { $fs.Dispose() }

    if ($header[0] -ne 0x7f -or $header[1] -ne 0x45 -or $header[2] -ne 0x4c -or $header[3] -ne 0x46) {
        throw "$binRelative is not an ELF binary. This is probably the Windows build -- check the --target."
    }
    if ($header[4] -ne 2) { throw "$binRelative is not 64-bit." }
    if ($header[18] -ne 0xb7 -or $header[19] -ne 0) {
        throw "$binRelative is not aarch64 (machine $($header[18])). Rebuild with --target $target."
    }

    $binItem = Get-Item -LiteralPath $binPath
    Say ("binary: {0:N0} bytes, aarch64 ELF, built {1:yyyy-MM-dd HH:mm}" -f $binItem.Length, $binItem.LastWriteTime)

    # Staleness. -SkipBuild exists for re-running a deploy whose upload failed;
    # what it must not do quietly is ship yesterday's binary for today's change.
    if ($SkipBuild) {
        $bundle = Get-Item -LiteralPath (Join-Path $repoRoot 'client\dist\main.js')
        # @() so a single surviving directory does not unroll to a bare string,
        # and so an empty result is an empty array rather than $null -- which
        # Get-ChildItem -LiteralPath would refuse under Set-StrictMode.
        $sourceDirs = @(@('server\src', 'client\src') |
            ForEach-Object { Join-Path $repoRoot $_ } |
            Where-Object { Test-Path -LiteralPath $_ })
        $newest = $null
        if ($sourceDirs.Count -gt 0) {
            $newest = Get-ChildItem -LiteralPath $sourceDirs -Recurse -File |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
        }
        if ($null -ne $newest) {
            $oldest = if ($binItem.LastWriteTime -lt $bundle.LastWriteTime) { $binItem } else { $bundle }
            if ($newest.LastWriteTime -gt $oldest.LastWriteTime) {
                throw ("$($oldest.Name) is older than $($newest.Name) ({0:yyyy-MM-dd HH:mm} vs {1:yyyy-MM-dd HH:mm}). " -f $oldest.LastWriteTime, $newest.LastWriteTime) +
                      'Drop -SkipBuild.'
            }
        }
        Say 'artifacts are newer than every source file'
    }

# ---------------------------------------------------------------------------
# 4. Ship
# ---------------------------------------------------------------------------

    Step "Shipping to $PiTarget"

    # Every remote command in this script is quote-free on purpose. PowerShell
    # 5.1 mangles embedded double quotes when it hands an argument to a native
    # exe, so a remote command that needs quoting is a bug that appears only on
    # the machine you did not test on. $HOME/stage has no spaces in it, so none
    # is needed -- and the one thing that genuinely wanted quoting, the CRLF
    # strip, is done locally below instead.

    # Clear the stage first. A file left behind by a deploy that failed half way
    # through would otherwise be installed by this one, which is the kind of
    # thing that works until the one time it does not.
    Invoke-Native -Exe 'ssh.exe' -Arguments @('-o', 'ConnectTimeout=10', $PiTarget, 'rm -rf $HOME/stage && mkdir -p $HOME/stage/client') -What 'clearing the stage directory'

    # core.autocrlf is true on this machine, so install.sh is very likely checked
    # out with CRLF, and bash fails on a \r with an error naming the wrong line.
    # Normalise here rather than on arrival: doing it remotely needs `tr -d "\r"`,
    # whose quotes are exactly what PowerShell 5.1 will not pass intact, and an
    # unquoted \r silently becomes a plain r, which deletes every letter r in the
    # script. Local, byte-exact, and checkable.
    $installSource = Join-Path $repoRoot 'deploy\pi\install.sh'
    $installBytes = [System.IO.File]::ReadAllBytes($installSource)
    $lf = [System.Collections.Generic.List[byte]]::new($installBytes.Length)
    for ($i = 0; $i -lt $installBytes.Length; $i++) {
        # Drop a CR only where it precedes an LF, so a lone 0x0D inside the file
        # would survive rather than being quietly rewritten.
        if ($installBytes[$i] -eq 0x0D -and $i + 1 -lt $installBytes.Length -and $installBytes[$i + 1] -eq 0x0A) { continue }
        $lf.Add($installBytes[$i])
    }
    $installLocal = Join-Path ([System.IO.Path]::GetTempPath()) 'slate-install.sh'
    [System.IO.File]::WriteAllBytes($installLocal, $lf.ToArray())
    if ($lf.Count -ne $installBytes.Length) {
        Say ("install.sh: stripped {0} CR bytes" -f ($installBytes.Length - $lf.Count))
    }

    # One source per scp, always. `scp -r` with several sources and a
    # trailing-slash destination flattens them a level up, silently -- so the
    # rule is encoded as a table here rather than left to be remembered.
    $uploads = @(
        @{ Local = $binRelative;                 Remote = 'stage/slate-server';  Recurse = $false }
        @{ Local = 'client\index.html';          Remote = 'stage/client/';       Recurse = $false }
        @{ Local = 'client\dist';                Remote = 'stage/client/';       Recurse = $true  }
        @{ Local = 'client\assets';              Remote = 'stage/client/';       Recurse = $true  }
        @{ Local = 'client\spells';              Remote = 'stage/client/';       Recurse = $true  }
        @{ Local = 'client\status';              Remote = 'stage/client/';       Recurse = $true  }
        @{ Local = 'build.json';                 Remote = 'stage/build.json';    Recurse = $false }
    )
    # client\src and client\node_modules are deliberately absent: the Pi serves
    # the bundle, not the sources.

    foreach ($u in $uploads) {
        # Not $args: that is an automatic variable, and assigning to it in a
        # script scope is a bug waiting for the one run where it matters.
        $scpArgs = @('-o', 'ConnectTimeout=10')
        if ($u.Recurse) { $scpArgs += '-r' }
        $scpArgs += $u.Local
        $scpArgs += "${PiTarget}:$($u.Remote)"
        Say "$($u.Local) -> $($u.Remote)"
        Invoke-Native -Exe 'scp.exe' -Arguments $scpArgs -What "scp $($u.Local)"
    }

    # install.sh goes separately because the normalised copy lives in the temp
    # directory, and every other path here is relative to the repo root. Sent
    # from inside its own directory rather than by absolute path: whether scp
    # reads a leading `C:` as a drive or as a hostname is a question worth not
    # having, and a bare filename does not raise it.
    Say "$installLocal -> stage/install.sh"
    Push-Location -LiteralPath (Split-Path -Parent $installLocal)
    try {
        Invoke-Native -Exe 'scp.exe' `
            -Arguments @('-o', 'ConnectTimeout=10', (Split-Path -Leaf $installLocal), "${PiTarget}:stage/install.sh") `
            -What 'scp install.sh'
    } finally { Pop-Location }

# ---------------------------------------------------------------------------
# 5. Install -- everything past here is install.sh's, including the rollback
# ---------------------------------------------------------------------------

    Step 'Installing on the Pi'

    & ssh.exe -o ConnectTimeout=10 $PiTarget 'sudo -n bash $HOME/stage/install.sh $HOME/stage'
    if ($LASTEXITCODE -ne 0) {
        throw "The install failed with exit code $LASTEXITCODE. install.sh rolls back on its own, so Slate should be " +
              "running the previous build -- confirm with: ssh $PiTarget systemctl is-active slate"
    }

    Remove-Item -LiteralPath $installLocal -Force -ErrorAction SilentlyContinue
}
finally { Pop-Location }

Write-Host ''
Write-Host 'Deployed.' -ForegroundColor Green
Write-Host "  ssh -L 3000:127.0.0.1:3000 $PiTarget   then browse http://localhost:3000/"
