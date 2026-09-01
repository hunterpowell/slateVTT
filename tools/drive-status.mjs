// The status page: the three states it can be in, and the one thing only a
// browser can see — that it fits the display it is going to.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATUS_KEY=test-status \
//     SLATE_STATE=scratch.json cargo run
//   node tools/drive-status.mjs        # or: ... http://host:port secret statuskey
//
// **`SLATE_STATUS_KEY` is required** — without it the route is not mounted and
// every check here fails on a 404, which is the feature working rather than the
// driver being broken. `SLATE_HOST_STATUS` and `SLATE_BUILD_INFO` are *not*:
// each names a file written by something outside this repo, so the two sections
// they feed have a legitimate empty state, and the checks below assert whichever
// one they find rather than demanding the furnished one.
//
// It opens two: the page cannot show a name in `here` unless somebody is
// actually connected, and one browser cannot be both. The second session is a
// DM on the board, which is also what proves the status key and the DM secret
// are separate credentials reaching the same server.
//
// It reads and does not write, so it leaves the room as it found it.

import { open, checks } from './cdp.mjs';

const [
  ,
  ,
  base = 'http://127.0.0.1:3000',
  secret = 'test-secret',
  key = 'test-status',
] = process.argv;

const { check, note, verdict } = checks();

const text = (session, sel) =>
  session.evaluate(
    `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`,
  );

// TRMNL's panel is 800x480. If the page scrolls sideways there, it is broken
// on the hardware this was designed for and nothing else would have told us.
const fits = (session) =>
  session.evaluate('document.documentElement.scrollWidth <= window.innerWidth');

// --- no key, and a wrong one --------------------------------------------

const blank = await open(`${base}/status/`, { port: 9336, width: 800, height: 480 });
await blank.wait(600);
check('a page opened with no key says so', (await text(blank, '.down .big')).trim(), 'NO KEY');
check('and does not poll for one', await text(blank, '.card'), '');

await blank.evaluate(`location.href = ${JSON.stringify(`${base}/status/?key=wrong`)}; "go"`);
await blank.wait(1500);
check('a refused key reads as unreachable', (await text(blank, '.down .big')).trim(), 'UNREACHABLE');
check(
  'and says which of the two failures it was',
  (await text(blank, '.down .why')).includes('refused'),
  true,
);
await blank.close();

// --- the real thing ------------------------------------------------------

const page = await open(`${base}/status/?key=${key}&every=5`, {
  port: 9336,
  width: 800,
  height: 480,
});
await page.wait(1500);

check('the bar is drawn', (await text(page, '.bar h1')).trim(), 'Slate');
check('with no unreachable panel over it', await text(page, '.down .big'), '');
check('it fits an 800x480 panel', await fits(page), true);

const rooms = await page.evaluate(
  '[...document.querySelectorAll(".card table tbody tr .name")].map(e => e.textContent)',
);
check('every room has a row', rooms.length >= 2, true);
check('named as the picker names them', rooms.some((r) => r.includes('Campaign')), true);

const cards = await text(page, '.grid');

if (cards.includes('No collector')) {
  // The ordinary case for a driver run: no SLATE_HOST_STATUS, so there is no
  // host section to judge. That must read as calm, not as a fault — a server
  // without a collector is not a server in trouble.
  note('no host collector on this server; driving the calm case');
  check('a missing collector is not an alarm', (await text(page, '.verdict')).trim(), 'OK');
  check('and says so plainly', cards.includes('No collector on this machine'), true);
} else {
  // A furnished run. The repo's fixture is stamped far in the past, so the
  // staleness alarm is the one that fires — and it is the alarm worth driving:
  // a collector that has died leaves a file that still parses, and age is the
  // only thing that catches it.
  check('a stale host reading raises the alarm', (await text(page, '.verdict')).trim(), 'ATTENTION');
  check('and names it rather than just glowing', (await text(page, '.alarms')).includes('old'), true);
}

if (cards.includes('No build stamp')) {
  note('no build stamp on this server; that section is empty by design');
} else {
  check('the build stamp is shown', cards.includes('sha'), true);
}

// --- somebody connects ---------------------------------------------------

const empty = await text(page, '.card table tbody');
check('nobody is in the room yet', empty.includes('empty'), true);
// Not inverted, and that is the assertion: an alarm on the ordinary case is one
// you learn to ignore, so only a *failing* write is allowed to shout.
check(
  'a room with nothing pending reads as saved',
  empty.includes('FAILING'),
  false,
);

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9337 });
await dm.wait(2500);
note('a DM joined the campaign');

// Long enough for one poll at ?every=5 to have gone round.
await page.wait(6500);
check(
  'the status page notices without being reloaded',
  (await text(page, '.card table tbody')).includes('DM'),
  true,
);

check('a taller portrait display also fits', await fits(page), true);

await dm.close();
await page.close();

verdict(page);
