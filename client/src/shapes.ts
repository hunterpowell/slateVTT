// Drawn shapes: what they are, where they are, and which cells they cover.
//
// All four kinds are one struct — a kind and two points — because that is all
// any of them needs. A line is its two ends, a rectangle its opposite corners, a
// circle its centre and a point on the rim, a cone its apex and its tip. Four
// geometries, one shape of data, and so one hit test and one coverage rule
// rather than four of each.
//
// Everything here works in grid units. A shape is measured in cells the way a
// token is placed in them, so recalibrating the grid leaves a 20 ft circle 20 ft
// across — invariant 1, applied to a thing that is not a token. Walls will be
// the other case: they trace the art, so they will be in image pixels.

import type { Vec2 } from './coords.js';
import type { Owner, ShapeKind, WireShape } from './protocol.js';
import type { Scene, Token } from './scene.js';

/** A grid cell is five feet — the same constant the movement ruler counts in. */
const FEET_PER_CELL = 5;

/**
 * How far a shape may reach from its origin, in cells. Mirrors the server's
 * `MAX_SHAPE_CELLS`, and is clamped here rather than merely checked.
 *
 * The server refusing an oversized shape is not enough on its own: a sweep sends
 * a frame every 40ms, so a drag past the bound would be refused thirty times a
 * second and answer with thirty error banners. Clamping means the sweep simply
 * stops growing, which is also what it should look like.
 */
const MAX_SHAPE_CELLS = 30;

/** Holds a sweep inside what the server will accept, per axis, exactly as the
 *  server bounds it. */
export function clampExtent(to: Vec2): Vec2 {
  const hold = (v: number): number => Math.min(MAX_SHAPE_CELLS, Math.max(-MAX_SHAPE_CELLS, v));
  return { x: hold(to.x), y: hold(to.y) };
}

/**
 * The centre of the cell a point falls in. Where a free-placed shape starts.
 *
 * This is **not** the token rule and does not duplicate it. `snap_to_cell`
 * depends on how wide a token is — an even width settles on the corner four
 * cells meet at — and it lives on the server as the only copy of itself. A
 * shape has no width to settle by, so its origin is always a cell centre, and
 * that is a different sentence rather than the same one written twice.
 *
 * It also has to be said here rather than on the server, which is the honest
 * reason it is in the client at all. A token's drop is echoed back carrying the
 * settled position, so the client can afford never to snap; a sweep is *relayed*
 * and never echoed, so an origin decided on the server would arrive after five
 * other people had already watched the circle being drawn somewhere else.
 *
 * An anchored shape does not go through this: its origin is its token's
 * position, which the server has already settled, and an aura on a 2x2 creature
 * belongs on that creature rather than in one of the four cells it covers.
 */
export function originCell(at: Vec2): Vec2 {
  return { x: Math.floor(at.x) + 0.5, y: Math.floor(at.y) + 0.5 };
}

/**
 * Half the angle at a cone's apex, in radians.
 *
 * `atan(0.5)`, which makes a cone exactly as wide at its far end as it is long.
 * That is a statement about a wedge and not about a spell: nothing here knows
 * what a breath weapon is, only that this is the shape the table draws.
 */
export const CONE_HALF_ANGLE = Math.atan(0.5);

/** The same angle as a slope and as a normal, which is what the wedge test
 *  actually wants. `tan` is exactly a half by construction. */
const CONE_SLOPE = 0.5;
const CONE_COS = Math.cos(CONE_HALF_ANGLE);

/**
 * How far outside a shape a cell centre may sit and still count as covered, in
 * cells.
 *
 * Zero is the strict reading — the shape has to cover the middle of the square —
 * and it is unforgiving in exactly one place: a cone is narrow near its apex, so
 * the squares beside it fall outside a wedge that is plainly pointing at them.
 * The other end is about 0.71, half a diagonal, at which a shape grazing any
 * corner of a square claims the whole thing.
 *
 * This sits nearer the strict end. It is the one number in this file worth
 * playing with at the table, which is why it has a name.
 */
const COVERAGE_SLACK = .15;

export interface Shape {
  id: string;
  kind: ShapeKind;
  /** The token it follows, or null for one pinned to a cell. */
  anchor: string | null;
  /** Where it starts, in grid units. Ignored when `anchor` is set — the token's
   *  position is the origin then, which is why an anchored shape needs no
   *  position updates on the wire at all. */
  at: Vec2;
  /** The second point, as an offset from the origin. An offset so an anchored
   *  shape travels with its token rather than stretching towards a fixed cell. */
  to: Vec2;
  by: Owner;
  color: string;
}

/** An in-progress sweep, ours or somebody else's. Never stored anywhere but
 *  here: it is gone the moment the mouse comes up. */
export interface Sketch {
  kind: ShapeKind;
  at: Vec2;
  to: Vec2;
  color: string;
}

/**
 * Every sweep currently on screen, keyed by the connection doing it.
 *
 * The shape-scale twin of `Rulers`, with one difference that matters: there is
 * no timeout. A ruler has to guess when a drag ended because nothing announces
 * it; a sketch ends either on the release frame or on the `sketch_ended` the
 * room sends when a socket closes. Nothing has to expire, so a sweep held still
 * while somebody works out where the fireball goes stays on screen.
 */
