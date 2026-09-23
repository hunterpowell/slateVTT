/**
 * The scratchpad: one box of text, and it is yours.
 *
 * The smallest module behind the dock. Its two decisions are about when text
 * leaves the box.
 *
 * Nobody is sent this but you. That is enforced by the room, not this file:
 * there is no permission to check and no identity to branch on here, because
 * the command carries no key and the room keeps one box per socket owner. So
 * the DM's copy of this module is the same as everybody else's.
 *
 * The privacy has a limit: the notes are in the save file and the DM hosts
 * the server, so anyone holding that file can read all of them. What is
 * guaranteed is that **no client is ever sent somebody else's**, the same
 * guarantee the walls and the hit points get.
 *
 * It sends on a pause, not on each keystroke or on a submit. A scratchpad has
 * no send button (the text is the state), so something has to decide when a
 * paragraph is finished, and a debounce needs no action from the user: type,
 * stop, it is saved. `blur` flushes whatever the timer is still holding, so a
 * sentence isn't lost when somebody types a line and clicks straight back onto
 * the board.
 *
 * There is no "saved" indicator. It would be the first UI in this project that
 * reports on the network, and it would make a scratchpad look like a document,
 * which the non-goal in `.claude/CLAUDE.md` rules out: a second document makes
 * it a journal.
 */

import type { ClientMsg } from './protocol.js';

/**
 * How long a pause counts as having stopped typing.
 *
 * Short enough that clicking away from the box almost never has anything left
 * to flush, long enough that a sentence is one frame, not forty. Compare the
 * drag throttle: there the room needs to see the motion, here it only needs to
 * see where the typing stopped.
 */
const IDLE_MS = 500;

export interface NotesUi {
  root: HTMLElement;
  text: HTMLTextAreaElement;
}

export interface Notes {
  /** Our other tab wrote something. Never called for our own typing: the room
   *  doesn't echo it back, so this can't move our caret. */
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
  // flush, or a second tab writing back what is already here, sends nothing.
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
  // straight back onto the board, which is how this box is mostly used.
  ui.text.addEventListener('blur', flush);

  // A keystroke in this box stays in this box, as in `chat.ts`, and it matters
  // more here. Every tool in the project listens on `window`, four of them
  // disarm on Escape, and `undo.ts` binds Ctrl+Z. A scratchpad is where
  // somebody types for a minute at a time with the board behind them.
  //
  // Unlike the chat box, Escape doesn't blur. People leave this textarea
  // focused while they read, and the way out is clicking the board, which
  // they were going to do anyway.
  ui.text.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });

  ui.root.hidden = true;

  return {
    changed(text) {
      // Whatever is being typed here now is newer than the frame that just
      // arrived, and this box's own flush is about to overwrite the room's
      // copy. Adopting on top of an unflushed edit would erase the sentence
      // mid-word, so the pending timer wins.
      if (pending !== undefined) return;
      sent = text;
      ui.text.value = text;
    },
    opened() {
      ui.text.focus();
    },
  };
}
