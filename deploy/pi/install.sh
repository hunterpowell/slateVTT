#!/usr/bin/env bash
#
# Installs a staged Slate build into /opt/slate, on the Pi, as root.
#
# Called by deploy/pi/Deploy-Slate.ps1 from the Windows build machine. It is a
# separate file rather than a quoted string inside that script for two reasons:
# a shell sequence embedded in PowerShell is quoted twice and reviewable in
# neither language, and the rollback below is more logic than a one-liner can
# carry honestly.
#
# The shape is: build the whole new tree beside the live one, and only then
# stop the service for the renames that swap them. Everything that can fail --
# a missing artifact, the wrong architecture, a bad copy -- fails while Slate
# is still running the old build and has not been touched. After the swap the
# only failure left is the new build refusing to serve, and that one rolls back.
#
# Usage: sudo bash install.sh <stage-dir>

set -euo pipefail

STAGE="${1:?usage: install.sh <stage-dir>}"

# Both are the real paths in every real run. They are overridable only so the
# rollback below can be exercised against a fake tree on a machine that is not
# the Pi -- a failsafe nobody has watched fire is a comment, not a failsafe.
OPT="${SLATE_OPT:-/opt/slate}"
ENV_FILE="${SLATE_ENV_FILE:-/etc/slate/slate.env}"
UNIT="${SLATE_UNIT:-/etc/systemd/system/slate.service}"

# Set once the swap has happened, so the trap knows whether there is anything to
# undo. Before that point a failure needs no rollback: nothing has moved.
SWAPPED=0
ROLLED_BACK=0

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------

rollback() {
    # set +e first: a rollback that aborts half way through because one mv
    # failed is worse than no rollback at all, and `set -e` would do exactly
    # that inside a function.
    set +e

    [ "$SWAPPED" -eq 1 ] || return 0
    [ "$ROLLED_BACK" -eq 0 ] || return 0
    ROLLED_BACK=1

    printf '\n== Rolling back to the previous build\n' >&2

    systemctl stop slate 2>/dev/null || true

    # Keep what failed rather than deleting it. A build that would not serve is
    # the thing you want to look at, and /opt is reproducible from a build, so
    # the disk it costs is not precious.
    if [ -d "$OPT/client" ] && [ -d "$OPT/client.old" ]; then
        rm -rf "$OPT/client.failed"
        mv "$OPT/client" "$OPT/client.failed"
        mv "$OPT/client.old" "$OPT/client"
    fi
    if [ -f "$OPT/bin/slate-server.old" ]; then
        mv -f "$OPT/bin/slate-server" "$OPT/bin/slate-server.failed" 2>/dev/null || true
        mv -f "$OPT/bin/slate-server.old" "$OPT/bin/slate-server"
    fi

    if systemctl start slate 2>/dev/null; then
        printf '  the previous build is running again\n' >&2
        printf '  what failed is kept at %s/client.failed and %s/bin/slate-server.failed\n' "$OPT" "$OPT" >&2
    else
        printf '  COULD NOT RESTART SLATE. Look at: journalctl -u slate -n 50\n' >&2
    fi
}

# EXIT as well as ERR, and that is load-bearing rather than belt-and-braces:
# `die` exits explicitly, and an explicit exit does not fire an ERR trap. The
# one failure that most needs a rollback -- the health check below refusing to
# go green -- reaches it through EXIT and through nothing else. Firing both is
# harmless; `rollback` is idempotent, and the success path clears all four.
trap rollback EXIT ERR INT TERM

# ---------------------------------------------------------------------------
# Preflight -- everything knowable before anything is touched
# ---------------------------------------------------------------------------

step "Checking the staged build"

[ "$(id -u)" -eq 0 ] || die "must run as root (sudo bash install.sh <stage-dir>)"
[ -d "$STAGE" ]      || die "no stage directory at $STAGE"

# The install target has to exist already. If it does not, this is a first
# install: the layout, the service account and the env file have not been made,
# which is section 3 of the README and not this script's job.
[ -d "$OPT/bin" ]    || die "$OPT/bin is missing -- run the first-time setup in deploy/pi/README.md"
[ -d "$OPT/client" ] || die "$OPT/client is missing -- run the first-time setup in deploy/pi/README.md"
[ -f "$UNIT" ] || die "there is no slate.service -- run the first-time setup"
[ -f "$ENV_FILE" ]   || die "$ENV_FILE is missing -- run the first-time setup"

BIN="$STAGE/slate-server"
[ -s "$BIN" ] || die "no staged binary at $BIN, or it is empty"

# Every file the client needs, named individually. A directory that silently
# arrived one level up is the deploy failure this README warns about twice, and
# naming them turns it into a refusal here rather than a blank page on Saturday.
for f in \
    "$STAGE/client/index.html" \
    "$STAGE/client/dist/main.js" \
    "$STAGE/client/spells/index.html"
do
    [ -s "$f" ] || die "missing or empty: $f"
done
[ -d "$STAGE/client/assets" ] || die "missing directory: $STAGE/client/assets"

