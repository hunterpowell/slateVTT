// The board as the table is looking at it, on the DM's own screen.
//
// The client-side counterpart of `snapshot_for`, and the only one. The DM
// holds more of the room than anybody else (the walls, their own painted
// squares, the monster in the unlit chamber, every hit point total) and all of
// it is drawn on their board, because it is the board they are playing on. The
// cost is that they can't see what the other six screens are showing.
//
// `solo.ts` answers the narrow version of that question (can *this creature*
// see it) and this answers the broad one. Solo sight is a second raycast about
// one pair of eyes; this is no raycast at all. It is the party's own fog, which
// the DM was already sent, with everything the server would have withheld
// taken back out of the scene around it.
//
// Under party sight there is one answer to "what can the table see", so a
// mirror of it is a fact, not a choice between six boards. Under split sight
// it names a player: the server sends the DM each player's fog (`fogBy`) and
// this applies the same rules to that frame. See *Split sight* in
// `docs/fog.md`.
//
// **Client-only, and nothing goes in the room.** No command, no event, no
// filter: the server does not know the DM is looking at this and must not
// learn, the same rule as `solo.ts` and `previewing`. Nothing here is a
// security boundary. It *removes* things the DM is entitled to see and can put
// back. The server still decides what every other client holds, so every line
// of this could be wrong without a player learning anything.
//
// It does not annotate. Nothing is marked as withheld, dimmed or outlined: a
// board that shows "and here is what they cannot see" is the DM's board again,
// which they get by turning this off. `docs/tokens.md` makes the same argument
// for not marking a planned token on the live board.
//
// Read `docs/fog.md` before changing what this withholds.

import { cellKnown, cellVisible } from './fog.js';
import type { Fog } from './fog.js';
import type { Overrides } from './overrides.js';
import type { Initiative } from './protocol.js';
import type { Scene, Token } from './scene.js';
import type { Shape } from './shapes.js';
import { MAX_SHAPE_CELLS, coveredCells, isArea, strokeOf } from './shapes.js';

/** Nothing painted at all, which is what a player's copy always is. */
const NO_OVERRIDES: Overrides = { x: 0, y: 0, w: 0, h: 0, tint: null };

/**
 * The scene a player would have been handed, built from the one the DM holds.
 *
 * Every line of this has a counterpart on the server, named in the comment
 * beside it. What it leaves alone matters too: the map, the grid, the room-wide
 * switches and the fog itself are identical for every recipient, so changing
 * them would make the mirror wrong.
 *
 * Leaving the fog as it arrived looks like an omission and isn't. It is already
 * the table's own answer; the DM's copy differs only in how faintly it is
 * *drawn*, and that belongs to the renderer (see `Fog.table` and `drawFog`).
 * This decides what is on the board, not how dark it is.
 */
export function asTable(scene: Scene, as: string | null = null): Scene {
  const eyes = through(scene, as);
  const shown = scene.tokens.filter((token) => !unseenByTable(eyes, token, as)).map(redact);
  const ids = new Set(shown.map((token) => token.id));

  return {
    ...eyes,
    // A player is never previewing, because they are never sent a staged board
    // to preview. One null withholds the next dungeon's image, its walls and its
    // paint together, as it does on the wire.
    previewing: false,
    staged: null,
    tokens: shown,
    shapes: scene.shapes.filter((shape) => shapeSeen(eyes, ids, shape)),
    // `WallsChanged`'s rule: the geometry is the secret and the shadow it casts
    // is what the table plays with. Empty is also what an untraced map looks
    // like, so this matches a player's copy.
    walls: [],
    // The same rule as the walls: what the table gets of the DM's paint is the
    // fog, which is already on the board underneath.
    overrides: NO_OVERRIDES,
  };
}

/**
 * The turn order as the table holds it: `initiative_for` on the server.
 *
 * The panel names its rows by looking each token up in the scene, so mirroring
 * the scene without this leaves a row drawing as a raw id: a monster the DM hid,
 * shown by the one panel that is always on screen. The server's version exists
 * to prevent that, and it is why `current` is cleared along with the row.
 */
export function tableInitiative(
  initiative: Initiative,
  scene: Scene,
  as: string | null = null,
): Initiative {
  const eyes = through(scene, as);
  const unseen = new Map(
    scene.tokens
      .filter((token) => unseenByTable(eyes, token, as))
      .map((token) => [token.id, token]),
  );
  if (unseen.size === 0) return initiative;

  // A party member out of sight keeps their row, labelled, as `initiative_for`
  // does. Only line of sight is waived: one the DM hid goes.
  const label = (id: string): { name: string; img: string } | null => {
    const token = unseen.get(id);
    if (token === undefined || token.owner.kind !== 'player') return null;
    if (token.hidden || token.stagedOnly) return null;
    return { name: token.name, img: token.img };
  };
  const kept = (id: string): boolean => !unseen.has(id) || label(id) !== null;

  const current = initiative.current;
  return {
    entries: initiative.entries.filter((entry) => kept(entry.token)).map((entry) => {
      const named = unseen.has(entry.token) ? label(entry.token) : null;
      return named === null ? entry : { ...entry, label: named };
    }),
    current: current !== null && !kept(current) ? null : current,
    round: initiative.round,
  };
}