export interface Sketches {
  /** Ours. Keyed apart from any connection id, since the server never sends our
   *  own sweep back to us and both have to be drawable at once. */
  own(sketch: Sketch | null): void;
  seen(by: number, sketch: Sketch): void;
  ended(by: number): void;
  all(): readonly Sketch[];
}

export function createSketches(): Sketches {
  let mine: Sketch | null = null;
  const theirs = new Map<number, Sketch>();

  return {
    own(sketch) {
      mine = sketch;
    },
    seen(by, sketch) {
      theirs.set(by, sketch);
    },
    ended(by) {
      theirs.delete(by);
    },
    all() {
      const live = [...theirs.values()];
      if (mine !== null) live.push(mine);
      return live;
    },
  };
}

export function shapeFromWire(wire: WireShape): Shape {
  return {
    id: wire.id,
    kind: wire.kind,
    anchor: wire.from.kind === 'token' ? wire.from.at : null,
    at: wire.from.kind === 'point' ? wire.from.at : { x: 0, y: 0 },
    to: wire.to,
    by: wire.by,
    color: wire.color,
  };
}

/**
 * Where a shape starts on the board, or null when it is not on the board at all.
 *
 * `shownPos`'s counterpart for drawings, and it exists for the same reason: an
 * anchored shape's origin is a question with two answers, and every draw and
 * every hit test has to ask exactly one of them.
 *
 * Null is an anchor this client does not hold. That should not happen — the room
 * withholds a shape whose anchor it withholds — so this is the belt to that
 * braces: a shape drawn at the origin because its token was missing would be a
 * shape sitting on cell zero for no reason anybody could explain.
 */
export function shapeOrigin(scene: Scene, shape: Shape): Vec2 | null {
  if (shape.anchor === null) return shape.at;
  const token = scene.tokens.find((t) => t.id === shape.anchor);
  if (token === undefined) return null;
  // The token's own cell, not `shownPos`: shapes belong to the live board, and
  // are not drawn over a staged map at all — see `drawShapes`.
  return { x: token.x, y: token.y };
}

/** The far point, in grid units: the origin plus the offset stored on the shape. */
export function shapeEnd(origin: Vec2, to: Vec2): Vec2 {
  return { x: origin.x + to.x, y: origin.y + to.y };
}

/** Whether this kind encloses anything. A line measures; the rest cover ground,
 *  and only things that cover ground tint the cells underneath them. */
export function isArea(kind: ShapeKind): boolean {
  return kind !== 'line';
}

/**
 * The reading a shape carries, in feet, rounded the way the table counts.
 *
 * Deliberately *not* the way `feetMoved` rounds. A movement ruler counts cells
 * crossed, where a diagonal step costs one — that is a rule about walking. This
 * is a length, so it is the actual distance, quantised to five feet because a
 * table that counts in fives has no use for 17 ft. The two disagree on a
 * diagonal, and they are measuring different things.
 */
export function feetOf(shape: Shape | Sketch): number {
  const { x, y } = shape.to;
  const cells = shape.kind === 'rect' ? Math.max(Math.abs(x), Math.abs(y)) : Math.hypot(x, y);
  return Math.round(cells) * FEET_PER_CELL;
}

/** What to write beside a shape. Rectangles get two numbers because one would
 *  describe neither side. */
export function labelFor(shape: Shape | Sketch): string {
  if (shape.kind === 'rect') {
    const w = Math.round(Math.abs(shape.to.x)) * FEET_PER_CELL;
    const h = Math.round(Math.abs(shape.to.y)) * FEET_PER_CELL;
    return `${w} × ${h} ft`;
  }
  return `${feetOf(shape)} ft`;
}

/**
 * Whether a point in grid units falls inside a shape.
 *
 * One function, two callers, and that is why the covered cells are affordable:
 * the cell tint asks this of every cell centre in the bounding box, and clicking
 * a shape to erase it asks it of the cursor. Writing the coverage rule without a
 * hit test would have meant writing the hit test anyway.
 *
 * A line encloses nothing, so it is never inside anything — clicking one to
 * erase it is not a gesture that exists, since a line is never kept.
 */
