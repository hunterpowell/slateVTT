// Turns the book dumps in `spells_tmp/` into `extra.json` and its text overlay.
//
// The page at `client/spells/` is **not part of Slate** — see the header of
// `tools/build-spells.mjs`. This is that script's twin for the books SRD 5.1
// does not carry: `build-spells.mjs` fetches the 319 licensed spells, and this
// reads the other ~158 out of a hand-made text dump.
//
// **The licence line is the reason there are two outputs.** `extra.json` holds
// header facts and a page and is committed; `text.json` holds the prose and is
// **gitignored**, because Xanathar's, Tasha's and the non-SRD half of the PHB
// are under no open licence and this repository is public. The page fetches the
// overlay and tolerates its absence, so a checkout without it degrades to
// exactly what `extra.json` has always been — an index that names a page. See
// `client/spells/LICENSE-SRD.md`.
//
// **Every mapping below throws on an input it does not recognise**, for the
// reason `build-spells.mjs` gives: a silent default is a confident wrong answer
// that nobody notices at the table.
//
//   node tools/import-spells.mjs [--report]
//
// `--report` prints what it would change without writing anything.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vocab from '../client/spells/vocab.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'spells_tmp');
const SPELLS = join(ROOT, 'client', 'spells');

const SOURCES = [
  { book: 'PHB', file: 'trimmed_phb_spells.txt' },
  { book: 'XGE', file: 'xanathars_spells.txt' },
  { book: 'TCE', file: 'tashas_spells.txt' },
];

/** Eighty dashes, which is how the dumps separate one spell from the next. */
const SEPARATOR = /^-{80}$/;

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

/**
 * Casting times that name two options, and which one `time` records.
 *
 * `time` is one slug, so a spell castable two ways has to pick. It picks the
 * shorter, because the question the filter is asked is "what can I cast right
 * now" — the ritual-length option is the one you were never in a hurry about.
 * Upstream made the same choice for Plant Growth, so the SRD entry and this
 * agree; listed rather than inferred so a second such spell stops the run.
 */
const TIME_CHOICES = { '1 action or 8 hours': 'action' };

const RANGE_WORDS = {
  Self: 'self',
  Touch: 'touch',
  Sight: 'sight',
  Unlimited: 'unlimited',
  Special: 'special',
};

/**
 * The shape words a `Range: Self (...)` line can end in.
 *
 * `hemisphere` maps to a sphere on purpose: it is one clipped by the ground, and
 * the radius is the number a shape filter is being asked about. Leaving it out
 * would drop Leomund's Tiny Hut from every area query to record a distinction
 * nothing here can act on.
 */
const AREA_WORDS = {
  radius: 'sphere',
  sphere: 'sphere',
  hemisphere: 'sphere',
  cone: 'cone',
  cube: 'cube',
  line: 'line',
  cylinder: 'cylinder',
};

/**
 * Scanning slips in the dumps, and what the book actually prints.
 *
 * Every key is asserted to appear below, so a fix for a slip that has since been
 * corrected in the dump fails the run instead of sitting here forever pretending
 * to do something.
 */
const OCR_FIXES = {
  "DRAWMJ'S INSTANT SUMMONS": "DRAWMIJ'S INSTANT SUMMONS",
  'Concentration up to 10 minutes': 'Concentration, up to 10 minutes',
  'Concentration, up to one minute': 'Concentration, up to 1 minute',
};

/**
 * Character-level scanning slips, which are a different thing from a line that
 * came out wrong as a whole: a capital I read for a 1 can land in front of any
 * school, so this is a rule rather than a list of the lines it happened to hit.
 */
const SCAN_SLIPS = [{ from: /^Ist-level /, to: '1st-level ', label: 'Ist- for 1st-' }];

/**
 * Cyrillic and Greek letters the scan left behind where Latin ones belong.
 *
 * This is the nastiest thing in the dumps and the only one invisible on screen:
 * Xanathar's prints HOLY WEAPON with a Greek rho, omicron and nu in it, which
 * looks exactly right and matches nothing. Left alone it does not fail — it
 * quietly produces a spell whose name no class list can name and whose text no
 * phrase search can reach.
 *
 * So they are mapped, and **anything else outside ASCII stops the run** rather
 * than being passed through: the whole point is that the eye cannot be the check
 * here. `ALLOWED` is the punctuation that is genuinely meant to be there.
 */
