// Everything wrong with the spell index that can be found without a browser.
//
// The data is half generated and half typed by hand, and the hand-typed half is
// where a mistake hides: a school spelled wrong is not a visible error, it is a
// spell that no filter will ever return. That is the whole reason this exists,
// and why it reports every problem rather than stopping at the first.
//
// **Deliberately not part of `tools/check.mjs`.** That command is Slate's. The
// page at `/spells/` shares no code with the client and keeping the two checks
// apart is part of keeping the two things apart.
//
//   node tools/check-spells.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vocab from '../client/spells/vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'client', 'spells', f), 'utf8'));

const problems = [];
const complain = (where, what) => problems.push(`${where}: ${what}`);

const srd = read('srd.json');
const extra = read('extra.json');

/** Reject a value that is present and wrong; absence is `required`'s business. */
const oneOf = (where, field, value, allowed) => {
  if (value !== undefined && value !== null && !allowed.includes(value)) {
    complain(where, `${field} "${value}" is not one of ${allowed.join(', ')}`);
  }
};

function checkEntry(entry, where, handTyped) {
  for (const field of vocab.TIER_A) {
    if (entry[field] === undefined || entry[field] === null) complain(where, `missing ${field}`);
  }

  // Required on hand-typed entries and never defaulted, because both defaults
  // are wrong: assuming true silently trusts a draft nobody checked, and
  // assuming false cries wolf about entries somebody did check. Make it answered.
  if (handTyped && typeof entry.verified !== 'boolean') {
    complain(where, 'missing verified — true if checked against the book, false if not');
  }

  if (entry.alias !== undefined && entry.alias !== null) {
    if (!Array.isArray(entry.alias)) complain(where, 'alias must be an array');
    else for (const a of entry.alias) {
      if (typeof a !== 'string' || !a.trim()) complain(where, 'alias entries must be non-empty strings');
    }
  }

  if (typeof entry.level === 'number' && (entry.level < 0 || entry.level > 9)) {
    complain(where, `level ${entry.level} is outside 0-9`);
  }
  oneOf(where, 'school', entry.school, vocab.SCHOOLS);
  oneOf(where, 'time', entry.time, vocab.TIMES);
  oneOf(where, 'save', entry.save, vocab.SAVES);
  oneOf(where, 'attack', entry.attack, vocab.ATTACKS);

  if (Array.isArray(entry.classes)) {
    if (entry.classes.length === 0) complain(where, 'classes is empty');
    for (const c of entry.classes) oneOf(where, 'class', c, vocab.CLASSES);
  } else if (entry.classes !== undefined) {
    complain(where, 'classes must be an array');
  }

  if (Array.isArray(entry.damage)) {
    for (const d of entry.damage) oneOf(where, 'damage', d, vocab.DAMAGE);
  } else if (entry.damage !== undefined) {
    complain(where, 'damage must be an array — [] means "deals none"');
  }

  if (entry.range !== undefined && entry.range !== null) {
    oneOf(where, 'range.kind', entry.range.kind, vocab.RANGE_KINDS);
    const ranged = entry.range.kind === 'ranged';
    if (ranged && typeof entry.range.feet !== 'number') complain(where, 'range.kind "ranged" needs feet');
    if (!ranged && entry.range.feet != null) complain(where, `range.kind "${entry.range.kind}" must have feet: null`);
  }

  if (entry.components !== undefined && !/^V?S?M?$/.test(entry.components ?? '')) {
    complain(where, `components "${entry.components}" must be a subset of VSM, in that order`);
  }
  if (entry.components?.includes('M') && !entry.material) {
    complain(where, 'components says M but material is empty');
  }

  if (entry.area !== undefined && entry.area !== null) oneOf(where, 'area.type', entry.area.type, vocab.AREAS);

  if (entry.src) {
    const pages = vocab.BOOKS[entry.src.book];
    if (pages === undefined) {
      complain(where, `src.book "${entry.src.book}" is not one of ${Object.keys(vocab.BOOKS).join(', ')}`);
    } else if (entry.src.page != null && (entry.src.page < 1 || entry.src.page > pages)) {
      complain(where, `src.page ${entry.src.page} is outside ${entry.src.book}'s 1-${pages}`);
    }
  }
}

for (const [i, entry] of srd.entries()) checkEntry(entry, `srd.json[${i}] ${entry.name ?? '?'}`, false);
for (const [i, entry] of extra.entries()) checkEntry(entry, `extra.json[${i}] ${entry.name ?? '?'}`, true);

// A name typed twice in `extra.json` is one entry silently eating the other.
const seen = new Set();
for (const entry of extra) {
  if (seen.has(entry.name)) complain(`extra.json ${entry.name}`, 'appears twice');
  seen.add(entry.name);
}

// An `extra.json` entry whose name matches an SRD one replaces it, which is how
// a class list Tasha's changed gets fixed. It is also how a typo'd new spell
// quietly destroys a PHB entry — so every override is printed to be eyeballed,
// never merely allowed.
const srdNames = new Set(srd.map((s) => s.name));
const overrides = extra.filter((e) => srdNames.has(e.name)).map((e) => e.name);

console.log(`${srd.length} SRD + ${extra.length} hand-typed = ${srd.length + extra.length - overrides.length} spells`);

if (overrides.length) {
  console.log(`\noverriding ${overrides.length} SRD entr${overrides.length === 1 ? 'y' : 'ies'} — check each is deliberate:`);
  for (const name of overrides) console.log(`  ${name}`);
}

const unchecked = extra.filter((e) => e.verified === false);
if (unchecked.length) {
  console.log(`
${unchecked.length} entr${unchecked.length === 1 ? 'y' : 'ies'} not yet checked against a book:`);
  const byBook = new Map();
  for (const e of unchecked) byBook.set(e.src.book, [...(byBook.get(e.src.book) ?? []), e.name]);
  for (const [book, names] of byBook) console.log(`  ${book}: ${names.length} — ${names.join(', ')}`);
}

// What the page's completeness gate will decide, said in the terminal so it is
// not a surprise at the table. A tier-B filter stays off until its field is
// recorded on every entry, because a filter over a half-filled field returns a
// short list that looks like a complete one.
const merged = [...srd.filter((s) => !extra.some((e) => e.name === s.name)), ...extra];
console.log('\ntier-B filters:');
for (const field of vocab.TIER_B) {
  const have = merged.filter((s) => s[field] !== undefined).length;
  const ok = have === merged.length;
  console.log(`  ${field.padEnd(7)} ${have}/${merged.length} ${ok ? 'enabled' : 'DISABLED until complete'}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('\nok');
