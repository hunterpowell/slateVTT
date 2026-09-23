# Hosting Slate from a Raspberry Pi

This is the always-on host, and it works differently from [the Windows one](../windows/README.md).
That one runs while the group is playing and stops afterwards. This one stays up so the DM can
prepare the next dungeon on a Tuesday afternoon without anyone else being involved.

The Pi builds nothing. It receives a cross-compiled binary and a bundled client from a Windows
machine and runs them under `systemd`. Everything below assumes that split, which is why there's no
Rust or Node toolchain anywhere on the Pi: `cargo build --release` on 1GB of RAM thrashes, and heavy
swapping to the card is the one workload that really does kill SD cards.

## What this was built and verified on

- Raspberry Pi 3 Model B v1.2, 1GB RAM, 32GB SanDisk microSD
- Raspberry Pi OS Lite (64-bit), Debian 13 (trixie)
- Wired ethernet, with a DHCP reservation on the router
- A Windows 10 build machine with Rust, Node, and OpenSSH

64-bit rather than 32-bit because `aarch64-unknown-linux-gnu` is the better-tested Rust
cross-compilation target, and because a future Pi 4 or 5 would use it unchanged. At idle, before
Slate starts, the board uses around 166MB of 905MB, so there's room.

## Layout

```text
/opt/slate/            root-owned, replaced by every deploy
  bin/slate-server
  build.json           which commit is running, for the status page
  client/              index.html, dist/, assets/, spells/, status/

/var/lib/slate/        slate-owned, never touched by a deploy
  slate-state.json     the first room
  halloween.json       one file per other room (see `docs/rooms.md`)
  host.json            written by the host collector (see 3a)
  uploads/
  maps/                the DM's map library
  portraits/           the DM's token art library
  backdrops/           the DM's backdrop library
  tracks/              the DM's music library

/etc/slate/slate.env   root-only, holds the DM secret
```

**The libraries are data, not deploy artifacts, and have been since milestone 32.** They used to sit
under `/opt/slate` and be wiped and re-copied by every deploy, which was fine while the only way to
get a map into one was `scp`. The DM now adds and removes files from the panel, so a folder the
deploy replaces would lose that work on the next build. More directly, `ProtectSystem=strict` makes
everything outside `ReadWritePaths` read-only to the service, so adding a file under `/opt/slate`
wouldn't have worked at all. Moving them next to `uploads/` fixes the permissions, the ownership and
the wipe together, and puts them inside what *Backups* already copies. The repo's own `maps/`,
`portraits/`, `backdrops/` and `tracks/` are seed content: copied in once at install and never again.

The split is also the backup boundary. **`/var/lib/slate` is the only directory worth backing up**,
and a deploy never writes there. Everything under `/opt/slate` can be rebuilt, so losing it costs a
rebuild rather than a game.

The `slate` service account owns the data and none of the code, so the server can't modify its own
binary or the client it serves.

---

# First-time setup

## 1. Flash the card

Raspberry Pi Imager, *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.

Open the customisation settings **before** writing. This is what makes the box headless:

- Hostname `slate`
- A username and password
- Services → Enable SSH → **Allow public-key authentication only**, with the contents of
  `~/.ssh/id_ed25519.pub` from the Windows machine
- Locale and **timezone**, which logs and any scheduled backup depend on

Boot with ethernet attached, then `ssh <user>@slate.local`. If mDNS doesn't resolve from Windows,
find the address in the router's DHCP table. Add a DHCP reservation while you're there: doing it on
the router survives an OS reinstall and avoids the dhcpcd-versus-NetworkManager difference between Pi
OS versions.

## 2. Harden, and protect the card

```bash
sudo apt update && sudo apt full-upgrade -y
```

**Don't go looking for `dphys-swapfile`.** Trixie's Pi OS replaced it with `rpi-swap`, which provides
zram (compressed swap in RAM). It never touches the card, so there's nothing to disable, and
disabling it would only cost you headroom on a 1GB board. Confirm with `swapon --show`; a line
reading `/dev/zram0` is what you want. A swap *file* on the card would not be, and would be worth
removing.

Limit the journal's size, so logging can't turn into a constant slow stream of writes:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
echo -e "[Journal]\nSystemMaxUse=32M" | sudo tee /etc/systemd/journald.conf.d/99-slate.conf
sudo systemctl restart systemd-journald
```

Automatic security updates. This is the one step here that really costs you if you skip it: the
appeal of this box is that you forget about it, and a forgotten box goes unpatched.

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Leave `Unattended-Upgrade::Automatic-Reboot` at its default of `"false"`. A reboot in the middle of
a session is worse than a kernel patch that waits. Reboot by hand every month or so instead.

Then SSH. Check first, because the Imager may already have done it:

```bash
sudo sshd -T | grep -i -E 'passwordauth|permitrootlogin'
```

If it doesn't already say `passwordauthentication no`:

```bash
echo -e "PasswordAuthentication no\nPermitRootLogin no" | sudo tee /etc/ssh/sshd_config.d/99-slate.conf
sudo systemctl restart ssh
```

Open a second terminal and confirm you can still get in before closing the first.

This is an extra layer rather than the main protection: `sshd` is reachable only from the LAN,
because nothing is port-forwarded and the tunnel carries Slate alone. Note also that `sudo` is
passwordless for the first user by Pi OS default, so anyone holding the SSH key has root.

## 3. The service account, the directories, and the secret

```bash
sudo adduser --system --group --no-create-home --home /var/lib/slate --shell /usr/sbin/nologin slate