const HOMOGLYPHS = {
  'а': 'a', 'с': 'c', 'е': 'e', 'г': 'r', 'п': 'n',
  'à': 'a', 'Ρ': 'P', 'Ο': 'O', 'Ν': 'N',
};
const ALLOWED = new Set(['•', '—', '–', '‘', '’', '“', '”', '…']);

function deHomoglyph(text, file) {
  let out = '';
  for (const ch of text) {
    if (ch.codePointAt(0) < 128 || ALLOWED.has(ch)) out += ch;
    else if (HOMOGLYPHS[ch]) out += HOMOGLYPHS[ch];
    else {
      const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      fail(file, `character U+${hex} ${JSON.stringify(ch)} — add it to HOMOGLYPHS or ALLOWED`);
    }
  }
  return out;
}

/** Words a spell name leaves lowercase unless they open it. */
const MINOR = new Set([
  'of', 'the', 'and', 'from', 'in', 'on', 'to', 'with',
  'a', 'an', 'for', 'at', 'by', 'into', 'upon', 'or',
]);

const fail = (name, what) => {
  throw new Error(`${name}: unrecognised ${what} — the dump changed, update tools/import-spells.mjs`);
};

/** Names are matched on letters alone, so punctuation and case cannot miss. */
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// ------------------------------------------------------------------ parsing

/** ALL CAPS as the dumps print it, to the mixed case a book prints. */
function titleCase(shouty) {
  return shouty
    .toLowerCase()
    .split(' ')
    .map((word, i) =>
      word
        .split('-')
        .map((part, j) => {
          if (i > 0 && j === 0 && MINOR.has(part)) return part;
          // An apostrophe is possessive, so what follows it stays lowercase:
          // "Abi-Dalzim's", never "Abi-Dalzim'S".
          return part.replace(/^[a-z]/, (c) => c.toUpperCase());
        })
        .join('-'),
    )
    .join(' ');
}

/**
 * Where a hyphen at a wrap is **not** a word broken across the line.
 *
 * The dumps are hard-wrapped, and welding a trailing hyphen back together is
 * right 167 times out of 173. The exceptions are two kinds, and both had to be
 * listed because nothing in the text tells them apart:
 *
 * - a **real compound** that happened to break at its own hyphen ("yellow-green"),
 * - an **em dash** the scan flattened to a hyphen, which then landed at a wrap
 *   ("four pieces of nonmagical ammunition—arrows or crossbow bolts—in the
 *   ground"). Welded, that one reads as a spell component called
 *   "ammunitionarrows", which is the sort of thing a phrase search never finds.
 *
 * A number before the hyphen is the one case with a rule behind it, so it is
 * written as one. Every other pair is named, and every name is asserted to occur
 * below — a corrected dump fails the run rather than keeping a stale entry.
 */
const NUMBERED_COMPOUND = /(?:^|\s)\d+-$/;
const WRAP_JOINS = {
  'foot|radius': '-',
  'nine|course': '-',
  'yellow|green': '-',
  'ammunition|arrows': '—',
  'command|such': '—',
  'runes|worth': '—',
};
const usedJoins = new Set();

