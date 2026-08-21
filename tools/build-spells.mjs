// Turns the SRD 5.1 spell dump into the index that `/spells/` reads.
//
// The page at `client/spells/` is **not part of Slate** — it shares no code with
// the client, has no entry in esbuild's build, and touches nothing on the wire.
// It is an index into books the table already owns: a physical book is excellent
// at "read me Fireball" and miserable at "what 2nd-level bard spells are a bonus
// action and don't eat concentration", and the second question is this whole
// feature. See `client/spells/spells.js`.
//
// **The output is committed.** `srd.json` is generated but lives in git, so the
// page works with no build step and no network, and so a Pi that has never run
// node can serve it. Re-running this must produce no diff unless upstream moved.
//
// **Every mapping below throws on an input it does not recognise.** A silent
// default is the same class of bug as a filter over an incomplete field: it
// produces a confident wrong answer that nobody notices at the table. If
// upstream adds a casting time, this script stops and says so.
//
//   node tools/build-spells.mjs [--from <file>]
//
// `--from` reads a local copy instead of fetching, for working offline.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vocab from '../client/spells/vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'client', 'spells', 'srd.json');

const SOURCE =
  'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en/5e-SRD-Spells.json';

/** Every casting time in SRD 5.1, and what the query language calls it. */
const TIMES = {
  '1 action': 'action',
  '1 bonus action': 'bonus',
  '1 reaction': 'reaction',
  '1 minute': '1min',
  '10 minutes': '10min',
  '1 hour': '1hr',
  '8 hours': '8hr',
  '12 hours': '12hr',
  '24 hours': '24hr',
};

/** Ranges that are a word rather than a distance. */
const RANGE_WORDS = {
  Self: 'self',
  Touch: 'touch',
  Sight: 'sight',
  Unlimited: 'unlimited',
  Special: 'special',
};

/**
 * The two spells whose damage the SRD carries without a `damage_type`.
 *
 * They cannot be normalised by rule, and the tempting default — an empty array —
 * would be a *recorded fact* meaning "this spell deals no damage", which is true
 * of one of them and badly false of the other. Prismatic Spray would then be
 * absent from every damage query at the table. So they are named here, and the
 * `damage_type`-less case throws for anything not on this list.
 */
const DAMAGE_EXCEPTIONS = {
  // Eight rays; five of them deal damage and the SRD has nowhere to put a list.
  'Prismatic Spray': ['fire', 'acid', 'lightning', 'poison', 'cold'],
  // Carries `damage_at_slot_level` describing hit points *affected*, not dealt.
  Sleep: [],
};

/**
 * The names the PHB prints, for the spells SRD 5.1 had to strip a wizard off.
 *
 * These are not decoration. The spell is *present* under the stripped name, so
 * without these a player typing "bigby" or "tasha" gets nothing back — which
 * reads as "this tool does not have it" rather than "look under Arcane Hand".
 * Every key is asserted to exist below, so a rename upstream fails the build
 * instead of quietly dropping an alias.
 */
const ALIASES = {
  'Arcane Hand': ["Bigby's Hand"],
  'Arcane Sword': ["Mordenkainen's Sword"],
  "Arcanist's Magic Aura": ["Nystul's Magic Aura"],
  'Acid Arrow': ["Melf's Acid Arrow"],
  'Black Tentacles': ["Evard's Black Tentacles"],
  'Faithful Hound': ["Mordenkainen's Faithful Hound"],
  'Floating Disk': ["Tenser's Floating Disk"],
  'Freezing Sphere': ["Otiluke's Freezing Sphere"],
  'Hideous Laughter': ["Tasha's Hideous Laughter"],
  'Instant Summons': ["Drawmij's Instant Summons"],
  'Irresistible Dance': ["Otto's Irresistible Dance"],
  'Magnificent Mansion': ["Mordenkainen's Magnificent Mansion"],
  'Private Sanctum': ["Mordenkainen's Private Sanctum"],
  'Resilient Sphere': ["Otiluke's Resilient Sphere"],
  'Secret Chest': ["Leomund's Secret Chest"],
  'Telepathic Bond': ["Rary's Telepathic Bond"],
  'Tiny Hut': ["Leomund's Tiny Hut"],
};

const fail = (spell, what) => {
  throw new Error(`${spell}: unrecognised ${what} — upstream changed, update tools/build-spells.mjs`);
};