sudo mkdir -p /opt/slate/{bin,client}
sudo mkdir -p /var/lib/slate/{uploads,maps,portraits,backdrops,tracks}

sudo chown -R root:root /opt/slate
sudo chown -R slate:slate /var/lib/slate
sudo chmod 750 /var/lib/slate
```

```bash
sudo mkdir -p /etc/slate
SECRET=$(openssl rand -hex 16)
# A second, separate credential: it reads the status page and nothing else, so a
# display left on a shelf does not hold the key to the map library.
STATUS_KEY=$(openssl rand -hex 16)
# A third, for the Kindle on the shelf: it opens the renderer's LAN port and nothing else.
KINDLE_TOKEN=$(openssl rand -hex 16)
sudo tee /etc/slate/slate.env >/dev/null <<EOF
SLATE_ADDR=127.0.0.1:3000
SLATE_CLIENT_DIR=/opt/slate/client
SLATE_MAPS=/var/lib/slate/maps
SLATE_PORTRAITS=/var/lib/slate/portraits
SLATE_BACKDROPS=/var/lib/slate/backdrops
SLATE_TRACKS=/var/lib/slate/tracks
SLATE_STATE=/var/lib/slate/slate-state.json
SLATE_UPLOADS=/var/lib/slate/uploads
SLATE_DM_SECRET=$SECRET
SLATE_STATUS_KEY=$STATUS_KEY
SLATE_KINDLE_TOKEN=$KINDLE_TOKEN
SLATE_HOST_STATUS=/var/lib/slate/host.json
SLATE_BUILD_INFO=/opt/slate/build.json
RUST_LOG=slate_server=info
EOF
sudo chmod 600 /etc/slate/slate.env
```

Some of those need explaining:

- **`SLATE_STATE` names the *first* room's save file**, which is why it didn't have to change when
  Slate gained a second room. Every other room's save sits in the same directory, named after its id:
  `halloween.json` next to `slate-state.json`. There's nothing to migrate and nothing here to edit
  when a room is added; `docs/rooms.md` explains why it's a naming rule rather than a directory.
- **`SLATE_DM_SECRET` is one secret for the whole server** and opens whichever room is picked. There's
  no per-room secret and the DM link names no room, so the same link reaches both.
- **`SLATE_ADDR` is loopback.** `cloudflared` runs on this same box and connects locally, so Slate
  never listens on the LAN. To see it in a browser, forward the port rather than rebinding it (see
  *Seeing it in a browser* below).
- **Mode 600, root-owned** is enough, because `systemd` reads `EnvironmentFile=` as root before
  switching to `User=slate`. The service account never reads the file.
- **The secret is hex** because it goes unencoded into both the DM URL's query string and an HTTP
  header, so it must be letters, digits, `-` and `_` only. That's the same rule
  [`Start-Slate.ps1`](../windows/Start-Slate.ps1) enforces on Windows.
- **`RUST_LOG=slate_server=info`** overrides the `debug` default in `server/src/main.rs`. Turning the
  level down at the source is better than routing debug output somewhere cheap.
- **`SLATE_STATUS_KEY` is a second credential, separate from the DM secret.** It reads `/api/status`
  and nothing else, so a Kindle or a TRMNL panel left on a shelf doesn't hold the key to the map
  library. **Leave it out and `/api/status` isn't mounted at all.** The page then answers 404 rather
  than 403, because an endpoint that says "wrong credential" has announced that it exists. It's hex
  for the same reason `SLATE_DM_SECRET` is: it goes into a URL unencoded.
- **`SLATE_KINDLE_TOKEN` is read by `slate-kindle.service` and never by Slate.** It's what the Kindle
  sends as `access-token` to the one process on this box that listens on the LAN. Slate ignores it;
  it's in this file so that the service and Slate read one file and the status key is written down
  once. Leave it out and the service refuses to start. See *The Kindle* below.
- **`SLATE_HOST_STATUS` is written by something else on this box**, never by Slate. The server
  doesn't read `/sys/class/thermal` and isn't going to. See *The host collector* below; without it
  the status page's host section just reads "no collector on this machine".
- **`SLATE_BUILD_INFO` points outside `/opt/slate/client`**, which is served to anyone. The deploy
  writes it and `install.sh` puts it in place. It names the running commit, and it's rolled back with
  the binary so it can't claim a failed deploy landed.

To read the secret back later, either open that file as root or:

```bash
journalctl -u slate | grep "DM link"
```

Slate logs the DM link on every start. That's convenient, but it means the secret is sitting in the
journal in plain text.

## 3a. The host collector

The status page's host section (temperature, load, memory, disk, undervoltage, the size of
`uploads/`, and how many times systemd has restarted Slate on its own) comes from a file this
collector writes, not from Slate. `client/status/README.md` explains the split: Slate reports what
Slate knows, and a game server that grows a hardware monitor has stopped being just a game server.

It's installed once, by hand, like the service unit itself. **`Deploy-Slate.ps1` doesn't ship these
files**: they change about as often as `slate.service` does, and a deploy shouldn't be reinstalling
a systemd timer every time.

From the Windows machine, in the repo:

```powershell
scp deploy\pi\slate-host-status.sh deploy\pi\slate-host-status.service deploy\pi\slate-host-status.timer hunter@slate.local:~
```

Then on the Pi:

```bash
sudo install -m 755 ~/slate-host-status.sh      /usr/local/bin/slate-host-status
sudo install -m 644 ~/slate-host-status.service /etc/systemd/system/
sudo install -m 644 ~/slate-host-status.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slate-host-status.timer
```

Check it wrote something:

```bash
systemctl list-timers slate-host-status.timer
cat /var/lib/slate/host.json
```

It runs as root because `vcgencmd` needs the video group, and it's a separate unit rather than part
of `slate.service`, because that one runs as `slate` under `ProtectSystem=strict`, which is the wrong
sandbox for reading `/sys`.

**Every reading is stamped with the time it was taken, and that stamp is essential.** A timer that
has died leaves a file that still parses and still looks like data. The page treats a reading older
than five minutes as an alarm, which allows four missed runs.

## 3b. The Kindle

A jailbroken Kindle running the TRMNL client shows the status page as a PNG. The PNG is drawn on this
box by `client/status/kindle/kindle.py` (Python and Pillow, no browser), and
`client/status/kindle/README.md` explains why. The script arrives with every deploy in the client
tree; the unit is installed once, by hand, like the collector's.

```bash
sudo apt install -y python3-pil fonts-dejavu-core
```

Then, with `SLATE_KINDLE_TOKEN` added to `slate.env` as in step 3, from the Windows machine:

```powershell
scp deploy\pi\slate-kindle.service hunter@slate.local:~
```

and on the Pi:

```bash
sudo install -m 644 ~/slate-kindle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slate-kindle
journalctl -u slate-kindle -n 5
```

It listens on `0.0.0.0:3001`, **the one thing on this box that listens on the LAN.** Slate is on
loopback and reached through the tunnel; the Kindle is on wifi, and its TRMNL client speaks plain
HTTP to whatever `BASE_URL` it's given. That's why the token is required rather than optional, and
why the unit runs as `slate` under the same `ProtectSystem=strict` as the server: it reads
`slate.env` and writes nothing.

Test it from another machine on the LAN, with the token from `slate.env`:

```bash
curl -s -H "access-token: $KINDLE_TOKEN" -H "png-width: 1648" -H "png-height: 1236" http://slate.local:3001/api/display
```

It answers with one line of JSON naming an image; fetch that URL and you have the frame. The Kindle
README has the settings for both TRMNL clients: `BASE_URL` is the Pi's LAN address with `:3001`
(reserve the address in the router), and `API_KEY` is the token. Use the KOReader plugin if KOReader
is on the device, in either orientation. The KUAL shell client instead needs
`SLATE_KINDLE_ROTATE=90` in the unit, for its portrait framebuffer.

A deploy that changes `kindle.py` takes effect when `install.sh` runs `try-restart` on the unit,
which it does after the health check; a box without the unit installed is left alone.

## 4. The systemd unit

```bash
sudo tee /etc/systemd/system/slate.service >/dev/null <<'EOF'
[Unit]
Description=Slate virtual tabletop
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=slate
Group=slate
EnvironmentFile=/etc/slate/slate.env
WorkingDirectory=/var/lib/slate
ExecStart=/opt/slate/bin/slate-server
Restart=always
RestartSec=5

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/slate
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now slate
```

`Restart=always` is what lets the box recover unattended: a crash, or an OOM kill, is a five-second
gap rather than a lost evening. `ProtectSystem=strict` makes the whole filesystem read-only to the
service except the one path named in `ReadWritePaths`. That costs nothing, because everything Slate
writes (its save files, `uploads/`, and the four libraries the DM adds to from the panel) is under
`/var/lib/slate`. **That's why the libraries live there**: adding a map from the map panel is a
write, and systemd refuses a write anywhere else before it reaches the filesystem.

`systemctl stop` sends `SIGTERM`, which `server/src/main.rs` handles, so a stop saves any change
still waiting on the two-second save debounce, just as Ctrl+C does on Windows.

---

# Building and deploying

Run this from the Windows machine every time you want to ship a change. Nothing here touches
`/var/lib/slate`.

## Once, to set up the cross-compiler

```powershell
rustup target add aarch64-unknown-linux-gnu
winget install -e --id zig.zig
cargo install cargo-zigbuild
```

Restart the terminal afterwards so `zig` is on `PATH`.

`cargo-zigbuild` rather than WSL or Docker because Slate's dependencies are pure Rust (nothing in
`server/Cargo.toml` pulls in a C build), which makes cross-linking straightforward, and because it can
pin the glibc version explicitly.

## Every deploy

```powershell
cd c:\Users\Hunter\source\repos\slateVTT
.\deploy\pi\Deploy-Slate.ps1
```

That's all. The script builds, checks what it built, copies it to `~/stage` on the Pi, and hands off
to [`install.sh`](install.sh), which does the swap. `-PiHost` overrides the default of
`hunter@slate.local`. `-SkipBuild` re-sends the artifacts already on disk, for a re-run after a
network failure, and refuses if either artifact is older than a source file.

**The name is resolved once, in the preflight, and every `ssh` and `scp` after that is given the
resulting address.** That matters more than it sounds. mDNS is the least reliable part of this chain:
from the build machine, roughly one `slate.local` lookup in four times out with no answer at all.
Each of the seven remote commands used to resolve the name for itself, so a deploy took that chance
seven times and could die halfway through the uploads with `Could not resolve hostname`. Resolving
once also settles which *network interface* the deploy uses: a Pi on ethernet and wifi at the same
time answers to one name on two addresses, and a lookup per command means consecutive uploads can
take different paths. The preflight tries each address that came back, twice over, and the first to
answer `sudo -n true` is used for the whole run, so an interface that has gone to sleep costs one
connect timeout instead of a stalled upload. Pass `-PiHost <user>@<address>` to skip all of this and
pin the deploy to one route.

**Nothing in it writes to `/var/lib/slate`.** The saved rooms, the uploads and the libraries belong
to the DM, and a deploy has no business changing them. Seeding them is the one-off step below, run
by hand at install time.

### What it runs

The two halves are worth knowing separately, because the failure messages name them.

On the build machine:

```text
npm ci                                                   in client\
npm run check                                            typecheck, test, build -> dist/main.js
cargo test                                               in server\, natively on x86
cargo zigbuild --release --target aarch64-unknown-linux-gnu.2.36
```

`cargo test` runs natively because a cross-compiled test binary can't run on the build machine, so
it tests first, then cross-builds. **The `.2.36` suffix targets glibc 2.36 rather than whatever is
newest.** Building against an *older* glibc than the Pi's is the safe direction: old symbols exist on
new systems, not the reverse. The Pi currently has 2.41 (`ldd --version`).

Then it runs `scp` once per source, **one source per command**. `scp -r` with several sources and a
destination ending in a slash flattens them a level up without any warning, which is why the script
keeps them in a table rather than relying on someone remembering the rule:

```text
server\target\aarch64-unknown-linux-gnu\release\slate-server  ->  stage/slate-server
client\index.html                                             ->  stage/client/
client\dist                                                   ->  stage/client/
client\assets                                                 ->  stage/client/
client\spells                                                 ->  stage/client/
client\status                                                 ->  stage/client/
build.json                                                    ->  stage/build.json
deploy\pi\install.sh                                          ->  stage/install.sh
```

`client\src` and `client\node_modules` are left out: the Pi serves the bundle, not the sources.
**`client\spells` and `client\status` aren't part of the bundle and are copied on their own.**
esbuild never touches them, so they arrive only if those lines run. The client links to `/spells/`
from its bottom-right corner, and a missing copy is a 404 behind a link that looked fine on the build
machine. `text.json` is gitignored and absent here as it is everywhere else; the page falls back to
the row naming a page, which is the licensing decision in `client/spells/README.md`, not a broken
deploy. `build.json` is the stamp the script writes naming the commit being deployed; it goes outside
the client tree (see `SLATE_BUILD_INFO` above).

Then, on the Pi, it runs `sudo bash stage/install.sh stage`.

### How it fails

One rule: **refuse before the service stops.** Everything that can be checked from a file on disk is
checked on the build machine before anything is uploaded, and checked again on the Pi before Slate is
stopped: the binary's ELF header (64-bit, `EM_AARCH64`), every file the bundle needs by name, and
that the client tree holds nothing but `index.html`, `dist`, `assets`, `spells` and `status`. That
last check isn't just tidiness: the client directory is served to anyone, so a map that lands in it
can be downloaded by URL, bypassing the DM-only picker entirely.

A refusal at any of those points has stopped nothing and moved nothing. Slate is still up on the old
build.

Past that, `install.sh` builds the replacement tree at `/opt/slate/client.new` *next to* the live
one and only then stops the service, so the swap is two renames and the outage is a second or two.
The previous build is kept at `client.old` and `bin/slate-server.old` during the swap.

The one failure left is a new build that installs and then won't serve. `install.sh` waits up to 20s
for `systemctl is-active` plus a 200 from `/`, `/spells/` and `/status/`. If it doesn't get them, it
**puts the old build back and restarts it**, keeping what failed at `client.failed` and
`bin/slate-server.failed` for you to look at. `/spells/` and `/status/` are in that check because a
missed `client\spells` or `client\status` copy is a 404 the build machine can't show you.

Two preflight checks on the Windows side are worth knowing about, because they fail early and their
messages are short. `ssh -o BatchMode=yes … sudo -n true` runs before anything is built: it proves the
key works and that `sudo` on the Pi won't wait for a password, which over a non-interactive `ssh` is
a *hang* rather than an error. And `cargo zigbuild --version` is checked before `npm ci`, so a missing
cross-compiler costs a message rather than five minutes.

### Seeding the libraries (install time only)

`maps/`, `portraits/`, `backdrops/` and `tracks/` are the DM's own folders, and the deploy doesn't
touch them. Seed them once, on the first install:

```bash
scp -r maps      <user>@slate.local:stage/
scp -r portraits <user>@slate.local:stage/
scp -r backdrops <user>@slate.local:stage/
scp -r tracks    <user>@slate.local:stage/
```

```bash
# once, at install time — and never again, or a removed map comes back
sudo -u slate cp -rn ~/stage/maps/.       /var/lib/slate/maps/
sudo -u slate cp -rn ~/stage/portraits/.  /var/lib/slate/portraits/
sudo -u slate cp -rn ~/stage/backdrops/.  /var/lib/slate/backdrops/
sudo -u slate cp -rn ~/stage/tracks/.     /var/lib/slate/tracks/
```

`-n` rather than a plain copy: it never overwrites, so running this again by mistake can't replace
art the DM has since changed. It will still put back a file they *removed*, which is why this is an
install step and not part of the deploy.

Upgrading a Pi that predates milestone 32 means moving what's already there, once:

```bash
sudo systemctl stop slate
sudo mkdir -p /var/lib/slate/{maps,portraits,backdrops,tracks}
sudo cp -rn /opt/slate/maps/.       /var/lib/slate/maps/
sudo cp -rn /opt/slate/portraits/.  /var/lib/slate/portraits/
sudo chown -R slate:slate /var/lib/slate
sudo rm -rf /opt/slate/maps /opt/slate/portraits
# then update SLATE_MAPS / SLATE_PORTRAITS and add SLATE_BACKDROPS in
# /etc/slate/slate.env, and start it again
sudo systemctl start slate
```

### Doing it by hand

`install.sh` is a plain shell script that reads top to bottom. If you need to deploy without the
PowerShell half (from a machine that isn't the build machine, say), the `scp` table above and
`sudo bash stage/install.sh stage` are all it takes.

## Verify

`Deploy-Slate.ps1` already does the first four of these and rolls back if they fail, so this is for
checking a box you didn't just deploy to, or for reading the log after a deploy that did roll back.

```bash
systemctl is-active slate
curl -sI http://127.0.0.1:3000/ | head -1
curl -sI http://127.0.0.1:3000/spells/ | head -1
curl -sI http://127.0.0.1:3000/status/ | head -1
journalctl -u slate -n 20 --no-pager
```

You want `active`, `HTTP/1.1 200 OK` from all three, and a `slate listening` line whose paths match
the layout above. The second and third are the spell index and the status page, which the bundle
doesn't carry; a 404 there means the `client\spells` or `client\status` copy was missed. The absence
of any `no map library there`, `no portrait library there`, `no backdrop library there` or
`no track library there` warning confirms that the libraries were found.

`/var/lib/slate` holding only `uploads/` is normal on a fresh install. The save file isn't written
until something changes the room, because saves only happen when there's a change.

## Seeing it in a browser

Slate listens on loopback, so forward the port from the Windows machine rather than rebinding it:

```powershell
ssh -L 3000:127.0.0.1:3000 <user>@slate.local
```

Leave that window open and browse to `http://localhost:3000/`. Append `?dm=<secret>` for the DM
view. This runs **on Windows**, not on the Pi.

