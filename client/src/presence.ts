/**
 * The presence strip: who is here, and what colour they draw in.
 *
 * Two features on one row of chips, and they are together because they are the
 * same seven names looked at twice — who is connected is written on a chip, and
 * what colour that person picked is what the chip is written in. A second
 * control somewhere else would have meant looking up the same list twice.
 *
 * Three decisions are worth keeping.
 *
 * **It is the top of the right-hand column**, which is the one edge of that
 * column that never moves: the initiative panel folds and the dock grows upward
 * from the bottom, so anything between them shifts when either does. A strip
 * that answers "is the DM still there" is worth nothing if it is somewhere
 * different every time you look.
 *
 * **Absent people dim rather than disappear.** Every roster slot is drawn from
 * the moment the page loads and never leaves, so the row has one layout for the
 * whole session — a chip that vanished would move its neighbours under the
 * pointer, and would also make "nobody is here" and "there is no such person"
 * the same picture.
 *
 * **The colour control is your own chip**, because that is where your colour
 * already is. It is not a third dock tab: `dock.ts` argues against that itself,
 * since what belongs there is a thing you read while something else is going on,
 * and this is one click twice a campaign. The DM has no control at all — their
 * hue sits outside the six on purpose, and the server refuses a `set_colour`
 * from them, so a picker on their chip would be a button that only ever
 * produced a red banner.
 */

import type { Identity } from './identity.js';
import { PLAYER_HUES, colourOf, nameOf } from './pings.js';
import type { ClientMsg, Colours, Owner, RosterEntry } from './protocol.js';

export interface PresenceUi {
  root: HTMLElement;
  /** The chips. Empty in the document — one per roster slot plus the DM's, so
   *  which ones exist depends on the roster and they are built here. */
  chips: HTMLElement;
  /** The swatch row that opens under your own chip. Empty in the document, and
   *  hidden until it is asked for. */
  swatches: HTMLElement;
}

export interface Presence {
  /** Is this person connected right now?
   *
   *  Chat asks it about a destination — whispering somebody who is not there is
   *  the specific failure this feature exists to prevent. */
  connected(owner: Owner): boolean;
  /** What everybody picked, as the room last said.
   *
   *  **A live reference**, read at draw time by everything that colours
   *  anything. Replacing it wholesale would leave the renderer and the chat log
   *  holding the table from before somebody changed their mind. */
  readonly colours: Colours;
  /** Somebody joined or left. */
  here(list: readonly Owner[]): void;
  /** Somebody picked a colour. */
  picked(colours: Colours): void;
}

/** A key for one person that a `Set` or a `Map` can hold. `Owner` is an object,
 *  so two copies of the same identity are never the same value.
 *
 *  Exported for `cursors.ts`, which keeps one pointer per person and needs the
 *  same answer to "is this the same person" that this file and `chat.ts`
 *  already share. */
export function keyOf(owner: Owner): string {
  return owner.kind === 'dm' ? 'dm' : `player:${owner.id}`;
}

/** Whether these two name the same person. Exported because `chat.ts` asks it
 *  of a line's sender, and one answer to "is this the same person" is better
 *  than two that could drift. */
export function sameOwner(a: Owner, b: Owner): boolean {
  return keyOf(a) === keyOf(b);
}

/** Who this client is, as an `Owner` — the pair of facts `pings.ts` resolves a
 *  name and a colour from. Here rather than in `identity.ts`, which knows about
 *  a slot in `localStorage` and nothing about the table. */
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
  // Everyone who could be here, in one order that never changes: the DM, then
  // the roster's own. The strip is built from this once and never rebuilt, which
  // is what keeps the row from reflowing as people come and go.
  const everyone: Owner[] = [
    { kind: 'dm' },
    ...roster.map((slot): Owner => ({ kind: 'player', id: slot.id })),
  ];

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

  for (const owner of everyone) {
    const key = keyOf(owner);
    const chip = document.createElement('span');
    chip.className = 'presence-chip';

    const dot = document.createElement('span');
    dot.className = 'presence-dot';

    const label = document.createElement('span');
    label.className = 'presence-name';
    // The slug rather than the display name, which is what the chat chips do
    // and for the same reason: it fits, and it is what the DM already calls each
    // character. The full name is on the chip's tooltip.
    label.textContent = owner.kind === 'dm' ? 'DM' : owner.id;

    chip.append(dot, label);
    chips.set(key, chip);
    dots.set(key, dot);
    ui.chips.append(chip);
  }

  // The control, and only for a player. It hangs off the one chip that is ours,
  // which is where our colour is already shown.
  if (me.kind === 'player') {
    const own = chips.get(keyOf(me));
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

    PLAYER_HUES.forEach((hue, at) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'presence-swatch';
      swatch.dataset['colour'] = String(at);
      swatch.style.backgroundColor = hue;
      swatch.title = 'Draw in this colour.';
      swatch.setAttribute('aria-label', `colour ${at + 1}`);
      swatch.addEventListener('click', () => {
        // Nothing is predicted locally: the swatch settles when the room says
        // so, which is the same frame that tells everybody else. Two people may
        // land on the same one — the name beside a ring is what tells them
        // apart, and the server does not refuse it.
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
  };
}
