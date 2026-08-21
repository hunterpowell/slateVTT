// A searchable index of the spells the table already owns in print.
//
// **This is not part of Slate.** It imports nothing from `../src/`, has no entry
// in esbuild's build and touches no room state. It is served at `/spells/` by
// the same `ServeDir` fallback that serves the client, which is the whole of the
// coupling between them.
//
// The premise is that everyone has the books. A book is excellent at "read me
// Fireball" and useless at "what 2nd-level bard spells are a bonus action and
// don't eat concentration" — so this stores the fields that answer the second
// question and leaves the reading to the page number.
//
// The search lives in `query.js`, which has no DOM in it and is tested in node.
// What is left here is loading, drawing and one input listener.

import { createIndex, merge } from './query.js';

const [srd, extra] = await Promise.all(
  ['srd.json', 'extra.json'].map((f) => fetch(f).then((r) => r.json())),
);

// `text.json` is the prose for the hand-typed half, and it is **not committed**
// — Xanathar's, Tasha's and the non-SRD part of the PHB are under no open
// licence, so `extra.json` carries the header facts and the text stays out of
// the repository. See `LICENSE-SRD.md` and `tools/import-spells.mjs`.
//
// So its absence is the ordinary case, not an error: a checkout without it shows
// exactly what `extra.json` has always shown, which is a row that names a page.
// The failure is swallowed on purpose, and it is the one place on this page that
// is allowed to do that.
const overlay = await fetch('text.json')
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
for (const entry of extra) {
  const held = overlay[entry.name];
  if (held) Object.assign(entry, { text: held.text, higher: held.higher });
}

const index = createIndex(merge(srd, extra));

// ---------------------------------------------------------------- rendering

const LEVEL = (n) => (n === 0 ? 'cantrip' : `level ${n}`);
const TIME_LABEL = {
  action: 'action',
  bonus: 'bonus action',
  reaction: 'reaction',
  '1min': '1 minute',
  '10min': '10 minutes',
  '1hr': '1 hour',
  '8hr': '8 hours',
  '12hr': '12 hours',
  '24hr': '24 hours',
};

const rangeLabel = (r) =>
  r.kind !== 'ranged' ? r.kind : r.feet >= 5280 ? `${r.feet / 5280} mi` : `${r.feet} ft`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** The header block a book prints, in the order a book prints it. */
function facts(s) {
  const out = [LEVEL(s.level), s.school, TIME_LABEL[s.time], rangeLabel(s.range), s.duration];
  if (s.conc) out.push('concentration');
  if (s.ritual) out.push('ritual');
  if (s.components) out.push(s.components.split('').join('/'));
  if (s.save) out.push(`${s.save} save`);
  if (s.attack) out.push(`${s.attack} attack`);
  if (s.damage?.length) out.push(s.damage.join('/'));
  if (s.area) out.push(`${s.area.size} ft ${s.area.type}`);
  return out;
}

function render(spell) {
  const row = el('details', 'spell');
  const head = el('summary');
  head.append(el('span', 'name', spell.name));
  // The PHB name, where the SRD renamed the spell. Shown rather than merely
  // searched, so finding "Arcane Hand" by typing "bigby" is not a surprise.
  if (spell.alias?.length) head.append(el('span', 'alias', `= ${spell.alias.join(', ')}`));
  head.append(el('span', 'classes', spell.classes.join(' ')));
  const cite = spell.src.page ? `${spell.src.book} ${spell.src.page}` : spell.src.book;
  head.append(el('span', 'src', cite));
  row.append(head);

  const body = el('div', 'body');
  const chips = el('div', 'facts');
  for (const f of facts(spell)) chips.append(el('span', 'chip', f));
  // Not yet checked against the book. A chip among the facts rather than a tag
  // on the row: it is a fact about the *entry* rather than about the spell, and
  // it belongs where you are reading the entry. Quiet on purpose — see the
  // colour it is deliberately not, in index.html.
  if (spell.verified === false) chips.append(el('span', 'chip unverified', 'unchecked'));
  body.append(chips);

  if (spell.trigger) body.append(el('p', 'trigger', `Trigger: ${spell.trigger}`));
  if (spell.material) body.append(el('p', 'material', `Material: ${spell.material}`));
  for (const p of spell.text ?? []) body.append(el('p', null, p));
  for (const p of spell.higher ?? []) body.append(el('p', 'higher', `At higher levels: ${p}`));
  // The index half of the job: no text means go and read the book, and the row
  // says which page rather than leaving a blank that reads as a missing spell.
  if (!spell.text?.length) body.append(el('p', 'lookup', `Not reproduced here — see ${cite}.`));

  row.append(body);
  return row;
}

// ---------------------------------------------------------------- wiring

const box = document.querySelector('#q');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const total = index.spells.length;

function update() {
  const { hits, refused, phrases } = index.search(box.value.trim());

  const notes = [`${hits.length} of ${total}`];
  for (const r of refused) {
    notes.push(
      `"${r.token}" ignored — ${r.field} is recorded on ${index.complete.get(r.field)}/${total} spells, so filtering on it would hide the rest`,
    );
  }
  if (phrases.length) {
    const words = phrases.map((p) => `${p.negated ? '-' : ''}"${p.text}"`).join(', ');
    const n = index.withoutText;
    notes.push(
      n
        ? `matching name and text: ${words} — ${n} spell${n === 1 ? '' : 's'} carr${n === 1 ? 'ies' : 'y'} no text here, so only ${n === 1 ? 'its name was' : 'their names were'} searched`
        : `matching name and text: ${words}`,
    );
  }

  status.replaceChildren(...notes.map((n, i) => el('div', i ? 'note' : 'count', n)));
  results.replaceChildren(...hits.map(render));
}

box.addEventListener('input', update);
box.focus();
update();
