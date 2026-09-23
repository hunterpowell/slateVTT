# Hosting Slate from Windows

Slate can run from a Windows PC only while the group is playing. The server listens on the loopback
interface, and a separate Cloudflare Tunnel process provides the public HTTPS and WebSocket
connection. No inbound firewall port is needed.

Runtime state doesn't live in the repository. The launcher keeps the saved rooms, uploaded maps, and
a stable DM secret in:

```text
%LOCALAPPDATA%\Slate
```

## Prerequisites

- Node.js and npm
- Rust and Cargo
- `cloudflared` for remote sessions

Install `cloudflared` from Cloudflare's Windows MSI or executable:
<https://developers.cloudflare.com/tunnel/downloads/>

## Build

From the repository root:

```powershell
.\deploy\windows\Build-Slate.ps1
```

The script installs the exact client dependencies in `package-lock.json`, typechecks, tests and
bundles the client, runs the Rust tests, and builds the optimized server executable.

If PowerShell refuses to run a local script, allow it for this process only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

## Run locally

In terminal one:

```powershell
.\deploy\windows\Start-Slate.ps1
```

The launcher prints local player and DM links. It also creates the data directory and reuses the
same DM secret in later sessions. Use `-Port 3001` if port 3000 is already taken.

Press Ctrl+C to stop. Slate handles the interrupt, saves any change still waiting on the save
debounce, and then exits.

## Remote rehearsal with a Quick Tunnel

First start Slate as above. In terminal two:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

`cloudflared` prints a random URL like:

```text
https://words-words-words.trycloudflare.com
```

That URL is the player link. For the DM link, append the `?dm=...` query from the local DM URL
printed in terminal one:

```text
https://words-words-words.trycloudflare.com/?dm=<the-local-secret>
```

The browser removes the secret from its address bar immediately after reading it. Don't give the DM
link to players.

Quick Tunnel addresses change whenever `cloudflared` restarts. Cloudflare describes them as
development and testing infrastructure, so use them for the rehearsal and don't treat the address as
permanent.

At the end of a session, press Ctrl+C in terminal one to stop Slate cleanly, then Ctrl+C in terminal
two to close the tunnel.

## Rehearsal checklist

Use the public links from at least two networks if you can:

1. Join once as the DM and from two player browsers.
2. Confirm that players can move only their own tokens.
3. Move tokens continuously and confirm that all browsers stay in sync.
4. Set and advance initiative.
5. Upload and calibrate a real map.
6. Refresh a player and confirm that the same character rejoins.
7. Stop Slate, start it again, and confirm that the map, token positions, and initiative come back.
8. Confirm that the old Quick Tunnel URL stops working after its process exits.

## Data and backup

The entire persistent installation is `%LOCALAPPDATA%\Slate`:

```text
dm-secret.txt
slate-state.json     the first room
halloween.json       one file per other room, named after its id
uploads\
```

With Slate stopped, back up that whole directory. The JSON files and uploads belong together: a
saved map stores a URL pointing at a file under `uploads\`.

To set your own DM secret instead of the random one the launcher generates, stop Slate and edit
`dm-secret.txt`. Use letters, digits, `-` and `_` only, since the secret goes unencoded into both the
DM URL and an HTTP header.

To reset to the built-in room, stop Slate and move this directory somewhere safe. Starting again
creates a new secret and data directory. Moving rather than deleting keeps the old game recoverable.

## Updating

Stop Slate, update the repository, then run the build script again:

```powershell
git pull
.\deploy\windows\Build-Slate.ps1
```

The build doesn't touch `%LOCALAPPDATA%\Slate`.

## Common failures

- **`cloudflared` is not recognized:** install it, or run the executable by its full path.
- **Cloudflare reports that the origin is unavailable:** make sure Slate is still running and that
  both terminals use the same port.
- **Slate says the address is in use:** close the older Slate process or choose another port in both
  commands.
- **A browser says it disconnected:** check both processes and refresh. A reconnect is a fresh join
  by design.
- **The saved room won't load:** Slate refuses to replace an unreadable save. Keep the file and read
  the startup error rather than deleting it.

## Stable hostname later

After the Quick Tunnel rehearsal works, create a remotely managed named tunnel and route a chosen
subdomain to `http://127.0.0.1:3000`. The Slate build, launcher, data directory, and player behaviour
stay the same; only the `cloudflared` setup and public URL become permanent.
