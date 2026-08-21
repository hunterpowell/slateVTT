// The search itself, with no DOM in it.
//
// Split from `spells.js` for the reason the client splits `coords.ts` out: this
// half is pure, so `query.test.mjs` can drive it in node, and the half that
// touches the document cannot be tested without a browser. Everything here is a
// function of the spell array it is handed.

import * as vocab from './vocab.js';

/**
 * One list from the two files.
 *
 * A hand-typed entry **replaces** an SRD entry of the same name rather than
 * joining it — which is how a class list Tasha's changed gets corrected without
 * inventing a second mechanism for it. `check-spells.mjs` prints every override
 * by name, so a mistyped new spell cannot quietly eat a PHB one.
 */
export function merge(srd, extra) {
  const replaced = new Set(extra.map((e) => e.name));
  return [...srd.filter((s) => !replaced.has(s.name)), ...extra].sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name),
  );
}

export function createIndex(spells) {
  /**
   * How many entries carry each tier-B field.
   *
   * The failure this exists to prevent: `damage` arrives complete from the SRD
   * and empty for Xanathar's until somebody types it, so `-fire` would return a
   * list missing every XGE spell — a wrong answer wearing the costume of a right
   * one, which nobody notices mid-fight. A filter over an incomplete field is
   * refused with a count instead, and the gate lifts by itself as typing
   * finishes. `undefined` is "not recorded"; `null` and `[]` are "has none".
   */
  const complete = new Map(
    vocab.TIER_B.map((f) => [f, spells.filter((s) => s[f] !== undefined).length]),
  );
  const isComplete = (field) => complete.get(field) === spells.length;

  /** No entry outside the SRD carries prose, so a phrase search cannot see it. */
  const withoutText = spells.filter((s) => !s.text?.length).length;

  /** Every token that means something, and the test it stands for. */
  const exact = new Map();
  const define = (token, field, test) => exact.set(token, { field, test });

  define('cantrip', 'level', (s) => s.level === 0);
  for (let n = 0; n <= 9; n++) {
    const test = (s) => s.level === n;
    define(String(n), 'level', test);
    define(`${n}${['th', 'st', 'nd', 'rd'][n] ?? 'th'}`, 'level', test);
  }
  for (const school of vocab.SCHOOLS) define(school, 'school', (s) => s.school === school);
  for (const klass of vocab.CLASSES) define(klass, 'classes', (s) => s.classes.includes(klass));
  for (const time of vocab.TIMES) define(time, 'time', (s) => s.time === time);
  for (const book of Object.keys(vocab.BOOKS)) {
    define(book.toLowerCase(), 'src', (s) => s.src.book === book);
  }
  define('conc', 'conc', (s) => s.conc);
  define('ritual', 'ritual', (s) => s.ritual);
  define('self', 'range', (s) => s.range.kind === 'self');
  define('touch', 'range', (s) => s.range.kind === 'touch');

  // Tier-B. The `field` each one names is what the gate looks up, so they must
  // be spelled exactly as `vocab.TIER_B` spells them.
  for (const dmg of vocab.DAMAGE) define(dmg, 'damage', (s) => s.damage.includes(dmg));
  for (const save of vocab.SAVES) define(save, 'save', (s) => s.save === save);
  define('save', 'save', (s) => s.save !== null);
  define('attack', 'attack', (s) => s.attack !== null);
  for (const area of vocab.AREAS) define(area, 'area', (s) => s.area?.type === area);

  /** Schools and classes take a prefix, so `necro` and `wiz` work. */
  const prefixable = [...vocab.SCHOOLS, ...vocab.CLASSES];

  /**
   * `con` is a saving throw and `conc` is concentration, so an exact hit always
   * wins over a prefix — otherwise the shorter of the two would be unreachable.
   */
  function resolve(word) {
    const hit = exact.get(word);
    if (hit) return hit;
    if (word.length < 3) return null;
    const matches = prefixable.filter((v) => v.startsWith(word));
    return matches.length === 1 ? exact.get(matches[0]) : null;
  }

  /** Splits on whitespace, but a quoted phrase stays one token. */
  const tokenize = (q) => q.match(/-?"[^"]*"|\S+/g) ?? [];

  function parse(query) {
    const groups = new Map(); // field -> tests, OR'd within one field
    const nots = [];
    const phrases = [];
    const refused = [];

    for (const raw of tokenize(query)) {
      const negated = raw.startsWith('-');
      const body = (negated ? raw.slice(1) : raw).replace(/^"|"$/g, '').toLowerCase();
      if (!body) continue;

      // A quoted token is a phrase by request, never a keyword.
      const hit = raw.includes('"') ? null : resolve(body);
      if (!hit) {
        phrases.push({ text: body, negated });
        continue;
      }
      if (vocab.TIER_B.includes(hit.field) && !isComplete(hit.field)) {
        refused.push({ token: body, field: hit.field });
        continue;
      }
      if (negated) nots.push(hit.test);
      else groups.set(hit.field, [...(groups.get(hit.field) ?? []), hit.test]);
    }
    return { groups, nots, phrases, refused };
  }

  /**
   * The alias is in here for the spells SRD stripped a wizard's name off: the
   * entry is called "Arcane Hand" and every player at the table calls it Bigby's,
   * so without this the search answers "no such spell" about a spell it holds.
   */
  const haystack = (s) =>
    [s.name, ...(s.alias ?? []), ...(s.text ?? []), ...(s.higher ?? [])].join('\n').toLowerCase();

  /** Same field ORs, different fields AND — `fire cold` widens, `wiz 3` narrows. */
  function run({ groups, nots, phrases }) {
    return spells.filter((s) => {
      for (const tests of groups.values()) if (!tests.some((t) => t(s))) return false;
      for (const t of nots) if (t(s)) return false;
      for (const p of phrases) if (haystack(s).includes(p.text) === p.negated) return false;
      return true;
    });
  }

  const search = (query) => {
    const parsed = parse(query);
    return { ...parsed, hits: run(parsed) };
  };

  return { spells, complete, isComplete, withoutText, parse, run, search };
}