function unwrap(lines) {
  let out = '';
  for (const line of lines) {
    if (!out) {
      out = line;
      continue;
    }
    if (!out.endsWith('-')) {
      out = `${out} ${line}`;
      continue;
    }
    if (NUMBERED_COMPOUND.test(out)) {
      out = `${out}${line}`;
      continue;
    }
    const left = (/([A-Za-z]+)-$/.exec(out) ?? [])[1] ?? '';
    const right = (/^([A-Za-z]+)/.exec(line) ?? [])[1] ?? '';
    const joiner = WRAP_JOINS[`${left}|${right}`];
    if (joiner === undefined) {
      out = `${out.slice(0, -1)}${line}`;
      continue;
    }
    usedJoins.add(`${left}|${right}`);
    out = `${out.slice(0, -1)}${joiner}${line}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Blank lines separate paragraphs in the Tasha's dump; the others use none. */
function paragraphs(lines) {
  const groups = [[]];
  for (const line of lines) {
    if (!line.trim()) groups.push([]);
    else groups[groups.length - 1].push(line.trim());
  }
  return groups.filter((g) => g.length).map(unwrap);
}

function blocksOf(file) {
  const text = deHomoglyph(readFileSync(join(IN, file), 'utf8'), file);
  const blocks = [[]];
  for (const line of text.split(/\r?\n/)) {
    if (SEPARATOR.test(line)) blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.filter((b) => b.join('').trim());
}

const KEYS = ['Casting Time:', 'Range:', 'Components:', 'Duration:'];

function parse(lines, book, usedFixes) {
  const fix = (raw) => {
    let out = raw;
    if (OCR_FIXES[out] !== undefined) {
      usedFixes.add(out);
      out = OCR_FIXES[out];
    }
    for (const slip of SCAN_SLIPS) {
      if (slip.from.test(out)) {
        usedFixes.add(slip.label);
        out = out.replace(slip.from, slip.to);
      }
    }
    return out;
  };

  const dense = lines.map((l) => l.trim()).filter(Boolean);
  const name = titleCase(fix(dense[0]));

  const at = KEYS.map((k) => dense.findIndex((l) => l.startsWith(k)));
  if (at.some((i) => i === -1)) fail(name, 'block — a header line is missing');

  // ---- level, school, ritual
  const header = fix(dense[1]);
  const ritual = / \(ritual\)$/.test(header);
  const bare = header.replace(/ \(ritual\)$/, '');
  let level;
  let school;
  const cantrip = /^([A-Za-z]+) cantrip$/.exec(bare);
  const levelled = /^(\d+)(?:st|nd|rd|th)-level ([A-Za-z]+)$/.exec(bare);
  if (cantrip) [level, school] = [0, cantrip[1].toLowerCase()];
  else if (levelled) [level, school] = [Number(levelled[1]), levelled[2].toLowerCase()];
  else fail(name, `level line ${JSON.stringify(header)}`);
  if (!vocab.SCHOOLS.includes(school)) fail(name, `school "${school}"`);

  // ---- casting time, and the trigger a reaction states in passing
  // A reaction prints its trigger on the same line and wraps onto the next, so
  // the value runs to the `Range:` line rather than to the end of its own.
  const timeRaw = unwrap(dense.slice(at[0], at[1])).replace(/^Casting Time: /, '');
  let time = TIMES[timeRaw] ?? TIMES[TIME_CHOICES[timeRaw]] ?? TIME_CHOICES[timeRaw];
  let trigger = null;
  if (!time) {
    const reaction = /^1 reaction,? which you take (.*)$/.exec(timeRaw);
    if (!reaction) fail(name, `casting time ${JSON.stringify(timeRaw)}`);
    time = 'reaction';
    // The SRD could never supply this — it prints a bare "1 reaction" and buries
    // the trigger in the prose. The books print it in the header block.
    trigger = reaction[1].replace(/[.\s]+$/, '');
  }

  // ---- range, and the area a self-range spell names in passing
  const rangeRaw = dense[at[1]].replace(/^Range: /, '');
  let range;
  let area = null;
  // "Self (15-foot cone)", "Self (10-foot-radius sphere)", "Self (5-foot radius)" —
  // the shape is the last word either way, and "radius" is itself one of them.
  const selfShape = /^Self \((\d+)-(?:foot|mile)[- ](?:[a-z]+[- ])*([a-z]+)\)$/.exec(rangeRaw);
  const distance = /^(\d+) (feet|foot|mile|miles)$/.exec(rangeRaw);
  if (RANGE_WORDS[rangeRaw]) range = { kind: RANGE_WORDS[rangeRaw], feet: null };
  else if (selfShape) {
    range = { kind: 'self', feet: null };
    const shape = AREA_WORDS[selfShape[2]];
    if (!shape) fail(name, `area shape "${selfShape[2]}"`);
    area = { type: shape, size: Number(selfShape[1]) * (rangeRaw.includes('-mile') ? 5280 : 1) };
  } else if (distance) {
    const n = Number(distance[1]);
    range = { kind: 'ranged', feet: distance[2].startsWith('mile') ? n * 5280 : n };
  } else fail(name, `range ${JSON.stringify(rangeRaw)}`);

  // ---- components and material
  // The material clause wraps, so this runs to the `Duration:` line too.
  const compRaw = unwrap(dense.slice(at[2], at[3])).replace(/^Components: /, '');
  const letters = compRaw.split('(')[0].replace(/[^VSM]/g, '');
  if (!/^V?S?M?$/.test(letters)) fail(name, `components ${JSON.stringify(compRaw)}`);
  let material = null;
  if (letters.includes('M')) {
    const m = /\((.*)\)\s*$/.exec(compRaw);
    if (!m) fail(name, `components says M but names no material: ${JSON.stringify(compRaw)}`);
    material = m[1];
  }

  // ---- duration
  const duration = fix(dense[at[3]].replace(/^Duration: /, ''));
  const conc = /^Concentration/.test(duration);

  // ---- body, split into prose and the "At Higher Levels" note
  const bodyStart = lines.findIndex((l) => l.trim().startsWith('Duration:')) + 1;
  const text = [];
  const higher = [];
  for (const para of paragraphs(lines.slice(bodyStart))) {
    // The PHB and Xanathar's dumps have no blank lines, so a whole body arrives
    // as one paragraph with the note welded onto its end.
    const split = /^(.*?)\s*At Higher Levels\.\s*(.*)$/s.exec(para);
    if (split) {
      if (split[1]) text.push(split[1]);
      higher.push(split[2]);
    } else text.push(para);
  }

  return {
    entry: {
      name,
      level,
      school,
      classes: null, // filled from `classes.txt` below
      time,
      trigger,
      range,
      components: letters,
      material,
      duration,
      conc,
      ritual,
      src: { book, page: null },
      area,
    },
    text: text.filter(Boolean),
    higher,
  };
}

// ------------------------------------------------------------------ classes

/**
 * `spells_tmp/classes.txt`, which is the one thing the dumps do not carry.
 *
 * The books print their spell lists *by class* in an appendix, so that is the
 * shape this reads: a `[class]` heading and the names under it. Inverting it
 * here rather than typing nine class names onto each of 125 spells is the
 * difference between transcribing thirteen lists and doing 125 lookups.
 */
function readClasses() {
  const path = join(IN, 'classes.txt');
  if (!existsSync(path)) return { byName: new Map(), problems: [] };

  const byName = new Map();
  const problems = [];
  let current = null;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const heading = /^\[([a-z]+)\]$/.exec(line);
    if (heading) {
      current = heading[1];
      if (!vocab.CLASSES.includes(current)) problems.push(`class "${current}" is not one of ${vocab.CLASSES.join(', ')}`);
      continue;
    }
    if (!current) {
      problems.push(`"${line}" appears before any [class] heading`);
      continue;
    }
    for (const name of line.split(',').map((s) => s.trim()).filter(Boolean)) {
      const key = keyOf(name);
      byName.set(key, [...new Set([...(byName.get(key) ?? []), current])].sort());
    }
  }
  return { byName, problems };
}

// ------------------------------------------------------------------- output

const srd = JSON.parse(readFileSync(join(SPELLS, 'srd.json'), 'utf8'));
const existing = JSON.parse(readFileSync(join(SPELLS, 'extra.json'), 'utf8'));

// A name the SRD already carries, under either the name it files it as or the
// one the book prints. Those spells belong to `build-spells.mjs` and this script
// must not produce a second copy — an `extra.json` entry of the same name would
// silently override the licensed one, text and all.
const srdKeys = new Set();
for (const s of srd) {
  srdKeys.add(keyOf(s.name));
  for (const a of s.alias ?? []) srdKeys.add(keyOf(a));
}
const existingByKey = new Map(existing.map((e) => [keyOf(e.name), e]));

const { byName: classesFor, problems: classProblems } = readClasses();
const usedFixes = new Set();

const parsed = [];
for (const { book, file } of SOURCES) {
  for (const block of blocksOf(file)) parsed.push({ book, ...parse(block, book, usedFixes) });
}

for (const raw of [...Object.keys(OCR_FIXES), ...SCAN_SLIPS.map((s) => s.label)]) {
  if (!usedFixes.has(raw)) fail(raw, 'scan fix — nothing in the dumps matches it any more');
}
for (const pair of Object.keys(WRAP_JOINS)) {
  if (!usedJoins.has(pair)) fail(pair, 'wrap exception — no line in the dumps breaks there any more');
}

const held = [];
const fresh = [];
const textOverlay = {};

for (const { entry, text, higher } of parsed) {
  const key = keyOf(entry.name);
  const already = existingByKey.get(key);

  // Text is keyed for every hand-typed entry, including the 33 that predate this
  // script — the overlay is not committed, so there is no reason to withhold it.
  if (already || !srdKeys.has(key)) textOverlay[already?.name ?? entry.name] = { text, higher };

  if (srdKeys.has(key)) continue; // the SRD's, and licensed; leave it alone
  if (already) continue; // hand-typed already, and not this script's to rewrite

  const classes = classesFor.get(key);
  if (!classes) {
    held.push({ book: entry.src.book, name: entry.name });
    continue;
  }
  fresh.push({
    ...entry,
    classes,
    // Tier-B facts this script cannot read off a header block. Left **absent**,
    // not null: null is the recorded fact "this spell has none", and absence is
    // "nobody has typed it", which is what keeps the completeness gate honest.
    save: undefined,
    attack: undefined,
    damage: undefined,
    // `area` is the exception — the range line states it outright when it states
    // it at all, so it is recorded either way and stays above.
    verified: false,
  });
}

// A name in the appendix that matches no spell anywhere is a typo, and a typo
// there is a spell that stays held back with no obvious reason why. `srdKeys` is
// allowed alongside the dumps so a whole appendix list can be pasted in without
// pruning: it carries the SRD's own filing names, which the books do not print.
const parsedKeys = new Set(parsed.map((p) => keyOf(p.entry.name)));
for (const key of classesFor.keys()) {
  if (!parsedKeys.has(key) && !srdKeys.has(key)) classProblems.push(`"${key}" matches no spell in any dump`);
}

// By level and then by name, which is the order the file is already in and the
// order a book's spell list is in.
const merged = [...existing, ...fresh].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

/**
 * `extra.json` in the shape a person edits it in.
 *
 * `JSON.stringify(value, null, 2)` is correct and unreadable here: it breaks
 * `classes` and `range` across five lines apiece and turns the 662-line file
 * into a 1032-line one. This is the half of the data that is **maintained by
 * hand** — checking an entry against a book is meant to be a one-word edit — so
 * the compact form the file already uses is kept: one line per field, with
 * scalar arrays and the small fixed-shape objects left inline.
 *
 * A field whose value is `undefined` is skipped rather than written as null,
 * which is exactly the absence the completeness gate reads. Said out loud
 * because it looks like an oversight.
 */
const inlineArray = (a) => `[${a.map((x) => JSON.stringify(x)).join(', ')}]`;
const inlineObject = (o) =>
  `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;

function formatEntry(entry) {
  const fields = [];
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    let text;
    if (Array.isArray(value)) text = inlineArray(value);
    else if (value && typeof value === 'object') text = inlineObject(value);
    else text = JSON.stringify(value);
    fields.push(`    ${JSON.stringify(key)}: ${text}`);
  }
  return `  {\n${fields.join(',\n')}\n  }`;
}

const report = process.argv.includes('--report');
if (!report) {
  writeFileSync(join(SPELLS, 'extra.json'), `[\n${merged.map(formatEntry).join(',\n')}\n]\n`);
  // The overlay is machine-read and gitignored, so it takes the plain form.
  writeFileSync(join(SPELLS, 'text.json'), `${JSON.stringify(textOverlay, null, 2)}\n`);
}

const would = report ? ' (would be)' : '';
console.log(`${parsed.length} blocks parsed from ${SOURCES.length} dumps`);
console.log(`  ${parsed.filter((p) => srdKeys.has(keyOf(p.entry.name))).length} already in srd.json — left alone`);
console.log(`  ${existing.length} already in extra.json — left alone`);
console.log(`  ${fresh.length} new entries${would} written to extra.json (${merged.length} total)`);
console.log(`  ${Object.keys(textOverlay).length} entries${would} written to text.json (gitignored)`);

if (held.length) {
  console.log(`\n${held.length} spells held back — no class list in spells_tmp/classes.txt:`);
  const byBook = new Map();
  for (const h of held) byBook.set(h.book, [...(byBook.get(h.book) ?? []), h.name]);
  for (const [book, names] of byBook) console.log(`  ${book} (${names.length}): ${names.join(', ')}`);
}

if (classProblems.length) {
  console.error(`\n${classProblems.length} problem${classProblems.length === 1 ? '' : 's'} in classes.txt:`);
  for (const p of classProblems) console.error(`  ${p}`);
  process.exit(1);
}
