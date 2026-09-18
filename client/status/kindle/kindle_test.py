"""The Kindle's side of the contract, asserted the way the Kindle reads it.

    python3 kindle_test.py

The TRMNL client parses `/api/display` with `sed`, so the tests here match its
patterns rather than parsing JSON — a response a JSON parser accepts and `sed`
does not is a blank Kindle.
"""

import io
import json
import os
import re
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from PIL import Image

import kindle

# The client's own patterns, copied from TRMNL.sh.
SED_IMAGE_URL = re.compile(r'.*"image_url":"([^"]*)".*')
SED_REFRESH = re.compile(r'.*"refresh_rate":([^,}]*).*')
SED_FILENAME = re.compile(r'.*"filename":"([^"]*)".*')

HEALTHY = {
    "server": {"version": "0.9.3", "started_unix": 1_700_000_000, "uptime_s": 4000},
    "build": {"sha": "abc1234", "dirty": False},
    "rooms": [
        {
            "id": "campaign",
            "name": "Campaign",
            "responding": True,
            "here": [{"kind": "dm"}],
            "sockets": 1,
            "tokens": 3,
            "unsaved": False,
            "saves_failing": False,
            "last_saved_unix": 1_700_003_990,
        }
    ],
    "host": None,
    "verdict": {
        "alarms": [],
        "host_age_s": None,
        "host_stale": False,
        "cpu_hot": False,
        "disk_full": False,
        "restarted": False,
    },
}


def png_size(data):
    return Image.open(io.BytesIO(data)).size


class Rendering(unittest.TestCase):
    def test_a_frame_is_the_size_the_kindle_asked_for(self):
        png = kindle.render(HEALTHY, None, 0, 1648, 1236)
        self.assertEqual(png_size(png), (1648, 1236))
        self.assertEqual(Image.open(io.BytesIO(png)).mode, "L", "greyscale, for eips")

    def test_the_unreachable_frame_is_still_a_frame(self):
        # The TRMNL client is silent on failure and keeps the last image, so a
        # server that has gone must be *drawn* as gone.
        png = kindle.render(None, "no answer from the server", 0, 800, 480)
        self.assertEqual(png_size(png), (800, 480))

    def test_the_layout_width_follows_the_panels_shape(self):
        # 800 on the panel the page was designed for; narrower on a taller
        # one so the cards wrap and the height is used — pinned at 800, a
        # portrait Kindle drew the page across its top third.
        self.assertEqual(kindle.choose_layout(800, 480), 800)
        self.assertEqual(kindle.choose_layout(1648, 1236), 640)
        self.assertEqual(kindle.choose_layout(1236, 1648), 440)
        self.assertEqual(kindle.choose_layout(4000, 200), 800, "never wider than the design")

    def test_cards_wrap_the_way_the_css_does(self):
        # flex: 1 1 220px inside the 800 / 640 / 440 layouts' inner width.
        self.assertEqual(kindle.cards_per_row(800 - 12), 3)
        self.assertEqual(kindle.cards_per_row(640 - 12), 2)
        self.assertEqual(kindle.cards_per_row(440 - 12), 1)

    def test_a_frame_that_will_not_fit_narrow_is_drawn_wider_not_cut(self):
        # Every alarm lit, upright: at 440 the stack runs off the bottom, so
        # the page is redrawn a step wider until it fits. The check is that
        # the last rows of pixels are white, which a cut-off card's border
        # would not leave.
        loud = json.loads(json.dumps(HEALTHY))
        loud["verdict"]["alarms"] = ["Campaign: SAVES FAILING, last good write 2h 0m ago",
                                     "Halloween is not responding", "host readings are 21m old",
                                     "undervoltage", "CPU at 79.2°C", "disk 93% full",
                                     "slate has restarted itself 2 times"]
        loud["host"] = {"at": 1, "cpu_c": 79.2, "load1": 1.0, "mem_total_mb": 908, "mem_used_mb": 200,
                        "disk_total_gb": 29.1, "disk_used_gb": 27.0, "disk_pct": 93,
                        "uploads_mb": 1, "uploads_files": 1, "uptime_s": 5, "undervoltage": True,
                        "restarts": 2}
        loud["verdict"]["host_age_s"] = 1300
        img = Image.open(io.BytesIO(kindle.render(loud, None, 0, 1236, 1648)))
        bottom = img.crop((0, img.height - 4, img.width, img.height))
        self.assertEqual(bottom.getextrema(), (255, 255), "nothing drawn on the last rows")

    def test_a_long_word_is_cut_rather_than_run_off_the_frame(self):
        fr = kindle.Frame(800, 480, kindle.Fonts())
        lines = fr.wrap("x" * 400, "regular", 14, 200)
        self.assertGreater(len(lines), 1)
        for line in lines:
            self.assertLessEqual(fr.width_of(line, "regular", 14) / fr.s, 200)


