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
  client/              index.html, dist/, assets/, spells/

/var/lib/slate/        slate-owned, never touched by a deploy
  slate-state.json     the primary room
  halloween.json       one file per other room — see `docs/rooms.md`
  uploads/
  maps/                the DM's map picker library
  portraits/           the DM's token art library
  backdrops/           the DM's backdrop library

/etc/slate/slate.env   root-only, holds the DM secret
```

**The three libraries are data, not deploy artifacts, and that changed in milestone 32.** They
used to sit under `/opt/slate` and be wiped and re-copied by every deploy, which was right while
the only way to get a map into one was an `scp`. The DM adds and removes images from the panel
now, so a folder the deploy replaces would throw that away on the next build — and, more bluntly,
`ProtectSystem=strict` makes everything outside `ReadWritePaths` read-only to the service, so an
add under `/opt/slate` would not have worked at all. Moving them beside `uploads/` fixes the
permission, the ownership and the wipe together, and puts them inside what *5. Backups* already
copies. The repo's own `maps/` and `portraits/` are seed content: copied in once at install, and
never again.

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

sudo mkdir -p /opt/slate/{bin,client}
sudo mkdir -p /var/lib/slate/{uploads,maps,portraits,backdrops}

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
SLATE_MAPS=/var/lib/slate/maps
SLATE_PORTRAITS=/var/lib/slate/portraits
SLATE_BACKDROPS=/var/lib/slate/backdrops
SLATE_STATE=/var/lib/slate/slate-state.json
SLATE_UPLOADS=/var/lib/slate/uploads
SLATE_DM_SECRET=$SECRET
RUST_LOG=slate_server=info
EOF
sudo chmod 600 /etc/slate/slate.env
```

Five of those deserve a note:

- **`SLATE_STATE` names the *primary* room's save file**, which is why it did not have to change
  when Slate gained a second room. Every other room's save is a sibling in the same directory,
  named after its id — `halloween.json` beside `slate-state.json`. There is nothing to migrate and
  nothing here to edit when a room is added; see `docs/rooms.md` for why it is a sibling rule rather
  than a directory.
