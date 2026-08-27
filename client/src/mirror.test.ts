// The mirror: what the DM's own board loses when they ask to see the table's.
//
// Every assertion here is the same shape — something the DM holds is *not* in
// what comes back — because that is the only thing this function does. It is
// the client-side echo of the rule the server suite already works under: for a
// filter, what was withheld is the whole test.
//
// Nothing here is a security boundary and the tests are not pretending
// otherwise. A leak lives on the server; this is a DM misreading their own
// table's board, which is a different failure with the same shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Fog } from './fog.js';
import { asTable, tableInitiative, unseenByTable } from './mirror.js';
import type { Initiative } from './protocol.js';
import type { Board, Scene, Token } from './scene.js';
import type { Shape } from './shapes.js';
import type { Wall } from './walls.js';

/** A four by four board packed one character per cell, the way the server sends
 *  it: `.` in sight, `o` explored, `#` never seen. The lit square is cell (1, 1)
 *  and the remembered one is (2, 1). */
const CELLS = ['####', '#.o#', '####', '####'].join('');

function fog(over: Partial<Fog> = {}): Fog {
  return { x: 0, y: 0, w: 4, h: 4, cells: CELLS, shade: null, table: null, ...over };
}

function board(over: Partial<Board> = {}): Board {
  return {
    mapUrl: 'crypt.png',
    grid: { px: 10, offsetX: 0, offsetY: 0 },
    gridColor: '#ffffff33',
    playArea: null,
    fog: true,
    visionFt: 30,
    lighting: 'dynamic',
    ...over,
  };
}

/** A creature standing in the centre of cell `(cx, cy)`. The DM's unless a test
 *  says otherwise, since a player's own token is never the interesting case. */
function token(id: string, cx: number, cy: number, over: Partial<Token> = {}): Token {
  return {
    id,
    name: id,
    x: cx + 0.5,
    y: cy + 0.5,
    owner: { kind: 'dm' },
    img: '',
    size: 1,
    hidden: false,
    hp: null,
    stagedPos: null,
    stagedOnly: false,
    ...over,
  };
}

function wall(id: string): Wall {
  return { id, from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, door: null };
}

function shape(over: Partial<Shape> = {}): Shape {
  return {
    id: 's1',
    kind: 'circle',
    anchor: null,
    at: { x: 1.5, y: 1.5 },
    to: { x: 1, y: 0 },
    by: { kind: 'dm' },
    color: '#ff0000',
    ...over,
  };
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    live: board(),
    staged: null,
    previewing: false,
    tokens: [],
    shapes: [],
    walls: [],
    fog: fog(),
    overrides: { x: 0, y: 0, w: 4, h: 4, tint: null },
    showNames: true,
    diagonals: 'equal',
    showCursors: true,
    showDmCursor: true,
    backdrop: null,
    ...over,
  };
}

const ids = (s: Scene): string[] => s.tokens.map((t) => t.id);

test('a monster standing in the dark is not on the table’s board', () => {
  const s = scene({ tokens: [token('lit', 1, 1), token('dark', 3, 3)] });
  assert.deepEqual(ids(asTable(s)), ['lit']);
});

test('a cell the party only remembers does not hand over what is standing in it', () => {
  // The whole of "terrain gates on `known`, creatures gate on `visible`", asked
  // from the creature's side: cell (2, 1) is explored and not in sight.
  const s = scene({ tokens: [token('remembered', 2, 1)] });
  assert.deepEqual(ids(asTable(s)), []);
});

test('hidden and staged-only are still reasons, on a lit square and an unfogged map', () => {
  const lit = scene({
    tokens: [
      token('hidden', 1, 1, { hidden: true }),
      token('planned', 1, 1, { stagedOnly: true }),
      token('there', 1, 1),
    ],
  });
  assert.deepEqual(ids(asTable(lit)), ['there']);

  // Fog off is not "everything shows": two of the three reasons have nothing to
  // do with sight, which is why `unseen_by_table` funnels all three.
  const bright = scene({ live: board({ fog: false }), tokens: lit.tokens });
  assert.deepEqual(ids(asTable(bright)), ['there']);
});

test('a player’s own token is a vision source, so it is never in the dark', () => {
  const mine = token('rogue', 3, 3, { owner: { kind: 'player', id: 'rogue' } });
  assert.equal(unseenByTable(scene({ tokens: [mine] }), mine), false);
  // And the reason is ownership rather than the cell, which is what makes
  // handing a token over grant sight with no second rule.
  assert.equal(unseenByTable(scene({ tokens: [mine] }), { ...mine, owner: { kind: 'dm' } }), true);
});

test('an ogre leaning into a lit corridor is an ogre the party can see', () => {
  // A 2-cell token centred on the corner of cells (0,0)–(1,1): three of its four
  // squares are dark and the fourth is the lit one, and any is enough.
  const ogre = token('ogre', 0, 0, { size: 2, x: 1, y: 1 });
  assert.equal(unseenByTable(scene({ tokens: [ogre] }), ogre), false);

  // Moved one cell up and left, it covers nothing lit at all.
  const back = { ...ogre, x: 0, y: 0 };
  assert.equal(unseenByTable(scene({ tokens: [back] }), back), true);
});