export function containsPoint(
  kind: ShapeKind,
  origin: Vec2,
  to: Vec2,
  px: number,
  py: number,
  /**
   * How far outside the shape still counts, in cells. Zero is the shape itself.
   *
   * The shape is grown rather than the point being sampled around, which is
   * both exact and one call instead of several — and it is the only way to be
   * generous in every direction at once. Sampling a handful of offsets is
   * generous along whichever directions happen to be sampled, which for a cone
   * is never the diagonals its edges are actually cut on.
   */
  slack = 0,
): boolean {
  const dx = px - origin.x;
  const dy = py - origin.y;

  switch (kind) {
    case 'line':
      return false;

    case 'circle':
      return Math.hypot(dx, dy) <= Math.hypot(to.x, to.y) + slack;

    case 'rect': {
      const lo = { x: Math.min(0, to.x) - slack, y: Math.min(0, to.y) - slack };
      const hi = { x: Math.max(0, to.x) + slack, y: Math.max(0, to.y) + slack };
      return dx >= lo.x && dx <= hi.x && dy >= lo.y && dy <= hi.y;
    }

    case 'cone': {
      const length = Math.hypot(to.x, to.y);
      if (length === 0) return false;
      if (Math.hypot(dx, dy) > length + slack) return false;

      // Resolved along the cone's own axis rather than into an angle: `along`
      // is how far down the wedge the point is, `perp` how far off it. Both are
      // a dot and a cross product against the unit axis, so nothing here can
      // trip over a wedge pointing due west the way subtracting two `atan2`
      // results does.
      const ux = to.x / length;
      const uy = to.y / length;
      const along = dx * ux + dy * uy;
      const perp = Math.abs(dx * uy - dy * ux);

      // `perp <= along * slope` is the wedge. Multiplied through by the cosine
      // it becomes the perpendicular *distance* to the edge, which is what a
      // slack in cells can be compared against — and, unlike the angle it
      // replaces, it is the same test at the apex as at the tip. The apex
      // itself is inside at zero slack, which the arc-cosine could not say:
      // there is no angle from a point to itself, and a cone whose own square
      // went untinted was the visible half of that.
      return (perp - along * CONE_SLOPE) * CONE_COS <= slack;
    }
  }
}

/**
 * The cells an area shape covers: every cell whose centre the shape reaches,
 * give or take `COVERAGE_SLACK`.
 *
 * Centres rather than any overlap, which is the difference between a fireball
 * catching the cell you are standing in and one catching every cell it grazes.
 * The slack is what keeps that from being pedantic — see the constant. It grows
 * the shape rather than sampling around the cell, so it is generous in every
 * direction equally, which matters most for a cone: a wedge is narrow near its
 * apex, and the squares plainly in front of it were the ones falling out.
 *
 * The tint therefore reaches a little past the drawn outline. That is
 * deliberate — the outline is the shape and the tint is which squares it is
 * being counted against, and the second is the question anyone is asking.
 *
 * This is also where the honest inconsistency in this milestone lives. The
 * movement ruler counts a diagonal step as one cell, under which "everything
 * within 20 ft" is a square; a circle drawn here is a circle, and the cells it
 * covers are the round blob you would expect. They disagree at the corners
 * because they answer different questions — how far something walked, and what a
 * shape covers — and the tint is what makes the second one countable.
 *
 * Returned as flat pairs rather than objects: this can be a few hundred cells
 * per shape per frame, and it is the one place in the client where that matters.
 */
export function coveredCells(
  kind: ShapeKind,
  origin: Vec2,
  to: Vec2,
  slack = COVERAGE_SLACK,
): number[] {
  const cells: number[] = [];
  if (!isArea(kind)) return cells;

  // The bounding box in cells, which every kind fits inside: a circle and a cone
  // both reach at most their own length in any direction. Grown by the slack,
  // or the cells the slack is what admits fall outside the box that finds them.
  const reach = kind === 'rect' ? { x: Math.abs(to.x), y: Math.abs(to.y) } : radius(to);
  const x0 = Math.floor(origin.x - reach.x - slack);
  const x1 = Math.ceil(origin.x + reach.x + slack);
  const y0 = Math.floor(origin.y - reach.y - slack);
  const y1 = Math.ceil(origin.y + reach.y + slack);

  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      if (containsPoint(kind, origin, to, cx + 0.5, cy + 0.5, slack)) cells.push(cx, cy);
    }
  }
  return cells;
}

function radius(to: Vec2): Vec2 {
  const r = Math.hypot(to.x, to.y);
  return { x: r, y: r };
}

/**
 * The topmost shape under a point that this client may erase, or null.
 *
 * Reverse draw order, like `tokenAt`, and skipping what is not yours for the
 * same reason: a shape you cannot erase sitting on top of yours must not block
 * you from clicking your own.
 */
export function erasableAt(
  scene: Scene,
  isDm: boolean,
  playerId: string | null,
  at: Vec2,
): Shape | null {
  for (let i = scene.shapes.length - 1; i >= 0; i--) {
    const shape = scene.shapes[i];
    if (shape === undefined) continue;
    if (!canErase(isDm, playerId, shape)) continue;
    const origin = shapeOrigin(scene, shape);
    if (origin === null) continue;
    if (containsPoint(shape.kind, origin, shape.to, at.x, at.y)) return shape;
  }
  return null;
}

/** The DM may erase anything; everyone else may take back what they drew. The
 *  server re-checks; this is what decides whether the cursor offers to. */
export function canErase(isDm: boolean, playerId: string | null, shape: Shape): boolean {
  if (isDm) return true;
  return shape.by.kind === 'player' && shape.by.id === playerId;
}

/** Whether a token can be anchored to: one on the board, which is any token
 *  drawn on it. A staged-only token has no live position to follow. */
export function anchorable(token: Token): boolean {
  return !token.stagedOnly;
}
