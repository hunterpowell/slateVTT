// The "who are you?" overlay. Shown when the server has no identity for this
// browser — which is also the only state in which the server has sent us no
// room state at all, so there is nothing behind it to look at.

import type { RosterSlot } from './protocol.js';

export interface Picker {
  show(roster: RosterSlot[]): void;
  hide(): void;
}

export function createPicker(root: HTMLElement, onPick: (playerId: string) => void): Picker {
  const list = root.querySelector<HTMLElement>('.picker-list');
  if (list === null) throw new Error('#picker is missing its .picker-list');

  return {
    // Re-sent by the server whenever a slot is taken or freed, so this can be
    // called repeatedly while the picker is open.
    show(roster) {
      list.replaceChildren(
        ...roster.map((slot) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'picker-choice';
          if (slot.claimed) button.classList.add('is-claimed');

          const name = document.createElement('span');
          name.textContent = slot.name;
          button.append(name);

          if (slot.claimed) {
            // Still clickable: one person on a laptop and a phone is a real
            // case, and this is a private game. It is a warning, not a lock.
            const note = document.createElement('span');
            note.className = 'picker-note';
            note.textContent = 'in use';
            button.append(note);
          }

          button.addEventListener('click', () => onPick(slot.id), { once: true });
          return button;
        }),
      );
      root.hidden = false;
    },

    hide() {
      root.hidden = true;
      list.replaceChildren();
    },
  };
}
