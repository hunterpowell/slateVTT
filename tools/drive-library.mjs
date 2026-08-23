// Drives the DM adding an image to a library and taking it back out again.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-library.mjs                  # or: ... http://host:port secret
//
// It runs against a live room and **writes to the server's disk** — it adds one
// file to `portraits/` and one to `backdrops/`, and removes both again at the
// end. Point it at a checkout you do not mind it touching. Nothing it adds
// survives a passing run; a run that dies partway leaves a file called
// `slate-driver-probe.png` in one of those folders, which is safe to delete and
// which the next run will refuse to add over.
//
// **One browser, unlike the drivers either side of it.** Everything here is the
// DM's own panel talking to `/api`, and nothing it does is visible to a player
// at all until the DM picks something — so a second session would be watching a
// board that is deliberately never touched. The room is not the subject: this is
// the one driver whose subject is the filesystem.
//
// What only a browser can see, and the reason this exists rather than another
// Rust test: the widget is shared by three panels that build it three different
// ways, the file input is a real `<input type="file">` that no unit test can put
// a file into, and a removal is a `window.confirm` away from doing nothing at
// all. The server's half — what a name may be, what a traversal does — is in
// `library::tests`, where it can be asserted directly.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?dm=${secret}`);
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const openTab = (session, name) =>
  session.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);

const text = (session, sel) => session.evaluate(`document.querySelector("${sel}").textContent`);
const hidden = (session, sel) => session.evaluate(`document.querySelector("${sel}").hidden`);

/** The smallest thing the server will agree is a PNG: one transparent pixel. */
const PROBE = 'slate-driver-probe.png';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Puts a file into a real `<input type="file">` and lets the page notice.
 *
 * `input.files` is read-only to assignment of anything but a `FileList`, and a
 * `DataTransfer` is the only way to make one — which is exactly what a drop or a
 * file dialog hands over, so this is the same path a DM's click takes. Going
 * through the input rather than calling `fetch` from the driver is the whole
 * point: what is being tested is the widget, not the endpoint.
 */
const chooseFile = (session, inputSel, name) =>
  session.evaluate(`(() => {
    const raw = atob('${PNG}');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], '${name}', { type: 'image/png' }));
    const input = document.querySelector('${inputSel}');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return 'ok';
  })()`);

/** Opens a library list and waits for the fetch behind it. */
const openList = async (session, buttonSel) => {
  await session.evaluate(`document.querySelector("${buttonSel}").click(); "ok"`);
  await session.wait(1200);
};

/** What the open list is offering, by the full path on each row's tooltip. */
const listed = (session, listSel) =>
  session.evaluate(`[...document.querySelectorAll('${listSel} .map-library-pick')]
    .map(b => b.title)`);

