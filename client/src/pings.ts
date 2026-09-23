// Ping: hold the left button with nothing armed and a ring appears where
// everyone can see it. Foundry's gesture, chosen because half the table has
// already used it.
//
// This file is the whole feature on the client, apart from the gesture in
// input.ts and the drawing in render.ts. It holds three things that are easier
// to reason about apart than together: the rings currently on screen, whose
// colour each one is, and where a ring off the edge of the view gets an arrow
// instead.
//
// Nothing here can leak, and for a stronger reason than the ruler's: a ping
// carries a position and nothing else. There is no anchor to resolve, no token
// to look up, no state it could read out of the room. That is why it is the
// one thing the table is shown over ground they have never explored (see
// *Ping* in `docs/drawings.md`).

import type { Vec2 } from './coords.js';
import type { Colours, Owner, RosterEntry } from './protocol.js';

/**
 * How long a hold has to last before it fires.
 *
 * The gesture is told apart from the click underneath it by *duration*, not
 * by target, which lets it coexist with the one place in this project where
 * what a click means depends on what is under it: a door still swings, because
 * a door swings on a release before this elapses.
 */
export const HOLD_MS = 400;

/**
 * When the ring starts growing under the held button, well before it fires.
 *
 * Two reasons, pulling in opposite directions, set this value. 400ms of
 * nothing happening makes a long press feel broken, so something has to
 * appear before it fires; and a ring that has *started* growing lets an
 * accidental ping be noticed in time to cancel it by letting go. A preview at
 * 0ms would flicker on every click, and one at 390ms would do neither job.
 */
export const GROW_FROM_MS = 150;

/**
 * How long a ring lives, measured from the moment the button went down.
 *
 * From the button, not from the moment it fires, so the held preview and the
 * landed ring are one continuous drawing instead of two with a handoff. The
 * cost is that the pinger's own ring expires `HOLD_MS` before everybody
 * else's, which nobody can perceive because nobody is looking at two screens.
 */
const LIFE_MS = 2600;

/** How long the ring takes to fade out at the end of that. */
const FADE_MS = 600;

/** The ring's full radius, in *screen* pixels (see `ringRadius`). */
const RADIUS_PX = 34;

/**
 * A ring on the board.
 *
 * `at` is in grid units like everything else a client holds a position for, so
 * a ping stays where it was pointed if somebody recalibrates the map under it.
 * That won't happen inside two and a half seconds, but it costs nothing and is
 * invariant 1 either way.
 */
export interface Ping {
  owner: Owner;
  at: Vec2;
  /** `performance.now()` when the button went down, not when it fired. */
  startedAt: number;
}

export interface Pings {
  /**
   * The button just went down here with nothing armed. Starts the preview; it
   * fires only if `commit` follows.
   */
  hold(at: Vec2, startedAt: number): void;
  /** The hold was cancelled: it moved, or it was released early. A no-op when
   *  there is no hold, which is most releases. */
  drop(): void;
  /**
   * The hold lasted. Promotes the preview to a real ring and returns where it
   * landed so the caller can send it, or null if there is no hold to promote.
   *
   * The ring keeps the preview's own `startedAt`, so it doesn't restart.
   */
  commit(): Vec2 | null;
  /** A ping from somebody else. Ours never arrives this way: the server
   *  doesn't echo it, because `commit` already put it on our own board. */
  add(owner: Owner, at: Vec2, now: number): void;
  /**
   * Every ring to draw, oldest first, having dropped the expired.
   *
   * **The hold in progress is one of them**, so the preview and the landed
   * ring are one continuous drawing: firing moves the same object from one
   * list to the other without touching its `startedAt`, so nothing on screen
   * restarts, jumps or blinks at the moment it commits. The renderer can't
   * tell the two apart and has no reason to.
   */
  active(now: number): readonly Ping[];
}

export function createPings(me: Owner): Pings {
  let live: Ping[] = [];
  let holding: Ping | null = null;

  return {
    hold(at, startedAt) {
      holding = { owner: me, at: { x: at.x, y: at.y }, startedAt };
    },

    drop() {
      holding = null;
    },

    commit() {
      if (holding === null) return null;
      live.push(holding);
      const at = holding.at;
      holding = null;
      return at;
    },

    add(owner, at, now) {
      live.push({ owner, at: { x: at.x, y: at.y }, startedAt: now });
    },

    active(now) {
      // Both guards are for the idle case, which is nearly every frame of every
      // session: with nothing pinged and nothing held this returns the same
      // empty array it returned last frame and allocates nothing.
      if (live.length > 0) live = live.filter((p) => now - p.startedAt < LIFE_MS);
      return holding === null ? live : [...live, holding];
    },
  };
}

/**
 * How big a ring draws, in screen pixels, or 0 while it is still too young to
 * appear.
 *
 * **Screen pixels, not world units.** A ring sized in cells is invisible
 * zoomed out, and zoomed out over the whole dungeon is when somebody most
 * needs to point at a corner of it. Its *position* is world-anchored like
 * everything else; only its size isn't.
 *
 * It grows to full by the moment it fires and then holds. Don't add a pulse
 * afterwards: the ring has already announced itself by arriving, and what has
 * to be legible for two seconds is where it is, not that it is animating.
 */
export function ringRadius(ping: Ping, now: number): number {
  const age = now - ping.startedAt;
  if (age < GROW_FROM_MS) return 0;
  const grown = Math.min(1, (age - GROW_FROM_MS) / (HOLD_MS - GROW_FROM_MS));
  return RADIUS_PX * grown;
}