---

# Exposing it

## Installing `cloudflared`

Install it from Cloudflare's apt repository, so `unattended-upgrades` keeps it patched. An always-on
box shouldn't have a network daemon that needs updating by hand, which is what a downloaded `.deb`
is.

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

**The suite is `any`, not `$(lsb_release -cs)`.** Every guide online uses the `lsb_release` form,
which on this box expands to `trixie`, and Cloudflare publishes `any`, `bookworm`, `focal`, `jammy`
and `noble` for cloudflared, with no trixie suite. The `lsb_release` form 404s on every `apt update`
from then on.

## Quick Tunnel rehearsal

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

It prints a random `trycloudflare.com` address. That's the player link; append `?dm=<secret>` for
yours. The URL changes every time `cloudflared` restarts.

**A Quick Tunnel has no authentication at all**: anyone with the URL is in the room. Use it for a
rehearsal and stop it afterwards. The named tunnel below replaces it for the box at home; a Quick
Tunnel is still useful for a game away from home, where there's no time to arrange DNS.

The rehearsal checklist in [the Windows doc](../windows/README.md) applies unchanged. The items that
matter most are the ones a tunnel can break: continuous token dragging with two browsers open, which
exercises the WebSocket upgrade and the drag frame rate over real latency; a map upload, which is a
large POST on a different path; and refreshing a player mid-session to confirm they rejoin as the
same character.

