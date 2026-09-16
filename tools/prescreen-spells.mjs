// A checklist for verifying `extra.json` against the books, with the prose
// cross-checked first so the eye knows where to slow down.
//
// `verified: true` means somebody read the entry off the page, and nothing here
// earns it — this is the pass *before* that one. Every entry is printed in the
// order the book prints them (by book, then name), with the header block in the
// book's own order so the row reads against the page top to bottom. Under any
// entry whose tier-B fields disagree with what its own prose says, the
// disagreement is printed indented. Some of those are the conventions in
// `client/spells/README.md` working as intended; what is left is where a typo
// would be.
//
// Needs `text.json`, which is gitignored — without it there is no prose to
// check against and only the checklist prints.
//
//   node tools/prescreen-spells.mjs            # everything
//   node tools/prescreen-spells.mjs XGE        # one book
//   node tools/prescreen-spells.mjs --flagged  # only entries with a disagreement

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOOKS, DAMAGE, TIER_B } from '../client/spells/vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = (f) => join(ROOT, 'client', 'spells', f);
const read = (f) => JSON.parse(readFileSync(path(f), 'utf8'));

const args = process.argv.slice(2);
const onlyFlagged = args.includes('--flagged');
const onlyBook = args.find((a) => !a.startsWith('--'))?.toUpperCase();
if (onlyBook && !(onlyBook in BOOKS)) {
  console.error(`no book "${onlyBook}" — one of ${Object.keys(BOOKS).join(', ')}`);
  process.exit(1);
}
for (const a of args) {
  if (a.startsWith('--') && a !== '--flagged') {
    console.error(`unknown flag ${a} — only --flagged`);
    process.exit(1);
  }
}

const extra = read('extra.json');
const text = existsSync(path('text.json')) ? read('text.json') : null;
if (!text) console.error('no text.json — printing the checklist without the prose check\n');

const ABILITY = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const ABILITIES = '(?:strength|dexterity|constitution|intelligence|wisdom|charisma)';
const TYPE = '(?:acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder)';
/** One or more of the given words as the books list them: "acid, cold, or fire". */
const listOf = (word) => `(?:${word}(?:,\\s*)?(?:\\s*(?:or|and)\\s*)?)+`;

/** "acid, cold, or fire damage" — the types, then the word. */
const DAMAGE_DEALT = new RegExp(`\\b(${listOf(TYPE)}) damage\\b`, 'gi');
/** "choose acid, cold, fire, or thunder" — three or more types is a menu even without the word. */
const DAMAGE_MENU = new RegExp(`\\b(${TYPE},\\s*${TYPE}(?:,\\s*${TYPE})*,?\\s*(?:or|and)\\s*${TYPE})\\b`, 'gi');
/** Not damage dealt, by the README's convention — struck out before the scan. */
const NOT_DEALT = new RegExp(
  `(?:resistan\\w*|immun\\w*|vulnerab\\w*)(?: to| against)? (?:all damage except )?${listOf(TYPE)} damage`
    + `(?:\\s*\\([^)]*\\)\\s*or\\s*${listOf(TYPE)} damage)?`, // "(Lower Planes) or radiant and necrotic damage"
  'gi',
);
/** A save the target does not make: advantage on it, proficiency in it. */
const NOT_FORCED = new RegExp(
  `(?:advantage on|proficien\\w+ (?:in|with)|bonus to) ${listOf(ABILITIES)} saving throws?`
    + `|make ${listOf(ABILITIES)} saving throws? with advantage`,
  'gi',
);
const SAVE = new RegExp(`\\b(${ABILITIES}) saving throw`, 'gi');
const AREA = /(\d+)-foot(?:-radius)?(?:,? \d+-foot-(?:high|tall|long))? (cone|cube|cylinder|line|sphere|radius|square)/gi;
const TABLE_TYPE = new RegExp(`\\b${TYPE}\\b`, 'gi');

/** A summoned creature's stat block is the creature's, not the spell's. */
const summoned = (name) => name.startsWith('Summon ') || name === 'Tiny Servant';

const words = (s) => s.toLowerCase().split(/,?\s*\b(?:or|and)\b\s*|,\s*/).filter(Boolean);

