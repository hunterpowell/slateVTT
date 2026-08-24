// What is in `uploads/`, and what the room still points at.
//
// Nothing ever deletes one, so the directory only grows — a map is capped at
// 25 MB and the Pi backs the whole folder up.
//
// **It grows more slowly than it used to.** There were direct uploads once, each
// landing under a fresh UUID, so re-uploading the same battle map five times
// kept five copies. Milestone 32 made the upload button add to the library
// instead, and everything in here is now a *pick* — fingerprinted, so one file
// however many times it is picked. What still accumulates is a copy per distinct
// library file ever picked, and a file whose library original the DM has since
// removed, which is deliberate: the board goes on being served (see
// `docs/maps.md`).
//
// **This deletes nothing and takes no arguments that could make it.** It reads
// the save file and the directory and prints what it found; removing anything is
// the DM's own `rm`, with the list in front of them. A reaper inside the room
// actor is the thing not being built here: the room would have to know about the
// filesystem, and the one case it cannot see — a file referenced only by a
// calibration the DM may still want — is exactly the case that matters.
//
//   node tools/audit-uploads.mjs [state.json] [uploads/]
//
// Defaults match the server's own: `SLATE_STATE` or `server/slate-state.json`,
// and `server/uploads`.
//
// **It reads every room's save, not only the one it was pointed at.** The
// libraries and the uploads directory are shared between rooms and the boards
// are not, so a portrait on a one-shot token is referenced by a file the
// campaign's save has never heard of. Reading one room alone would print an `rm`
// for every other room's art.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath =
  process.argv[2] ?? process.env.SLATE_STATE ?? join(ROOT, 'server', 'slate-state.json');
const uploadsDir = process.argv[3] ?? join(ROOT, 'server', 'uploads');

/**
 * Every room's save file, not just the one named.
 *
 * **The libraries are shared and the boards are not**, so a portrait on a
 * one-shot token is referenced by a save file the campaign's has never heard of
 * — and reading one room alone would list every other room's art as
 * unreferenced and print an `rm` for it. That is the one way this tool could do
 * damage, so it reads all of them.
 *
 * Every `.json` beside the primary save *is* a room save, which is the sibling
 * rule from `docs/rooms.md` read backwards. It cannot ask the server for the
 * list, because this runs with the service stopped — which is when the `rm`s
 * below are safe. A `.tmp` is a write in progress and is not matched.
 */
const saveFiles = () => {
  const dir = dirname(statePath) || '.';
  // Resolved before comparing, or the primary is read twice: the path we were
  // handed may use one separator and `join` produces the platform's.
  const primary = resolve(statePath);
  try {
    const siblings = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => resolve(dir, name))
      .filter((path) => path !== primary);
    return [primary, ...siblings];
  } catch {
    // No directory to scan — fall back to the one path we were given.
    return [primary];
  }
};

const rooms = [];
for (const path of saveFiles()) {
  try {
    rooms.push({ path, saved: JSON.parse(readFileSync(path, 'utf8')) });
  } catch (err) {
    if (path === resolve(statePath)) {
      console.error(`could not read the save file at ${path}: ${err.message}`);
      process.exit(1);
    }
    // A sibling that is not a room, or is half-written. It means the list below
    // may be missing references, so it is said out loud rather than skipped
    // quietly.
    console.error(`warning: ignoring ${path}: ${err.message}`);
  }
}

/** `/uploads/abc.png` is the only shape the room stores; anything else — a
 *  built-in asset, an empty string on an art-less token — is not ours. */
const fileOf = (url) =>
  typeof url === 'string' && url.startsWith('/uploads/') ? url.slice('/uploads/'.length) : null;

// **Unions across every room**, which is the only safe way to fold them: a file
// in use in one room and unreferenced in another is in use. `remembered` is
// filtered against `inUse` afterwards rather than as it is built, so a map on
// the campaign's board that the one-shot has merely calibrated does not come out
// as merely remembered.
const inUse = new Set();
const calibrated = new Set();

for (const { saved } of rooms) {
  // What that board is actually showing. `staged` is `#[serde(flatten)]`ed, so
  // its map fields sit directly on it rather than under a `map` key.
  for (const url of [saved.map?.url, saved.staged?.url]) {
    const name = fileOf(url);
    if (name) inUse.add(name);
  }
  // One token collection and not two: a token planned for the staged board is
  // the same token with a `staged_pos` on it, so its art is already counted.
  for (const token of saved.tokens ?? []) {
    const name = fileOf(token.img);
    if (name) inUse.add(name);
  }
  // Every map the DM has ever calibrated keeps an entry keyed on its URL, so
  // this is the pile that grows: art nothing is showing, that the room would
  // still recognise if it were loaded again.
  for (const url of Object.keys(saved.calibrations ?? {})) {
    const name = fileOf(url);
    if (name) calibrated.add(name);
  }
}

const remembered = new Set([...calibrated].filter((name) => !inUse.has(name)));

let files;
try {
  files = readdirSync(uploadsDir);
} catch (err) {
  console.error(`could not read the uploads directory at ${uploadsDir}: ${err.message}`);
  process.exit(1);
}

const DAY = 24 * 60 * 60 * 1000;
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const rows = files.map((name) => {
  const info = statSync(join(uploadsDir, name));
  return {
    name,
    bytes: info.size,
    days: Math.floor((Date.now() - info.mtimeMs) / DAY),
    kind: inUse.has(name) ? 'in use' : remembered.has(name) ? 'remembered' : 'unreferenced',
  };
});

const total = rows.reduce((sum, r) => sum + r.bytes, 0);
const group = (kind) => rows.filter((r) => r.kind === kind).sort((a, b) => b.bytes - a.bytes);

console.log(`${uploadsDir}`);
console.log(
  `against ${rooms.length} room${rooms.length === 1 ? '' : 's'}: ${rooms.map((r) => r.path).join(', ')}`,
);
console.log(`${rows.length} files, ${mb(total)} total\n`);

for (const [kind, blurb] of [
  ['in use', 'the live board, the staged one, or a token'],
  ['remembered', 'not shown, but the DM has calibrated it — loading it again keeps the grid'],
  ['unreferenced', 'nothing in the room points at these'],
]) {
  const found = group(kind);
  const bytes = found.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`${kind} — ${found.length} files, ${mb(bytes)}`);
  console.log(`  ${blurb}`);
  for (const r of found) {
    console.log(`  ${mb(r.bytes).padStart(8)}  ${String(r.days).padStart(4)}d  ${r.name}`);
  }
  console.log();
}

const dead = group('unreferenced');
if (dead.length > 0) {
  const bytes = dead.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`${mb(bytes)} is unreferenced. To remove it, with the server stopped:\n`);
  for (const r of dead) console.log(`  rm ${join(uploadsDir, r.name)}`);
  console.log('\nCheck the list first — a file uploaded since this save was written');
  console.log('is unreferenced only because the room has not been persisted yet.');
}