class Serving(unittest.TestCase):
    def setUp(self):
        self.calls = []
        real = kindle.fetch
        self.addCleanup(setattr, kindle, "fetch", real)
        self.answer = (HEALTHY, None)
        kindle.fetch = lambda url, key: self.answer
        cfg = {
            "status_url": "http://127.0.0.1:1/api/status",
            "status_key": "status-key",
            "token": "kindle-token",
            "addr": "127.0.0.1:0",
            "refresh_s": 300,
            "rotate": 90,
        }
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), kindle.make_handler(kindle.Display(cfg)))
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def kindle_asks(self, token="kindle-token"):
        return self.get(
            "/api/display",
            {"access-token": token, "png-width": "1648", "png-height": "1236", "ID": "AA:BB"},
        )

    def test_the_json_is_shaped_for_sed_not_for_a_parser(self):
        status, body = self.kindle_asks()
        self.assertEqual(status, 200)
        text = body.decode("utf-8")
        self.assertRegex(text, SED_IMAGE_URL)
        self.assertRegex(text, SED_REFRESH)
        self.assertRegex(text, SED_FILENAME)
        self.assertEqual(SED_REFRESH.match(text).group(1), "300")
        self.assertTrue(SED_FILENAME.match(text).group(1).endswith(".png"))
        self.assertNotIn(": ", text, "a space after a colon is a frame the Kindle never shows")
        json.loads(text)  # and it is still JSON

    def test_the_image_is_where_the_json_says_stood_on_its_side(self):
        # Asked for 1648x1236 (landscape) and served 1236x1648: the Kindle
        # blits into a portrait framebuffer and is stood on its side to read.
        _, body = self.kindle_asks()
        url = SED_IMAGE_URL.match(body.decode("utf-8")).group(1)
        self.assertTrue(url.startswith(self.base + "/display/"), url)
        status, png = self.get(url[len(self.base):])
        self.assertEqual(status, 200)
        self.assertEqual(png_size(png), (1236, 1648))

    def test_a_frame_is_drawn_landscape_and_only_then_turned(self):
        # Same pixels, turned — so the layout is the 800-wide one at 2.06x,
        # not a portrait reflow.
        flat = Image.open(io.BytesIO(kindle.render(HEALTHY, None, 0, 1648, 1236, now=0)))
        turned = Image.open(io.BytesIO(kindle.render(HEALTHY, None, 0, 1648, 1236, now=0, rotate=90)))
        self.assertEqual(turned.size, (1236, 1648))
        self.assertEqual(list(turned.rotate(-90, expand=True).getdata()), list(flat.getdata()))

    def test_a_wrong_token_is_refused_and_no_frame_is_drawn(self):
        status, _ = self.kindle_asks(token="nearly")
        self.assertEqual(status, 403)
        status, _ = self.get("/display/slate-anything.png")
        self.assertEqual(status, 404, "nothing has been rendered, so nothing is served")

    def test_each_frame_has_a_fresh_name_and_the_old_one_is_gone(self):
        # The image request carries no token, so the name is the credential:
        # random per render and good for one frame.
        _, first = self.kindle_asks()
        _, second = self.kindle_asks()
        a = SED_IMAGE_URL.match(first.decode("utf-8")).group(1)
        b = SED_IMAGE_URL.match(second.decode("utf-8")).group(1)
        self.assertNotEqual(a, b)
        self.assertEqual(self.get(a[len(self.base):])[0], 404)
        self.assertEqual(self.get(b[len(self.base):])[0], 200)

    def test_a_server_that_has_gone_is_drawn_as_gone_not_left_as_it_was(self):
        self.kindle_asks()
        self.answer = (None, "no answer from the server")
        status, body = self.kindle_asks()
        self.assertEqual(status, 200, "the Kindle still gets a frame")
        url = SED_IMAGE_URL.match(body.decode("utf-8")).group(1)
        status, png = self.get(url[len(self.base):])
        self.assertEqual(status, 200)
        # Different from the healthy frame at the same size: the verdict
        # inverted and the UNREACHABLE panel drawn. Compared rather than
        # read, because a test that OCRs a PNG is a test of the font.
        healthy = kindle.render(HEALTHY, None, 0, 1648, 1236)
        self.assertNotEqual(png, healthy)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    unittest.main(verbosity=2)