---

# The named tunnel

This is what the box runs. The URL stops changing, nothing is port-forwarded, and the home IP address
never appears in public DNS.

**The hostname isn't written down here on purpose.** There are no player accounts and no Cloudflare
Access in front of Slate, so the unguessable hostname *is* the access control, and this file is in a
public git repository. Substitute the real one for `<label>` throughout. It lives in
`/etc/cloudflared/config.yml` on the Pi and nowhere in this repo.

## 1. The domain's DNS moves to Cloudflare

A named tunnel can only route DNS in a zone Cloudflare hosts, so the **nameservers** move. The
registration stays at the registrar and stays free.

This step can break a lot if the domain hosts anything else, so do it in the order below rather than
switching and seeing what happens.

**Check DNSSEC first.** If the registry publishes a DS record, changing nameservers without disabling
DNSSEC first takes the whole domain offline with SERVFAIL everywhere, for hours. It's the most common
way this migration breaks badly:

```powershell
Resolve-DnsName <domain> -Type DS -Server 1.1.1.1
```

No DS records means DNSSEC is off and there's nothing to do. If there are any, turn DNSSEC off at the
registrar and wait for the DS record to disappear from the registry before going on.

Then, in order:

1. **Inventory the existing zone** at the registrar and keep a copy. That copy is the rollback.
2. **Add the domain to Cloudflare** on the Free plan. Cloudflare's scanner is unreliable (it found
   zero records on a zone that resolves perfectly well), so expect to enter them by hand against the
   inventory. Adding a zone changes nothing yet: the registry still points every resolver at the old
   nameservers, so at this stage it can be edited or abandoned safely.