- **`SLATE_DM_SECRET` is one secret for the whole server** and opens whichever room is picked. There
  is no per-room secret and the DM link carries no room, so the same link reaches both.
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
because everything Slate writes — its state file, `uploads/`, and the three libraries the DM adds
to from the panel — is under `/var/lib/slate`. **That is the reason the libraries live there**: a
map added from the map panel is a write, and a write anywhere else is refused by systemd before it
reaches the filesystem.

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
cd c:\Users\Hunter\source\repos\slateVTT
.\deploy\pi\Deploy-Slate.ps1
```

That is the whole of it. The script builds, checks what it built, ships it to `~/stage` on
the Pi, and hands off to [`install.sh`](install.sh), which does the swap. `-PiHost` overrides
the default of `hunter@slate.local`; `-SkipBuild` reships the artifacts already on disk, for a
re-run after a network failure, and refuses if either artifact is older than a source file.

**The name is resolved once, in the preflight, and the address it produces is what every `ssh`
and `scp` below is handed.** That is not a micro-optimisation. mDNS is the least reliable link
in this chain — from the build machine roughly one `slate.local` lookup in four times out with
no answer at all — and each of the seven remote commands used to resolve the name for itself, so
a deploy rolled that dice seven times and died half way through the uploads with `Could not
resolve hostname`. Resolving once also settles which *interface* the deploy uses: a Pi on
ethernet and wifi at the same time answers to one name on two addresses, and a lookup per command
means consecutive uploads can take different paths. The preflight tries each address that came
back, twice round, and the first to answer `sudo -n true` carries the whole run — so an interface
that has gone to sleep costs one connect timeout instead of a stalled upload. Pass
`-PiHost <user>@<address>` to skip all of it and pin the deploy to one route.

**Nothing in it writes to `/var/lib/slate`.** The saved rooms, the uploads and the three
libraries are the DM's, and a deploy has nothing to say about them — seeding those is the
one-off below, run by hand at install time.

### What it runs

The two halves are worth knowing separately, because the failure messages name them.

On this machine:

```text
npm ci                                                   in client\
npm run check                                            typecheck, test, build -> dist/main.js
cargo test                                               in server\, natively on x86
cargo zigbuild --release --target aarch64-unknown-linux-gnu.2.36
```

`cargo test` runs natively because a cross-compiled test binary cannot run on the build
machine — test first, then cross-build. **The `.2.36` suffix targets glibc 2.36 rather than
whatever is newest.** Building against an *older* glibc than the Pi's is the safe direction:
old symbols exist on new systems, not the reverse. The Pi currently has 2.41 (`ldd --version`).

Then six `scp`s, **one source per command** — `scp -r` with several sources and a
trailing-slash destination flattens them a level up, silently, which is why the script keeps
them in a table rather than leaving the rule to be remembered:

```text
server\target\aarch64-unknown-linux-gnu\release\slate-server  ->  stage/slate-server
client\index.html                                             ->  stage/client/
client\dist                                                   ->  stage/client/
client\assets                                                 ->  stage/client/
client\spells                                                 ->  stage/client/
deploy\pi\install.sh                                          ->  stage/install.sh
```

`client\src` and `client\node_modules` are deliberately absent. The Pi serves the bundle, not
the sources. **`client\spells` is not part of the bundle and is copied on its own** — esbuild
never touches it, so it arrives only if that line does. The client links to `/spells/` from the
bottom-right corner, and a missing copy is a 404 behind a button that looked fine on the build
machine. `text.json` is gitignored and absent here as it is everywhere else; the page falls back
to the row naming a page, which is the licensing decision in `client/spells/README.md` and not a
broken deploy.

Then, on the Pi, `sudo bash stage/install.sh stage`.

### How it fails

One rule: **refuse before the service stops.** Everything knowable from a file on disk is
checked on the build machine before a byte is uploaded, and checked again on the Pi before Slate
is stopped — the binary's ELF header (64-bit, `EM_AARCH64`), every file the bundle needs by
name, and that the client tree holds nothing but `index.html`, `dist`, `assets` and `spells`.
That last one is not tidiness: the client directory is served statically, so a map that lands in
it is downloadable by URL, which routes around the DM-only picker entirely.

A refusal at any of those points has stopped nothing and moved nothing. Slate is still up on the
old build.

Past that, `install.sh` builds the replacement tree at `/opt/slate/client.new` *beside* the live
one and only then stops the service, so the swap is two renames and the outage is a second or
two. The previous build is kept at `client.old` and `bin/slate-server.old` across it.

The one failure left is a new build that installs and then will not serve. `install.sh` waits up
to 20s for `systemctl is-active` plus a 200 from both `/` and `/spells/`, and if it does not get
them it **puts the old build back and restarts it**, keeping what failed at `client.failed` and
`bin/slate-server.failed` for you to look at. `/spells/` is in that check deliberately: a missed
`client\spells` is a 404 the build machine cannot show you.

Two preflight checks on the Windows side are worth knowing about because they fail early and
their message is short. `ssh -o BatchMode=yes … sudo -n true` runs before anything is built: it
proves the key works and that `sudo` on the Pi will not sit waiting for a password, which over a
non-interactive `ssh` is a *hang* rather than an error. And `cargo zigbuild --version` is checked
before `npm ci`, so a missing cross-compiler costs a message rather than five minutes.

### Seeding the libraries — install time only

`maps/`, `portraits/` and `backdrops/` are the DM's own folders and the deploy does not touch
them. Seed them once, on the first install:

```bash
scp -r maps      <user>@slate.local:stage/
scp -r portraits <user>@slate.local:stage/
scp -r backdrops <user>@slate.local:stage/
```

```bash
# once, at install time — and never again, or a removed map comes back
sudo -u slate cp -rn ~/stage/maps/.       /var/lib/slate/maps/
sudo -u slate cp -rn ~/stage/portraits/.  /var/lib/slate/portraits/
sudo -u slate cp -rn ~/stage/backdrops/.  /var/lib/slate/backdrops/
```

`-n` rather than a plain copy: it never overwrites, so running this again by mistake cannot
replace art the DM has since changed. It will still put back a file they *removed*, which is why
this is an install step and not part of the deploy.

Upgrading a Pi that predates milestone 32 means moving what is already there, once:

```bash
sudo systemctl stop slate
sudo mkdir -p /var/lib/slate/{maps,portraits,backdrops}
sudo cp -rn /opt/slate/maps/.       /var/lib/slate/maps/
sudo cp -rn /opt/slate/portraits/.  /var/lib/slate/portraits/
sudo chown -R slate:slate /var/lib/slate
sudo rm -rf /opt/slate/maps /opt/slate/portraits
# then update SLATE_MAPS / SLATE_PORTRAITS and add SLATE_BACKDROPS in
# /etc/slate/slate.env, and start it again
sudo systemctl start slate
```

### Doing it by hand

`install.sh` is a plain shell script and reads top to bottom; if you need to do a deploy without
the PowerShell half — from a machine that is not the build machine, say — the `scp` table above
and `sudo bash stage/install.sh stage` are the whole of it.

## Verify

`Deploy-Slate.ps1` already does the first three of these and rolls back if they do not come
good, so this is for checking a box you did not just deploy to — or for reading the log after
one that did roll back.

```bash
systemctl is-active slate
curl -sI http://127.0.0.1:3000/ | head -1
curl -sI http://127.0.0.1:3000/spells/ | head -1
journalctl -u slate -n 20 --no-pager
```

You want `active`, `HTTP/1.1 200 OK` from both, and a `slate listening` line whose paths match
the layout above. The second one is the spell index, which the client links to and the bundle
does not carry — a 404 there means the `client\spells` copy was missed. **No `no map library there` or `no portrait library there` warning** is the
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

## Installing `cloudflared`

From Cloudflare's apt repository, so `unattended-upgrades` keeps it patched. An always-on box
should not have a manually-updated network daemon, which is what a downloaded `.deb` is.

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

**The suite is `any`, not `$(lsb_release -cs)`.** Every guide online uses the `lsb_release`
form, which on this box expands to `trixie` — and Cloudflare publishes `any`, `bookworm`,
`focal`, `jammy` and `noble` for cloudflared, with no trixie suite. The `lsb_release` form
404s on every `apt update` from then on.

## Quick Tunnel rehearsal

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

It prints a random `trycloudflare.com` address. That is the player link; append `?dm=<secret>`
for yours. The URL changes every time `cloudflared` restarts.

**A Quick Tunnel has no authentication at all** — anyone with the URL is in the room. Use it
for a rehearsal and stop it afterwards. The named tunnel below supersedes it for the box at
home; this stays useful for a game away from home, where there is no time to arrange DNS.

The rehearsal checklist in [the Windows doc](../windows/README.md) applies unchanged. The
items that matter most are the ones a tunnel can break: continuous token dragging with two
browsers open, which exercises the WebSocket upgrade and the drag frame rate over real
latency; a map upload, which is a large POST on a different path; and refreshing a player
mid-session to confirm they rejoin as the same character.

---

# The named tunnel

This is what the box runs. The URL stops changing, nothing is port-forwarded, and the home IP
address never appears in public DNS.

**The hostname is deliberately not written down here.** There are no player accounts and no
Cloudflare Access in front of Slate, so the unguessable hostname *is* the access control — and
this file is in a git repository that could be shared or made public. Substitute the real one
for `<label>` throughout. It lives in `/etc/cloudflared/config.yml` on the Pi and nowhere in
this repo.

## 1. The domain's DNS moves to Cloudflare

A named tunnel can only route DNS in a zone Cloudflare hosts, so the **nameservers** move.
The registration stays at the registrar and it stays free.

This is the step with real blast radius if the domain hosts anything else, so it is worth
doing in the order below rather than switching and watching.

**Check DNSSEC first.** If the registry publishes a DS record, changing nameservers without
disabling DNSSEC first takes the whole domain offline with SERVFAIL everywhere, for hours. It
is the most common way this migration breaks hard:

```powershell
Resolve-DnsName <domain> -Type DS -Server 1.1.1.1
```

No DS records means DNSSEC is off and there is nothing to do. If there are any, turn DNSSEC
off at the registrar and wait for the DS record to disappear from the registry before going on.

Then, in order:

1. **Inventory the existing zone** at the registrar and keep a copy. That copy is the rollback.
2. **Add the domain to Cloudflare** on the Free plan. Cloudflare's scanner is unreliable — it
   found zero records on a zone that resolves perfectly well — so expect to enter them by hand
   against the inventory. Adding a zone changes nothing: the registry still points every
   resolver at the old nameservers, so this state is inert and can be edited or abandoned.
3. **Grey-cloud every pre-existing record.** Cloudflare imports A and CNAME records as
   *proxied*, and proxying a site that is not Slate is how this step breaks something. For a
   GitHub Pages site specifically, Cloudflare's default Flexible SSL mode produces an infinite
   redirect loop, and GitHub's Let's Encrypt renewal uses an HTTP challenge to the apex that
   proxying can interfere with — so it works for ninety days and then the certificate quietly
   fails. Grey cloud makes Cloudflare a pure DNS host and the behaviour byte-for-byte
   unchanged. Slate's own record is the one exception and `tunnel route dns` sets it up
   proxied on its own.
4. **Verify before delegating.** Cloudflare's assigned nameservers answer for a pending zone,
   so the whole thing can be rehearsed at zero risk by querying them directly and comparing
   against the registrar's. Do this until every record set matches.
5. **Then change the nameservers** at the registrar — all of the old ones out, both Cloudflare
   ones in. A mixed delegation is a broken configuration where resolvers get inconsistent
   answers depending on which server they hit.

Step 4 is what makes step 5 safe, and it is not optional politeness. The registry publishes
the delegation with a TTL of roughly a day, so a rollback takes **24–48 hours** to propagate —
there is no quick undo. Verifying first means there is nothing to undo: both sets of
nameservers return identical answers, so it does not matter which one any given resolver is
still using during propagation, and there is no window where the site is down.

Expect resolvers to disagree for a while afterwards, and expect that to be fine. Query the
registry directly to tell "propagating normally" from "the registrar never pushed it" —
a resolver holding the old delegation is cache, not a fault.

Last, wait for **SSL/TLS → Edge Certificates** to show a Universal certificate reading
*Active*. That covers the apex and `*.<domain>`, and the wildcard is what gets Slate's
subdomain HTTPS.

## 2. Choosing the hostname

```bash
openssl rand -hex 6
```

**One label deep — `<label>.<domain>`, never `<label>.slate.<domain>`.** Cloudflare's free
Universal certificate covers the apex and `*.<domain>`, one level only. A single label is
therefore served by a wildcard, and the certificate published to Certificate Transparency
logs names `*.<domain>` and never the label. Go two levels deep and the wildcard no longer
covers it, so it needs an advanced certificate that names the host explicitly — and **that
name lands in a public, permanently searchable CT log within minutes**, which is precisely
what people scrape to find unlisted hosts. It would defeat the whole arrangement on day one.

Do not season it with `slate`, `dnd` or `vtt` either.

## 3. Creating the tunnel

```bash
cloudflared tunnel login
```

Prints a URL rather than opening a browser, which is what makes it headless-safe. Open it
elsewhere and authorise the zone. Writes `~/.cloudflared/cert.pem`. The zone must already be
**Active** in Cloudflare or it will not be offered.

```bash
cloudflared tunnel create slate
cloudflared tunnel list
```

Writes `~/.cloudflared/<UUID>.json`. That file is a credential — it is what lets anything
serve traffic on the hostname.

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<UUID>.json
sudo chown root:root /etc/cloudflared/<UUID>.json
```

