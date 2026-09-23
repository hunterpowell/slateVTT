# The Kindle

The status page, drawn as a PNG for a jailbroken Kindle on a shelf in the room. One Python file,
one systemd unit, no browser anywhere.

**It isn't part of Slate**, in the same sense the page next to it isn't: it imports nothing from
`client/src/`, isn't in esbuild's build, and touches no room state. It's a second *client* of
`/api/status`, alongside `status.js`. It lives in the client tree only so a deploy carries it. As a
side effect Slate serves the source at `/status/kindle/kindle.py`, which is fine: it's in a public
repository and holds no secret.

## Why it works this way

The Kindle runs a TRMNL client: either [trmnl-koreader](https://github.com/usetrmnl/trmnl-koreader),
a KOReader plugin, or the older [trmnl-kindle](https://github.com/usetrmnl/trmnl-kindle) KUAL shell
script. Both speak the same contract, and both are **frame viewers, not browsers**. The loop, read
from the shell client's source:

1. `GET {BASE_URL}/api/display` with `access-token`, `png-width`, `png-height`, its MAC and battery
   level in headers.
2. Parse `image_url`, `refresh_rate` and `filename` out of the answer, **with `sed`** rather than a
   JSON parser.
3. `GET image_url`, bare. No token on this one.
4. `eips` the PNG onto the panel.
5. Put the whole device to sleep, wifi off, with an RTC alarm set for `refresh_rate` seconds.

Three other ways of getting the page onto that screen were tried or costed first, and the reasons
they lost explain the design:

- **The Kindle's own browser**, which the page was originally written for (hence the `-webkit-box`
  prefixes, ES5, `?key=`). Used for a day and disliked: the browser chrome, the screensaver, and wifi
  that never slept. A TRMNL client fixes all three and is what the device now runs.
- **trmnl.app**, which polls a URL and renders Liquid templates to a PNG on its servers. It works,
  but it puts a third party, the status key and a tunnel hop into a status display for a box that
  sits in the same room as the Kindle.
- **Headless Chromium on the Pi**, screenshotting the real page. It runs the actual HTML, and it
  would be the heaviest thing ever to run on a 1 GB board, all for a few tables of text.

So the PNG is **drawn from the JSON**, on the Pi, in Python with Pillow, both an `apt install` on
Raspberry Pi OS. The Kindle talks to the Pi over the LAN in plain HTTP; nothing crosses the tunnel,
and the Kindle holds no Slate credential.

## What must not break

**It judges nothing.** Everything that inverts on the frame (`FAILING`, `DID NOT ANSWER`, a hot CPU,
a stale reading) comes from the `verdict` section of `/api/status`, decided on the server. This
renderer and `status.js` are two drawings of one judgement; a threshold written in either would be a
second copy that drifts. The one exception is *whether a row is worth showing at all* (the `Read` row
past 90 seconds), which is layout and lives in both.

**It always serves a frame.** The TRMNL client is silent on failure with debug off: a `curl` that
returns nothing leaves the previous image on the panel. So a Slate that has gone down is *drawn* as
gone: `UNREACHABLE`, inverted, with the reason and the last good data underneath, because "fine
twenty seconds ago" and "gone for an hour" are different emergencies. A refused key, a server with
no status endpoint, and no server at all are told apart the same way the page tells them apart.

**Each frame is stamped with the time it was drawn.** The page's "updated 4s ago" has no equivalent
on a static image. If this service dies, the Kindle keeps showing its last frame, an `OK` from
Tuesday that looks like a current one except for `rendered 14:32` in the corner. That stamp is the
only thing that can catch it. The host collector's `at` field exists for the same reason.

**The image request carries no token**, so the image's name is the credential: a fresh random name
per render, valid until the next one, and 404 for anything else. The `access-token` on the first
request is what gets you told the name.

**Compact JSON.** The client's pattern is `"image_url":"`, so a space after the colon and the Kindle
shows nothing. `kindle_test.py` checks the response against the client's own `sed` patterns for that
reason.

**Sized by the request, laid out the way the CSS would.** The page's cards are `flex: 1 1 220px`:
three a row at 800, two at 640, one at 440. The renderer picks the layout width at which the panel is
480 layout units tall, then wraps the cards by the same rule, so a panel's *height* gets used. When
the width was fixed at 800, a portrait Kindle drew the page across its top third and left the rest
white. A Paperwhite upright (1236×1648) lays out at 440, one card a row, at 2.8×; on its side
(1648×1236) at 640, two a row; a TRMNL panel at 800. If a busy frame (every alarm lit) runs off the
bottom at that width, it's redrawn a step wider until it fits, because a panel can't scroll. Nothing
in the file knows what a Paperwhite is, and by default it serves exactly the size asked for.

**Text is the page's size, and bigger was tried.** At 1.25× and 1.5×, a full frame was too tall for
two cards a row on a Paperwhite on its side, so `render` widened the layout to three a row, and a
card a third of the width cut labels short (`Uploads` → `Up…`). The size is controlled by the layout
width, not the font: text on the panel is `size × width / layout_w`, and the layout has no spare
height to give. `draw_rows` truncates a label to the space its value leaves rather than let the two
run together, as the rooms table already did.

`SLATE_KINDLE_ROTATE=90` exists for the KUAL shell client. That client asks for a landscape frame (it
sends the panel's *long* side as `png-width`) and then hands the PNG to `eips`, which copies pixels
straight into a **portrait** framebuffer. Served as drawn, the frame lost its right quarter and sat in
the top third of the screen. Rotated 90° before encoding, it displays correctly with the Kindle on its
side, which is how TRMNL's own server serves that client. The KOReader plugin needs none of this: it
asks for its screen as currently oriented and fits the image to it.

**It's the one thing on the box that listens on the LAN**, because the Kindle is on wifi and Slate is
on loopback behind the tunnel. That's why the token is *required*: without `SLATE_KINDLE_TOKEN` the
service refuses to start, the same rule `/api/status` follows with `SLATE_STATUS_KEY`.

## What the Kindle needs

**The KOReader plugin** is the one to use if KOReader is on the device at all. The shell client stops
the stock framework but not KOReader, which then repaints over its frame on every wake and leaves two
patches of status on top of a file browser. Drop `trmnl.koplugin` into `/koreader/plugins/`, restart
KOReader, then go to *Tools → TRMNL Display → Configure TRMNL*:

| Setting | |
|---|---|
| Base URL | `http://<the Pi's LAN address>:3001`, e.g. `http://192.168.1.20:3001` |
| API Key | `SLATE_KINDLE_TOKEN` from `slate.env`; sent as `access-token` |
| Use server refresh interval | on: the service's `SLATE_KINDLE_REFRESH_S`, default 300 |

Either orientation works. The plugin asks for the screen as it's oriented and the frame is laid out
for that shape: upright the cards stack, on its side they pair up. Follow the plugin README's *Run it
as a dashboard* settings: keep-alive on, auto-suspend off, wifi on when needed.

**The KUAL shell client**, if KOReader isn't installed: `TRMNL_config.sh` gets `BASE_URL` and
`API_KEY` as above and `MIN_REFRESH_RATE=300`, and the unit gets `SLATE_KINDLE_ROTATE=90`.

Either way, use an address rather than `slate.local`, with a DHCP reservation so it stays the same. I
wouldn't expect the Kindle's resolver to do mDNS, and a display that stops working after the router
hands out a new lease is the kind of failure nobody looks for. The refresh interval is limited to the
TRMNL API's own range, 60–86400 seconds; a Kindle is not a 15-second status display.

## Running it

On the Pi, the install is in `deploy/pi/README.md` § *The Kindle*. On the Windows machine, against a
dev server:

```
cd client/status/kindle
set SLATE_STATUS_KEY=test-status
set SLATE_KINDLE_TOKEN=kindle-token
python kindle.py                                  # serves on 0.0.0.0:3001
python kindle.py --render out.png 1648x1236       # one frame from the dev server, then exit
python kindle.py --render out.png 800x480 x.json  # one frame from a saved payload
python kindle_test.py
```

`--render` with a JSON file that doesn't exist draws the `UNREACHABLE` frame, exactly as it does for
a server that doesn't answer.

Fonts: DejaVu if `fonts-dejavu-core` is installed (it's the face the page's CSS asks for), otherwise
Pillow's built-in scalable face, which has no true bold. Install the package on the Pi; the fallback
exists so a preview works on Windows without it.

## Files

| File | |
|---|---|
| `kindle.py` | The service and the renderer. `render()` draws the page; `Display` is what the Kindle is told; `make_handler` is the two routes |
| `kindle_test.py` | `python3 kindle_test.py`. The contract, checked with the client's own `sed` patterns |
| `../../../deploy/pi/slate-kindle.service` | The unit. Reads `slate.env` like `slate.service` does |
