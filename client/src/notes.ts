/**
 * The scratchpad: one box of text, and it is yours.
 *
 * **The smallest module behind the dock, and the two decisions in it are both
 * about when text leaves the box rather than about the box.**
 *
 * **Nobody is sent this but you**, which is a fact about the room and not about
 * this file — there is no permission here to check and no identity to branch
 * on, because the command carries no key and the room keeps one box per socket
 * owner. What that buys the client is that the DM's copy of this module is the
 * same as everybody else's, which no other panel in the project can say.
 *
 * Be accurate about how far the privacy goes: the notes are in the save file
 * and the DM hosts the server, so anyone holding that file can read every one
 * of them. What is guaranteed is that **no client is ever sent somebody else's**
 * — the same guarantee the walls and the hit points get, and the only kind this
 * architecture makes about anything.
 *
 * **It sends on a pause, not on a keystroke and not on a submit.** A scratchpad
 * has no send button — the text *is* the state — so something has to decide
 * when a paragraph is finished, and a debounce is the answer that costs nothing
 * to use: type, stop, it is saved. `blur` flushes whatever the timer is still
 * holding, which is the case that would otherwise lose a sentence: somebody
 * types a line and clicks straight back onto the board.
 *
 * There is no "saved" indicator, deliberately. It would be the first piece of
 * UI in this project that narrates the network, and it would make a scratchpad
 * look like a document — which is the direction the non-goal in
 * `.claude/CLAUDE.md` draws a line against. **A second document makes it a
 * journal.**
 */

import type { ClientMsg } from './protocol.js';

/**
 * How long a pause counts as having stopped typing.
 *
 * Short enough that clicking away from the box almost never has anything left
 * to flush, long enough that a sentence is one frame rather than forty. The
 * drag throttle's argument, from the other end: there the room needs to see the
 * motion, here it only needs to see where the typing came to rest.
 */
const IDLE_MS = 500;

export interface NotesUi {
  root: HTMLElement;
  text: HTMLTextAreaElement;
}

export interface Notes {
  /** Our other tab wrote something. Never called for our own typing — the room
   *  does not echo it back, precisely so this cannot move our caret. */
  changed(text: string): void;
  /** The panel came on screen. */
  opened(): void;
}

export function createNotes(
  ui: NotesUi,
  initial: string,
  send: (msg: ClientMsg) => void,
): Notes {
  ui.text.value = initial;

  let pending: number | undefined;
  // What the room was last told. Compared before sending, so a `blur` after a
  // flush — or a second tab writing back exactly what is already here — is not
  // a frame.
  let sent = initial;

  const flush = (): void => {
    window.clearTimeout(pending);
    pending = undefined;
    if (ui.text.value === sent) return;
    sent = ui.text.value;
    send({ type: 'set_notes', text: sent });
  };

  ui.text.addEventListener('input', () => {
    window.clearTimeout(pending);
    pending = window.setTimeout(flush, IDLE_MS);
  });

  // The case the debounce alone would lose: a line typed and then a click
  // straight back onto the board, which is most of how this box gets used.
  ui.text.addEventListener('blur', flush);

  // A keystroke in this box belongs to this box — `chat.ts`'s rule, and it
  // matters more here. Every tool in the project listens on `window`, four of
  // them disarm on Escape, and `undo.ts` binds Ctrl+Z; a scratchpad is the one
  // place somebody types for a minute at a time with the board behind them.
  //
  // Escape is not swallowed to blur, unlike the chat box: this is a textarea
  // that people leave focused while they read, and the way out of it is the
  // board they were going to click anyway.
  ui.text.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });

  ui.root.hidden = true;

  return {
    changed(text) {
      // Whatever is being typed here right now was typed *later* than the frame
      // that just arrived, and the room's copy is about to be overwritten by
      // this box's own flush. Adopting on top of an unflushed edit would take
      // the sentence away mid-word, so the pending timer wins.
      if (pending !== undefined) return;
      sent = text;
      ui.text.value = text;
    },
    opened() {
      ui.text.focus();
    },
  };
}
