# Hosting Slate from a Raspberry Pi

This is the always-on host, and it is a different proposition from
[the Windows one](../windows/README.md). That one runs while the group is playing and stops
afterwards. This one stays up so the DM can prepare the next dungeon on a Tuesday afternoon
without anyone else being involved.

The Pi builds nothing. It receives a cross-compiled binary and a bundled client from a
Windows machine and runs them under `systemd`. Everything below assumes that split, which is
why there is no Rust or Node toolchain anywhere on the Pi: `cargo build --release` on 1GB of
RAM thrashes, and the swap it would thrash into is the one workload that genuinely kills SD
cards.

## What this was built and verified on

- Raspberry Pi 3 Model B v1.2, 1GB RAM, 32GB SanDisk microSD
- Raspberry Pi OS Lite (64-bit) — Debian 13 (trixie)
- Wired ethernet, with a DHCP reservation on the router
- A Windows 10 build machine with Rust, Node, and OpenSSH

64-bit rather than 32-bit because `aarch64-unknown-linux-gnu` is the better-trodden Rust
cross-compilation target and because a future Pi 4 or 5 would use it unchanged. At idle,
before Slate starts, the board sits around 166MB used of 905MB — there is room.

## Layout

```text
/opt/slate/            root-owned, replaced by every deploy
  bin/slate-server
  client/              index.html, dist/, assets/
  maps/                the DM's map picker library
  portraits/           the DM's token art library

/var/lib/slate/        slate-owned, never touched by a deploy
  slate-state.json
  uploads/

/etc/slate/slate.env   root-only, holds the DM secret
```

The split is the backup boundary. **`/var/lib/slate` is the only directory worth backing
up**, and a deploy never writes there. Everything under `/opt/slate` is reproducible from a
build, so losing it costs a rebuild rather than a game.

The `slate` service account owns the data and none of the code, so the server cannot modify
its own binary or the client it serves.

---

# First-time setup

## 1. Flash the card

Raspberry Pi Imager, *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**.

Open the customisation settings **before** writing — this is what makes the box headless:

- Hostname `slate`
- A username and password
- Services → Enable SSH → **Allow public-key authentication only**, with the contents of
  `~/.ssh/id_ed25519.pub` from the Windows machine
- Locale and **timezone** — logs and any scheduled backup depend on it

Boot with ethernet attached, then `ssh <user>@slate.local`. If mDNS does not resolve from
Windows, find the address in the router's DHCP table. Add a DHCP reservation while you are
there: doing it router-side survives an OS reinstall and avoids the dhcpcd-versus-
NetworkManager difference between Pi OS versions.

## 2. Harden, and protect the card

```bash
sudo apt update && sudo apt full-upgrade -y
```

**Do not go looking for `dphys-swapfile`.** Trixie's Pi OS replaced it with `rpi-swap`, which
provides zram — compressed swap in RAM. It never touches the card, so there is nothing to
disable and disabling it would only cost you headroom on a 1GB board. Confirm with
`swapon --show`; a line reading `/dev/zram0` is the state you want. A *file* on the card
would not be, and would be worth removing.

Bound the journal, so logging cannot become a slow write drip:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
echo -e "[Journal]\nSystemMaxUse=32M" | sudo tee /etc/systemd/journald.conf.d/99-slate.conf
sudo systemctl restart systemd-journald
```

Automatic security updates. This is the one step here with a real cost to skipping — the
appeal of this box is that you forget about it, and forgotten-and-unpatched is how that goes
wrong:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Leave `Unattended-Upgrade::Automatic-Reboot` at its `"false"` default. A reboot in the middle
of a session is worse than a kernel patch that waits. Reboot by hand every month or so
instead.

Then SSH. Check first, because the Imager may already have done it:

```bash
sudo sshd -T | grep -i -E 'passwordauth|permitrootlogin'
```

If it does not already say `passwordauthentication no`:

```bash
echo -e "PasswordAuthentication no\nPermitRootLogin no" | sudo tee /etc/ssh/sshd_config.d/99-slate.conf
sudo systemctl restart ssh
```

Open a second terminal and confirm you can still get in before closing the first.

This one is defence in depth rather than a load-bearing wall: `sshd` is reachable only from
the LAN, because nothing is port-forwarded and the tunnel carries Slate alone. Note also that
`sudo` is passwordless for the first user by Pi OS default, so anyone holding the SSH key has
root.

## 3. The service account, the directories, and the secret

```bash
sudo adduser --system --group --no-create-home --home /var/lib/slate --shell /usr/sbin/nologin slate

