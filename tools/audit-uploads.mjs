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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath =
  process.argv[2] ?? process.env.SLATE_STATE ?? join(ROOT, 'server', 'slate-state.json');
const uploadsDir = process.argv[3] ?? join(ROOT, 'server', 'uploads');

let saved;
try {
  saved = JSON.parse(readFileSync(statePath, 'utf8'));
} catch (err) {
  console.error(`could not read the save file at ${statePath}: ${err.message}`);
  process.exit(1);
}

/** `/uploads/abc.png` is the only shape the room stores; anything else — a
 *  built-in asset, an empty string on an art-less token — is not ours. */
const fileOf = (url) =>
  typeof url === 'string' && url.startsWith('/uploads/') ? url.slice('/uploads/'.length) : null;

// What the board is actually showing. `staged` is `#[serde(flatten)]`ed, so its
// map fields sit directly on it rather than under a `map` key.
const inUse = new Set();
for (const url of [saved.map?.url, saved.staged?.url]) {
  const name = fileOf(url);
  if (name) inUse.add(name);
}
// One token collection and not two: a token planned for the staged board is the
// same token with a `staged_pos` on it, so its art is already counted here.
for (const token of saved.tokens ?? []) {
  const name = fileOf(token.img);
  if (name) inUse.add(name);
}

// Every map the DM has ever calibrated keeps an entry keyed on its URL, so this
// is the pile that grows: art nothing is showing, that the room would still
// recognise if it were loaded again.
const remembered = new Set();
for (const url of Object.keys(saved.calibrations ?? {})) {
  const name = fileOf(url);
  if (name && !inUse.has(name)) remembered.add(name);
}

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