3. **Grey-cloud every pre-existing record.** Cloudflare imports A and CNAME records as *proxied*, and
   proxying a site that isn't Slate is how this step breaks something. For a GitHub Pages site in
   particular, Cloudflare's default Flexible SSL mode produces an infinite redirect loop, and GitHub's
   Let's Encrypt renewal uses an HTTP challenge to the apex that proxying can interfere with, so it
   works for ninety days and then the certificate renewal fails without warning. Grey cloud makes
   Cloudflare a plain DNS host, and the behaviour is unchanged. Slate's own record is the one
   exception, and `tunnel route dns` sets it up proxied by itself.
4. **Verify before delegating.** Cloudflare's assigned nameservers answer for a pending zone, so you
   can rehearse the whole thing at no risk by querying them directly and comparing against the
   registrar's. Repeat until every record set matches.
5. **Then change the nameservers** at the registrar: all of the old ones out, both Cloudflare ones
   in. A mixed delegation is a broken configuration where resolvers get different answers depending
   on which server they hit.

Step 4 is what makes step 5 safe, and it isn't optional. The registry publishes the delegation with
a TTL of roughly a day, so a rollback takes **24–48 hours** to propagate; there's no quick undo.
Verifying first means there's nothing to undo: both sets of nameservers return identical answers, so
it doesn't matter which one a given resolver is still using during propagation, and the site is never
down.