sudo mkdir -p /opt/slate/{bin,client,maps,portraits}
sudo mkdir -p /var/lib/slate/uploads

sudo chown -R root:root /opt/slate
sudo chown -R slate:slate /var/lib/slate
sudo chmod 750 /var/lib/slate
```

```bash
sudo mkdir -p /etc/slate
SECRET=$(openssl rand -hex 16)
sudo tee /etc/slate/slate.env >/dev/null <<EOF
SLATE_ADDR=127.0.0.1:3000
SLATE_CLIENT_DIR=/opt/slate/client
SLATE_MAPS=/opt/slate/maps
SLATE_PORTRAITS=/opt/slate/portraits
SLATE_STATE=/var/lib/slate/slate-state.json
SLATE_UPLOADS=/var/lib/slate/uploads
SLATE_DM_SECRET=$SECRET
RUST_LOG=slate_server=info
EOF
sudo chmod 600 /etc/slate/slate.env
```

Four of those deserve a note:

- **`SLATE_ADDR` is loopback.** `cloudflared` runs on this same box and connects locally, so
  Slate never listens on the LAN. To see it in a browser, forward the port rather than
  rebinding it — see *Seeing it in a browser* below.
- **Mode 600, root-owned** is enough, because `systemd` reads `EnvironmentFile=` as root
  before dropping to `User=slate`. The service account never reads the file.
- **The secret is hex** because it goes unencoded into both the DM URL's query string and an
  HTTP header, so it must be letters, digits, `-` and `_` only — the same rule
  [`Start-Slate.ps1`](../windows/Start-Slate.ps1) enforces on Windows.
- **`RUST_LOG=slate_server=info`** overrides the `debug` default in `server/src/main.rs`.
  Turning the level down at the source is better than routing debug output somewhere cheap.

To read the secret back later, either open that file as root or:

```bash
journalctl -u slate | grep "DM link"
```

Slate logs the DM link on every start. Convenient, and worth knowing the secret is therefore
sitting in the journal in plaintext.

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

`Restart=always` is the self-healing half of an unattended box: a crash, or an OOM kill, is a
five-second gap rather than a dead evening. `ProtectSystem=strict` makes the whole filesystem
read-only to the service except the one path named in `ReadWritePaths`, which costs nothing
because Slate only ever writes its state file and `uploads/`.

`systemctl stop` sends `SIGTERM`, which `server/src/main.rs` handles — so a stop flushes a
change still inside the two-second save debounce, exactly as Ctrl+C does on Windows.

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

Restart the terminal afterwards so `zig` lands on `PATH`.

`cargo-zigbuild` rather than WSL or Docker because Slate's dependency tree is pure Rust —
nothing in `server/Cargo.toml` pulls in a C build — which makes cross-linking
straightforward, and because it can pin the glibc version explicitly.

## Every deploy

```powershell
cd c:\Users\Hunter\source\repos\slateVTT\client
npm ci
npm run check

cd ..\server
cargo test
cargo zigbuild --release --target aarch64-unknown-linux-gnu.2.36
```

`npm run check` is typecheck, test and build, and produces `dist/main.js`. `cargo test` runs
natively on x86 because cross-compiled tests cannot run on the build machine — test first,
then cross-build.

**The `.2.36` suffix targets glibc 2.36 rather than whatever is newest.** Building against an
*older* glibc than the Pi's is the safe direction: old symbols exist on new systems, not the
reverse. The Pi currently has 2.41 (`ldd --version`).

Then ship it. **One source per `scp`** — `scp -r` with several sources and a trailing-slash
destination flattens them a level up, silently:

```powershell
cd c:\Users\Hunter\source\repos\slateVTT
ssh <user>@slate.local "mkdir -p stage/client"
scp    server\target\aarch64-unknown-linux-gnu\release\slate-server <user>@slate.local:stage/slate-server
scp    client\index.html <user>@slate.local:stage/client/
scp -r client\dist       <user>@slate.local:stage/client/
scp -r client\assets     <user>@slate.local:stage/client/
scp -r maps              <user>@slate.local:stage/
scp -r portraits         <user>@slate.local:stage/
```

`client\src` and `client\node_modules` are deliberately absent. The Pi serves the bundle, not
the sources.

Install into place, on the Pi. **Read the destinations carefully** — see *Common failures*:

```bash
sudo systemctl stop slate

