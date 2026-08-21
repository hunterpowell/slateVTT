// The search, driven against the real index.
//
// Two kinds of assertion live here. The ordinary ones check that a query returns
// what it should. The one that matters checks what a query **refuses** to
// return: a filter over a half-recorded field would answer with a short list
// that looks complete, and nobody catches that at the table.
//
//   node --test client/spells/

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createIndex, merge } from './query.js';
import * as vocab from './vocab.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));

const srd = read('srd.json');
const index = createIndex(merge(srd, read('extra.json')));
const names = (q) => index.search(q).hits.map((s) => s.name);

// The SRD alone, which records every tier-B field on every entry it holds.
// Two tests below are about the **query language** rather than about the shipped
// data, and while `extra.json` is half-typed the completeness gate refuses their
// tokens before the rule they check is ever reached — so they would pass or fail
// on how far the typing has got, which is not what they are asking.
const whole = createIndex(srd);
const wholeNames = (q) => whole.search(q).hits.map((s) => s.name);

test('a bare word falls through to name and text', () => {
  assert.ok(names('fireball').includes('Fireball'));
});

test('level, class and school narrow together', () => {
  const hits = index.search('wiz 3 evocation').hits;
  assert.ok(hits.length > 0);
  for (const s of hits) {
    assert.equal(s.level, 3);
    assert.equal(s.school, 'evocation');
    assert.ok(s.classes.includes('wizard'));
  }
});

test('classes and schools take a prefix', () => {
  assert.deepEqual(names('wiz 3 evoc'), names('wizard 3 evocation'));
  assert.deepEqual(names('necro cantrip'), names('necromancy 0'));
});

test('an ambiguous prefix is a text search, not a wrong guess', () => {
  // `co` could be conjuration, cold, cone or con — so it matches none of them
  // and searches the prose instead, where it turns up far more than four spells.
  const { hits, phrases } = index.search('co');
  assert.equal(phrases.length, 1);
  assert.ok(hits.length > 50);
});

test('exact beats prefix, so `con` and `conc` stay distinct', () => {
  for (const s of whole.search('con').hits) assert.equal(s.save, 'con');
  for (const s of whole.search('conc').hits) assert.equal(s.conc, true);
  assert.notDeepEqual(wholeNames('con'), wholeNames('conc'));
});

test('same field ORs and different fields AND', () => {
  const fire = new Set(names('fire'));
  const cold = new Set(names('cold'));
  const both = new Set(names('fire cold'));
  assert.equal(both.size, new Set([...fire, ...cold]).size);
  for (const n of fire) assert.ok(both.has(n));

  const narrowed = index.search('fire cold bard').hits;
  for (const s of narrowed) assert.ok(s.classes.includes('bard'));
});

test('a leading dash negates', () => {
  const hits = index.search('sor 2 -conc').hits;
  // Assert the query is not empty first: every check below is a loop over it, and
  // a query that matches nothing passes all of them without running once.
  assert.ok(hits.length > 0, 'the sample query must match something');
  for (const s of hits) {
    assert.equal(s.conc, false);
    assert.equal(s.level, 2);
    assert.ok(s.classes.includes('sorcerer'));
  }
  // On `whole`, because a negated token the gate refuses is simply dropped —
  // Fireball would survive `-fire` for a reason that is not negation.
  assert.ok(wholeNames('evocation').includes('Fireball'));
  assert.ok(!wholeNames('evocation -fire').includes('Fireball'));
});

test('a bonus-action query works, and the SRD simply has few', () => {
  const bonus = index.search('bonus').hits;
  assert.ok(bonus.length > 0);
  for (const s of bonus) assert.equal(s.time, 'bonus');
  assert.deepEqual(names('cleric 1 bonus').sort(), ['Healing Word', 'Sanctuary', 'Shield of Faith']);
});

test('a quoted phrase stays one token and is never a keyword', () => {
  const quoted = index.search('"difficult terrain"');
  assert.equal(quoted.phrases.length, 1);
  assert.equal(quoted.phrases[0].text, 'difficult terrain');
  assert.ok(quoted.hits.length > 0);

  // `fire` is a damage keyword bare, and a phrase when quoted.
  assert.notDeepEqual(names('fire'), names('"fire"'));
});

test('the gate tells the truth about every tier-B field', () => {
  // Deliberately not "every field is recorded". Which of them `extra.json` has
  // finished is data and moves as the typing goes on; what must hold whatever
  // it says is that the gate agrees with it — a field every entry records
  // filters, and a field with one gap in it is refused rather than quietly
  // answering with a short list. Both branches run against the shipped data.
  const probe = { save: 'wis', attack: 'attack', damage: 'fire', area: 'cone' };
  let live = 0;
  let refused = 0;
  for (const field of vocab.TIER_B) {
    const recorded = index.spells.filter((s) => s[field] !== undefined).length;
    assert.equal(index.complete.get(field), recorded, `${field} miscounted`);
    assert.equal(index.isComplete(field), recorded === index.spells.length);

    const got = index.search(probe[field]).refused;
    if (index.isComplete(field)) {
      live++;
      assert.deepEqual(got, [], `"${probe[field]}" should filter`);
    } else {
      refused++;
      assert.deepEqual(got, [{ token: probe[field], field }]);
    }
  }
  // A gate that had drifted to always-open or always-shut would pass every
  // assertion above, so say that today's data exercises both ways through it.
  assert.ok(live > 0 && refused > 0, `${live} live, ${refused} refused`);
});