/** Clicks the remove on the row for one path. Confirm is stubbed to true. */
const removeRow = async (session, listSel, path) => {
  const clicked = await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('${listSel} .map-library-row')]
      .find(r => r.querySelector('.map-library-pick').title === ${JSON.stringify(path)});
    if (row === undefined) return 'no such row';
    row.querySelector('.map-library-remove').click();
    return 'ok';
  })()`);
  await session.wait(1200);
  return clicked;
};

// --- the portrait library, which is the one that costs the room nothing -----
//
// Deliberately not the maps. A pick out of the map library lands on the board
// for everybody, and the file this adds is one pixel across — every driver that
// runs after this one measures the grid off the map that is loaded. Picking a
// portrait only fills in the token panel's form, which nothing has saved.

await openTab(dm, 'token');
await openList(dm, '#token-library');

const before = await listed(dm, '#token-library-list');
note(`the portrait library holds ${before.length}: ${before.join(', ')}`);
check('the library lists what is in the folder', before.length > 0, true);
check(
  'and every row offers a way to remove it',
  await dm.evaluate(`document.querySelectorAll('#token-library-list .map-library-row').length
    === document.querySelectorAll('#token-library-list .map-library-remove').length`),
  true,
);
check('the probe is not already there', before.includes(PROBE), false);

// --- adding ------------------------------------------------------------------

await chooseFile(dm, '#token-art', PROBE);
await dm.wait(1500);

// The upload button is the library's now, so this is the assertion that the
// bytes went into the folder rather than into `uploads/` under a UUID.
await openList(dm, '#token-library'); // closed by the add? no — reopened to re-read
const afterAdd = await listed(dm, '#token-library-list');
note(`after adding, the library holds ${afterAdd.length}`);
check('the file the DM chose is in the library', afterAdd.includes(PROBE), true);
check('and nothing else moved', afterAdd.length, before.length + 1);

// An add is still a pick: the panel is holding the art, exactly as it would be
// if the DM had picked the file off the list.
check(
  'the token panel is holding the art it just added',
  await hidden(dm, '#token-art-clear'),
  false,
);
check(
  'and it is being served out of the uploads directory like any other',
  await dm.evaluate(`document.querySelector('#token-art-preview').style.backgroundImage
    .includes('/uploads/')`),
  true,
);

// --- adding it twice ---------------------------------------------------------
//
// Refused rather than overwritten, and the DM is told why. Silently replacing a
// file is the one outcome here that cannot be undone.

await chooseFile(dm, '#token-art', PROBE);
await dm.wait(1500);
const complaint = await text(dm, '#banner');
note(`the second add said: ${complaint}`);
check('a name already taken is refused', complaint.includes('already'), true);

await openList(dm, '#token-library');
check(
  'and the library still holds one of it',
  (await listed(dm, '#token-library-list')).filter((p) => p === PROBE).length,
  1,
);

// --- removing ----------------------------------------------------------------

check(
  'the remove found its row',
  await removeRow(dm, '#token-library-list', PROBE),
  'ok',
);

const afterRemove = await listed(dm, '#token-library-list');
note(`after removing, the library holds ${afterRemove.length}`);
check('the file is out of the library', afterRemove.includes(PROBE), false);
check('and the rest of the folder is untouched', afterRemove.length, before.length);

// The half of the promise that is about not breaking the room: what was copied
// out of the library is still there, so a token wearing that art still has it.
check(
  'the copy already in use is not deleted with it',
  await dm.evaluate(`(async () => {
    const url = document.querySelector('#token-art-preview').style.backgroundImage
      .replace(/^url\\("?/, '').replace(/"?\\)$/, '');
    const res = await fetch(url, { method: 'GET' });
    return res.ok;
  })()`),
  true,
);

// --- the third panel, which had no upload of its own until now ---------------

await openTab(dm, 'table');
check(
  'the table panel can add a backdrop now',
  await text(dm, '#table-backdrop-upload-text'),
  'upload a backdrop…',
);

await chooseFile(dm, '#table-backdrop-file', PROBE);
await dm.wait(1500);

// A backdrop pick is the one of the three that reaches the room, so this is
// also the check that an add is a pick all the way through.
check(
  'and adding one puts it in front of the table',
  await dm.evaluate('document.body.classList.contains("covered")'),
  true,
);

await dm.evaluate('document.querySelector("#table-backdrop-clear").click(); "ok"');
await dm.wait(600);
check(
  'the board comes back when it is taken down',
  await dm.evaluate('document.body.classList.contains("covered")'),
  false,
);

// --- put the folder back -----------------------------------------------------
//
// The room needed nothing put back — the backdrop is down and the token was
// never saved — but the disk does. Both probes go, and the check below is what
// makes a re-run of this script mean the same thing as the first run.

await openList(dm, '#table-backdrop');
await removeRow(dm, '#table-backdrop-list', PROBE);
check(
  'the backdrop probe is cleaned up',
  (await listed(dm, '#table-backdrop-list')).includes(PROBE),
  false,
);

// --- and the panel that shares the widget without being touched here ---------

await openTab(dm, 'map');
await openList(dm, '#map-library');
check(
  'the map library got the same rows without being asked',
  await dm.evaluate(`document.querySelectorAll('#map-library-list .map-library-remove').length > 0`),
  true,
);
check(
  'and its upload button is still where the DM left it',
  await text(dm, '#map-upload-text'),
  'upload image…',
);

dm.close();
process.exit(verdict(dm) === 0 ? 0 : 1);