sudo install -o root -g root -m 755 ~/stage/slate-server /opt/slate/bin/slate-server
sudo rm -rf /opt/slate/client/* /opt/slate/maps/* /opt/slate/portraits/*
sudo cp -r ~/stage/client/.     /opt/slate/client/
sudo cp -r ~/stage/maps/.       /opt/slate/maps/
sudo cp -r ~/stage/portraits/.  /opt/slate/portraits/
sudo chown -R root:root /opt/slate
sudo chmod -R a+rX /opt/slate

sudo systemctl start slate
```

## Verify

```bash
systemctl is-active slate
curl -sI http://127.0.0.1:3000/ | head -1
journalctl -u slate -n 20 --no-pager
```

You want `active`, `HTTP/1.1 200 OK`, and a `slate listening` line whose paths match the
layout above. **No `no map library there` or `no portrait library there` warning** is the
positive signal that both libraries were found.

`/var/lib/slate` holding only `uploads/` is normal on a fresh install — the state file is not
written until something changes the room, because saves are debounced on dirty.

## Seeing it in a browser

Slate listens on loopback, so forward the port from the Windows machine rather than
rebinding it:

```powershell
ssh -L 3000:127.0.0.1:3000 <user>@slate.local
```

Leave that window open and browse `http://localhost:3000/`. Append `?dm=<secret>` for the DM
view. This runs **on Windows**, not on the Pi.

---

# Exposing it

## Quick Tunnel rehearsal

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o /tmp/cloudflared.deb
sudo apt install -y /tmp/cloudflared.deb
rm /tmp/cloudflared.deb

cloudflared tunnel --url http://127.0.0.1:3000
```

It prints a random `trycloudflare.com` address. That is the player link; append `?dm=<secret>`
for yours. The URL changes every time `cloudflared` restarts.

**A Quick Tunnel has no authentication at all** — anyone with the URL is in the room. Use it
for a rehearsal and stop it afterwards.

The rehearsal checklist in [the Windows doc](../windows/README.md) applies unchanged. The
items that matter most are the ones a tunnel can break: continuous token dragging with two
browsers open, which exercises the WebSocket upgrade and the drag frame rate over real
latency; a map upload, which is a large POST on a different path; and refreshing a player
mid-session to confirm they rejoin as the same character.

## Still to do

- **A named tunnel on a real domain**, so the URL stops changing. The domain's DNS must move
  to Cloudflare (nameservers only — the registration can stay at Porkbun). A subdomain such
  as `slate.example.com` leaves an apex pointing at GitHub Pages alone; keep those records
  DNS-only rather than proxied.
- **Cloudflare Access** with the players' email addresses, so strangers never reach the
  WebSocket or the upload endpoint. It is per-hostname, so it gates Slate without touching
  anything else on the domain. Set the session duration long — an Access session lapsing
  mid-game drops the WebSocket, and Slate's reconnect is a fresh join that would land on a
  login page.
- **Switch `cloudflared` to Cloudflare's apt repository** so `unattended-upgrades` picks it
  up. An always-on box should not have a manually-updated network daemon.
- **Backups of `/var/lib/slate`** to the Windows machine. Nothing else on the Pi is worth
  keeping, and without this an SD card failure costs the game rather than an evening.

---

# Common failures

- **`install: cannot stat '~/stage/slate-server'`** — the `scp` of the binary did not run or
  did not resolve its local path. Check that
  `server\target\aarch64-unknown-linux-gnu\release\slate-server` exists on the build machine
  and re-run that one command with an absolute path, watching its exit code.
- **Client files land in `~/stage` instead of `~/stage/client`** — `scp -r` with multiple
  sources and a trailing-slash destination. One source per command.
- **Map images appear in `/opt/slate/client`** — a `cp` destination typo. This one matters
  beyond tidiness: the client directory is *served statically*, so a map sitting in it is
  downloadable by URL, which routes around the DM-only map picker entirely. Move them with
  `sudo mv /opt/slate/client/*.jpg /opt/slate/maps/` and check that `/opt/slate/client` holds
  exactly `assets`, `dist` and `index.html`.
- **`Permission denied (publickey)` when forwarding the port** — the `ssh -L` command was run
  on the Pi rather than on Windows. The private key lives on the build machine.
- **`cannot execute binary file: Exec format error`** — wrong architecture. `file` on the
  binary should say `ELF 64-bit LSB pie executable, ARM aarch64`.
- **`GLIBC_2.xx not found`** — the version suffix on the build target was higher than the
  Pi's. Lower it and rebuild.
- **`ls: cannot open directory '/var/lib/slate'`** — expected. It is mode 750 owned by
  `slate`; use `sudo`.
