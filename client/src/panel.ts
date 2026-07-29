// The initiative panel. Read-only for players; the DM gets the controls.
//
// Rebuilt wholesale on every change rather than diffed — it is at most a dozen
// rows and only changes when the DM does something deliberate.

import type { Identity } from './identity.js';
import type { ClientMsg, Initiative } from './protocol.js';
import type { Scene, Token } from './scene.js';

export interface Panel {
  update(initiative: Initiative, scene: Scene): void;
}

interface PanelUi {
  root: HTMLElement;
  round: HTMLElement;
  list: HTMLElement;
  controls: HTMLElement;
  form: HTMLFormElement;
  tokenSelect: HTMLSelectElement;
  valueInput: HTMLInputElement;
  clear: HTMLButtonElement;
  next: HTMLButtonElement;
  previous: HTMLButtonElement;
}

export function createPanel(
  ui: PanelUi,
  identity: Identity,
  send: (msg: ClientMsg) => void,
): Panel {
  const isDm = identity.isDm;

  ui.controls.hidden = !isDm;
  ui.form.hidden = !isDm;
  ui.clear.hidden = !isDm;

  if (isDm) {
    ui.next.addEventListener('click', () => send({ type: 'next_turn' }));
    ui.previous.addEventListener('click', () => send({ type: 'previous_turn' }));

    ui.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = ui.tokenSelect.value;
      const value = Number.parseInt(ui.valueInput.value, 10);
      if (token === '' || Number.isNaN(value)) return;
      send({ type: 'set_initiative', token, value });
      ui.valueInput.value = '';
      ui.valueInput.focus();
    });

    ui.clear.addEventListener('click', () => {
      // The order takes real effort to enter and a stray click would bin it
      // mid-combat.
      if (!window.confirm('Clear the initiative order?')) return;
      send({ type: 'clear_initiative' });
    });
  }

  let knownTokenIds = '';

  return {
    update(initiative, scene) {
      const tokenFor = (id: string): Token | undefined =>
        scene.tokens.find((t: Token) => t.id === id);
      const nameOf = (id: string): string => tokenFor(id)?.name ?? id;

      ui.round.textContent = `Round ${initiative.round}`;

      ui.list.replaceChildren(
        ...initiative.entries.map((entry) => {
          const row = document.createElement('li');
          row.className = 'init-row';
          if (entry.token === initiative.current) row.classList.add('is-current');
          // Only ever on the DM's panel — a hidden creature's row is filtered
          // out of the table's copy server-side. It is marked because the two
          // panels now differ, and the DM is the one who has to know that this
          // row is a name only they can read.
          if (tokenFor(entry.token)?.hidden === true) row.classList.add('is-unseen');

          const value = document.createElement('span');
          value.className = 'init-value';
          value.textContent = String(entry.value);

          const name = document.createElement('span');
          name.className = 'init-name';
          name.textContent = nameOf(entry.token);

          row.append(value, name);

          if (isDm) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'init-remove';
            remove.title = `Remove ${nameOf(entry.token)}`;
            remove.textContent = '×';
            remove.addEventListener('click', () =>
              send({ type: 'remove_from_initiative', token: entry.token }),
            );
            row.append(remove);
          }

          return row;
        }),
      );

      if (isDm) {
        // Only rebuild the dropdown when the token list itself changes, so a
        // half-made selection survives every turn advance. Names are part of
        // that: renaming a token has to reach the option that shows it.
        const ids = scene.tokens.map((t) => `${t.id}:${t.name}`).join(',');
        if (ids !== knownTokenIds) {
          knownTokenIds = ids;
          ui.tokenSelect.replaceChildren(
            ...[...scene.tokens]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((token) => {
                const option = document.createElement('option');
                option.value = token.id;
                option.textContent = token.name;
                return option;
              }),
          );
        }
      }

      // Players only see the panel once there is something in it; the DM always
      // needs it, since that is where combat gets started.
      ui.root.hidden = !isDm && initiative.entries.length === 0;
    },
  };
}
