// The one pure piece of the chat log: which rule, if any, goes above a line.
//
// The room stamps each line with its round (`server/src/room/tests/chat.rs`);
// this decides what the log draws from two of them. Whether a refreshed log
// draws the same rules as a live one is the browser's question, in
// `tools/drive-chat.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { roundRule } from './chat.js';

// [round of the line above (null for none, or the first line), this line's round, rule]
const CASES: [number | null, number | null, string | null][] = [
  // Outside a fight there is nothing to mark.
  [null, null, null],
  // The first line of a fight, whether or not anything was said before it.
  [null, 1, 'Round 1'],
  // The same round: one rule, at its first line.
  [1, 1, null],
  [3, 3, null],
  // The next round.
  [1, 2, 'Round 2'],
  // A round nobody spoke in is skipped, not drawn empty.
  [2, 4, 'Round 4'],
  // The DM stepped back a round.
  [3, 2, 'Round 2'],
  // The fight ended, so talk after it isn't read as the last round's.
  [3, null, 'End of combat'],
  // A new fight straight after one, with nothing said between.
  [3, 1, 'Round 1'],
];

for (const [above, round, rule] of CASES) {
  test(`a line in round ${round} under one in round ${above} gets ${rule ?? 'no rule'}`, () => {
    assert.equal(roundRule(above, round), rule);
  });
}

test('two fights that both end and start on round 1 share a rule, and that is accepted', () => {
  // The log only has round numbers, so the second fight's first line looks
  // like more of the first fight's round 1.
  assert.equal(roundRule(1, 1), null);
});
