// What the DM's damage box accepts.
//
// The box is the one place in this client where a typed string decides how much
// a creature is hurt, so the grammar is worth pinning down rather than leaving
// to a regex nobody reads. Everything else about the panel needs a DOM and is
// `tools/drive-panels.mjs`'s job.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHpEntry } from './panel.js';

test('a signed entry is a delta against the row', () => {
  assert.equal(parseHpEntry('-12', 27), 15);
  assert.equal(parseHpEntry('+7', 15), 22);
  // Damage past zero is not refused: the server allows a negative total and
  // "a creature cannot go below zero" is rules knowledge this does not have.
  assert.equal(parseHpEntry('-30', 12), -18);
  // Healing past the maximum is not refused either, for the same reason. The
  // bar clamps its drawing; the number is the DM's.
  assert.equal(parseHpEntry('+40', 20), 60);
});

test('a bare entry is the new total', () => {
  assert.equal(parseHpEntry('35', 27), 35);
  assert.equal(parseHpEntry('0', 27), 0);
});

test('a sign with no digits after it is nothing, not zero', () => {
  // `-0` and `+0` are legal deltas that happen to change nothing; `-` alone is
  // half a thought, and sending the row's own number back for it would be a
  // command nobody asked for.
  assert.equal(parseHpEntry('-0', 27), 27);
  assert.equal(parseHpEntry('+0', 27), 27);
  assert.equal(parseHpEntry('-', 27), null);
  assert.equal(parseHpEntry('+', 27), null);
});

test('surrounding space is trimmed, inner space is not', () => {
  assert.equal(parseHpEntry('  -6  ', 20), 14);
  assert.equal(parseHpEntry('- 6', 20), null);
});

test('anything that is not one of the three forms says nothing', () => {
  // `null` rather than a guess, which is `valueField`'s rule beside it: put the
  // row back rather than send the server something it would have to interpret.
  for (const junk of ['', '   ', '--6', '6-', '1.5', '-1.5', 'abc', '12abc', '1e3', '٤']) {
    assert.equal(parseHpEntry(junk, 27), null, `expected ${JSON.stringify(junk)} to be refused`);
  }
});
