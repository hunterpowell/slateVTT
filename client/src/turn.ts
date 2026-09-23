/**
 * "It's your turn": the one thing a player on Discord misses while they are
 * looking at something else.
 *
 * Client-only. Nothing here touches the wire: `initiative.current` already
 * arrives on every change, the scene already says who owns each token, and
 * `identity.ts` already says who we are. The room doesn't know this exists and
 * has no reason to: whose turn it is isn't a secret, it is in the initiative
 * panel.
 *
 * Three rules. Breaking the first ruins the feature.
 *
 * **It must not fire on a `Welcome` or a `Restored`.** Adopting state isn't a
 * turn change: a refresh mid-combat would flash the tab of whoever is already
 * looking at it, and a DM's undo would nudge six people at once for a turn
 * that didn't move. So those frames seed the previous value instead of being
 * compared against it. That is why `adopt` and `update` are separate methods.
 *
 * It doesn't open or move anything. The title flashes and a line appears
 * beside the dock. No panel opens and the camera doesn't pan, like the ping
 * arrow, the folded initiative panel and the chat badge: none of them moves
 * the board under somebody who might be mid-drag.
 *
 * The title only flashes while the tab is hidden, since a background tab is
 * when the panel can't be seen. It stops as soon as the tab is looked at.
 *
 * One question is left open: it fires for the DM on every monster's turn,
 * because the DM owns the monsters and it is their turn to act. That may be
 * right or may be noise, and only playing a session with it will tell. If it
 * is noise, the cheap fix is a `localStorage` off-switch, not a rule invented
 * here first.
 */

import type { Identity } from './identity.js';
import type { Initiative } from './protocol.js';
import type { Scene } from './scene.js';

/** How long the line beside the dock stays. Same as the chat toast, because it
 *  is in the same place and for the same purpose: telling you what you missed
 *  while looking away. */
const TOAST_MS = 6000;

/** How fast the title alternates while the tab is hidden. Slow enough to read
 *  the room name between flashes, fast enough to catch out of the corner of an
 *  eye on a taskbar. */
const FLASH_MS = 1000;

export interface TurnUi {
  /** The box beside the dock. Its own element, not the chat toast's, so a
   *  whisper arriving doesn't replace the news that you are up. */
  toast: HTMLElement;
}

export interface Turn {
  /** A fresh initiative frame. Fires if the turn moved to something we own. */
  update(initiative: Initiative, scene: Scene): void;
  /** Take this as the current turn without firing. Used on a join and a
   *  restore; see the note at the top of this file. */
  adopt(initiative: Initiative): void;
}

export function createTurn(ui: TurnUi, identity: Identity, initiative: Initiative): Turn {
  /** The turn as of the last frame. Seeded from the join, so the first thing
   *  this can ever report is a change. */
  let was: string | null = initiative.current;

  const title = document.title;
  let flashing: number | undefined;
  let toastAt: number | undefined;

  const stopFlashing = (): void => {
    window.clearInterval(flashing);
    flashing = undefined;
    document.title = title;
  };

  // Looking at the tab stops the flashing.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopFlashing();
  });

  const flash = (): void => {
    if (!document.hidden || flashing !== undefined) return;
    let on = false;
    flashing = window.setInterval(() => {
      on = !on;
      document.title = on ? '▶ your turn' : title;
    }, FLASH_MS);
  };

  const surface = (name: string): void => {
    ui.toast.textContent = `${name} — your turn`;
    ui.toast.hidden = false;
    window.clearTimeout(toastAt);
    toastAt = window.setTimeout(() => {
      ui.toast.hidden = true;
    }, TOAST_MS);
  };

  return {
    update(initiative, scene) {
      const now = initiative.current;
      if (now === was) return;
      was = now;
      if (now === null) return;

      // The server filters a creature we can't see out of our token list, so
      // finding nothing means it isn't ours and needs no separate case.
      const token = scene.tokens.find((t) => t.id === now);
      if (token === undefined) return;
      const mine =
        token.owner.kind === 'dm'
          ? identity.isDm
          : token.owner.id === identity.playerId;
      if (!mine) return;

      surface(token.name);
      flash();
    },
    adopt(initiative) {
      was = initiative.current;
    },
  };
}