# The architecture check, before the service is stopped. `file` is not on a Lite
# install, so read the ELF header directly: 7f 45 4c 46 is the magic, byte 4 is
# 02 for 64-bit, and bytes 18-19 are the machine -- b7 00 little-endian for
# EM_AARCH64. Getting this wrong is `Exec format error` at start, which without
# this check would cost a rollback instead of a refusal.
magic=$(head -c 20 "$BIN" | od -An -v -tx1 | tr -d ' \n')
[ "${magic:0:10}" = "7f454c4602" ] || die "$BIN is not a 64-bit ELF binary (header ${magic:0:10})"
[ "${magic:36:4}" = "b700" ]       || die "$BIN is not aarch64 -- wrong --target on the build machine (machine ${magic:36:4})"

say "binary is 64-bit aarch64 ELF, $(stat -c %s "$BIN") bytes"
say "client carries index.html, dist/main.js, assets/ and spells/"

# Where to knock once it is up. Sourcing the env file would execute it; read the
# one line instead. Loopback and 3000 are the README's defaults.
ADDR=$(sed -n 's/^SLATE_ADDR=//p' "$ENV_FILE" | tail -1)
ADDR="${ADDR:-127.0.0.1:3000}"
say "health check will use http://$ADDR/"

# ---------------------------------------------------------------------------
# Build the new tree beside the live one
# ---------------------------------------------------------------------------

step "Staging the new build into $OPT"

rm -rf "$OPT/client.new"
rm -f  "$OPT/bin/slate-server.new"

install -o root -g root -m 755 "$BIN" "$OPT/bin/slate-server.new"

mkdir -p "$OPT/client.new"
cp -r "$STAGE/client/." "$OPT/client.new/"
chown -R root:root "$OPT/client.new"
chmod -R a+rX "$OPT/client.new"
# u+w as well, so the next deploy's rm -rf is not fighting the mode this one set.
chmod -R u+w "$OPT/client.new"

# Prove the copy arrived rather than trusting cp's exit code. Same list as the
# preflight, one directory later.
for f in index.html dist/main.js spells/index.html; do
    [ -s "$OPT/client.new/$f" ] || die "the copy into $OPT/client.new is missing $f"
done
[ -d "$OPT/client.new/assets" ] || die "the copy into $OPT/client.new is missing assets/"

# A map or a portrait under the client directory is served statically, which
# routes around the DM-only picker entirely -- the README calls this out as the
# one deploy typo that matters beyond tidiness. Refuse it here, where refusing
# is still free.
unexpected=$(find "$OPT/client.new" -maxdepth 1 -mindepth 1 \
    ! -name index.html ! -name dist ! -name assets ! -name spells -printf '%f\n')
if [ -n "$unexpected" ]; then
    die "unexpected entries in the staged client tree, which is served statically: $(echo "$unexpected" | tr '\n' ' ')"
fi
say "client tree holds exactly index.html, dist, assets and spells"

say "new tree built; nothing live has been touched yet"

# ---------------------------------------------------------------------------
# The swap
# ---------------------------------------------------------------------------

step "Swapping it in"

# systemctl stop sends SIGTERM, which main.rs handles -- so this flushes a change
# still inside the save debounce. Do not kill the service instead.
systemctl stop slate
say "slate stopped"

SWAPPED=1

rm -rf "$OPT/client.old"
cp -p "$OPT/bin/slate-server" "$OPT/bin/slate-server.old"
mv    "$OPT/client" "$OPT/client.old"
mv    "$OPT/client.new" "$OPT/client"
mv -f "$OPT/bin/slate-server.new" "$OPT/bin/slate-server"

say "swapped; the previous build is at client.old and bin/slate-server.old"

systemctl start slate

# ---------------------------------------------------------------------------
# Health check -- what the rollback exists for
# ---------------------------------------------------------------------------

step "Checking that it serves"

ok=0
for attempt in $(seq 1 20); do
    sleep 1
    systemctl is-active --quiet slate || continue
    curl -fsS -o /dev/null --max-time 3 "http://$ADDR/"        || continue
    # The spell index is not part of the esbuild bundle and arrives only if its
    # own copy ran. A 404 here is the missed client/spells, and it looks fine on
    # the build machine, so it is worth a rollback rather than a warning.
    curl -fsS -o /dev/null --max-time 3 "http://$ADDR/spells/" || continue
    ok=1
    say "serving after ${attempt}s: / and /spells/ both 200"
    break
done

[ "$ok" -eq 1 ] || die "slate did not serve within 20s -- see journalctl -u slate -n 50"

# ---------------------------------------------------------------------------
# Done -- retire the rollback copies
# ---------------------------------------------------------------------------

trap - EXIT ERR INT TERM

step "Done"

rm -rf "$OPT/client.old" "$OPT/bin/slate-server.old"
rm -rf "$OPT/client.failed" "$OPT/bin/slate-server.failed"

# The libraries live under /var/lib/slate and a deploy never writes there, so a
# missing one is the env file rather than this run -- a warning and not a
# failure, because rolling back would not fix it.
if journalctl -u slate --since '2 minutes ago' --no-pager 2>/dev/null | grep -q 'no .* library there'; then
    printf '\n  WARNING: slate logged a missing library. Check SLATE_MAPS / SLATE_PORTRAITS /\n'
    printf '           SLATE_BACKDROPS in %s against /var/lib/slate.\n' "$ENV_FILE"
fi

say "$(systemctl is-active slate) -- $(journalctl -u slate -n 1 --no-pager -o cat 2>/dev/null | head -1)"
printf '\n'
