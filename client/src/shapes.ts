// Drawn shapes: what they are, where they are, and which cells they cover.
//
// All four kinds are one struct (a kind and two points) because that is all
// any of them needs. A line is its two ends, a rectangle its opposite corners, a
// circle its centre and a point on the rim, a cone its apex and its tip. One
// shape of data means one hit test and one coverage rule.
//
// Everything here works in grid units. A shape is measured in cells the way a
// token is placed in them, so recalibrating the grid leaves a 20 ft circle 20 ft
// across (invariant 1, applied to something that isn't a token). Walls are the
// other case: they trace the art, so they are in image pixels.

import type { Vec2 } from './coords.js';
import type { Owner, ShapeKind, WireShape } from './protocol.js';
import type { Scene, Token } from './scene.js';

/** A grid cell is five feet, the same constant the movement ruler counts in. */
const FEET_PER_CELL = 5;

/**
 * How far a shape may reach from its origin, in cells. Mirrors the server's
 * `MAX_SHAPE_CELLS`. The server checks it and the client also clamps to it.
 *
 * The server's refusal isn't enough on its own: a sweep sends a frame every
 * 40ms, so a drag past the bound would be refused thirty times a second and
 * answer with thirty error banners. Clamping makes the sweep stop growing,
 * which is also what it should look like.
 */
export const MAX_SHAPE_CELLS = 30;

/** Holds a sweep inside what the server will accept, per axis, the same way
 *  the server bounds it. */
export function clampExtent(to: Vec2): Vec2 {
  const hold = (v: number): number => Math.min(MAX_SHAPE_CELLS, Math.max(-MAX_SHAPE_CELLS, v));
  return { x: hold(to.x), y: hold(to.y) };
}

/**
 * The nearest point on the half-cell lattice. Where a free-placed shape starts.
 *
 * Cell centres, the corners between them and the middle of every cell edge
 * together make every half-integer, so the rule is a round to the nearest
 * half. Which of the three a given point lands on depends on the point.
 *
 * A centre is where a circle on one creature's square goes and a corner is
 * where the table drops a fireball. Don't snap to centres only: a rectangle
 * starting on a centre can never be drawn aligned to the squares it covers.
 *
 * This is **not** the token rule and doesn't duplicate it. `snap_to_cell`
 * depends on how wide a token is (an even width settles on the corner four
 * cells meet at) and lives only on the server. A shape has no width to settle
 * by, so it is offered every point on the lattice and the hand picks. The two
 * lattices coincide, which is why an anchored shape can skip this and still
 * sit on one of these points.
 *
 * It runs on the client because it has to. A token's drop is echoed back
 * carrying the settled position, so the client never needs to snap; a sweep
 * is *relayed* and never echoed, so an origin decided on the server would
 * arrive after five other people had already watched the circle being drawn
 * somewhere else.
 *
 * An anchored shape doesn't go through this: its origin is its token's
 * position, which the server has already settled, and an aura on a 2x2 creature
 * belongs on that creature, not in one of the four cells it covers.
 */
export function snapOrigin(at: Vec2): Vec2 {
  return { x: Math.round(at.x * 2) / 2, y: Math.round(at.y * 2) / 2 };
}

/**
 * The sweep held to whole cells, so what is drawn is what is read.
 *
 * Two rules, and what a kind's label says decides which it gets. A rectangle
 * reads as two numbers and a line is pointed at a square, so both snap per
 * axis. From an origin on the lattice that lands the far point on the lattice
 * too, corner to corner and centre to centre.
 *
 * A circle and a cone read as one number that is a *length*, and snapping their
 * offset per axis would not make that length whole: four cells across and four
 * up is a radius of 5.66, drawn as 28 ft and labelled 30. So those two snap the
 * **magnitude** and leave the direction free. A cone points wherever it is
 * pointed, and the rim of a 20 ft circle is 20 ft away on every bearing. This
 * makes `feetOf`'s rounding irrelevant for the two kinds where the drawn size
 * and the spoken number have to agree.
 */
export function snapExtent(kind: ShapeKind, to: Vec2): Vec2 {
  if (kind === 'circle' || kind === 'cone') {
    const length = Math.hypot(to.x, to.y);
    if (length === 0) return { x: 0, y: 0 };
    const cells = Math.round(length);
    return { x: (to.x / length) * cells, y: (to.y / length) * cells };
  }
  return { x: Math.round(to.x), y: Math.round(to.y) };
}

/**
 * Half the angle at a cone's apex, in radians.
 *
 * `atan(0.5)`, which makes a cone as wide at its far end as it is long. That
 * describes a wedge, not a spell: nothing here knows what a breath weapon is,
 * only that this is the shape the table draws.
 */
export const CONE_HALF_ANGLE = Math.atan(0.5);

/** The same angle as a slope and as a normal, which is what the wedge test
 *  wants. The slope is 0.5 because the angle is `atan(0.5)`. */
const CONE_SLOPE = 0.5;
const CONE_COS = Math.cos(CONE_HALF_ANGLE);

/**
 * How far outside a shape a cell centre may sit and still count as covered, in
 * cells.
 *
 * Zero is the strict reading (the shape has to cover the middle of the square),
 * and it is unforgiving in one place: a cone is narrow near its apex, so the
 * squares beside it fall outside a wedge that is plainly pointing at them.
 * The other end is about 0.71, half a diagonal, at which a shape grazing any
 * corner of a square claims the whole thing.
 */
const COVERAGE_SLACK = .15;

