/**
 * The DM's undo button.
 *
 * Not a rail tab, and not behind one. The rail shows one editing panel at a
 * time, and undo isn't an editing panel: the DM reaches for it while using
 * whichever panel is open, which is also why the draw tool is pinned. So it
 * sits above the tab strip, always on screen for the DM and absent for
 * everyone else.
 *
 * It names what it would undo. There is no redo, so a press the DM can't
 * predict is unrecoverable. The fog fill handles the same problem the same
 * way: show the result before it lands instead of confirming after. The label
 * comes from the room, not from what this client last sent, so it stays right
 * when the DM's other tab, or a player's drawing, added the step.
 *
 * The button is disabled when there is nothing to undo. That is the rail's
 * inert-tab rule (a control that can do nothing must not look usable), and it
 * also spares the DM a refusal from the room.
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
 * Whether a keystroke belongs to whatever somebody is typing in.
 *
 * Ctrl+Z inside the token name, the hit point boxes or the initiative value is
 * the browser's own undo. Taking it there would make the standard shortcut
 * revert the whole room instead of the text. `isContentEditable` is included
 * for completeness; this project has no such element.
 *
 * **Every global key except Escape must check this**, which is why it is
 * exported. Home, for example, is start-of-line inside the chat box before it
 * has anything to do with the camera. The four Escape bindings don't need it
 * only because the element-scoped handlers beside them call stopPropagation.
 */
export function typingIn(target: EventTarget | null): boolean {
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
    // The label is all the button says, so an empty ring gets its own text
    // instead of a sentence with a hole in it.
    ui.button.textContent = label === null ? 'nothing to undo' : `undo: ${label}`;
    ui.button.title =
      label === null
        ? 'Nothing has changed yet this session.'
        : `Put the room back the way it was before ${label}. There is no redo.`;
  };

  const fire = (): void => {
    // Guarded here as well as by `disabled`, because the keyboard path doesn't
    // go through the button. The label can still be stale by one round trip.
    if (label === null) return;
    send({ type: 'undo' });
  };

  ui.button.addEventListener('click', fire);

  // Ctrl+Z and Cmd+Z both, since the DM may be on a Mac. There is no redo, so
  // nothing is bound to Shift; the `'Z'` check means Ctrl+Shift+Z undoes too.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'z' && e.key !== 'Z') return;
    if (!e.ctrlKey && !e.metaKey) return;
    if (typingIn(e.target)) return;
    // Only once the room has said there is something to undo, so the shortcut
    // doesn't swallow the browser's own when the ring is empty.
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
