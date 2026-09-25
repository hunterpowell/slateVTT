// The one pure piece of the roster editor: the id a new slot is given.
//
// The room checks every id is a slug and refuses the whole roster otherwise,
// so an id this made wrongly would be a DM who can't add a player, with a
// refusal that names an id they never typed. What the room refuses and why is
// in `server/src/room/tests/roster.rs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PLAYER_ID_LEN, slugFor } from './roster.js';

/** `is_slug` in server/src/room.rs, restated so a test can hold the two to one rule. */
const SLUG = /^[a-z0-9-]+$/;

test('a name becomes the lowercase, hyphenated id the chips show', () => {
  assert.equal(slugFor('Captain Bronzebeard', []), 'captain-bronzebeard');
  assert.equal(slugFor('  Iron  Beak!! ', []), 'iron-beak');
  assert.equal(slugFor("D'Artagnan", []), 'd-artagnan');
});

test('accents are folded, not dropped', () => {
  assert.equal(slugFor('Zoë', []), 'zoe');
  assert.equal(slugFor('Ínigo Montoya', []), 'inigo-montoya');
});

test('a name with nothing sluggable in it still gets an id', () => {
  assert.equal(slugFor('🐉', []), 'player');
  assert.equal(slugFor('---', []), 'player');
});

test('a clash gets a number rather than taking somebody else’s id', () => {
  assert.equal(slugFor('Ash', ['ash']), 'ash-2');
  assert.equal(slugFor('Ash', ['ash', 'ash-2']), 'ash-3');
  assert.equal(slugFor('🐉', ['player']), 'player-2');
});

test('a long name is cut to the length the room accepts, suffix included', () => {
  const long = 'The Most Honourable Lady Seraphina of the Western Marches';
  const id = slugFor(long, []);
  assert.ok(id.length <= MAX_PLAYER_ID_LEN, id);
  assert.ok(SLUG.test(id), id);
  assert.ok(!id.endsWith('-'), id);

  const again = slugFor(long, [id]);
  assert.ok(again.length <= MAX_PLAYER_ID_LEN, again);
  assert.notEqual(again, id);
  assert.ok(SLUG.test(again), again);
});

test('whatever the name, the id is one the room accepts', () => {
  for (const name of ['Saelyn', 'Player 6', 'ÆTHELRED', '李白', 'a/b\\c', 'x'.repeat(200)]) {
    const id = slugFor(name, []);
    assert.ok(SLUG.test(id), name);
    assert.ok(id.length > 0 && id.length <= MAX_PLAYER_ID_LEN, name);
  }
});