export interface Shape {
  id: string;
  kind: ShapeKind;
  /** The token it follows, or null for one pinned to a cell. */
  anchor: string | null;
  /** Where it starts, in grid units. Ignored when `anchor` is set: the token's
   *  position is the origin then, so an anchored shape needs no position
   *  updates on the wire. */
  at: Vec2;
  /** The second point, as an offset from the origin, so an anchored shape
   *  travels with its token instead of stretching towards a fixed cell. */
  to: Vec2;
  by: Owner;
  color: string;
}

/** An in-progress sweep, ours or somebody else's. Stored only here, and gone
 *  the moment the mouse comes up. */
export interface Sketch {
  kind: ShapeKind;
  at: Vec2;
  to: Vec2;
  color: string;
}

/**
 * Every sweep currently on screen, keyed by the connection doing it.
 *
 * Like `Rulers`, but with no timeout. A ruler has to guess when a drag ended
 * because nothing announces it; a sketch ends either on the release frame or on
 * the `sketch_ended` the room sends when a socket closes. Nothing has to
 * expire, so a sweep held still while somebody works out where the fireball
 * goes stays on screen.
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
 * The drawings' equivalent of `shownPos`, for the same reason: an anchored
 * shape's origin can be read two ways, and every draw and every hit test has
 * to read it the same way.
 *
 * Null is an anchor this client doesn't hold. That shouldn't happen, since the
 * room withholds a shape whose anchor it withholds, but if it did, a shape
 * drawn at the origin would sit on cell zero for no reason anybody could
 * explain.
 */
export function shapeOrigin(scene: Scene, shape: Shape): Vec2 | null {
  if (shape.anchor === null) return shape.at;
  const token = scene.tokens.find((t) => t.id === shape.anchor);
  if (token === undefined) return null;
  // The token's own cell, not `shownPos`: shapes belong to the live board, and
  // aren't drawn over a staged map at all (see `drawShapes`).
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
 * Whether a sweep has enough size to be worth keeping.
 *
 * A shape nobody can see is a shape nobody can find to erase, and a rectangle
 * is the kind that can be that while still looking like something. A circle
 * and a cone snap their *magnitude*, so either reaches nothing only by reaching
 * nothing on both axes at once. A rectangle snaps per axis, so a drag a hair
 * off the horizontal keeps its three cells of width and rounds its height to
 * zero. What is left has no area: it covers no cell centres from a corner
 * origin, and from a centre origin it tints a whole row that `containsPoint`
 * matches only along the line through it. Either way only "clear all" can
 * take it off the board.
 */
export function hasExtent(kind: ShapeKind, to: Vec2): boolean {
  if (kind === 'rect') return to.x !== 0 && to.y !== 0;
  return to.x !== 0 || to.y !== 0;
}

/**
 * The reading a shape carries, in feet, rounded the way the table counts.
 *
 * Not the way `feetMoved` rounds. A movement ruler counts cells crossed, where
 * a diagonal step costs one: that is a rule about walking. This is a length,
 * so it is the actual distance, quantised to five feet because a table that
 * counts in fives has no use for 17 ft. The two disagree on a diagonal because
 * they measure different things.
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
 * Two callers share it: the cell tint asks this of every cell centre in the
 * bounding box, and clicking a shape to erase it asks it of the cursor. The
 * coverage rule and the hit test are the same test.
 *
 * A line encloses nothing, so nothing is inside it. There is no clicking a
 * line to erase it, since a line is never kept.
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
   * The shape is grown instead of the point being sampled around, which is
   * exact, one call instead of several, and the only way to be generous in
   * every direction at once. Sampling a handful of offsets is generous along
   * whichever directions happen to be sampled, which for a cone is never the
   * diagonals its edges are cut on.
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

      // Resolved along the cone's own axis instead of into an angle: `along`
      // is how far down the wedge the point is, `perp` how far off it. Both are
      // a dot and a cross product against the unit axis, so a wedge pointing
      // due west can't break this the way subtracting two `atan2` results does.
      const ux = to.x / length;
      const uy = to.y / length;
      const along = dx * ux + dy * uy;
      const perp = Math.abs(dx * uy - dy * ux);

      // `perp <= along * slope` is the wedge. Multiplied through by the cosine
      // it becomes the perpendicular *distance* to the edge, which a slack in
      // cells can be compared against, and it is the same test at the apex as
      // at the tip. The apex itself is inside at zero slack. Don't test with an
      // arc-cosine: there is no angle from a point to itself, so the cone's own
      // square goes untinted.
      return (perp - along * CONE_SLOPE) * CONE_COS <= slack;
    }
  }
}

/**
 * The cells an area shape covers: every cell whose centre the shape reaches,
 * give or take `COVERAGE_SLACK`.
 *
 * Centres, not any overlap: the difference between a fireball catching the cell
 * you are standing in and one catching every cell it grazes. The slack keeps
 * that from being pedantic (see the constant). It grows the shape instead of
 * sampling around the cell, so it is generous in every direction equally,
 * which matters most for a cone: a wedge is narrow near its apex, and the
 * squares plainly in front of it are the ones that would fall out.
 *
 * The tint therefore reaches a little past the drawn outline. The outline is
 * the shape and the tint is which squares it is counted against, and the
 * second is what anyone is asking.
 *
 * This disagrees with the movement ruler. The ruler counts a diagonal step as
 * one cell, under which "everything within 20 ft" is a square; a circle drawn
 * here is a circle, and the cells it covers are the round blob you would
 * expect. They differ at the corners because they answer different questions
 * (how far something walked, and what a shape covers), and the tint is what
 * makes the second one countable.
 *
 * Returned as flat pairs, not objects: this can be a few hundred cells per
 * shape per frame, and it is the one place in the client where that matters.
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
  // or the cells only the slack admits fall outside the box that finds them.
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
 * Reverse draw order, like `tokenAt`, and skipping what isn't yours for the
 * same reason: a shape you can't erase sitting on top of yours must not block
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
