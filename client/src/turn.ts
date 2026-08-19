/**
 * "It is your turn" — the one thing a player at a table on Discord misses while
 * they are looking at something else.
 *
 * **Client-only, and it is the cheapest feature in this project.** Nothing here
 * touches the wire: `initiative.current` already arrives on every change, the
 * scene already says who owns each token, and `identity.ts` already says who we
 * are. The room does not know this exists and there is nothing for it to know —
 * whose turn it is is not a secret, it is the panel two inches away.
 *
 * Three rules, and the first is the one that would ruin it.
 *
 * **It must not fire on a `Welcome` or a `Restored`.** Adopting state is not a
 * turn change: a refresh mid-combat would flash the tab of whoever is already
 * looking at it, and a DM undoing something would nudge six people at once for a
 * turn that did not move. So the previous value is *seeded* from those frames
 * rather than compared against — `adopt` and `update` are two methods for that
 * reason and not for tidiness.
 *
 * **It does not open or move anything.** The title flashes, and a line surfaces
 * beside the dock. No panel opens, no camera pans — the ping arrow, the folded
 * initiative panel and the chat badge each already refuse to move the board
 * under somebody who might be mid-drag, and this is the fourth thing to.
 *
 * **The title only flashes while the tab is hidden.** That is the whole of what
 * the title is for here: a tab in the background is the case where the panel
 * cannot be seen. It stops the moment the tab is looked at.
 *
 * One thing is deliberately left open rather than pre-solved: **it fires for the
 * DM on every monster's turn**, because monsters are owned by the DM and it
 * genuinely is their turn to act. That may be right or may be noise, and only
 * playing a session with it decides — the same shape as the draw tool's question
 * in milestone 19. The cheap answer if it is noise is a `localStorage`
 * off-switch, not a rule invented here first.
 */

import type { Identity } from './identity.js';
import type { Initiative } from './protocol.js';
import type { Scene } from './scene.js';

/** How long the line beside the dock stays. The chat toast's span, because it
 *  is the same box in the same place answering the same question — did I miss
 *  something while I was looking away. */
const TOAST_MS = 6000;

/** How fast the title alternates while the tab is hidden. Slow enough to read
 *  the room name between flashes, fast enough to catch out of the corner of an
 *  eye on a taskbar. */
const FLASH_MS = 1000;

export interface TurnUi {
  /** The box beside the dock. Its own element rather than the chat toast's, so
   *  a whisper arriving does not wipe out the news that you are up. */
  toast: HTMLElement;
}

export interface Turn {
  /** A fresh initiative frame. Fires if the turn moved to something we own. */
  update(initiative: Initiative, scene: Scene): void;
  /** Take this as the current turn without firing. What a join and a restore
   *  do — see the note at the top of this file. */
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

  // Looking at the tab is the answer to the question the flashing asked, so it
  // stops — including when the flashing started while the tab was already
  // visible and did nothing at all.
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

      // A creature we cannot see is absent from our token list entirely — the
      // server filters it out — so this finding nothing is the same answer as
      // it not being ours, and needs no separate case.
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