test('what survives is redacted, field for field', () => {
  const s = scene({
    tokens: [
      token('boss', 1, 1, {
        hp: { current: 30, max: 44 },
        stagedPos: { x: 9, y: 9 },
      }),
    ],
  });

  const shown = asTable(s).tokens[0];
  assert.equal(shown?.hp, null);
  assert.equal(shown?.stagedPos, null);
  assert.equal(shown?.stagedOnly, false);
  assert.equal(shown?.hidden, false);
  // And nothing else is touched: the mirror is not a second place to decide
  // where a creature is standing.
  assert.equal(shown?.x, 1.5);
  assert.equal(shown?.name, 'boss');
});

test('the walls, the paint and the next dungeon all go', () => {
  const s = scene({
    walls: [wall('w1'), wall('w2')],
    overrides: { x: 0, y: 0, w: 4, h: 4, tint: null },
    staged: { ...board({ mapUrl: 'next.png' }), walls: [wall('w3')], overrides: { x: 0, y: 0, w: 0, h: 0, tint: null } },
    previewing: true,
  });

  const table = asTable(s);
  assert.deepEqual(table.walls, []);
  assert.equal(table.staged, null);
  assert.equal(table.previewing, false);
  assert.deepEqual(table.overrides, { x: 0, y: 0, w: 0, h: 0, tint: null });
  // The fog is not filtered at all — it is already the table's own answer, and
  // how faintly it draws is the renderer's business.
  assert.equal(table.fog, s.fog);
});

test('an aura on a monster in the dark goes with the monster', () => {
  const s = scene({
    tokens: [token('lit', 1, 1), token('dark', 3, 3)],
    shapes: [shape({ id: 'on-lit', anchor: 'lit' }), shape({ id: 'on-dark', anchor: 'dark' })],
  });
  assert.deepEqual(
    asTable(s).shapes.map((sh) => sh.id),
    ['on-lit'],
  );
});

test('a drawing on the floor gates on what has been explored, not on sight', () => {
  // Centred on the remembered cell, which no creature would survive standing in.
  const remembered = shape({ id: 'remembered', at: { x: 2.5, y: 1.5 }, to: { x: 0.2, y: 0 } });
  const unexplored = shape({ id: 'unexplored', at: { x: 3.5, y: 3.5 }, to: { x: 0.2, y: 0 } });

  const s = scene({ shapes: [remembered, unexplored] });
  assert.deepEqual(
    asTable(s).shapes.map((sh) => sh.id),
    ['remembered'],
  );
});

test('a line is the ground it is drawn across', () => {
  // A line encloses nothing, so the area test finds no cells at all and the walk
  // is the whole rule. This one starts in the dark and crosses the lit square.
  const across = shape({ id: 'across', kind: 'line', at: { x: 3.5, y: 1.5 }, to: { x: -2, y: 0 } });
  const away = shape({ id: 'away', kind: 'line', at: { x: 3.5, y: 3.5 }, to: { x: 0, y: -1 } });

  const s = scene({ shapes: [across, away] });
  assert.deepEqual(
    asTable(s).shapes.map((sh) => sh.id),
    ['across'],
  );
});

test('a row naming a creature the table cannot see goes, and the turn with it', () => {
  const s = scene({ tokens: [token('lit', 1, 1), token('dark', 3, 3)] });
  const order: Initiative = {
    entries: [
      { token: 'dark', value: 21 },
      { token: 'lit', value: 14 },
    ],
    current: 'dark',
    round: 3,
  };

  const table = tableInitiative(order, s);
  assert.deepEqual(table.entries, [{ token: 'lit', value: 14 }]);
  // Not merely cosmetic: a row the client has no token for draws as a raw id,
  // and `current` is an id like any other.
  assert.equal(table.current, null);
  assert.equal(table.round, 3);
  // The round the table is actually on, and the DM's own copy untouched.
  assert.equal(order.entries.length, 2);
  assert.equal(order.current, 'dark');
});

test('the mirror leaves the room’s own scene alone', () => {
  // It runs inside the frame loop, so a mirror that mutated what it was handed
  // would take the DM's board apart one frame after they asked to look at the
  // table's.
  const s = scene({
    tokens: [token('boss', 1, 1, { hp: { current: 30, max: 44 } }), token('dark', 3, 3)],
    walls: [wall('w1')],
    shapes: [shape({ anchor: 'dark' })],
  });

  asTable(s);

  assert.deepEqual(ids(s), ['boss', 'dark']);
  assert.deepEqual(s.tokens[0]?.hp, { current: 30, max: 44 });
  assert.equal(s.walls.length, 1);
  assert.equal(s.shapes.length, 1);
});