/** What the prose says about the four tier-B fields, as crude regexes over it. */
function fromProse(entry) {
  const t = text?.[entry.name];
  if (!t) return null;
  // The trigger is header, not prose, but Absorb Elements names its types nowhere else.
  const lines = [...t.text, ...(t.higher ?? []), entry.trigger ?? ''];
  const prose = lines.join(' ').replace(NOT_DEALT, ' ').replace(NOT_FORCED, ' ');

  const damage = new Set();
  for (const re of [DAMAGE_DEALT, DAMAGE_MENU]) {
    for (const m of prose.matchAll(re)) for (const d of words(m[1])) damage.add(d);
  }
  // Chaos Bolt's table lists its types bare, one per row.
  for (const row of lines) {
    if (!/^\d+ \| /.test(row)) continue;
    for (const m of row.matchAll(TABLE_TYPE)) damage.add(m[0].toLowerCase());
  }
  if (/damage of the weapon's type|damage type is the same as that of the (?:\w+ or )?weapon/i.test(prose)) damage.add('weapon');

  const saves = new Set();
  for (const m of prose.matchAll(SAVE)) saves.add(ABILITY[m[1].toLowerCase()]);

  const attacks = new Set();
  for (const m of prose.matchAll(/\b(melee|ranged) spell attack/gi)) attacks.add(m[1].toLowerCase());
  const weaponAttack = /weapon attack/i.test(prose);

  const areas = new Set();
  for (const m of prose.matchAll(AREA)) {
    const type = { radius: 'sphere', square: 'cube' }[m[2].toLowerCase()] ?? m[2].toLowerCase();
    areas.add(`${type} ${m[1]}`);
  }

  return { damage, saves, attacks, weaponAttack, areas };
}

const list = (s) => (s.size ? [...s].sort().join(', ') : 'none');

/** Every way the entry disagrees with its prose, in words. */
function disagreements(entry, p) {
  const out = [];
  // A key left out means "nobody has typed this yet" — see the README. That is
  // the thing the pass exists to fill, so it is a flag whatever the prose says.
  for (const field of TIER_B) {
    if (entry[field] === undefined) out.push(`${field.padEnd(8)} not recorded`);
  }
  if (!p || summoned(entry.name)) return out;

  const recorded = new Set(entry.damage ?? []);
  const missing = [...p.damage].filter((d) => !recorded.has(d));
  const surplus = [...recorded].filter((d) => !p.damage.has(d));
  if (entry.damage !== undefined && (missing.length || surplus.length)) {
    out.push(`damage   recorded ${list(recorded)}; prose names ${list(p.damage)}`);
  }

  if (entry.save === undefined) { /* flagged above */ }
  else if (entry.save === null && p.saves.size) out.push(`save     recorded none; prose has ${list(p.saves)} saving throw`);
  else if (entry.save !== null && !p.saves.has(entry.save)) out.push(`save     recorded ${entry.save}; prose has ${list(p.saves)}`);
  else if (p.saves.size > 1) out.push(`save     recorded ${entry.save}; prose forces ${list(p.saves)} (one is recorded on purpose — check it is the damage one)`);

  if (entry.attack === undefined) { /* flagged above */ }
  else if (entry.attack === null && p.attacks.size) out.push(`attack   recorded none; prose has a ${list(p.attacks)} spell attack`);
  else if (entry.attack !== null && !p.attacks.has(entry.attack)) {
    out.push(`attack   recorded ${entry.attack}; prose has ${p.attacks.size ? list(p.attacks) + ' spell attack' : p.weaponAttack ? 'a weapon attack (should be null)' : 'no spell attack'}`);
  }

  // An area the header stated (Self, 15-foot cone) is rarely restated in the
  // prose, so silence on the prose's side is not a disagreement. A shape the
  // prose names and the entry lacks is — the importer only ever read the header.
  const area = entry.area ? `${entry.area.type} ${entry.area.size}` : null;
  if (entry.area !== undefined && p.areas.size && !p.areas.has(area)) out.push(`area     recorded ${area ?? 'none'}; prose has ${list(p.areas)}`);

  return out;
}

const DAMAGE_ORDER = new Map(DAMAGE.map((d, i) => [d, i]));
const ordinal = (n) => (n === 0 ? 'cantrip' : `${n}${['th', 'st', 'nd', 'rd'][n] ?? 'th'}`);
const range = (r) => (r.kind === 'ranged' ? `${r.feet} ft` : r.kind);

/** One entry, header block in the order a book prints it, then the body facts. */
function line(e) {
  const head = [
    `${ordinal(e.level)} ${e.school}${e.ritual ? ' (ritual)' : ''}`,
    e.time + (e.trigger ? ` [${e.trigger}]` : ''),
    range(e.range),
    e.components + (e.material ? ` (${e.material})` : ''),
    (e.conc ? 'conc ' : '') + e.duration,
  ].join(' · ');
  const body = [
    `classes ${e.classes.join('/')}`,
    `save ${e.save === undefined ? '?' : e.save ?? '-'}`,
    `attack ${e.attack === undefined ? '?' : e.attack ?? '-'}`,
    `dmg ${e.damage === undefined ? '?' : e.damage.length ? [...e.damage].sort((a, b) => DAMAGE_ORDER.get(a) - DAMAGE_ORDER.get(b)).join('/') : '-'}`,
    `area ${e.area === undefined ? '?' : e.area ? `${e.area.type} ${e.area.size}` : '-'}`,
  ].join(' · ');
  return `${e.verified ? '[x]' : '[ ]'} ${e.name}\n      ${head}\n      ${body}`;
}

const sorted = [...extra]
  .filter((e) => !onlyBook || e.src.book === onlyBook)
  .sort((a, b) => a.src.book.localeCompare(b.src.book) || a.name.localeCompare(b.name));

let book = null;
let flagged = 0;
let unverified = 0;
let skipped = 0;
for (const e of sorted) {
  if (summoned(e.name)) skipped++;
  const bad = disagreements(e, fromProse(e));
  if (bad.length) flagged++;
  if (!e.verified) unverified++;
  if (onlyFlagged && !bad.length) continue;
  if (e.src.book !== book) {
    book = e.src.book;
    console.log(`\n== ${book} ==\n`);
  }
  console.log(line(e));
  for (const b of bad) console.log(`      !! ${b}`);
}

console.log(`\n${sorted.length} entries, ${unverified} unverified, ${flagged} with something to look at`);
if (text && skipped) console.log(`(${skipped} summoning spells not cross-checked: their damage, saves and attacks are the creature's, not the spell's)`);
if (!text) console.log('(no text.json — nothing was cross-checked)');