/**
 * How solidly a ring draws: full until the last `FADE_MS` of its life, then out.
 *
 * One number for the ring and the name beside it, as with `rulerAlpha`: they
 * are one annotation, and a label outliving its ring by a frame looks like a
 * rendering fault.
 */
export function ringAlpha(ping: Ping, now: number): number {
  const left = LIFE_MS - (now - ping.startedAt);
  if (left <= 0) return 0;
  return left >= FADE_MS ? 1 : left / FADE_MS;
}

/**
 * The ping vocabulary: one colour per roster slot, plus the DM's.
 *
 * The only place these six hues are defined. The server stores an index into
 * this list, holds its length as `PALETTE`, and knows nothing else about it, so
 * changing a hue here changes it everywhere and touches no Rust.
 *
 * By default a player's colour is their roster position: every client holds
 * the same roster from the same `Welcome`, so indexing it gives six people six
 * colours all six screens agree on with nothing on the wire. A player's pick
 * overrides that, which costs only the body of `colourOf` below.
 *
 * The hues avoid the token ring colours in render.ts (gold is ownership, blue
 * is in progress, white is the turn, violet is hidden, teal is staged-only),
 * for the same reason the draw palette does: a ring on the board shouldn't be
 * mistakable for something the board is saying about a creature. **That is
 * also why a player picks an index into this list, not a colour**: a free
 * choice includes gold, and a ring in gold would tell the table the wrong
 * owner. A name is written beside it regardless, which is what really tells
 * seven people apart, since colour alone doesn't scale. It also makes two
 * people picking the same swatch legible, which is why nothing refuses it.
 */
export const PLAYER_HUES: readonly string[] = [
  '#f43f5e', // rose
  '#f59e0b', // amber
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ec4899', // pink
];

/** The DM's, outside the six above: the one ring at the table that isn't one
 *  of the players. */
const DM_HUE = '#e8e6e1';

/**
 * What colour this owner's ring is, as `#rrggbb`.
 *
 * Three answers, in this order. What they picked, if they picked;
 * otherwise their roster position, which is what a player who hasn't
 * picked gets; otherwise the DM's, for a sender who isn't in the roster this
 * client holds. That last one is a fallback, not a refusal: there is nothing
 * to protect, so the ring draws anyway instead of vanishing over a roster two
 * clients disagree about.
 *
 * **The DM is answered before any of that**, and no entry in `colours` can
 * reach them: the server refuses a `set_colour` from the DM, and the table it
 * keeps is keyed by player. Theirs is the one ring at this table that isn't a
 * player's, and it stays outside the six.
 */
export function colourOf(
  owner: Owner,
  roster: readonly RosterEntry[],
  colours: Colours,
): string {
  if (owner.kind === 'dm') return DM_HUE;
  const picked = colours[owner.id];
  if (picked !== undefined) return PLAYER_HUES[picked] ?? DM_HUE;
  const at = roster.findIndex((slot) => slot.id === owner.id);
  if (at === -1) return DM_HUE;
  return PLAYER_HUES[at % PLAYER_HUES.length] ?? DM_HUE;
}

/** What to write beside the ring. The slug is the fallback, so an unknown
 *  sender is still attributed to something. */
export function nameOf(owner: Owner, roster: readonly RosterEntry[]): string {
  if (owner.kind === 'dm') return 'DM';
  return roster.find((slot) => slot.id === owner.id)?.name ?? owner.id;
}

/** An arrow at the edge of the screen, pointing at a ping that is off it. */
export interface EdgeMarker {
  /** Where to draw it, in screen pixels. */
  at: Vec2;
  /** Which way it points, in radians, `atan2`'s convention. */
  angle: number;
}

/**
 * Where a ping off the edge of the view gets its arrow, or null when the ping
 * is on screen and the ring itself is what draws.
 *
 * Six players looking at different parts of the map is the normal case, so a
 * ping nobody sees is worse than no ping at all, and an arrow is the cheap fix.
 * **Don't pan the camera instead**: moving the board under whoever is mid-drag
 * is what the initiative panel also refuses to do on a turn change, and being
 * told where to look is different from being taken there.
 *
 * The arrow sits where the line from the middle of the view to the ping leaves
 * a rectangle inset by `inset`, so it stays clear of the edge by the room its
 * own head needs, and a ping directly above the camera lands at the top middle
 * instead of in a corner. `t` is that line's parameter at the crossing, and
 * the smaller of the two axis limits is the side it leaves by. A ping already
 * inside the inset band is close enough to on-screen that its ring does the
 * job, hence the early return.
 */
export function edgeMarker(
  at: Vec2,
  view: { width: number; height: number },
  inset: number,
): EdgeMarker | null {
  const cx = view.width / 2;
  const cy = view.height / 2;
  // Never larger than half the view, or the inset rectangle turns inside out on
  // a narrow window and every arrow lands in the middle of the screen.
  const halfW = Math.max(0, Math.min(cx, cx - inset));
  const halfH = Math.max(0, Math.min(cy, cy - inset));

  const dx = at.x - cx;
  const dy = at.y - cy;
  if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH) return null;

  // How far along the line we may go before leaving the box on either axis. A
  // zero component never limits anything, hence `Infinity`: a ping directly
  // left of the camera is bounded by x alone.
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(tx, ty);

  return {
    at: { x: cx + dx * t, y: cy + dy * t },
    angle: Math.atan2(dy, dx),
  };
}

/** How far in from the edge the arrows sit, in screen pixels. Enough for the
 *  head and the name under it without either being clipped. */
export const EDGE_INSET_PX = 34;