Expect resolvers to disagree for a while afterwards; that's fine. Query the registry directly to tell
"propagating normally" apart from "the registrar never pushed it". A resolver holding the old
delegation is a cache, not a fault.

Last, wait for **SSL/TLS → Edge Certificates** to show a Universal certificate reading *Active*.
That covers the apex and `*.<domain>`, and the wildcard is what gives Slate's subdomain HTTPS.

## 2. Choosing the hostname

```bash
openssl rand -hex 6
```

**One label deep: `<label>.<domain>`, never `<label>.slate.<domain>`.** Cloudflare's free Universal
certificate covers the apex and `*.<domain>`, one level only. A single label is therefore served by
the wildcard, and the certificate published to Certificate Transparency logs names `*.<domain>` and
never the label. Go two levels deep and the wildcard no longer covers it, so it needs an advanced
certificate that names the host explicitly, and **that name lands in a public, permanently searchable
CT log within minutes**. People scrape those logs to find unlisted hosts, so it would expose the
hostname on day one.

Don't include `slate`, `dnd` or `vtt` in it either.

## 3. Creating the tunnel

```bash
cloudflared tunnel login
```

This prints a URL rather than opening a browser, which is why it works headless. Open the URL on
another machine and authorise the zone. It writes `~/.cloudflared/cert.pem`. The zone must already be
**Active** in Cloudflare or it won't be offered.

```bash
cloudflared tunnel create slate
cloudflared tunnel list
```

