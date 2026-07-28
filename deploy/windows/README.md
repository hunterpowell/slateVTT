# Hosting Slate from Windows

Slate can run from a Windows PC only while the group is playing. The server
listens on the loopback interface, and a separate Cloudflare Tunnel process
provides the public HTTPS and WebSocket connection. No inbound firewall port is
needed.

Runtime state does not live in the repository. The launcher keeps the saved
room, uploaded maps, and stable DM secret in:

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

The script installs the exact client dependencies in `package-lock.json`,
typechecks and bundles the client, runs the Rust tests, and builds the optimized
server executable.

If PowerShell refuses to run a local script, allow it for this process only:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

## Run locally

In terminal one:

```powershell
.\deploy\windows\Start-Slate.ps1
```

The launcher prints local player and DM links. It also creates the data
directory and reuses the same DM secret on later sessions. Use `-Port 3001` if
port 3000 is already occupied.

Press Ctrl+C to stop. Slate handles the interrupt, flushes a change still
inside the save debounce window, and then exits.

## Remote rehearsal with a Quick Tunnel

First start Slate as above. In terminal two:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

`cloudflared` prints a random URL resembling:

```text
https://words-words-words.trycloudflare.com
```

That URL is the player link. For the DM link, append the `?dm=...` query from
the local DM URL printed in terminal one:

```text
https://words-words-words.trycloudflare.com/?dm=<the-local-secret>
```

The browser removes the secret from its address bar immediately after reading
it. Do not give the DM link to players.

Quick Tunnel addresses change whenever `cloudflared` restarts. Cloudflare
positions them as development and testing infrastructure, so use this workflow
for the remote rehearsal rather than treating the address as permanent.

At the end of a session, press Ctrl+C in terminal one to stop Slate cleanly,
then Ctrl+C in terminal two to close the tunnel.

## Rehearsal checklist

Use the public links from at least two networks if practical:

1. Join once as the DM and from two player browsers.
2. Confirm that players can move only their own tokens.
3. Move tokens continuously and confirm that all browsers stay synchronized.
4. Set and advance initiative.
5. Upload and calibrate a real map.
6. Refresh a player and confirm that the same character rejoins.
7. Stop Slate, start it again, and confirm that the map, token positions, and
   initiative return.
8. Confirm that the old Quick Tunnel URL stops working after its process exits.

## Data and backup

The entire persistent installation is `%LOCALAPPDATA%\Slate`:

```text
dm-secret.txt
slate-state.json
uploads\
```

With Slate stopped, back up that whole directory. The JSON file and uploads
belong together: the saved map stores a URL referring to a file under
`uploads\`.

To reset to the built-in room, stop Slate and move this directory somewhere
safe. Starting again creates a new secret and data directory. Moving rather
than deleting keeps the old game recoverable.

## Updating

Stop Slate, update the repository, then run the build script again:

```powershell
git pull
.\deploy\windows\Build-Slate.ps1
```

The build does not touch `%LOCALAPPDATA%\Slate`.

## Common failures

- **`cloudflared` is not recognized:** install it, or invoke the executable by
  its full path.
- **Cloudflare reports that the origin is unavailable:** make sure Slate is
  still running and that both terminals use the same port.
- **Slate says the address is in use:** close the older Slate process or choose
  another port in both commands.
- **A browser says it disconnected:** verify both processes and refresh. A
  reconnect is deliberately a fresh join.
- **The saved room will not load:** Slate refuses to replace an unreadable save.
  Keep the file and inspect the startup error rather than deleting it.

## Stable hostname later

After the Quick Tunnel rehearsal succeeds, create a remotely managed named
tunnel and route a chosen subdomain to `http://127.0.0.1:3000`. The Slate build,
launcher, data directory, and player behavior remain unchanged; only the
`cloudflared` setup and public URL become permanent.