/** The scene with `as`'s own fog in place of the party's, under split sight. A
 *  player with no frame is drawn as an unexplored map, which shows the DM less
 *  than more: the safe direction for a mirror. Not `null`, which is an unfogged
 *  map and draws the whole board. */
function through(scene: Scene, as: string | null): Scene {
  if (as === null || scene.vision !== 'split') return scene;
  return { ...scene, fog: scene.fogBy.get(as) ?? (scene.live.fog ? UNEXPLORED : scene.fog) };
}

/** What an unexplored map packs to: an empty rectangle, which the renderer
 *  fills solid. */
const UNEXPLORED: Fog = { x: 0, y: 0, w: 0, h: 0, cells: '', shade: null, table: null };

/**
 * Whether the table cannot see this token at all: `unseen_by` under party
 * sight, the only question any filter on the server asks. Under split sight
 * this is still the party's answer, which no single player is sent.
 *
 * The same three reasons apply here, and they take the scene as well as the
 * token for the same reason: two are facts about the creature and the third is
 * a fact about where everybody is standing.
 */
export function unseenByTable(scene: Scene, token: Token, as: string | null = null): boolean {
  return token.hidden || token.stagedOnly || !inSight(scene, token, as);
}

/**
 * Whether the party has line of sight on this token: `in_sight`, shortcut
 * included. A player's own token is a vision source, so the cell it stands in is
 * lit by it and there is nothing to test.
 *
 * The live board, never `shownBoard`. This is a question about the map the table
 * is looking at, which is also why the panel greys the button over a preview.
 *
 * A monster is in sight if *any* cell it covers is, so an ogre leaning into a
 * lit corridor is an ogre the party can see. A map that claims to be fogged with
 * no fog in hand answers "unseen", which shows the DM less than the table has.
 * That is the safe direction for a mirror, where the failure that matters is a
 * DM who thinks the table can't see something it can.
 */
function inSight(scene: Scene, token: Token, as: string | null): boolean {
  if (!scene.live.fog) return true;
  // Under split sight only the player's own tokens are always in sight, as in
  // `in_sight`.
  if (token.owner.kind === 'player') {
    if (scene.vision !== 'split' || as === null || token.owner.id === as) return true;
  }
  const fog: Fog | null = scene.fog;
  if (fog === null) return false;
  return footprint(token).some(([cx, cy]) => cellVisible(fog, cx, cy));
}

/**
 * The cells a token covers: `fog::covered_cells`, nudge included.
 *
 * A token's edges land on grid lines, so the floors are deciding a tie at both
 * ends. The nudge keeps a 2-cell token at (4, 4) covering cells 3 and 4, not 3,
 * 4 and 5. The `max` makes a half-size token cover the one cell it stands in.
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
 * Whether a drawing survives the filter: `shape_seen`, both halves.
 *
 * An anchored shape goes with its token, so an aura on a monster in the dark
 * needs no rule of its own. An unanchored one gates on `known`, not `visible`,
 * because a drawing is painted on the floor, not standing on it. It belongs
 * with the terrain, fringe and all.
 */
function shapeSeen(scene: Scene, shown: ReadonlySet<string>, shape: Shape): boolean {
  if (shape.anchor !== null) return shown.has(shape.anchor);
  if (!scene.live.fog) return true;
  const fog = scene.fog;
  if (fog === null) return false;

  // A line or a path encloses nothing, so `containsPoint` is false everywhere
  // along one and `coveredCells` returns none at all. What a stroke covers is
  // the ground it is drawn across, which is a walk instead of a test, one per
  // segment: `line_cells` on the server, sampled twice per cell so a shallow
  // diagonal steps over none of it.
  if (!isArea(shape.kind)) {
    const corners = strokeOf(shape, shape.at);
    for (let k = 1; k < corners.length; k++) {
      const a = corners[k - 1];
      const b = corners[k];
      if (a === undefined || b === undefined) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.min(Math.hypot(dx, dy), MAX_SHAPE_CELLS);
      const steps = Math.max(Math.ceil(length * 2), 1);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (cellKnown(fog, Math.floor(a.x + dx * t), Math.floor(a.y + dy * t))) return true;
      }
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
 * The copy a player is handed: `Token::view_for(false)`, field for field.
 *
 * `hidden` is not redacted there either: a hidden token is dropped before this
 * is reached, so the flag is always false by the time anything reads it. It is
 * set here anyway, because the code that makes that true is one `filter` away
 * and could change without anyone looking here.
 *
 * `markers` is the only token field left alone: it is public, so `view_for`
 * copies it whoever is asking, and blanking it here would make player view
 * show *less* than the table can see. The spread carries it, which is why this
 * is written down.
 */
function redact(token: Token): Token {
  return {
    ...token,
    hidden: false,
    hp: null,
    lightFt: null,
    visionFt: null,
    stagedPos: null,
    stagedOnly: false,
  };
}
