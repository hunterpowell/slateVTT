// Which tokens a box gathers. The drag that draws the box is `drive-select.mjs`'s;
// this is the rule it applies on release.
//
// The permission check is the one to watch. A box gathering a token the client
// can't move would put it in a group drag the server then refuses one frame at
// a time, and `canMove` is the only thing standing between a player's box and
// the ogre.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { squareGrid } from './coords.js';
import type { Identity } from './identity.js';
import { inMarquee } from './marquee.js';
import type { Board, Scene, Token } from './scene.js';

const DM: Identity = { isDm: true, playerId: null };
const ARA: Identity = { isDm: false, playerId: 'ara' };

/** Ten-pixel cells, so a cell's centre is at `10 * cell + 5`. */
function board(over: Partial<Board> = {}): Board {
  return {
    mapUrl: 'crypt.png',
    grid: squareGrid(10, 0, 0),
    gridColor: '#ffffff33',
    playArea: null,
    fog: false,
    visionFt: 30,
    lighting: 'dynamic',
    ...over,
  };
}

/** A creature standing in the centre of cell `(cx, cy)`, the DM's unless a test
 *  says otherwise. */
function token(id: string, cx: number, cy: number, over: Partial<Token> = {}): Token {
  return {
    id,
    name: id,
    x: cx + 0.5,
    y: cy + 0.5,
    owner: { kind: 'dm' },
    img: '',
    size: 1,
    markers: [],
    hidden: false,
    hp: null,
    lightFt: null,
    stagedPos: null,
    stagedOnly: false,
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
    fog: null,
    overrides: { x: 0, y: 0, w: 0, h: 0, tint: null },
    showNames: true,
    diagonals: 'equal',
    showCursors: true,
    showDmCursor: true,
    backdrop: null,
    audio: null,
    ...over,
  };
}

test('a token is in when its centre is, whichever corner the drag began at', () => {
  const s = scene({ tokens: [token('in', 1, 1), token('out', 3, 1)] });
  // Centres at (15, 15) and (35, 15). Dragged down-right and up-left, the same box.
  assert.deepEqual(inMarquee(s, DM, { x: 8, y: 8 }, { x: 22, y: 22 }), ['in']);
  assert.deepEqual(inMarquee(s, DM, { x: 22, y: 22 }, { x: 8, y: 8 }), ['in']);
});

test('a box over a token’s edge but short of its centre misses it', () => {
  // A large creature's body reaches well past its centre. Catching it by the
  // rim would gather the ogre next to every goblin boxed beside it.
  const s = scene({ tokens: [token('ogre', 2, 2, { size: 3 })] });
  assert.deepEqual(inMarquee(s, DM, { x: 0, y: 0 }, { x: 20, y: 20 }), []);
  assert.deepEqual(inMarquee(s, DM, { x: 0, y: 0 }, { x: 30, y: 30 }), ['ogre']);
});

test('a player’s box gathers only their own tokens', () => {
  const s = scene({
    tokens: [
      token('mine', 1, 1, { owner: { kind: 'player', id: 'ara' } }),
      token('theirs', 1, 1, { owner: { kind: 'player', id: 'bren' } }),
      token('ogre', 1, 1),
    ],
  });
  assert.deepEqual(inMarquee(s, ARA, { x: 0, y: 0 }, { x: 40, y: 40 }), ['mine']);
  assert.deepEqual(inMarquee(s, DM, { x: 0, y: 0 }, { x: 40, y: 40 }), ['mine', 'theirs', 'ogre']);
});

test('over a preview the box reads the staged plan, and skips what is off the board', () => {
  const staged = { ...board(), walls: [], overrides: { x: 0, y: 0, w: 0, h: 0, tint: null } };
  const tokens = [
    // Standing at (1, 1) on the live board, planned for (3, 3) on the next one.
    token('planned', 1, 1, { stagedPos: { x: 3.5, y: 3.5 } }),
    // Only on the staged map.
    token('arriving', 3, 3, { stagedOnly: true }),
  ];

  const live = scene({ tokens, staged });
  assert.deepEqual(inMarquee(live, DM, { x: 0, y: 0 }, { x: 20, y: 20 }), ['planned']);
  assert.deepEqual(inMarquee(live, DM, { x: 30, y: 30 }, { x: 40, y: 40 }), []);

  const previewing = scene({ tokens, staged, previewing: true });
  assert.deepEqual(inMarquee(previewing, DM, { x: 0, y: 0 }, { x: 20, y: 20 }), []);
  assert.deepEqual(inMarquee(previewing, DM, { x: 30, y: 30 }, { x: 40, y: 40 }), [
    'planned',
    'arriving',
  ]);
});
