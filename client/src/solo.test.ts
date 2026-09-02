// Solo sight: what one creature can see, computed on the DM's client.
//
// The two modes and the union between them, which is the invariant that would
// break silently — `Room` losing its raycast half looks like a working feature
// right up until somebody stands in a doorway.
//
// Everything here is in image pixels except the token, which is in grid units
// like every other token in this project.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { soloSight } from './solo.js';
import type { Board, Token } from './scene.js';
import type { Wall } from './walls.js';
import { squareGrid } from './coords.js';

/** Ten pixels a cell, no offset, so cell `c` spans `10c` to `10c + 10` and its
 *  centre is at `10c + 5`. The same grid `overrides.test.ts` uses. */
const GRID = squareGrid(10, 0, 0);
/** Nine by nine, so a token in the middle at cell 4 has four cells of room in
 *  every direction. */
const SIZE = { w: 90, h: 90 };

function wall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, door: null };
}

function door(id: string, open: boolean, x1: number, y1: number, x2: number, y2: number): Wall {
  return { ...wall(id, x1, y1, x2, y2), door: open };
}

function board(over: Partial<Board> = {}): Board {
  return {
    mapUrl: 'dungeon.png',
    grid: GRID,
    gridColor: '#ffffff33',
    playArea: null,
    fog: true,
    // Fifty feet is ten cells, which is wider than this board — so the radius is
    // never what bounds anything unless a test says so.
    visionFt: 50,
    lighting: 'dynamic',
    ...over,
  };
}

/** A creature standing in the centre of cell `(cx, cy)`, carrying `lightFt`. */
function token(cx: number, cy: number, lightFt: number | null = null): Token {
  return {
    id: 't1',
    name: 'Rogue',
    x: cx + 0.5,
    y: cy + 0.5,
    owner: { kind: 'dm' },
    img: '',
    size: 1,
    hidden: false,
    hp: null,
    lightFt,
    stagedPos: null,
    stagedOnly: false,
  };
}

/** Which cells came back lit, as `"x,y"`. */
function lit(fog: ReturnType<typeof soloSight>): Set<string> {
  const out = new Set<string>();
  if (fog === null) return out;
  for (let i = 0; i < fog.w * fog.h; i++) {
    if (fog.cells[i] !== '.') continue;
    out.add(`${fog.x + (i % fog.w)},${fog.y + Math.floor(i / fog.w)}`);
  }
  return out;
}

test('an untraced board is lit to the radius and no further', () => {
  // Two cells of reach, so cell 4 sees 2, 3, 5 and 6 along a row and not 7.
  const seen = lit(soloSight(token(4, 4), board({ visionFt: 10 }), [], SIZE));
  assert.ok(seen.has('4,4'), 'its own square');
  assert.ok(seen.has('6,4'), 'two cells out');
  assert.ok(!seen.has('7,4'), 'three cells out is past the radius');
  // Euclidean, so the corner of the bounding box is outside the circle: two
  // cells diagonally is 2.83 cells away. A radius of light is a circle, which
  // agrees with a drawn circle and not with the movement ruler.
  assert.ok(!seen.has('6,6'), 'the reach is a circle and not a square');
});

test('a token carrying a light sees by that and not by the map', () => {
  // `fog::Source::radius_cells` on the server, asked of the DM's own raycast:
  // the sight check has to answer the question the fog it stands in for
  // answers, and since milestone 39 that question has a per-token radius in it.
  const dim = board({ visionFt: 10 });
  assert.ok(!lit(soloSight(token(4, 4), dim, [], SIZE)).has('7,4'), 'two cells');

  const carrying = lit(soloSight(token(4, 4, 30), dim, [], SIZE));
  assert.ok(carrying.has('7,4'), 'six cells by its own lantern');
  assert.ok(
    lit(soloSight(token(4, 4, 5), board({ visionFt: 100 }), [], SIZE)).size <
      lit(soloSight(token(4, 4), board({ visionFt: 100 }), [], SIZE)).size,
    'and it replaces the map\'s number rather than widening it',
  );
});

test('the circle is the same on both sides of the viewer', () => {
  // The server's `the_circle_is_the_same_on_both_sides_of_the_viewer`, asked of
  // the DM's own raycast so the sight check cannot disagree with the fog it is
  // previewing. A radius set in feet is a whole number of cells, so the cells at
  // exactly that distance sit exactly on the circle — and measured in pixels the
  // two sides of that tie rounded apart, dropping a cell off one edge. The ten
  // pixel grid the rest of this file uses is exact and hides it, so these are the
  // awkward numbers a real map calibrates to.
  for (const px of [35.65, 72.3, 28.4]) {
    for (const [offsetX, offsetY] of [
      [0, 0],
      [7, 13.5],
    ] as const) {
      for (const visionFt of [20, 25, 30]) {
        const grid = squareGrid(px, offsetX, offsetY);
        // Room enough that nothing is clipped by the edge of the board, which is
        // the other thing that can make the answer lopsided and is meant to.
        const size = { w: offsetX + px * 41, h: offsetY + px * 41 };
        const cell = 20;
        const seen = lit(soloSight(token(cell, cell), board({ grid, visionFt }), [], size));
        for (const key of seen) {
          const [x, y] = key.split(',').map(Number) as [number, number];
          for (const mirror of [
            `${2 * cell - x},${y}`,
            `${x},${2 * cell - y}`,
            `${2 * cell - x},${2 * cell - y}`,
          ]) {
            assert.ok(seen.has(mirror), `${px}px grid, ${visionFt}ft: ${key} is lit and ${mirror} is not`);
          }
        }
      }
    }
  }
});

