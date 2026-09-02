// The board as the table is looking at it, on the DM's own screen.
//
// **The client-side twin of `snapshot_for`, and nothing else in this project
// stands in for that function.** The DM holds more of the room than anybody
// else — the walls, their own painted squares, the monster in the unlit
// chamber, every hit point total — and the whole of that is drawn on their board
// on purpose, because it is the board they are playing on. What it costs them is
// the one thing the six other screens have for free: knowing what those screens
// are showing.
//
// `solo.ts` answers the narrow half of that question — can *this creature* see
// it — and this answers the broad one. The two are siblings and neither is the
// other: solo sight is a second raycast asking about one pair of eyes, and this
// is no raycast at all. It is the party's own fog, which the DM was already
// sent, with everything the server would have withheld taken back out of the
// scene around it.
//
// **It earns its keep because the fog is party-shared.** There is exactly one
// answer to "what can the table see", so a mirror of it is a fact rather than a
// guess — six players do not have six different boards to choose between. If
// milestone 29 ever makes `visible` per-player, this is the file that has to
// grow a name in it, and that is the argument this feature would have to be
// re-made under.
//
// **Client-only, and nothing goes in the room.** No command, no event, no
// filter — the server does not know the DM is looking at this and must not
// learn, which is `solo.ts`'s rule and `previewing`'s before it. Nothing here is
// a security boundary: it *removes* things the DM is entitled to and is entitled
// to put back. The server is still the only thing deciding what any other client
// holds, and every line of this could be wrong without a player learning
// anything.
//
// **It is a mirror, so it does not annotate.** Nothing is marked as withheld,
// dimmed or outlined — a board that says "and here is what they cannot see" is
// the DM's board again, which they can already have by turning this off.
// `docs/tokens.md` says the same thing about the live board's refusal to mark a
// planned token: a mirror with annotations is not a mirror.
//
// Read `docs/fog.md` before changing what this withholds.

import { cellKnown, cellVisible } from './fog.js';
import type { Fog } from './fog.js';
import type { Overrides } from './overrides.js';
import type { Initiative } from './protocol.js';
import type { Scene, Token } from './scene.js';
import type { Shape } from './shapes.js';
import { MAX_SHAPE_CELLS, coveredCells, isArea } from './shapes.js';

/** Nothing painted at all, which is what a player's copy always is. */
const NO_OVERRIDES: Overrides = { x: 0, y: 0, w: 0, h: 0, tint: null };

/**
 * The scene a player would have been handed, built from the one the DM holds.
 *
 * Every line of this has a counterpart on the server, named in the comment
 * beside it. What it does *not* touch is as deliberate: the map, the grid, the
 * room-wide switches and the fog itself are identical for every recipient, so a
 * mirror that changed them would be lying in the other direction.
 *
 * The fog staying exactly as it arrived looks like an omission and is the point.
 * It is already the table's own answer; the DM's copy differs only in how
 * faintly it is *drawn*, and that difference belongs to the renderer — see
 * `Fog.table` and `drawFog`. This decides what is on the board, not how dark it
 * is.
 */
export function asTable(scene: Scene): Scene {
  const shown = scene.tokens.filter((token) => !unseenByTable(scene, token)).map(redact);
  const ids = new Set(shown.map((token) => token.id));

  return {
    ...scene,
    // A player is never previewing, because they are never sent a staged board
    // to preview. One null withholds the next dungeon's image, its walls and its
    // paint together here exactly as it does on the wire.
    previewing: false,
    staged: null,
    tokens: shown,
    shapes: scene.shapes.filter((shape) => shapeSeen(scene, ids, shape)),
    // `WallsChanged`'s rule rather than the fog's: the geometry is the secret
    // and the shadow it casts is what the table plays with. Empty is also what
    // an untraced map looks like, which is what makes this indistinguishable
    // from the real thing rather than merely emptied.
    walls: [],
    // The DM's own hand, and the walls' rule again: what the table gets of it is
    // the fog, which is already on the board underneath it.
    overrides: NO_OVERRIDES,
  };
}

/**
 * The turn order as the table holds it — `initiative_for` on the server.
 *
 * The panel names its rows by looking each token up in the scene, so mirroring
 * the scene without this leaves a row drawing as a raw id: a monster the DM hid,
 * advertised by the one panel that is always on screen. That is the exact
 * failure the server's version exists to prevent, and it is why `current` goes
 * with the row rather than staying behind.
 */
