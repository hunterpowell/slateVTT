/**
 * The DM's undo button.
 *
 * **Not a rail tab, and not behind one.** The rail shows one editing panel at a
 * time, and undo is not an editing panel — it is reached in the middle of using
 * whichever one is open, which is exactly the draw tool's argument for being
 * pinned. So it sits above the tab strip, always on screen for the DM and absent
 * for everyone else.
 *
 * **It names what it would take.** There is no redo, so a press the DM cannot
 * predict is unrecoverable — the same problem the fog fill solved by previewing
 * before it commits, answered the same way: show the result before it lands
 * rather than confirm after. The label comes off the room rather than from
 * whatever this client last sent, which is what keeps it right when the DM's
 * other tab, or a player's drawing, is what added the step.
 *
 * The button is disabled when there is nothing to take. That is the rail's
 * inertness rule in its plainest form — a control that can do nothing must not
 * look armed — and here it also spares the DM a refusal from the room.
 */

import type { ClientMsg } from './protocol.js';

export interface UndoUi {
  root: HTMLElement;
  button: HTMLButtonElement;
}

export interface Undo {
  /** Takes the room's word for what the next press would undo. Null disables. */
  update(label: string | null): void;
}

/**
 * Whether a keystroke belongs to whatever the DM is typing in.
 *
 * Ctrl+Z inside the token name, the hit point boxes or the initiative value is
 * the browser's own undo, and stealing it there would make a text field the one
 * place in the application where the standard shortcut does something violent
 * and unrelated. `isContentEditable` is in for completeness rather than because
 * this project has one.
 */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function createUndo(ui: UndoUi, send: (msg: ClientMsg) => void): Undo {
  let label: string | null = null;

  const paint = (): void => {
    ui.button.disabled = label === null;
    // The label is the *whole* of what the button says, so an empty ring reads
    // as a plain "undo" rather than as a sentence with a hole in it.
    ui.button.textContent = label === null ? 'nothing to undo' : `undo: ${label}`;
    ui.button.title =
      label === null
        ? 'Nothing has changed yet this session.'
        : `Put the room back the way it was before ${label}. There is no redo.`;
  };

  const fire = (): void => {
    // Guarded here as well as by `disabled`, because the keyboard path does not
    // go through the button and a stale label is one round trip wide.
    if (label === null) return;
    send({ type: 'undo' });
  };

  ui.button.addEventListener('click', fire);

  // The first modifier binding in this client, and the first global key that is
  // not Escape. Ctrl+Z and Cmd+Z both, since the DM may be on a Mac; Shift+Z is
  // deliberately not redo, because there is no redo to bind.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'z' && e.key !== 'Z') return;
    if (!e.ctrlKey && !e.metaKey) return;
    if (typingIn(e.target)) return;
    // Only once the room has said there is something to undo, so the shortcut
    // does not swallow the browser's own on a board with an empty ring.
    if (label === null) return;
    e.preventDefault();
    fire();
  });

  paint();
  ui.root.hidden = false;

  return {
    update(next: string | null): void {
      label = next;
      paint();
    },
  };
}