test('a solid wall stops sight past it', () => {
  // Along the boundary between cells 5 and 6, which is where `snapToCorner` puts
  // most masonry: it runs between cell centres and never through one.
  const walls = [wall('w', 60, 0, 60, 90)];
  const seen = lit(soloSight(token(4, 4), board(), walls, SIZE));
  assert.ok(seen.has('5,4'), 'the floor this side of it');
  assert.ok(!seen.has('6,4'), 'nothing past it');
  assert.ok(!seen.has('8,4'), 'and nothing further past it');
});

test('a shut door stops sight and an open one does not', () => {
  const shut = [door('d', false, 60, 0, 60, 90)];
  const open = [door('d', true, 60, 0, 60, 90)];
  assert.ok(!lit(soloSight(token(4, 4), board(), shut, SIZE)).has('6,4'), 'shut');
  assert.ok(lit(soloSight(token(4, 4), board(), open, SIZE)).has('6,4'), 'open');
});

test('room lighting can never show less than sight does', () => {
  // The union is the whole of milestone 21's correction: *you see the whole room
  // you are standing in, plus whatever you have a straight line to*. Losing the
  // raycast half is the failure this test exists for — it looks like a working
  // feature until a creature stands in a doorway, where the flood gives the
  // doorway up and only the rays reach through it.
  const walls = [door('d', true, 60, 0, 60, 90)];
  const dynamic = lit(soloSight(token(4, 4), board(), walls, SIZE));
  const room = lit(soloSight(token(4, 4), board({ lighting: 'room' }), walls, SIZE));
  assert.ok(dynamic.size > 0, 'the raycast found something to compare against');
  for (const cell of dynamic) {
    assert.ok(room.has(cell), `room lighting dropped ${cell}`);
  }
});

test('an open door bounds the flood, so room lighting reaches past it by ray alone', () => {
  // An archway is a door left open: it blocks nothing the party does and it
  // still bounds a room, which is what stops a one-cell gap handing over the
  // whole chamber behind it. What gets through is the wedge the rays reach.
  const walls = [
    wall('n', 60, 0, 60, 40),
    door('arch', true, 60, 40, 60, 50),
    wall('s', 60, 50, 60, 90),
  ];
  const room = lit(soloSight(token(0, 4), board({ lighting: 'room' }), walls, SIZE));
  assert.ok(room.has('5,4'), 'the near side of the archway');
  assert.ok(room.has('6,4'), 'the wedge visible straight through it');
  // Off the axis and behind the masonry: the flood cannot get there, because the
  // archway bounds it, and no ray can either.
  assert.ok(!room.has('6,0'), 'the flood did not escape into the far room');
  assert.ok(!room.has('8,8'), 'nor into the far corner of it');
});

test('the radius bounds the flood as well as the walls', () => {
  // A pure fill does not respect corners — walk into a winding corridor and the
  // whole of it lights to its far end. Bounding by the radius is what keeps
  // `visionFt` meaningful in both modes rather than dead in one.
  const seen = lit(soloSight(token(4, 4), board({ lighting: 'room', visionFt: 10 }), [], SIZE));
  assert.ok(seen.has('6,4'), 'two cells out');
  assert.ok(!seen.has('7,4'), 'the flood stops at the radius like the rays do');
});

test('the play area clips the answer', () => {
  const seen = lit(
    soloSight(token(4, 4), board({ playArea: { x: 0, y: 0, w: 50, h: 50 } }), [], SIZE),
  );
  assert.ok(seen.has('4,4'));
  assert.ok(!seen.has('6,4'), 'nothing outside the play area is somewhere to be');
});

test('no map size is no answer, rather than a wrong one', () => {
  assert.equal(soloSight(token(4, 4), board(), [], null), null);
});

test('every cell is dark or in sight, and never explored', () => {
  // Two states rather than three: the question is what this creature's eyes
  // reach now, not what the party remembers. Nothing here reads `revealed`.
  const fog = soloSight(token(4, 4), board(), [], SIZE);
  assert.notEqual(fog, null);
  assert.ok(fog !== null && /^[#.]+$/.test(fog.cells), fog?.cells);
  assert.equal(fog?.cells.length, (fog?.w ?? 0) * (fog?.h ?? 0));
});
