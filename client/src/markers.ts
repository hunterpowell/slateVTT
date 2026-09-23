// The DM's marks on a creature: the closed set, the hues, and the row of
// toggles both panels offer.
//
// **A marker is a colour, and nothing here knows what any of them means.**
// There is nowhere in this file for a rule to live, and a name like `poisoned`
// is where that would stop being true. See the non-goal in `.claude/CLAUDE.md`.
//
// It is one module, not three copies, because two panels and the canvas all
// draw the same marks and must not disagree about them. `panel.ts` imports
// `hpColour` from `render.ts` for the same reason.

import type { Marker } from './protocol.js';

/**
 * Every marker there is, in the order the swatches are offered in.
 *
 * The server holds the same closed set as `Marker::ALL` and has no opinion
 * about what any of them looks like, so changing a hue below touches no Rust,
 * the same as changing one of `PLAYER_HUES`.
 *
 * **The order here is defined only in this file, and the band depends on it.**
 * A token's list is in the order the DM added them, which the room stores and
 * never sorts; the board sorts into *this* order before drawing the band, so
 * two creatures carrying the same marks draw the same picture whatever order
 * they were marked in. The band exists to be recognised at a glance, which
 * needs that. `dead` is last because it isn't one of the arcs.
 */
export const MARKERS: readonly Marker[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'dead',
];

/**
 * Whether this mark is one of the coloured arcs, or the X.
 *
 * One predicate instead of a comparison spelled out at each of the three
 * places that care (the band on the board, the X over it, and the swatch row
 * below), so that a second non-colour, if one is ever argued for, lands in one
 * place instead of three. There is no second one today and the bar for it is in
 * `docs/tokens.md`.
 */
export function isColour(marker: Marker): boolean {
  return marker !== 'dead';
}

/**
 * What each one is drawn in, on the board and in both panels.
 *
 * They overlap the player palette and the ring colours, and three of them sit
 * close enough to matter: yellow against the gold that means *yours*, blue
 * against the blue that means *in progress*, purple against the violet that
 * means *hidden*. `pings.ts` closes its own set to avoid that, and the marks
 * can't, because the six are the DM's to mean anything.
 *
 * What separates them is **position, not hue**. The band is stroked *inside*
 * the token's own rim, the one place on a token nothing else draws; every
 * state ring is outside it, so ownership in gold lands just outside a yellow
 * arc instead of competing with it for the same slot. Don't move the band
 * outward past the rim: hue is then all a reader has, and the colours collide.
 */
export const MARKER_HUES: Record<Marker, string> = {
  red: '#ef4444',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  // Not a hue in the same sense as the six above: it is what the X is stroked
  // in, and it is the *label* colour, not a seventh swatch colour. The X is
  // drawn like a name and the arcs like a ring, so the two read as different
  // kinds of mark before anybody has worked out which colour is which.
  dead: '#e8e6e1',
};

/**
 * One toggle per mark, hollow for one this creature doesn't carry and filled
 * for one it does.
 *
 * All of them are always shown, not only the ones that are set, because the
 * control is "which of these is on" and a row that grew as it was used would
 * move the swatch under the pointer between two clicks.
 *
 * `commit` is handed the whole resulting set, not the one that changed:
 * `update_token` replaces the token, so both callers send a list anyway, and a
 * delta here would only be turned back into one at each of them.
 */
export function markerRow(
  current: readonly Marker[],
  describe: (marker: Marker) => string,
  commit: (next: Marker[]) => void,
): HTMLElement {
  const row = document.createElement('span');
  row.className = 'markers';

  for (const marker of MARKERS) {
    const on = current.includes(marker);

    // Identical markup for all of them, `dead` included. The X on that one
    // swatch is `.marker[data-marker='dead']` in the stylesheet, keying off an
    // attribute this loop already sets. Nothing here branches, so the row stays
    // one loop and the driver keeps finding every swatch the same way.
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = on ? 'marker is-on' : 'marker';
    pip.dataset.marker = marker;
    pip.style.setProperty('--marker', MARKER_HUES[marker]);
    pip.setAttribute('aria-pressed', String(on));

    const label = describe(marker);
    pip.title = label;
    pip.setAttribute('aria-label', label);

    pip.addEventListener('click', (e) => {
      // An initiative row is a "look at this creature" target, so a click that
      // marks something must not also move the camera. The `×` beside it makes
      // the same stop, for the same reason.
      e.stopPropagation();
      commit(on ? current.filter((m) => m !== marker) : [...current, marker]);
    });

    row.append(pip);
  }

  return row;
}