This writes `~/.cloudflared/<UUID>.json`. That file is a credential: it's what lets anything serve
traffic on the hostname.

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<UUID>.json
sudo chown root:root /etc/cloudflared/<UUID>.json
```

## 4. The config, and the paste trap

**Write this with `printf`, not a heredoc.** This cost one debugging session and will cost another if
it's ignored:

```bash
SLATE_HOST=<label>.<domain>
TUNNEL_ID=$(basename ~/.cloudflared/*.json .json)

printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/%s.json\ningress:\n  - hostname: %s\n    service: http://127.0.0.1:3000\n  - service: http_status:404\n' "$TUNNEL_ID" "$TUNNEL_ID" "$SLATE_HOST" | sudo tee /etc/cloudflared/config.yml >/dev/null

sudo cat -A /etc/cloudflared/config.yml
```

A pasted heredoc arrives with its indentation normalised: leading spaces stripped and, fatally, **the
space after each `-` removed**. In YAML a dash starts a list item only when a space follows it, so
`-hostname:` is read as a key named `-hostname`, and `ingress:` becomes a mapping of three odd keys
instead of a list of two rules. The failure is `no ingress rules were defined in provided config` and
a **503**: the tunnel reaches Cloudflare's edge fine but has nothing telling it where to forward
traffic. `cloudflared ingress validate` doesn't catch it, because with no rules parsed there's nothing
for it to object to.

`printf` produces the spaces itself from a format string on one line, so there's no multi-line paste
to mangle. Check with `cat -A`, which is the only way to see the problem: it shows tabs as `^I` and
line ends as `$`, while a plain `cat` makes a broken file look fine. You want two spaces before each
`-`, one after it, and four before the nested `service:`.

The final catch-all rule is required (cloudflared refuses to start without a last rule matching
everything), and it's useful: anything arriving for a hostname not named here gets a 404 instead of
reaching Slate.

`SLATE_ADDR` stays `127.0.0.1:3000`. Nothing about Slate's own configuration changes.

## 5. The DNS route

```bash
cloudflared tunnel route dns slate $SLATE_HOST
```

This creates a **proxied** CNAME to `<UUID>.cfargotunnel.com`. It has to be proxied: that's what
keeps the home IP address out of public DNS.

## 6. Foreground first, then the service

Test the path where the logs are visible, before there's a unit in the way:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml tunnel run slate
```

`sudo` because the credentials file is root-owned and mode 600. A working start logs
`Registered tunnel connection` once per edge datacenter. Load `https://<label>.<domain>/` in a
browser, then Ctrl+C.

```bash
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo cat -A /etc/cloudflared/config.yml
```

**Pass `--config` explicitly.** Under `sudo`, `$HOME` is `/root`, so without it the installer looks
in `/root/.cloudflared/`, finds nothing, and installs a unit that reports success and then fails to
start.

The backup is a precaution: `service install` copies the config it's given into
`/etc/cloudflared/config.yml`, which is the same path, and copying a file onto itself can truncate
it. Check that `cat -A` still shows the `ingress:` block, and restore from `.bak` if it doesn't.

```bash
systemctl cat cloudflared | grep -E 'ExecStart|User='
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

## 7. Verifying

Reboot, because a box that needs a human after a power cut isn't always-on:

```bash
sudo reboot
systemctl is-active slate cloudflared
```

Both should be `active`, with nobody logged in. From the Windows machine:

```powershell
Resolve-DnsName <label>.<domain> -Type A -Server 1.1.1.1
```

You want Cloudflare anycast addresses (`104.x` or `172.67.x`), **not** the home IP. This is the
opposite of the check on the other records, where seeing the origin's own addresses proves the grey
cloud. Confirm that anything else on the domain still works, too.

Then run the rehearsal checklist from the Windows doc, over the tunnel this time.

## What this does and does not protect

The hostname is the access control. There are no accounts, so **anyone holding the link is in the
room**: the board, the WebSocket and the upload endpoint. For a private game among six friends that's
the intended trade-off, and it holds up better than "security through obscurity" usually does: the
label is unguessable, the wildcard certificate keeps it out of CT logs, Cloudflare serves no zone
transfers, and `.dev` is HSTS-preloaded so it's HTTPS-only.

The realistic failure is a leaked link rather than an attacker, and **rotating is cheap**: run
`cloudflared tunnel route dns` with a fresh label, change the hostname in `config.yml`, restart, and
delete the old DNS record.

Two limits the proxy imposes that loopback didn't:

- **Cloudflare's free plan caps request bodies at 100 MB.** A map larger than that gets a 413 from
  Cloudflare before it reaches Slate.
- **Idle proxied WebSockets are closed after around 100 seconds.** Nothing crosses a quiet board, so
  this would drop a connection mid-session. It's why the server pings every 30 seconds, as described
  under *Wire protocol* in `.claude/CLAUDE.md`.

## Still to do

- **Cloudflare Access** with the players' email addresses, so strangers never reach the WebSocket or
  the upload endpoint even if they have the link. It's per-hostname, so it would protect Slate
  without touching anything else on the domain. Declined for now because it's a login and the group
  doesn't want one; the unguessable hostname is the alternative chosen instead. If it's ever added,
  set the session duration long: an Access session expiring mid-game drops the WebSocket, and Slate's
  reconnect is a fresh join that would land on a login page.

---

# Backups

`/var/lib/slate` is the only thing on this box worth keeping, for the reason *Layout* gives:
everything else can be rebuilt, and this can't. Without a copy, an SD card failure costs the game
rather than an evening.

Since milestone 32 that includes the libraries, which moved here from `/opt/slate` when the DM gained
the ability to add to them. The script needed no change, since it archives the whole directory, but
what it archives became more valuable: a map added from the panel exists nowhere else, unlike one
that came from the repo.

[`Backup-Slate.ps1`](Backup-Slate.ps1) runs **on the Windows machine** and pulls:

```powershell
cd c:\Users\Hunter\source\repos\slateVTT
.\deploy\pi\Backup-Slate.ps1
```

It writes `slate-<timestamp>.tar.gz` into `%LOCALAPPDATA%\Slate\pi-backups` and keeps the newest 30.
Both are parameters. Pointing `-Destination` at a synced folder or an external drive is what makes
the copy survive losing *this* machine as well, which the default doesn't.

It **pulls rather than pushes**, for three reasons. The Pi never holds a credential to the Windows
machine, which matters because the Pi is the half facing the tunnel. The key is already on the
Windows machine. And the Windows machine is the one that's often off, so a push would be the
arrangement whose failures go unnoticed.

Three things it does that shouldn't be undone:

- **It verifies before it rotates.** The archive is downloaded to `.part`, decompressed to prove the
  gzip is complete, and checked for `slate-state.json` before being renamed into place. That's the
  same write-then-rename approach `Store::save` uses, so an interrupted run leaves nothing that could
  be mistaken for a good backup. Old backups are only deleted after a new one has passed all of that.
  **The check still names only the first room's file, and that's enough**: it's proving the archive
  is a Slate backup rather than listing rooms, and `SLATE_STATE` is that path whatever else is in the
  directory. Nothing here needed changing for multiple rooms, because each extra room's save is just
  another file in the same directory. Note that a room whose save has never been written is absent
  from the backup, correctly, because there's nothing in it yet.
- **It excludes temporary save files.** A save is written to a `.tmp` file and renamed into place, so
  what lands here is always a whole room; a `.tmp` caught mid-write would restore as a truncated file
  next to a good one. **The exclusion is a pattern, `*.json.tmp`, not one filename**: each room's save
  writes its own temp file, so naming a single one would let every other room's through.
- **It redirects through `cmd`.** PowerShell re-encodes a native command's stdout as text, which
  corrupts a tarball without any error. Measured on this data, `ssh ... > file.tar.gz` produced
  9,527,080 bytes that `gzip -t` rejects outright, against 5,248,529 that it accepts. This is the most
  likely way to end up with backups that all turn out to be unrestorable.

## Scheduling it

Use Task Scheduler, from an **elevated** PowerShell. Registering the task needs admin, though the
task itself doesn't run as admin.

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "c:\Users\Hunter\source\repos\slateVTT\deploy\pi\Backup-Slate.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId 'hp\hunter' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Slate Pi backup' `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal
```

**The principal is the part that matters, and the default is wrong.** The script authenticates with
the SSH key in `%USERPROFILE%\.ssh`, and `known_hosts` is per-profile too, so a task running as
`SYSTEM` fails with `Permission denied (publickey)` every night while looking perfectly registered in
the UI. `Interactive` needs no stored password and runs when that user is logged on, which is when
this machine is awake anyway. `Limited` because pulling a tarball over SSH needs no administrator
rights.

`-StartWhenAvailable` is the other setting that matters. This machine sleeps when idle, so a 03:00
trigger doesn't fire at 03:00; the flag makes the missed run happen shortly after the machine next
wakes, rather than skipping it until the following night. Add `-WakeToRun` to the settings if you'd
rather it actually woke the machine, which for 5MB is hard to justify.

The script exits non-zero when it fails, so a bad night shows up as a red *Last Run Result* in Task
Scheduler rather than as nothing at all. Check it occasionally: a backup you haven't verified might
not be one.

Force the first run rather than waiting a day, because that's what tells *registered* apart from
*working*:

```powershell
Start-ScheduledTask -TaskName 'Slate Pi backup'
Get-ScheduledTaskInfo -TaskName 'Slate Pi backup' | Select-Object LastRunTime, LastTaskResult
Get-ChildItem "$env:LOCALAPPDATA\Slate\pi-backups"
```

A `LastTaskResult` of `0` and a new timestamped archive means it passed. Anything else, run the
script by hand in a normal terminal; the error it prints is the one the task swallowed.

## Restoring

```bash
sudo systemctl stop slate
sudo tar -xzf ~/slate-20260814-030000.tar.gz -C /var/lib/slate
sudo chown -R slate:slate /var/lib/slate
sudo systemctl start slate
```

Extract as root: the archive carries `slate:slate` ownership and the directory's 750 mode, so a root
extract restores the permissions by itself. The `chown` is a precaution for the case where it was
extracted as someone else.

Stop the service first; that isn't optional. Slate holds the room in memory and writes it on a
debounce, so a restore under a running server is overwritten by whatever that server saves next.

---

# Common failures

Most of the deploy failures this README used to list are now refusals from `Deploy-Slate.ps1` or
`install.sh`, which say what's wrong and leave the running Slate alone. They're kept below because a
hand deploy can still hit them.

**From the deploy script:**

- **`Could not resolve <name> from this machine`**: the name lookup failed, not the Pi. mDNS is
  unreliable from Windows rather than broken, and the preflight already retries it, so this failure
  means several attempts in a row came back empty. Find the address in the router's DHCP table and
  pass `-PiHost <user>@<address>`. Nothing has been built.
- **`Could not reach <host> with a key at <addresses>, or passwordless sudo is not available
  there`**: the preflight, before anything is built. The name resolved but nothing at those addresses
  answered: either `ssh` doesn't work with a key from this machine, or `sudo -n true` on the Pi wants
  a password. The second matters more than it looks, because over a non-interactive `ssh` a password
  prompt is a *hang*, not an error.
- **`cargo zigbuild is not available`**: the cross-compiler was never installed, or `zig` isn't on
  `PATH` because the terminal wasn't restarted. See *Once, to set up the cross-compiler*.
- **`… is not aarch64`** or **`is not an ELF binary`**: the wrong `--target`, caught on the build
  machine before the upload. If you see this from `install.sh` instead, the staged binary isn't the
  one that was just built.
- **`main.js is older than <source file>. Drop -SkipBuild.`**: exactly what it says. `-SkipBuild` is
  for re-running a deploy whose upload failed, not for a code change.
- **`unexpected entries in the staged client tree, which is served statically`**: something other
  than `index.html`, `dist`, `assets`, `spells` or `status` is in `client\`. This matters beyond
  tidiness: the client directory is served to anyone, so a map sitting in it can be downloaded by
  URL, bypassing the DM-only map picker entirely.
- **`slate did not serve within 20s`**: the new build installed and wouldn't answer. It has been
  rolled back and the old one is running again; what failed is kept at `/opt/slate/client.failed` and
  `/opt/slate/bin/slate-server.failed`. Start with `journalctl -u slate -n 50`. A 200 from `/` but not
  from `/spells/` or `/status/` means the `client\spells` or `client\status` copy was missed.
- **`COULD NOT RESTART SLATE`**: the rollback ran and `systemctl start` still failed. This is the one
  message here that means the board is down. Check `journalctl -u slate -n 50`; `/opt/slate/client.old`
  and `bin/slate-server.old` may still be there to put back by hand.
- **`/opt/slate/bin is missing -- run the first-time setup`**: the deploy script installs onto a box
  that has already been set up. It doesn't create the layout, the service account or the env file;
  that's *First-time setup* above.

**From a hand deploy:**

- **`install: cannot stat '~/stage/slate-server'`**: the `scp` of the binary didn't run or didn't
  resolve its local path. Check that `server\target\aarch64-unknown-linux-gnu\release\slate-server`
  exists on the build machine, and re-run that one command with an absolute path, watching its exit
  code.
- **Client files land in `~/stage` instead of `~/stage/client`**: `scp -r` with multiple sources and
  a destination ending in a slash. Use one source per command.
- **`$'\r': command not found` from `install.sh`**: the script arrived with CRLF line endings.
  `.gitattributes` marks `*.sh` as `eol=lf` and `Deploy-Slate.ps1` strips them again on the way out,
  so this needs a clone that predates the first or an upload that skipped the second. Fix it with
  `tr -d '\r' < install.sh > install.lf.sh` on the Pi.

**From either:**

- **`Permission denied (publickey)` when forwarding the port**: the `ssh -L` command was run on the
  Pi rather than on Windows. The private key lives on the build machine.
- **`cannot execute binary file: Exec format error`**: wrong architecture. `file` on the binary
  should say `ELF 64-bit LSB pie executable, ARM aarch64`.
- **`GLIBC_2.xx not found`**: the version suffix on the build target was higher than the Pi's. Lower
  it and rebuild.
- **`ls: cannot open directory '/var/lib/slate'`**: expected. It's mode 750 and owned by `slate`; use
  `sudo`.
