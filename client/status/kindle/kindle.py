#!/usr/bin/env python3
"""The Kindle reader of the status page.

A jailbroken Kindle running the TRMNL client is a frame viewer, not a browser:
it wakes, asks one URL for JSON naming an image, downloads the image, draws it,
and sleeps for as long as the JSON told it to. This is the server it asks. It
fetches `/api/status` from Slate on the same box and draws the same page
`status.js` draws, as a PNG, at whatever size the Kindle says it is.

Deliberately no browser: rendering the HTML would mean Chromium on a Pi 3B, and
this is a few tables of text. Python and Pillow because both are an `apt`
away on Raspberry Pi OS and nothing here is worth a build step.

**It judges nothing.** What is wrong comes from `/api/status`'s `verdict`,
decided once on the server so that this and `status.js` cannot disagree about
what an alarm is. This file paints.

See README.md beside it for the Kindle's side of the contract and the two
failure modes that shaped the frame.

    kindle.py                 serve, configured from the environment
    kindle.py --render OUT.png [WxH] [status.json]
                              draw one frame and stop; a missing or unreadable
                              JSON file draws the UNREACHABLE frame, which is
                              exactly what a missing server would
"""

import hmac
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

# The CSS layout is 800px wide — three 220px cards to a row — and everything
# below is in those units, scaled to the panel at draw time. The Kindle's own
# size arrives in the request; nothing here knows what a Paperwhite is.
#
# 800 is the widest layout, not the only one. The page's cards are
# `flex: 1 1 220px`, so on a narrower viewport they wrap to two a row, then
# one; `choose_layout` picks the width that uses a panel's *height*, the way
# the browser would if you resized it to that shape, and the wrap rule below
# is the CSS's.
DESIGN_WIDTH = 800
DESIGN_HEIGHT = 480
MIN_DESIGN_WIDTH = 440
LAYOUT_STEP = 80
CARD_BASIS = 220

# The TRMNL API's own range, and the client refuses anything with six digits.
MIN_REFRESH_S, MAX_REFRESH_S = 60, 86400


# --- configuration ----------------------------------------------------------


def env(name, default=None):
    value = os.environ.get(name, "").strip()
    return value or default


def config():
    """Everything from the environment, so the unit file reads `slate.env` and
    the status key is written down in exactly one place."""
    status_url = env("SLATE_STATUS_URL") or "http://%s/api/status" % env("SLATE_ADDR", "127.0.0.1:3000")
    missing = [n for n in ("SLATE_STATUS_KEY", "SLATE_KINDLE_TOKEN") if not env(n)]
    if missing:
        # No key, no endpoint — the same rule /api/status has. This listens on
        # the LAN, which Slate itself never does, so it does not start open.
        sys.exit("kindle.py: %s must be set" % " and ".join(missing))
    refresh = int(env("SLATE_KINDLE_REFRESH_S", "300"))
    rotate = int(env("SLATE_KINDLE_ROTATE", "0"))
    if rotate not in (0, 90, 180, 270):
        sys.exit("kindle.py: SLATE_KINDLE_ROTATE must be 0, 90, 180 or 270")
    return {
        "status_url": status_url,
        "status_key": env("SLATE_STATUS_KEY"),
        "token": env("SLATE_KINDLE_TOKEN"),
        "addr": env("SLATE_KINDLE_ADDR", "0.0.0.0:3001"),
        "refresh_s": max(MIN_REFRESH_S, min(MAX_REFRESH_S, refresh)),
        "rotate": rotate,
    }


# --- fetching ---------------------------------------------------------------


