#!/bin/sh
#
# The host half of the status page.
#
# Slate reports what Slate knows -- rooms, sockets, uptime. It deliberately does
# not know what /sys/class/thermal is: that is Linux-only, it would make the
# status handler untestable on the Windows dev machine, and a game server that
# grows a hardware monitor has stopped being a game server. So this writes a
# small JSON file and the server passes it through untouched.
#
# Installed once, like slate.service itself, and run by slate-host-status.timer.
# See deploy/pi/README.md.
#
#   sudo install -m 755 slate-host-status.sh /usr/local/bin/slate-host-status
#
# Everything here is POSIX sh with no jq: this runs every minute on a Pi 3B and
# a dependency for eleven numbers would be absurd.

set -eu

OUT="${SLATE_HOST_STATUS:-/var/lib/slate/host.json}"
TMP="$OUT.tmp"

# Every write is stamped, and that is the load-bearing field. A timer that has
# died leaves a file that still parses and still looks like data -- the age of
# this reading is the only thing that can tell the page otherwise.
now=$(date +%s)

uptime_s=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
load1=$(cut -d' ' -f1 /proc/loadavg)

# Absent on hardware without a thermal zone, which is not an error -- the page
# omits any row it is not given.
cpu_c=null
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then
    milli=$(cat /sys/class/thermal/thermal_zone0/temp)
    cpu_c=$(awk "BEGIN { printf \"%.1f\", $milli / 1000 }")
fi

# MemAvailable rather than MemFree: the kernel's own estimate of what a new
# process could actually get, which is the only one of the two worth showing.
mem_total_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
mem_total_mb=$((mem_total_kb / 1024))
mem_used_mb=$(((mem_total_kb - mem_avail_kb) / 1024))

# The filesystem holding the saves and the uploads, which is the one that
# filling up would end an evening.
disk_dir=$(dirname "$OUT")
set -- $(df -P "$disk_dir" | awk 'NR == 2 { print $2, $3, $5 }')
disk_total_gb=$(awk "BEGIN { printf \"%.1f\", $1 / 1048576 }")
disk_used_gb=$(awk "BEGIN { printf \"%.1f\", $2 / 1048576 }")
disk_pct=$(printf '%s' "$3" | tr -d '%')

# Uploads only ever grows -- picking a map copies it in and removing it from
# the library deliberately leaves the copy behind -- so this is what tells you
# when to run tools/audit-uploads.mjs. Cheap at this scale, and `du` walking a
# few dozen files once a minute costs nothing on this board.
UPLOADS="${SLATE_UPLOADS:-$disk_dir/uploads}"
uploads_mb=null
uploads_files=null
if [ -d "$UPLOADS" ]; then
    # Both pipelines end in a command that succeeds on empty input, so neither
    # can trip `set -e` when the directory is unreadable.
    uploads_mb=$(du -sm "$UPLOADS" 2>/dev/null | cut -f1)
    uploads_files=$(find "$UPLOADS" -type f 2>/dev/null | wc -l | tr -d ' ')
    [ -n "$uploads_mb" ] || uploads_mb=null
    [ -n "$uploads_files" ] || uploads_files=null
fi

# Automatic restarts. `Restart=always` means a crash is invisible -- the service
# is back in five seconds and the only trace is in the journal -- so this is the
# one number that says it happened at all.
#
# systemd resets NRestarts on an *explicit* start or restart, so a deploy zeroes
# it. That is the semantic worth having: any number here means the service fell
# over on its own since the last time you touched it.
restarts=null
if command -v systemctl >/dev/null 2>&1; then
    n=$(systemctl show slate -p NRestarts --value 2>/dev/null) || n=
    case "$n" in
        '' | *[!0-9]*) ;;
        *) restarts=$n ;;
    esac
fi

# The Pi 3B's characteristic failure, and one that looks like nothing else: a
# tired supply browns out under load and the board silently throttles. Bit 0 is
# under-voltage right now, bit 16 is that it has happened since boot -- both are
# worth having, because the second is what catches an overnight dip.
throttled=unknown
undervoltage=false
undervoltage_ever=false
if command -v vcgencmd >/dev/null 2>&1; then
    raw=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2) || raw=
    # Matched before it is used as a number: an unexpected word here would make
    # the arithmetic below a syntax error, and `set -e` would take the whole
    # reading down over a field nothing depends on.
    case "$raw" in
        0x*)
            throttled=$raw
            bits=$((raw))
            if [ $((bits & 1)) -ne 0 ]; then undervoltage=true; fi
            if [ $((bits & 65536)) -ne 0 ]; then undervoltage_ever=true; fi
            ;;
    esac
fi

# Written whole and then renamed, so the server never reads a half-written file.
# rename(2) within one directory is atomic, which is the whole reason TMP sits
# beside OUT rather than in /tmp.
printf '{"at":%s,"uptime_s":%s,"load1":%s,"cpu_c":%s,' \
    "$now" "$uptime_s" "$load1" "$cpu_c" >"$TMP"
printf '"mem_used_mb":%s,"mem_total_mb":%s,' \
    "$mem_used_mb" "$mem_total_mb" >>"$TMP"
printf '"disk_used_gb":%s,"disk_total_gb":%s,"disk_pct":%s,' \
    "$disk_used_gb" "$disk_total_gb" "$disk_pct" >>"$TMP"
printf '"uploads_mb":%s,"uploads_files":%s,"restarts":%s,' \
    "$uploads_mb" "$uploads_files" "$restarts" >>"$TMP"
printf '"throttled":"%s","undervoltage":%s,"undervoltage_ever":%s}\n' \
    "$throttled" "$undervoltage" "$undervoltage_ever" >>"$TMP"

chmod 644 "$TMP"
mv -f "$TMP" "$OUT"