export function tableInitiative(initiative: Initiative, scene: Scene): Initiative {
  const unseen = new Set(
    scene.tokens.filter((token) => unseenByTable(scene, token)).map((token) => token.id),
  );
  if (unseen.size === 0) return initiative;

  const current = initiative.current;
  return {
    entries: initiative.entries.filter((entry) => !unseen.has(entry.token)),
    current: current !== null && unseen.has(current) ? null : current,
    round: initiative.round,
  };
}

/**
 * Whether the table cannot see this token at all — `unseen_by_table`, which is
 * the only question any filter on the server asks.
 *
 * The same three reasons compose here as there, and they sit on the scene rather
 * than on the token for the same reason: two are facts about the creature and
 * the third is a fact about where everybody is standing.
 */
export function unseenByTable(scene: Scene, token: Token): boolean {
  return token.hidden || token.stagedOnly || !inSight(scene, token);
}

/**
 * Whether the party has line of sight on this token — `in_sight`, shortcut
 * included: a player's own token is a vision source, so the cell it stands in is
 * lit by it and there is nothing to test.
 *
 * The live board, never `shownBoard`. This is a question about the map the table
 * is looking at, which is also why the panel greys the button over a preview.
 *
 * A monster is in sight if *any* cell it covers is, so an ogre leaning into a
 * lit corridor is an ogre the party can see. A map that claims to be fogged with
 * no fog in hand answers "unseen", which shows the DM less than the table has —
 * the safe direction for a mirror, where the failure that matters is a DM who
 * believes they got away with something.
 */
function inSight(scene: Scene, token: Token): boolean {
  if (!scene.live.fog || token.owner.kind === 'player') return true;
  const fog: Fog | null = scene.fog;
  if (fog === null) return false;
  return footprint(token).some(([cx, cy]) => cellVisible(fog, cx, cy));
}

/**
 * The cells a token covers — `fog::covered_cells`, nudge included.
 *
 * A token's edges land exactly on grid lines, so the floors are deciding an
 * exact tie at both ends; the nudge is what keeps a 2-cell token at (4, 4)
 * covering cells 3 and 4 rather than 3, 4 and 5. A half-size token covers the
 * one cell it stands in, which is what the `max` says.
 */
function footprint(token: Token): [number, number][] {
  const half = Math.max(token.size, 1) / 2;
  const slack = 1e-4;
  const x0 = Math.floor(token.x - half + slack);
  const x1 = Math.floor(token.x + half - slack);
  const y0 = Math.floor(token.y - half + slack);
  const y1 = Math.floor(token.y + half - slack);

  const cells: [number, number][] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) cells.push([cx, cy]);
  }
  return cells;
}

/**
 * Whether a drawing survives the filter — `shape_seen`, both halves.
 *
 * An anchored shape goes with its token, so an aura on a monster in the dark
 * needs no rule of its own. An unanchored one gates on `known` rather than on
 * `visible`, because a drawing is painted on the floor rather than standing on
 * it — it belongs with the terrain, fringe and all.
 */
function shapeSeen(scene: Scene, shown: ReadonlySet<string>, shape: Shape): boolean {
  if (shape.anchor !== null) return shown.has(shape.anchor);
  if (!scene.live.fog) return true;
  const fog = scene.fog;
  if (fog === null) return false;

  // A line encloses nothing, so `containsPoint` is false everywhere along one
  // and `coveredCells` returns none at all. What a line covers is the ground it
  // is drawn across, which is a walk rather than a test — `line_cells` on the
  // server, sampled twice per cell so a shallow diagonal steps over none of it.
  if (!isArea(shape.kind)) {
    const length = Math.min(Math.hypot(shape.to.x, shape.to.y), MAX_SHAPE_CELLS);
    const steps = Math.max(Math.ceil(length * 2), 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.floor(shape.at.x + shape.to.x * t);
      const cy = Math.floor(shape.at.y + shape.to.y * t);
      if (cellKnown(fog, cx, cy)) return true;
    }
    return false;
  }

  const cells = coveredCells(shape.kind, shape.at, shape.to);
  for (let i = 0; i < cells.length; i += 2) {
    if (cellKnown(fog, cells[i] ?? 0, cells[i + 1] ?? 0)) return true;
  }
  return false;
}

/**
 * The copy a player is handed — `Token::view_for(false)`, field for field.
 *
 * `hidden` is not redacted there either: a hidden token is dropped before this
 * is reached, so the flag is always false by the time anything reads it. Said
 * here rather than assumed, because the two lines that make it true are one
 * `filter` away and a mirror is exactly where that assumption would rot.
 */
function redact(token: Token): Token {
  return {
    ...token,
    hidden: false,
    hp: null,
    lightFt: null,
    stagedPos: null,
    stagedOnly: false,
  };
}