## 4. The config, and the paste trap

**Write this with `printf`, not a heredoc.** This cost a debugging cycle and will cost another
one if it is not respected:

```bash
SLATE_HOST=<label>.<domain>
TUNNEL_ID=$(basename ~/.cloudflared/*.json .json)

printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/%s.json\ningress:\n  - hostname: %s\n    service: http://127.0.0.1:3000\n  - service: http_status:404\n' "$TUNNEL_ID" "$TUNNEL_ID" "$SLATE_HOST" | sudo tee /etc/cloudflared/config.yml >/dev/null

sudo cat -A /etc/cloudflared/config.yml
```

A pasted heredoc arrives with its indentation normalised — leading spaces stripped and, fatally,
**the space after each `-` removed**. In YAML a dash starts a list item only when a space
follows it, so `-hostname:` is read as a key named `-hostname` and `ingress:` becomes a mapping
of three odd keys instead of a list of two rules. The failure is `no ingress rules were defined
in provided config` and a **503**: the tunnel reaches Cloudflare's edge perfectly well and has
nothing telling it where to forward traffic. `cloudflared ingress validate` does not catch it,
because with no rules parsed there is nothing for it to object to.

`printf` emits the spaces itself from a format string on one line, so there is no multi-line
paste to mangle. Check with `cat -A`, which is the only way to see the problem: it renders tabs
as `^I` and line ends as `$`, and a plain `cat` shows a broken file looking perfectly fine.
Two spaces before each `-`, one after it, four before the nested `service:`.