def fetch(status_url, status_key, timeout=10):
    """The payload, or the sentence saying why not. Mirrors `poll` in
    status.js: the three answers worth telling apart are a refused key, a
    server with no endpoint, and no server at all."""
    req = urllib.request.Request(status_url, headers={"x-slate-status-key": status_key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as err:
        if err.code == 403:
            return None, "the status key was refused"
        if err.code == 404:
            return None, "this server has no status endpoint - SLATE_STATUS_KEY is unset"
        return None, "the server answered %d" % err.code
    except (urllib.error.URLError, OSError, ValueError) as err:
        return None, "no answer from the server (%s)" % (getattr(err, "reason", None) or err)


# --- text -------------------------------------------------------------------


def duration(s):
    """Coarse on purpose, and the same coarseness as the page's."""
    s = max(0, int(round(s)))
    d, h, m = s // 86400, (s % 86400) // 3600, (s % 3600) // 60
    if d:
        return "%dd %dh" % (d, h)
    if h:
        return "%dh %dm" % (h, m)
    if m:
        return "%dm" % m
    return "%ds" % s


def stamp(unix):
    if not unix:
        return "unknown"
    try:
        return time.strftime("%d/%m %H:%M", time.localtime(float(unix)))
    except (ValueError, OverflowError, OSError):
        return "unknown"


def who_is_here(here):
    if not here:
        return None
    return ", ".join("DM" if p.get("kind") == "dm" else str(p.get("id", "?")) for p in here)


# --- fonts ------------------------------------------------------------------

# DejaVu if the box has it (`fonts-dejavu-core`), which is the face the page's
# CSS asks for on the numbers. Pillow's built-in scalable face otherwise, with
# a stroke standing in for bold: a frame in the wrong font beats no frame.
FONT_DIRS = ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu")
FACES = {
    "regular": "DejaVuSans.ttf",
    "bold": "DejaVuSans-Bold.ttf",
    "mono": "DejaVuSansMono.ttf",
}


class Fonts:
    def __init__(self):
        self.have_dejavu = any(os.path.isfile(os.path.join(d, FACES["regular"])) for d in FONT_DIRS)
        self.cache = {}

    def get(self, face, size):
        size = max(1, int(round(size)))
        key = (face, size)
        if key not in self.cache:
            font = None
            if self.have_dejavu:
                for d in FONT_DIRS:
                    path = os.path.join(d, FACES[face])
                    if os.path.isfile(path):
                        font = ImageFont.truetype(path, size)
                        break
            if font is None:
                font = ImageFont.load_default(size=size)
            self.cache[key] = font
        return self.cache[key]

    def stroke(self, face, size):
        """Faux bold when the real one is not on the box. Only once the glyphs
        are big enough to carry it: at 14px a one-pixel stroke is a smear."""
        return 1 if not self.have_dejavu and face == "bold" and size >= 24 else 0


# --- drawing ----------------------------------------------------------------


class Frame:
    """One PNG. Coordinates are layout units (`layout_w` wide) and `s` scales
    them to the panel, so the same code fits a 800x480 TRMNL, a 1648x1236
    Kindle on its side and a 1236x1648 one upright.
    """

    def __init__(self, width, height, fonts, layout_w=DESIGN_WIDTH):
        self.layout_w = layout_w
        self.s = width / layout_w
        self.w, self.h = width, height
        self.img = Image.new("L", (width, height), 255)
        self.d = ImageDraw.Draw(self.img)
        self.fonts = fonts

    def px(self, v):
        return int(round(v * self.s))

    def font(self, face, size):
        return self.fonts.get(face, size * self.s)

    def width_of(self, text, face, size, spacing=0):
        f = self.font(face, size)
        return self.d.textlength(text, font=f) + self.px(spacing) * max(0, len(text) - 1)

    def text(self, x, y, text, face="regular", size=14, invert=False, spacing=0, align="left"):
        """Draw at layout (x, y); returns the layout width used. `invert` is the
        page's `.alarm`: white on a black box, the only alarm the frame has.
        Baseline-free — y is the top of the line box, like CSS."""
        f = self.font(face, size)
        stroke = self.fonts.stroke(face, size * self.s)
        w = self.width_of(text, face, size, spacing)
        line_h = self.px(size * 1.25)
        X, Y = self.px(x), self.px(y)
        if align == "right":
            X -= int(w)
        fill = 0
        if invert:
            pad = self.px(3)
            self.d.rectangle([X - pad, Y, X + int(w) + pad, Y + line_h], fill=0)
            fill = 255
        # Vertically centre the glyph box in the line box.
        top = Y + (line_h - self.px(size)) // 2
        if spacing:
            cx = X
            for ch in text:
                self.d.text((cx, top), ch, font=f, fill=fill, stroke_width=stroke, stroke_fill=fill)
                cx += self.d.textlength(ch, font=f) + self.px(spacing)
        else:
            self.d.text((X, top), text, font=f, fill=fill, stroke_width=stroke, stroke_fill=fill)
        return w / self.s

    def line_height(self, size):
        return size * 1.25

    def rect(self, x, y, w, h, border=2):
        self.d.rectangle([self.px(x), self.px(y), self.px(x + w), self.px(y + h)], outline=0, width=self.px(border))

    def hline(self, x, y, w, thick=1):
        self.d.rectangle([self.px(x), self.px(y), self.px(x + w), self.px(y) + max(1, self.px(thick))], fill=0)

    def fit(self, text, face, size, max_w):
        """One line, cut with an ellipsis where it must be. For a cell whose
        width is the column's, not the text's."""
        if self.width_of(text, face, size) / self.s <= max_w:
            return text
        n = len(text)
        while n > 1 and self.width_of(text[:n] + "…", face, size) / self.s > max_w:
            n -= 1
        return text[:n] + "…"

    def wrap(self, text, face, size, max_w):
        """Greedy word wrap in layout units. A frame cannot scroll, so a line
        that would run off the right edge is worse than one more row."""
        fits = lambda t: self.width_of(t, face, size) / self.s <= max_w
        words = []
        for word in text.split(" "):
            # A word wider than the line — a path in an error — is cut where
            # it must be, since nothing else can be done with it.
            while word and not fits(word):
                n = len(word)
                while n > 1 and not fits(word[:n]):
                    n -= 1
                words.append(word[:n])
                word = word[n:]
            if word:
                words.append(word)
        lines, cur = [], ""
        for word in words:
            trial = (cur + " " + word).strip()
            if cur and not fits(trial):
                lines.append(cur)
                cur = word
            else:
                cur = trial
        if cur:
            lines.append(cur)
        return lines or [""]

    def png(self, rotate=0):
        """`rotate` is degrees anticlockwise, and 0 — serve the size that was
        asked for — is the default because that is what a reader that scales
        the image wants: the KOReader plugin asks for its screen as currently
        oriented and fits the PNG to it. 90 is for the KUAL shell client,
        which asks for a *landscape* frame (`png-width` = the panel's long
        side) and then hands it to `eips`, which blits pixels straight into a
        portrait framebuffer — served as drawn, that frame loses its right
        quarter. Turned, the Kindle is stood on its side, which is how TRMNL's
        own server serves that client."""
        img = self.img.rotate(rotate, expand=True) if rotate else self.img
        out = BytesIO()
        img.save(out, format="PNG", optimize=True)
        return out.getvalue()


# Layout constants, in the CSS's units.
PAD = 6
CARD_PAD_X, CARD_PAD_Y = 8, 6
GAP = 6
# The CSS's sizes. Larger type was tried (1.25x, 1.5x) and cut things: the
# frame gets taller, `render` widens the layout to fit, and the cards go three
# a row at a width that no longer holds a label and its value.
ROW = 14  # body text size
LABEL = 11  # card titles and table headers
BAR = 18  # SLATE and the state
STAMP = 13  # "rendered HH:MM"
SHOUT = 40  # UNREACHABLE


def draw_card_frame(fr, x, y, w, h, title):
    fr.rect(x, y, w, h)
    ty = y + CARD_PAD_Y
    fr.text(x + CARD_PAD_X, ty, title.upper(), "bold", LABEL, spacing=2)
    ty += fr.line_height(LABEL) + 2
    fr.hline(x + CARD_PAD_X, ty, w - 2 * CARD_PAD_X)
    return ty + 4


def measure_rows(fr, rows):
    """Height of a label/value table: one line per row plus separators."""
    return len(rows) * (fr.line_height(ROW) + 4)


def draw_rows(fr, x, y, w, rows):
    """`rows` is [(label, value, invert)]. Label left, value right in mono —
    the page's `td.num`."""
    for i, (label, value, invert) in enumerate(rows):
        if i:
            fr.hline(x, y, w)
        vw = fr.text(x + w, y + 2, value, "mono", ROW, invert=invert, align="right")
        fr.text(x, y + 2, fr.fit(label, "regular", ROW, w - vw - 6), "regular", ROW)
        y += fr.line_height(ROW) + 4
    return y


def card_height(fr, body_h):
    return CARD_PAD_Y + fr.line_height(LABEL) + 2 + 4 + body_h + CARD_PAD_Y


def server_rows(server, host, verdict):
    server = server or {}
    rows = [
        ("Version", str(server.get("version") or "?"), False),
        ("Uptime", duration(server.get("uptime_s") or 0), False),
        ("Since", stamp(server.get("started_unix")), False),
    ]
    if host and isinstance(host.get("restarts"), (int, float)):
        rows.append(("Restarts", str(host["restarts"]), bool(verdict.get("restarted"))))
    return rows


def host_rows(host, verdict):
    """Returns (rows, note): rows for the table, or a sentence instead of one."""
    if not host:
        return [], ("No collector on this machine.", False)
    if host.get("error"):
        return [], ("BROKEN " + str(host["error"]), True)
    rows = []
    age = verdict.get("host_age_s")
    if isinstance(host.get("cpu_c"), (int, float)):
        rows.append(("CPU", "%.1f°C" % host["cpu_c"], bool(verdict.get("cpu_hot"))))
    if isinstance(host.get("load1"), (int, float)):
        rows.append(("Load", "%.2f" % host["load1"], False))
    if host.get("mem_total_mb"):
        rows.append(("Memory", "%s / %s MB" % (host.get("mem_used_mb"), host["mem_total_mb"]), False))
    if host.get("disk_total_gb"):
        rows.append((
            "Disk",
            "%s / %s GB (%s%%)" % (host.get("disk_used_gb"), host["disk_total_gb"], host.get("disk_pct")),
            bool(verdict.get("disk_full")),
        ))
    if isinstance(host.get("uploads_mb"), (int, float)):
        files = " / %s files" % host["uploads_files"] if isinstance(host.get("uploads_files"), (int, float)) else ""
        rows.append(("Uploads", "%s MB%s" % (host["uploads_mb"], files), False))
    if host.get("uptime_s"):
        rows.append(("Host up", duration(host["uptime_s"]), False))
    # Three states, not two — see status.js.
    if host.get("undervoltage"):
        power = "UNDERVOLTAGE"
    elif host.get("undervoltage_ever"):
        power = "ok (dipped)"
    else:
        power = "ok"
    rows.append(("Power", power, bool(host.get("undervoltage"))))
    # Only once it is worth knowing; a fresh reading is the ordinary case.
    if isinstance(age, (int, float)) and age > 90:
        rows.append(("Read", duration(age) + " old", bool(verdict.get("host_stale"))))
    return rows, None


def build_rows(build):
    if not build:
        return [], ("No build stamp.", False)
    rows = []
    for k, v in build.items():
        if k.endswith("_unix") and isinstance(v, (int, float)):
            v = stamp(v)
        elif isinstance(v, bool):
            v = "yes" if v else "no"
        rows.append((k[:-5] if k.endswith("_unix") else k.replace("_", " "), str(v), k == "dirty" and build[k] is True))
    return rows, None


def draw_rooms(fr, x, y, w, rooms):
    """The wide card. Five columns; the last three right-aligned."""
    inner = w - 2 * CARD_PAD_X
    heads = [("Room", "left"), ("Here", "left"), ("Sockets", "right"), ("Tokens", "right"), ("Saved", "right")]
    lines = []  # (cells, is_header); a cell is (text, face, invert, align)
    lines.append(([(h, "regular", False, a) for h, a in heads], True))
    for r in rooms or []:
        name = str(r.get("name", "?"))
        if not r.get("responding"):
            lines.append(([(name, "bold", False, "left"), ("DID NOT ANSWER", "regular", True, "left")], False))
            continue
        here = who_is_here(r.get("here"))
        if r.get("saves_failing"):
            saved = ("FAILING", "mono", True, "right")
        else:
            saved = ("pending" if r.get("unsaved") else "yes", "mono", False, "right")
        lines.append((
            [
                (name, "bold", False, "left"),
                (here or "empty", "regular", False, "left"),
                (str(r.get("sockets", "")), "mono", False, "right"),
                (str(r.get("tokens", "")), "mono", False, "right"),
                saved,
            ],
            False,
        ))
    if len(lines) == 1:
        lines.append(([("No rooms.", "regular", False, "left")], False))

    # The three numeric columns are as wide as their widest content, header
    # included, and the two text columns share the rest — a fixed share
    # collides the headers at 440 wide and wastes half the row at 800.
    widths = [0.0] * 5
    for cells, is_header in lines:
        for j, (text, face, invert, align) in enumerate(cells):
            if j < 2 or len(cells) != 5:
                continue
            size = LABEL if is_header else ROW
            need = fr.width_of(text.upper() if is_header else text, face, size, 1 if is_header else 0) / fr.s
            widths[j] = max(widths[j], need + 12)
    rest = inner - sum(widths[2:])
    widths[0], widths[1] = rest * 0.4, rest * 0.6

    body_h = len(lines) * (fr.line_height(ROW) + 4)
    h = card_height(fr, body_h)
    ty = draw_card_frame(fr, x, y, w, h, "Rooms")
    cx0 = x + CARD_PAD_X
    for i, (cells, is_header) in enumerate(lines):
        if i > 1:
            fr.hline(cx0, ty, inner)
        cx = cx0
        for j, (text, face, invert, align) in enumerate(cells):
            cw = widths[j]
            size = LABEL if is_header else ROW
            if is_header:
                text = text.upper()
            elif not invert:
                text = fr.fit(text, face, size, cw - 6)
            if align == "right":
                fr.text(cx + cw, ty + 2, text, face, size, invert=invert, align="right", spacing=1 if is_header else 0)
            else:
                fr.text(cx, ty + 2, text, face, size, invert=invert, spacing=1 if is_header else 0)
            cx += cw
        ty += fr.line_height(ROW) + 4
    return h


def choose_layout(width, height):
    """The layout width at which the panel is 480 layout units tall — the
    page's own height — clamped to the widths the layout is good at. A
    800x480 panel gets 800; a Kindle on its side (1648x1236) 640, where the
    cards go two to a row; one upright (1236x1648) 440, one to a row. Pinned
    at 800 a portrait panel drew the page across its top third and left the
    rest white, which is what this replaces."""
    at_height = width * DESIGN_HEIGHT / height
    return int(max(MIN_DESIGN_WIDTH, min(DESIGN_WIDTH, round(at_height))))


def cards_per_row(inner_w):
    """`flex: 1 1 220px` with 3px margins in a grid pulled out by 3px: as many
    cards as fit their basis, one at least, three at most."""
    return max(1, min(3, int((inner_w + 2 * 3) // (CARD_BASIS + 2 * 3))))


def render(payload, problem, last_good_at, width, height, fonts=None, now=None, rotate=0):
    """The whole frame. `payload` is the last good `/api/status` body or None;
    `problem` the sentence for why the latest fetch failed, or None.

    Two things a static image needs that the live page does not. The frame is
    stamped with the time it was drawn, because the page's "updated 4s ago"
    has no equivalent on e-ink and a Kindle that keeps showing Tuesday's OK
    would otherwise be indistinguishable from one that is current. And the
    UNREACHABLE state is drawn as a frame rather than left to the Kindle,
    because the TRMNL client is silent on failure — it keeps the last image.

    Drawn at the layout width the panel's shape asks for, and wider in steps
    until it fits — a night with every alarm lit is taller than a quiet one,
    and a panel cannot scroll. At 800 it is drawn whether it fits or not,
    which is the page's own behaviour on the panel it was designed for.
    """
    fonts = fonts or Fonts()
    now = now if now is not None else time.time()
    layout_w = choose_layout(width, height)
    while True:
        fr = Frame(width, height, fonts, layout_w)
        bottom = draw_page(fr, payload, problem, last_good_at, now)
        if fr.px(bottom) <= height or layout_w >= DESIGN_WIDTH:
            return fr.png(rotate)
        layout_w = min(DESIGN_WIDTH, layout_w + LAYOUT_STEP)


def draw_page(fr, payload, problem, last_good_at, now):
    """Everything on the page, top to bottom; returns where it ended, in
    layout units, so `render` can tell whether it fit."""
    verdict = (payload or {}).get("verdict") or {}
    alarms = list(verdict.get("alarms") or [])
    state = "UNREACHABLE" if problem else ("ATTENTION" if alarms else "OK")

    inner_w = fr.layout_w - 2 * PAD
    x, y = PAD, PAD

    # The bar.
    bar_h = 5 * 2 + fr.line_height(BAR)
    fr.rect(x, y, inner_w, bar_h)
    tx = x + 8
    tx += fr.text(tx, y + 5, "SLATE", "bold", BAR, spacing=3) + 10
    fr.text(tx, y + 5, state, "bold", BAR, invert=(state != "OK"), spacing=1)
    fr.text(x + inner_w - 8, y + 5 + 3, "rendered " + time.strftime("%H:%M", time.localtime(now)), "regular", STAMP, align="right")
    y += bar_h + GAP

    # The most important state the frame has. Last good data underneath rather
    # than instead: "fine 20 seconds ago" and "gone an hour" are different
    # emergencies.
    if problem:
        fr.text(x + 8, y, "UNREACHABLE", "bold", SHOUT)
        y += fr.line_height(SHOUT) + 4
        why = problem + (
            "  Last good reading at %s." % time.strftime("%H:%M", time.localtime(last_good_at))
            if last_good_at
            else "  Nothing has ever been read from this server."
        )
        for line in fr.wrap(why, "regular", ROW, inner_w - 16):
            fr.text(x + 8, y, line, "regular", ROW)
            y += fr.line_height(ROW)
        y += GAP
    elif alarms:
        for line in fr.wrap("  ·  ".join(alarms), "regular", ROW, inner_w - 16):
            fr.text(x + 8 + 3, y, line, "regular", ROW, invert=True)
            y += fr.line_height(ROW) + 2
        y += GAP

    if not payload:
        return y

    y += draw_rooms(fr, x, y, inner_w, payload.get("rooms")) + GAP

    # The three cards, as many to a row as the CSS would put there, each row
    # sharing its tallest height and a short last row stretched across, which
    # is what `flex: 1 1 220px` does with a card that wrapped alone.
    cards = [
        ("Server", server_rows(payload.get("server"), payload.get("host"), verdict), None),
    ]
    rows, note = host_rows(payload.get("host"), verdict)
    cards.append(("Host", rows, note))
    rows, note = build_rows(payload.get("build"))
    cards.append(("Build", rows, note))

    per_row = cards_per_row(inner_w)
    for start in range(0, len(cards), per_row):
        row_cards = cards[start:start + per_row]
        n = len(row_cards)
        card_w = (inner_w - (n - 1) * GAP) / n
        body_hs = []
        for _, rows, note in row_cards:
            if note:
                body_hs.append(len(fr.wrap(note[0], "regular", ROW, card_w - 2 * CARD_PAD_X)) * fr.line_height(ROW))
            else:
                body_hs.append(measure_rows(fr, rows))
        h = card_height(fr, max(body_hs))
        for i, (title, rows, note) in enumerate(row_cards):
            cx = x + i * (card_w + GAP)
            ty = draw_card_frame(fr, cx, y, card_w, h, title)
            if note:
                text, invert = note
                for line in fr.wrap(text, "regular", ROW, card_w - 2 * CARD_PAD_X):
                    fr.text(cx + CARD_PAD_X, ty + 2, line, "regular", ROW, invert=invert)
                    ty += fr.line_height(ROW)
            else:
                draw_rows(fr, cx + CARD_PAD_X, ty, card_w - 2 * CARD_PAD_X, rows)
        y += h + GAP

    return y


# --- serving ----------------------------------------------------------------


class Display:
    """The last frame drawn and the name it was given. The Kindle's second
    request carries no token — the client fetches `image_url` bare — so the
    name is a fresh random one per render, unguessable, and replaced by the
    next. What the first request authenticates is the right to be told it."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.fonts = Fonts()
        self.lock = threading.Lock()
        self.good = None
        self.good_at = 0
        self.name = None
        self.png = b""

    def refresh(self, width, height):
        payload, problem = fetch(self.cfg["status_url"], self.cfg["status_key"])
        with self.lock:
            if payload is not None:
                self.good, self.good_at = payload, time.time()
            png = render(self.good, problem, self.good_at, width, height, self.fonts, rotate=self.cfg.get("rotate", 0))
            self.name = "slate-%s.png" % secrets.token_hex(8)
            self.png = png
            return self.name, problem

    def image(self, name):
        with self.lock:
            return self.png if name and name == self.name else None


def display_json(image_url, filename, refresh_s):
    """The TRMNL client parses this with `sed`, not a JSON parser, and its
    pattern is `"image_url":"` with no space — so this is emitted compact.
    Pretty-printing it would be a frame the Kindle never shows."""
    body = {"status": 0, "image_url": image_url, "filename": filename, "refresh_rate": refresh_s}
    return json.dumps(body, separators=(",", ":")).encode("utf-8")


def make_handler(display):
    cfg = display.cfg

    class Handler(BaseHTTPRequestHandler):
        server_version = "slate-kindle"

        def log_message(self, fmt, *args):
            sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
            sys.stdout.flush()

        def send(self, code, body, content_type):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/display":
                return self.display()
            if path.startswith("/display/") and path.endswith(".png"):
                png = display.image(path[len("/display/"):])
                if png is None:
                    return self.send(404, b"no such frame", "text/plain")
                return self.send(200, png, "image/png")
            self.send(404, b"not here", "text/plain")

        def display(self):
            sent = self.headers.get("access-token", "")
            if not hmac.compare_digest(sent.encode("utf-8"), cfg["token"].encode("utf-8")):
                self.log_message("refused a request with a bad token")
                return self.send(403, b"not the token", "text/plain")
            width = clamp_int(self.headers.get("png-width"), DESIGN_WIDTH)
            height = clamp_int(self.headers.get("png-height"), DESIGN_HEIGHT)
            name, problem = display.refresh(width, height)
            if problem:
                self.log_message("drew UNREACHABLE: %s", problem)
            # Whatever the Kindle dialled is what it can reach, which is what
            # matters on a box that is 127.0.0.1 to Slate and a LAN address to
            # the shelf.
            host = self.headers.get("Host") or cfg["addr"]
            url = "http://%s/display/%s" % (host, name)
            self.send(200, display_json(url, name, cfg["refresh_s"]), "application/json")

    return Handler


def clamp_int(value, default, lo=200, hi=4000):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def serve(cfg):
    host, _, port = cfg["addr"].rpartition(":")
    server = ThreadingHTTPServer((host or "0.0.0.0", int(port)), make_handler(Display(cfg)))
    print("slate-kindle: listening on %s, drawing %s every %ds, rotated %d" % (cfg["addr"], cfg["status_url"], cfg["refresh_s"], cfg["rotate"]))
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def render_once(args):
    """`--render OUT.png [WxH] [status.json]`"""
    if not args:
        sys.exit(__doc__)
    out, size, source = args[0], "%dx%d" % (DESIGN_WIDTH, DESIGN_HEIGHT), None
    for a in args[1:]:
        if "x" in a and a.replace("x", "").isdigit():
            size = a
        else:
            source = a
    w, h = (int(v) for v in size.split("x"))
    payload, problem = None, None
    if source:
        try:
            with open(source, encoding="utf-8") as f:
                payload = json.load(f)
        except (OSError, ValueError) as err:
            problem = "no answer from the server (%s)" % err
    else:
        cfg = config()
        payload, problem = fetch(cfg["status_url"], cfg["status_key"])
    with open(out, "wb") as f:
        f.write(render(payload, problem, time.time() if payload else 0, w, h))
    print("wrote %s (%dx%d)%s" % (out, w, h, " - " + problem if problem else ""))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--render":
        render_once(sys.argv[2:])
    elif len(sys.argv) > 1:
        sys.exit(__doc__)
    else:
        serve(config())
