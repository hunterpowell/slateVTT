// The DM's cast list, on the table tab: who can join, and what they're called.
//
// The roster is room state (`RoomState::roster`), so its control lives on the
// table tab with the other room-wide fields. The DM adds, renames and removes;
// every change sends the whole list as one `set_roster`, and nothing here
// changes until the room answers with `roster_changed`, like every other panel
// in the rail.
//
// **A slot's id never changes once made.** It is what tokens, colours,
// scratchpads and each player's `localStorage` are keyed on, so a rename sends
// the same id with a new name. The id is made once, from the name, when the
// slot is added (`slugFor`), and the room checks it is a slug.
//
// Removing a slot is refused by the room while that player owns a token, and
// otherwise deletes their colour and scratchpad and sends them back to the
// character picker. The confirm says so, since there's no undo for it: see
// `docs/rooms.md`.

import type { ClientMsg, RosterEntry } from './protocol.js';

/** `MAX_ROSTER` in server/src/room.rs. The room is what enforces it. */
export const MAX_ROSTER = 12;
/** `MAX_PLAYER_NAME_LEN` in server/src/room.rs. */
export const MAX_PLAYER_NAME_LEN = 48;
/** `MAX_PLAYER_ID_LEN` in server/src/room.rs. */
export const MAX_PLAYER_ID_LEN = 32;

/**
 * The id a new slot called `name` gets: lowercase letters, digits and hyphens,
 * the rule `is_slug` holds on the server, and not one already in `taken`.
 *
 * Accents are folded rather than dropped, so "Zoë" is `zoe` and not `zo`. A
 * name with nothing sluggable in it is `player`. A clash gets `-2`, `-3` and so
 * on, so two characters called "Ash" are `ash` and `ash-2`.
 *
 * A name added again after its slot was removed makes the same id, which is
 * how a token restored by an undo finds its owner again.
 */
export function slugFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_PLAYER_ID_LEN)
      .replace(/-+$/, '') || 'player';

  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_PLAYER_ID_LEN - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export interface RosterEditorUi {
  /** One row per slot. Empty in the document; built here from the roster. */
  list: HTMLElement;
  name: HTMLInputElement;
  add: HTMLButtonElement;
}

export interface RosterEditor {
  /** The roster passed in at creation changed in place. Rebuild the rows. */
  recast(): void;
}

export function createRosterEditor(
  ui: RosterEditorUi,
  /** The live roster, the same array everything else in the client reads.
   *  Never written here: a change is sent, and the room's answer replaces it. */
  roster: readonly RosterEntry[],
  send: (msg: ClientMsg) => void,
  confirmRemove: (message: string) => boolean,
): RosterEditor {
  const sendCast = (next: RosterEntry[]): void => {
    send({ type: 'set_roster', roster: next });
  };

  const add = (): void => {
    const name = ui.name.value.trim();
    if (name === '' || roster.length >= MAX_ROSTER) return;
    const id = slugFor(
      name,
      roster.map((entry) => entry.id),
    );
    sendCast([...roster, { id, name }]);
    ui.name.value = '';
  };

  ui.add.addEventListener('click', add);
  ui.name.maxLength = MAX_PLAYER_NAME_LEN;
  // Stops keydown for the reason `chat.ts` gives: every tool listens on
  // `window`, and none should fire because somebody typed a name.
  ui.name.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') add();
  });

  const row = (entry: RosterEntry): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'table-roster-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'table-roster-name';
    name.value = entry.name;
    name.maxLength = MAX_PLAYER_NAME_LEN;
    name.dataset['id'] = entry.id;
    name.title = `${entry.name}'s id is ${entry.id}, which stays the same if you rename them.`;
    name.setAttribute('aria-label', `rename ${entry.name}`);
    // On `change`, which is a blur or Enter, not every keystroke: a rename is
    // one decision, and sending half a name would rename a character on six
    // screens mid-word.
    name.addEventListener('change', () => {
      const next = name.value.trim();
      if (next === '' || next === entry.name) {
        name.value = entry.name;
        return;
      }
      sendCast(roster.map((slot) => (slot.id === entry.id ? { id: slot.id, name: next } : slot)));
    });
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = entry.name;
        name.blur();
      }
    });

    // The slug, as the chat and presence chips show it: that's the label the
    // table will see for them.
    const id = document.createElement('span');
    id.className = 'table-roster-id';
    id.textContent = entry.id;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'map-subtle table-roster-remove';
    remove.textContent = 'remove';
    remove.addEventListener('click', () => {
      const sure = confirmRemove(
        `Remove ${entry.name}? Their colour and scratchpad are deleted, and anyone ` +
          `playing them is sent back to the character picker.`,
      );
      if (!sure) return;
      sendCast(roster.filter((slot) => slot.id !== entry.id));
    });

    line.append(name, id, remove);
    return line;
  };

  const build = (): void => {
    // A rename that was in the middle of being typed keeps its caret. The
    // rows are rebuilt on every `roster_changed`, including the one this
    // panel's own add caused, and the damage box in `panel.ts` records what
    // losing focus mid-edit costs.
    const active = document.activeElement;
    const focusedId =
      active instanceof HTMLInputElement && ui.list.contains(active) ? active.dataset['id'] : undefined;

    ui.list.replaceChildren(...roster.map(row));
    ui.add.disabled = roster.length >= MAX_ROSTER;
    ui.name.disabled = roster.length >= MAX_ROSTER;
    ui.name.placeholder =
      roster.length >= MAX_ROSTER ? `a room holds ${MAX_ROSTER} players` : 'a new character';

    if (focusedId !== undefined) {
      ui.list.querySelector<HTMLInputElement>(`input[data-id="${CSS.escape(focusedId)}"]`)?.focus();
    }
  };
  build();

  return { recast: build };
}