/** "60 feet" and "1 mile" both become feet, so one comparison orders them. */
function range(spell) {
  const raw = spell.range;
  if (RANGE_WORDS[raw]) return { kind: RANGE_WORDS[raw], feet: null };
  const m = /^(\d+) (feet|mile|miles)$/.exec(raw);
  if (!m) fail(spell.name, `range ${JSON.stringify(raw)}`);
  const n = Number(m[1]);
  return { kind: 'ranged', feet: m[2] === 'feet' ? n : n * 5280 };
}

function damage(spell) {
  if (!spell.damage) return [];
  const type = spell.damage.damage_type?.index;
  if (type) return [type];
  const known = DAMAGE_EXCEPTIONS[spell.name];
  if (known === undefined) fail(spell.name, 'damage without a damage_type');
  return known;
}

function components(spell) {
  const joined = (spell.components ?? []).join('');
  if (!/^V?S?M?$/.test(joined)) fail(spell.name, `components ${JSON.stringify(joined)}`);
  return joined;
}

function convert(spell) {
  const time = TIMES[spell.casting_time];
  if (!time) fail(spell.name, `casting time ${JSON.stringify(spell.casting_time)}`);

  return {
    name: spell.name,
    level: spell.level,
    school: spell.school.index,
    classes: spell.classes.map((c) => c.index).sort(),
    time,
    // SRD 5.1 prints reactions as a bare "1 reaction" with the trigger buried in
    // the prose, so there is never one to lift. Hand-typed entries carry theirs.
    trigger: null,
    range: range(spell),
    components: components(spell),
    material: spell.material ?? null,
    duration: spell.duration,
    conc: spell.concentration,
    ritual: spell.ritual,
    // The SRD does not carry page numbers, so this is the one header fact it
    // cannot supply. Nothing filters on it; the row simply omits the page.
    src: { book: 'PHB', page: null },
    save: spell.dc?.dc_type?.index ?? null,
    attack: spell.attack_type ?? null,
    damage: damage(spell),
    area: spell.area_of_effect ?? null,
    text: spell.desc,
    higher: spell.higher_level ?? null,
    // The PHB name, where the SRD renamed the spell. Searched, and shown beside
    // the name so it is obvious the two are one spell.
    alias: ALIASES[spell.name] ?? null,
    // Wizards of the Coast wrote it; nobody here needs to check it against a book.
    verified: true,
  };
}

const fromFlag = process.argv.indexOf('--from');
const raw =
  fromFlag === -1
    ? await fetch(SOURCE).then((r) => {
        if (!r.ok) throw new Error(`${SOURCE} answered ${r.status}`);
        return r.text();
      })
    : readFileSync(process.argv[fromFlag + 1], 'utf8');

const spells = JSON.parse(raw).map(convert);
spells.sort((a, b) => a.name.localeCompare(b.name));

// The mappings above name their own output strings, so they are a second place
// the vocabulary could drift from `vocab.js`. Assert rather than trust: a slug
// this file invents that the page has never heard of is a filter that silently
// matches nothing.
for (const [field, allowed] of [
  ['school', vocab.SCHOOLS],
  ['time', vocab.TIMES],
  ['save', vocab.SAVES],
  ['attack', vocab.ATTACKS],
]) {
  for (const s of spells) {
    if (s[field] !== null && !allowed.includes(s[field])) fail(s.name, `${field} slug "${s[field]}"`);
  }
}
// An alias keyed on a name that no longer exists is an alias nobody will ever
// reach, and upstream renaming a spell is exactly how that would happen.
const produced = new Set(spells.map((s) => s.name));
for (const name of Object.keys(ALIASES)) {
  if (!produced.has(name)) fail(name, 'alias target — no spell of that name was produced');
}

for (const s of spells) {
  for (const c of s.classes) if (!vocab.CLASSES.includes(c)) fail(s.name, `class "${c}"`);
  for (const d of s.damage) if (!vocab.DAMAGE.includes(d)) fail(s.name, `damage type "${d}"`);
  if (!vocab.RANGE_KINDS.includes(s.range.kind)) fail(s.name, `range kind "${s.range.kind}"`);
  if (s.area && !vocab.AREAS.includes(s.area.type)) fail(s.name, `area type "${s.area.type}"`);
}

// Two spaces and a trailing newline so a regeneration diffs line by line rather
// than as one changed 600 KB line.
writeFileSync(OUT, `${JSON.stringify(spells, null, 2)}\n`);

const bytes = readFileSync(OUT).length;
console.log(`${spells.length} spells -> client/spells/srd.json (${(bytes / 1024).toFixed(0)} KB)`);