The trailing catch-all is required — cloudflared refuses to start without a final rule matching
everything — and it earns its keep: anything arriving for a hostname not named here gets a 404
instead of reaching Slate.

`SLATE_ADDR` stays `127.0.0.1:3000`. Nothing about Slate's own configuration changes.

## 5. The DNS route

```bash
cloudflared tunnel route dns slate $SLATE_HOST
```

Creates a **proxied** CNAME to `<UUID>.cfargotunnel.com`. Proxied is load-bearing: it is what
keeps the home IP address out of public DNS.

## 6. Foreground first, then the service

Prove the path where the logs are visible, before there is a unit in the way:

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

**Pass `--config` explicitly.** Under `sudo`, `$HOME` is `/root`, so without it the installer
looks in `/root/.cloudflared/`, finds nothing, and installs a unit that reports success and
then fails to start.

The backup is a guard: `service install` copies the config it is given into
`/etc/cloudflared/config.yml`, which is the same path it was given, and a copy onto itself can
truncate. Check `cat -A` still shows the `ingress:` block and restore from `.bak` if it does not.

```bash
systemctl cat cloudflared | grep -E 'ExecStart|User='
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

## 7. Verifying

Reboot, because a box that needs a human after a power cut is not always-on:

```bash
sudo reboot
systemctl is-active slate cloudflared
```

Both `active`, with nobody logged in. From the Windows machine:

```powershell
Resolve-DnsName <label>.<domain> -Type A -Server 1.1.1.1
```

Cloudflare anycast addresses — `104.x` or `172.67.x` — and **not** the home IP. This is the
inverse of the check on the other records, where seeing the origin's own addresses is what
proves the grey cloud. Confirm anything else on the domain still serves, too.

Then the rehearsal checklist above, over the tunnel this time.

## What this does and does not protect

The hostname is the access control. There are no accounts, so **anyone holding the link is in
the room** — the board, the WebSocket and the upload endpoint. For a private game among six
friends that is the intended trade, and it holds up better than "security through obscurity"
usually does: the label is unguessable, the wildcard certificate keeps it out of CT logs,
Cloudflare serves no zone transfers, and `.dev` is HSTS-preloaded so it is HTTPS-only.

The realistic failure is a leaked link rather than an attacker, and **rotating is cheap** —
`cloudflared tunnel route dns` a fresh label, change the hostname in `config.yml`, restart, and
delete the old DNS record.

Two things the proxy imposes that loopback did not:

- **Cloudflare's free plan caps request bodies at 100 MB.** A map larger than that gets a 413
  from Cloudflare before it ever reaches Slate.
- **Idle proxied WebSockets are closed at around 100 seconds.** Nothing crosses a quiet board,
  so this would drop a connection mid-session — it is the reason the send task pings every 30
  seconds, described under *Wire protocol* in `.claude/CLAUDE.md`.

## Still to do

- **Cloudflare Access** with the players' email addresses, so strangers never reach the
  WebSocket or the upload endpoint even holding the link. It is per-hostname, so it gates Slate
  without touching anything else on the domain. Declined for now because it is a login and the
  group does not want one; the unguessable hostname is the deliberate alternative. If it is ever
  added, set the session duration long — an Access session lapsing mid-game drops the WebSocket,
  and Slate's reconnect is a fresh join that would land on a login page.

---

# Backups

`/var/lib/slate` is the only thing on this box worth keeping, for the reason *Layout* gives:
everything else is reproducible from a build, and this is not. Without a copy, an SD card
failure costs the game rather than an evening.

Since milestone 32 that now includes the three libraries, which moved here from `/opt/slate` when
the DM gained the ability to add to them. The script needed no change — it archives the whole
directory — but the thing being archived got more valuable: a map added from the panel exists
nowhere else, unlike one that came out of the repo.

[`Backup-Slate.ps1`](Backup-Slate.ps1) runs **on the Windows machine** and pulls:

```powershell
cd c:\Users\Hunter\source\repos\slateVTT
.\deploy\pi\Backup-Slate.ps1
```

It writes `slate-<timestamp>.tar.gz` into `%LOCALAPPDATA%\Slate\pi-backups` and keeps the
newest 30. Both are parameters — `-Destination` at a synced folder or an external drive is
what makes the copy survive *this* machine as well, which the default does not.

It **pulls rather than pushing**, and that direction is the design. The Pi never holds a
credential to the Windows box, which matters because the Pi is the half facing the tunnel.
The key is already here. And the Windows box is the one that is often off, so a push is the
arrangement whose failures are invisible.

Three things it does that are worth not undoing:

- **It verifies before it rotates.** The archive is downloaded to `.part`, inflated to prove
  the gzip is whole, and checked for `slate-state.json` before being renamed into place —
  the same write-then-rename shape `Store::save` uses, so an interrupted run leaves something
  that cannot be mistaken for a good backup. Old backups are only deleted after a new one has
  passed all of that. **The check still names the primary room's file and that is enough**: it is
  proving the archive is a Slate backup rather than enumerating rooms, and `SLATE_STATE` is that
  path whatever else is in the directory. Nothing here needed changing for multi-room, which is the
  point of the sibling rule — but note that a room whose save has never been written is absent from
  the backup, correctly, because there is nothing in it yet.
- **It excludes `slate-state.json.tmp`.** The save is renamed over atomically, so what lands
  here is always a whole room; a `.tmp` caught mid-write would restore as a truncated file
  sitting beside a good one. **The exclusion is a glob, `*.json.tmp`, and not one filename** — there
  is one save per room and each writes its own temp beside it, so naming a single one would let every
  other room's slip in.
- **It redirects through `cmd`.** PowerShell re-encodes a native command's stdout as text,
  which silently corrupts a tarball — measured on this data, `ssh ... > file.tar.gz` produced
  9,527,080 bytes that `gzip -t` rejects outright, against 5,248,529 that it accepts. This is
  the single most likely way to end up holding backups that are all unrestorable.

## Scheduling it

Task Scheduler, from an **elevated** PowerShell — registering needs admin, though the task
itself deliberately does not run as one.

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "c:\Users\Hunter\source\repos\slateVTT\deploy\pi\Backup-Slate.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId 'hp\hunter' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Slate Pi backup' `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal
```

**The principal is the load-bearing part, and it is not a default worth relying on.** The
script authenticates with the SSH key in `%USERPROFILE%\.ssh`, and `known_hosts` is per-profile
as well, so a task running as `SYSTEM` fails with `Permission denied (publickey)` every night
while looking perfectly registered in the UI. `Interactive` needs no stored password and runs
when that user is logged on, which is when this machine is awake anyway. `Limited` because
pulling a tarball over SSH wants no administrator rights.

`-StartWhenAvailable` is the other one that matters. This machine sleeps on idle, so a 03:00
trigger does not fire at 03:00 — the flag is what makes the missed run happen shortly after the
machine is next woken, rather than being skipped until the following night. Add `-WakeToRun` to
the settings set if you would rather it actually woke the box, which for 5MB is hard to justify.

The script exits non-zero when it fails, so a bad night shows up as a red *Last Run Result*
in Task Scheduler rather than as nothing at all. Check it occasionally — an unverified
backup is a belief rather than a backup.

Force the first run rather than waiting a day, because this is the step that distinguishes
*registered* from *working*:

```powershell
Start-ScheduledTask -TaskName 'Slate Pi backup'
Get-ScheduledTaskInfo -TaskName 'Slate Pi backup' | Select-Object LastRunTime, LastTaskResult
Get-ChildItem "$env:LOCALAPPDATA\Slate\pi-backups"
```

`LastTaskResult` of `0` and a new timestamped archive is the pass. Anything else, run the
script by hand in a normal terminal — the error it prints is the one the task swallowed.

## Restoring

```bash
sudo systemctl stop slate
sudo tar -xzf ~/slate-20260814-030000.tar.gz -C /var/lib/slate
sudo chown -R slate:slate /var/lib/slate
sudo systemctl start slate
```

Extract as root: the archive carries `slate:slate` ownership and the directory's 750 mode, so
a root extract puts the permissions back on its own. The `chown` is belt and braces for the
case where it was extracted as somebody else.

Stopping first is not optional. Slate holds the room in memory and writes it on a debounce,
so a restore under a running server is overwritten by whatever that server saves next.

---

# Common failures

Most of the deploy failures this README used to list are now refusals from
`Deploy-Slate.ps1` or `install.sh`, which say what is wrong and leave the running Slate alone.
They are kept below because a hand deploy can still hit them.

**From the deploy script:**

- **`Could not resolve <name> from this machine`** — the lookup, not the Pi. An mDNS name is
  unreliable from Windows rather than broken, and the preflight already retries it, so a failure
  here means several attempts in a row came back empty. Find the address in the router's DHCP
  table and pass `-PiHost <user>@<address>`. Nothing has been built.
- **`Could not reach <host> with a key at <addresses>, or passwordless sudo is not available
  there`** — the preflight, before anything is built. The name resolved and nothing at those
  addresses answered: either `ssh` does not work with a key from this machine, or `sudo -n true`
  on the Pi wants a password. The second one matters more than it looks: over a non-interactive
  `ssh` a password prompt is a *hang*, not an error.
- **`cargo zigbuild is not available`** — the cross-compiler was never installed, or `zig` is not
  on `PATH` because the terminal was not restarted. See *Once, to set up the cross-compiler*.
- **`… is not aarch64`** or **`is not an ELF binary`** — the wrong `--target`, caught on the build
  machine before the upload. If you see this from `install.sh` instead, the staged binary is not
  the one that was just built.
- **`main.js is older than <source file>. Drop -SkipBuild.`** — exactly what it says. `-SkipBuild`
  is for re-running a deploy whose upload failed, not for a code change.
- **`unexpected entries in the staged client tree, which is served statically`** — something that
  is not `index.html`, `dist`, `assets` or `spells` is in `client\`. This matters beyond tidiness:
  the client directory is served statically, so a map sitting in it is downloadable by URL, which
  routes around the DM-only map picker entirely.
- **`slate did not serve within 20s`** — the new build installed and would not answer. It has been
  rolled back and the old one is running again; what failed is kept at `/opt/slate/client.failed`
  and `/opt/slate/bin/slate-server.failed`. Start with `journalctl -u slate -n 50`. A 200 from `/`
  but not `/spells/` is the missed `client\spells` copy.
- **`COULD NOT RESTART SLATE`** — the rollback ran and `systemctl start` still failed. This is the
  one message here that means the board is down. `journalctl -u slate -n 50`, and
  `/opt/slate/client.old` and `bin/slate-server.old` may still be there to put back by hand.
- **`/opt/slate/bin is missing — run the first-time setup`** — the deploy script installs onto a
  box that has already been set up. It does not create the layout, the service account or the env
  file; that is *First-time setup* above.

**From a hand deploy:**

- **`install: cannot stat '~/stage/slate-server'`** — the `scp` of the binary did not run or
  did not resolve its local path. Check that
  `server\target\aarch64-unknown-linux-gnu\release\slate-server` exists on the build machine
  and re-run that one command with an absolute path, watching its exit code.
- **Client files land in `~/stage` instead of `~/stage/client`** — `scp -r` with multiple
  sources and a trailing-slash destination. One source per command.
- **`$'\r': command not found` from `install.sh`** — the script arrived with CRLF line endings.
  `.gitattributes` marks `*.sh` as `eol=lf` and `Deploy-Slate.ps1` strips them again on the way
  out, so this needs a clone that predates the first or an upload that skipped the second. Fix
  with `tr -d '\r' < install.sh > install.lf.sh` on the Pi.

**From either:**

- **`Permission denied (publickey)` when forwarding the port** — the `ssh -L` command was run
  on the Pi rather than on Windows. The private key lives on the build machine.
- **`cannot execute binary file: Exec format error`** — wrong architecture. `file` on the
  binary should say `ELF 64-bit LSB pie executable, ARM aarch64`.
- **`GLIBC_2.xx not found`** — the version suffix on the build target was higher than the
  Pi's. Lower it and rebuild.
- **`ls: cannot open directory '/var/lib/slate'`** — expected. It is mode 750 owned by
  `slate`; use `sudo`.
