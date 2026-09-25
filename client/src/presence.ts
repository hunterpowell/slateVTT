/**
 * The presence strip: who is here, and what colour they draw in.
 *
 * Two features on one row of chips, because they are about the same seven
 * names: a chip shows whether that person is connected, and it is drawn in the
 * colour they picked. A separate control would list the same people twice.
 *
 * Three decisions:
 *
 * It is at the top of the right-hand column, the one edge of that column that
 * never moves. The initiative panel folds and the dock grows upward from the
 * bottom, so anything between them shifts when either does. A strip that says
 * whether the DM is still there is no use if it moves every time you look.
 *
 * Absent people dim, not disappear. Every roster slot is drawn from page load
 * and stays until the DM edits the cast, so the row keeps its layout while
 * people come and go. A chip that vanished would move its neighbours under the
 * pointer, and would make "not here" and "no such person" look the same.
 *
 * The colour control is your own chip, because that is where your colour
 * already shows. It isn't a dock tab: the dock is for things you read while
 * something else is going on, and this is one click twice a campaign. The DM
 * has no control. Their hue is outside the six, and the server refuses a
 * `set_colour` from them, so a picker on their chip could only produce a red
 * banner.
 */

import type { Identity } from './identity.js';
import { PLAYER_HUES, colourOf, nameOf } from './pings.js';
import type { ClientMsg, Colours, Owner, RosterEntry } from './protocol.js';

export interface PresenceUi {
  root: HTMLElement;
  /** The chips. Empty in the document: there is one per roster slot plus the
   *  DM's, so they are built here from the roster. */
  chips: HTMLElement;
  /** The swatch row that opens under your own chip. Empty in the document, and
   *  hidden until opened. */
  swatches: HTMLElement;
}

export interface Presence {
  /** Is this person connected right now?
   *
   *  Chat asks it about each destination, to dim the chip of somebody who
   *  isn't there. */
  connected(owner: Owner): boolean;
  /** What everybody picked, as the room last said.
   *
   *  **Read this at draw time; don't keep a copy.** `picked` replaces the
   *  object, so the renderer or the chat log holding its own reference would
   *  keep drawing old colours. */
  readonly colours: Colours;
  /** Somebody joined or left. */
  here(list: readonly Owner[]): void;
  /** Somebody picked a colour. */
  picked(colours: Colours): void;
  /** The DM edited the cast. The roster passed in at creation is the same
   *  array, already changed in place; this rebuilds the chips from it. */
  recast(): void;
}

/** A key for one person that a `Set` or a `Map` can hold. `Owner` is an object,
 *  so two copies of the same identity are never the same value.
 *
 *  Exported for `cursors.ts`, which keeps one pointer per person and must
 *  decide "is this the same person" the same way as this file and `chat.ts`. */
export function keyOf(owner: Owner): string {
  return owner.kind === 'dm' ? 'dm' : `player:${owner.id}`;
}

/** Whether these two name the same person. Exported because `chat.ts` asks it
 *  of a line's sender, and one answer to "is this the same person" is better
 *  than two that could drift. */
export function sameOwner(a: Owner, b: Owner): boolean {
  return keyOf(a) === keyOf(b);
}

/** Who this client is, as an `Owner`, which is what `pings.ts` resolves a name
 *  and a colour from. Here, not in `identity.ts`, which knows about a slot in
 *  `localStorage` and nothing about the table. */
export function ownerOf(identity: Identity): Owner {
  return identity.playerId === null ? { kind: 'dm' } : { kind: 'player', id: identity.playerId };
}

export function createPresence(
  ui: PresenceUi,
  identity: Identity,
  roster: readonly RosterEntry[],
  initialHere: readonly Owner[],
  initialColours: Colours,
  send: (msg: ClientMsg) => void,
): Presence {
  const me = ownerOf(identity);
  // Everyone who could be here: the DM, then the roster's order. Rebuilt only
  // when the DM edits the cast, never as people come and go, so the row doesn't
  // reflow under the pointer.
  const cast = (): Owner[] => [
    { kind: 'dm' },
    ...roster.map((slot): Owner => ({ kind: 'player', id: slot.id })),
  ];
  let everyone = cast();

  let here = new Set(initialHere.map(keyOf));
  let colours: Colours = initialColours;

  const chips = new Map<string, HTMLElement>();
  const dots = new Map<string, HTMLElement>();

  const paint = (): void => {
    for (const owner of everyone) {
      const key = keyOf(owner);
      const chip = chips.get(key);
      const dot = dots.get(key);
      if (chip === undefined || dot === undefined) continue;
      const present = here.has(key);
      chip.classList.toggle('is-away', !present);
      chip.title = present
        ? `${nameOf(owner, roster)} is here.`
        : `${nameOf(owner, roster)} is not connected.`;
      dot.style.backgroundColor = colourOf(owner, roster, colours);
    }
    // Only ever built for a player, so a DM's strip has nothing to close.
    for (const swatch of ui.swatches.children) {
      if (!(swatch instanceof HTMLElement)) continue;
      const at = Number(swatch.dataset['colour']);
      const mine = me.kind === 'player' ? colours[me.id] : undefined;
      swatch.classList.toggle('is-armed', mine === at);
    }
  };

  const closeSwatches = (): void => {
    ui.swatches.hidden = true;
  };

  const buildChips = (): void => {
    chips.clear();
    dots.clear();
    ui.chips.replaceChildren();
    for (const owner of everyone) {
      const key = keyOf(owner);
      const chip = document.createElement('span');
      chip.className = 'presence-chip';

      const dot = document.createElement('span');
      dot.className = 'presence-dot';

      const label = document.createElement('span');
      label.className = 'presence-name';
      // The slug, not the display name, as on the chat chips: it fits, and it
      // is what the DM already calls each character. The full name is on the
      // chip's tooltip.
      label.textContent = owner.kind === 'dm' ? 'DM' : owner.id;

      chip.append(dot, label);
      chips.set(key, chip);
      dots.set(key, dot);
      ui.chips.append(chip);
    }

    // The colour control, only for a player. It hangs off our own chip, where
    // our colour is already shown.
    const own = me.kind === 'player' ? chips.get(keyOf(me)) : undefined;
    if (own !== undefined) {
      own.classList.add('is-mine');
      own.setAttribute('role', 'button');
      own.tabIndex = 0;
      const open = (): void => {
        ui.swatches.hidden = !ui.swatches.hidden;
      };
      own.addEventListener('click', open);
      own.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
  };
  buildChips();

  if (me.kind === 'player') {
    PLAYER_HUES.forEach((hue, at) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'presence-swatch';
      swatch.dataset['colour'] = String(at);
      swatch.style.backgroundColor = hue;
      swatch.title = 'Draw in this colour.';
      swatch.setAttribute('aria-label', `colour ${at + 1}`);
      swatch.addEventListener('click', () => {
        // Nothing is predicted locally: the swatch updates when the room says
        // so, in the same frame that tells everybody else. Two people may pick
        // the same one. The server doesn't refuse it, and the name beside a
        // ring tells them apart.
        send({ type: 'set_colour', colour: at });
        closeSwatches();
      });
      ui.swatches.append(swatch);
    });
  }

  ui.swatches.hidden = true;
  ui.root.hidden = false;
  paint();

  return {
    connected(owner) {
      return here.has(keyOf(owner));
    },
    get colours() {
      return colours;
    },
    here(list) {
      here = new Set(list.map(keyOf));
      paint();
    },
    picked(next) {
      colours = next;
      paint();
    },
    recast() {
      everyone = cast();
      buildChips();
      paint();
    },
  };
}