test('a filter over a half-recorded field is refused, not silently narrowed', () => {
  // One hand-typed entry with no `damage` key is enough to make the whole field
  // incomplete — which is the point. `null` and `[]` are recorded facts;
  // a missing key is "not typed yet".
  const untyped = {
    name: 'Toll the Dead',
    level: 0,
    school: 'necromancy',
    classes: ['cleric', 'warlock', 'wizard'],
    time: 'action',
    trigger: null,
    range: { kind: 'ranged', feet: 60 },
    components: 'VS',
    material: null,
    duration: 'Instantaneous',
    conc: false,
    ritual: false,
    src: { book: 'XGE', page: 169 },
  };
  const partial = createIndex(merge(srd, [untyped]));

  assert.equal(partial.isComplete('damage'), false);
  const { hits, refused } = partial.search('fire');
  assert.deepEqual(
    refused.map((r) => r.field),
    ['damage'],
  );
  // Refused means the token is dropped, not that the query returns a subset.
  assert.equal(hits.length, partial.spells.length);
  assert.equal(partial.complete.get('damage'), partial.spells.length - 1);

  // A tier-A filter is unaffected by a missing tier-B field.
  assert.ok(partial.search('xge').hits.some((s) => s.name === 'Toll the Dead'));
});

test('a hand-typed entry replaces the SRD one of the same name', () => {
  const fireball = srd.find((s) => s.name === 'Fireball');
  const patched = { ...fireball, classes: [...fireball.classes, 'artificer'].sort() };
  const overridden = createIndex(merge(srd, [patched]));

  assert.equal(overridden.spells.length, srd.length, 'override must not add a row');
  assert.ok(overridden.search('artificer').hits.some((s) => s.name === 'Fireball'));
  assert.ok(!index.search('artificer').hits.some((s) => s.name === 'Fireball'));
});

test('the PHB name finds a spell the SRD renamed', () => {
  // The failure without this: the spell is present, so "no results" reads as
  // "this tool does not have Bigby's Hand" rather than "look under Arcane Hand".
  for (const [typed, actual] of [
    ['bigby', 'Arcane Hand'],
    ['tasha', 'Hideous Laughter'],
    ['evard', 'Black Tentacles'],
    ['melf', 'Acid Arrow'],
    ['leomund', 'Tiny Hut'],
    ['otiluke', 'Resilient Sphere'],
    ['otto', 'Irresistible Dance'],
    ['nystul', "Arcanist's Magic Aura"],
    ['tenser', 'Floating Disk'],
    ['drawmij', 'Instant Summons'],
    ['rary', 'Telepathic Bond'],
  ]) {
    assert.ok(names(typed).includes(actual), `${typed} should find ${actual}`);
  }
});

test('every alias points at a spell that exists', () => {
  const present = new Set(index.spells.map((s) => s.name));
  for (const s of index.spells) {
    for (const a of s.alias ?? []) {
      assert.equal(typeof a, 'string');
      assert.ok(present.has(s.name));
      assert.notEqual(a, s.name, 'an alias identical to the name buys nothing');
    }
  }
});

test('hand-typed drafts are marked unchecked and SRD entries are not', () => {
  // Every hand-typed entry answers the question, either way. `verified` has no
  // default on purpose — both possible ones are wrong — so a missing key is the
  // failure, not a `false`.
  for (const s of read('extra.json')) {
    assert.equal(typeof s.verified, 'boolean', `${s.name} must say whether it was checked`);
  }
  const drafts = index.spells.filter((s) => s.verified === false);
  assert.ok(drafts.length > 0, 'the drafts should be present');
  // Nothing from the SRD may be marked unchecked — Wizards wrote it. Only the
  // SRD half carries text here, since `text.json` is not committed.
  for (const s of index.spells) {
    if (s.text?.length) assert.notEqual(s.verified, false);
  }
});

test('the drafts fill real gaps rather than shadowing SRD entries', () => {
  assert.ok(names('hex').includes('Hex'));
  assert.ok(names('warlock 1').includes('Armor of Agathys'));
  // Smites are the gap a paladin notices first.
  const smites = names('paladin bonus').filter((n) => n.endsWith('Smite'));
  assert.ok(smites.length >= 6, `expected several smites, got ${smites.join(', ')}`);
});

test('spells with no text are searchable by name alone', () => {
  const indexOnly = {
    name: 'Dissonant Whispers',
    level: 1,
    school: 'enchantment',
    classes: ['bard'],
    time: 'action',
    trigger: null,
    range: { kind: 'ranged', feet: 60 },
    components: 'V',
    material: null,
    duration: 'Instantaneous',
    conc: false,
    ritual: false,
    src: { book: 'PHB', page: 234 },
    save: 'wis',
    attack: null,
    damage: ['psychic'],
    area: null,
  };
  const mixed = createIndex(merge(srd, [indexOnly]));
  assert.equal(mixed.withoutText, 1);
  assert.ok(mixed.search('dissonant').hits.some((s) => s.name === 'Dissonant Whispers'));
});
