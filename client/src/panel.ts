// The initiative panel. Read-only for players; the DM gets the controls.
//
// Rebuilt wholesale on every change rather than diffed — it is at most a dozen
// rows and only changes when the DM does something deliberate.

import type { Identity } from './identity.js';
import type { ClientMsg, Initiative } from './protocol.js';
// The only thing this panel takes from the renderer, and it takes it so that the
// bar in a row and the bar over the token cannot disagree about which monster is
// nearly down. See `hpColour` for the argument.
import { hpColour, hpFilled } from './render.js';
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
  /**
   * Put the camera on this token. Everyone gets it, not just the DM: a player
   * looking for whoever just went is the same want, and the panel already only
   * lists what that client may see.
   *
   * A callback rather than a camera, because the camera is main.ts's and the
   * panel has no business holding one — it knows which row was clicked and
   * nothing about coordinates.
   */
  look: (token: Token) => void,
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
          const token = tokenFor(entry.token);

          const row = document.createElement('li');
          row.className = 'init-row';
          if (entry.token === initiative.current) row.classList.add('is-current');
          // Only ever on the DM's panel — a hidden creature's row is filtered
          // out of the table's copy server-side. It is marked because the two
          // panels now differ, and the DM is the one who has to know that this
          // row is a name only they can read.
          if (token?.hidden === true) row.classList.add('is-unseen');

          const value = document.createElement('span');
          value.className = 'init-value';
          value.textContent = String(entry.value);

          // The same disc the canvas draws, in DOM: a circle whose grey shows
          // through when there is no art, so a token without a picture degrades
          // to exactly what it looks like on the board. No image cache and no
          // second download — the browser already has this URL from the canvas.
          const art = document.createElement('span');
          art.className = 'init-art';
          const src = token?.img ?? '';
          if (src !== '') art.style.backgroundImage = `url("${src}")`;

          // Name over bar. Two lines rather than one row of three things,
          // because the panel is narrow and a name is the part that has to stay
          // readable when a monster is called "Bugbear Chieftain".
          const body = document.createElement('span');
          body.className = 'init-body';

          const line = document.createElement('span');
          line.className = 'init-line';

          const name = document.createElement('span');
          name.className = 'init-name';
          name.textContent = nameOf(entry.token);
          line.append(name);

          // No check for who is reading this. `hp` is redacted server-side, so a
          // player's copy of the token carries null and there is nothing here to
          // decline to draw — invariant 4's shape, and the same reason
          // `drawHitPoints` needs no guard either.
          const hp = token?.hp ?? null;
          if (hp !== null) {
            const filled = hpFilled(hp);

            const total = document.createElement('span');
            total.className = 'init-hp-text';
            total.textContent = `${hp.current}/${hp.max}`;
            line.append(total);

            const track = document.createElement('span');
            track.className = 'init-hp';
            const fill = document.createElement('span');
            fill.className = 'init-hp-fill';
            fill.style.width = `${filled * 100}%`;
            fill.style.backgroundColor = hpColour(filled);
            track.append(fill);
            body.append(line, track);
          } else {
            body.append(line);
          }

          row.append(value, art, body);

          if (isDm) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'init-remove';
            remove.title = `Remove ${nameOf(entry.token)}`;
            remove.textContent = '×';
            remove.addEventListener('click', (e) => {
              // The row underneath would otherwise also fire, and the last thing
              // a click that deletes something should do is move the camera.
              e.stopPropagation();
              send({ type: 'remove_from_initiative', token: entry.token });
            });
            row.append(remove);
          }

          // A token staged for the next map has no position on this one, and
          // `look` will find that out — but a row that cannot be looked at
          // should not offer to be, so the pointer only changes where it can.
          if (token !== undefined) {
            row.classList.add('is-lookable');
            row.title = `Look at ${nameOf(entry.token)}`;
            row.addEventListener('click', () => look(token));
          }

          return row;
        }),
      );

      if (isDm) {
        // A token built on the next map is not in this fight — the server
        // refuses it, and offering it would be offering an error. Combat is the
        // fight happening now; next room's order needs rolls nobody has made.
        const rollable = scene.tokens.filter((t) => !t.stagedOnly);

        // Only rebuild the dropdown when the token list itself changes, so a
        // half-made selection survives every turn advance. Names are part of
        // that: renaming a token has to reach the option that shows it.
        const ids = rollable.map((t) => `${t.id}:${t.name}`).join(',');
        if (ids !== knownTokenIds) {
          knownTokenIds = ids;
          ui.tokenSelect.replaceChildren(
            ...[...rollable]
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
