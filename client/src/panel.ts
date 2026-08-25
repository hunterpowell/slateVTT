// The initiative panel. Read-only for players; the DM gets the controls.
//
// Rebuilt wholesale on every change rather than diffed — it is at most a dozen
// rows and only changes when the DM does something deliberate.

import type { Identity } from './identity.js';
import { asTable, tableInitiative } from './mirror.js';
import type { ClientMsg, Initiative } from './protocol.js';
// The only thing this panel takes from the renderer, and it takes it so that the
// bar in a row and the bar over the token cannot disagree about which monster is
// nearly down. See `hpColour` for the argument.
import { hpColour, hpFilled } from './render.js';
import type { Scene, Token } from './scene.js';

export interface Panel {
  update(initiative: Initiative, scene: Scene): void;
  /**
   * Draw the rows the table has, rather than the ones the DM has.
   *
   * The board is redrawn every frame from a scene main.ts narrows on the way
   * in; this panel is redrawn only when something arrives, so it is told
   * instead. It goes through the same two functions either way — see
   * `mirror.ts`.
   */
  mirror(on: boolean): void;
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
  collapse: HTMLButtonElement;
}

/**
 * The DM's copy of a row's number: an input that reads as the span it replaces
 * until it is pointed at.
 *
 * Commits on `change` rather than on `input`, which is what makes it usable at
 * all — the order re-sorts on every value the server accepts, so a keystroke
 * that committed would move the row out from under the caret while the second
 * digit was still being typed.
 */
function valueField(value: number, name: string, commit: (value: number) => void): HTMLElement {
  const field = document.createElement('input');
  field.type = 'number';
  field.step = '1';
  field.className = 'init-value init-value-edit';
  field.value = String(value);
  field.setAttribute('aria-label', `${name}'s initiative`);
  field.title = `${name}'s initiative`;

  // The row underneath looks at the creature, and clicking a number to correct
  // it is not a request to move the camera. Same reason the `×` stops here.
  field.addEventListener('click', (e) => e.stopPropagation());

  field.addEventListener('change', () => {
    const next = Number.parseInt(field.value, 10);
    // Emptied, or otherwise not a number. Put the row's own back rather than
    // sending something the server would have to guess at.
    if (Number.isNaN(next)) {
      field.value = String(value);
      return;
    }
    commit(next);
  });

  // Abandoning an edit has to be possible, and a blur commits — so this puts
  // the number back first, which leaves the blur that follows with nothing to
  // report.
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    field.value = String(value);
    field.blur();
  });

  return field;
}

/**
 * Whether this browser had the list folded away last time.
 *
 * `localStorage` and deliberately not the room, which is the line `diagonals`
 * falls on the other side of: that one is on `RoomState` because the only thing
 * the server is authoritative over there is that six clients agree on a *rule*.
 * How much of a panel somebody wants on their own screen is nobody else's
 * business and nothing has to agree about it.
 *
 * Wrapped for the reason `identity.ts` wraps its own reads: a private browsing
 * mode can throw on the property itself, and defaulting to the expanded panel is
 * a worse outcome than a crash only in theory.
 */
const COLLAPSED_KEY = 'slate.initiative.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* the panel still folds; it just forgets by the next load */
  }
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

  // Null rather than empty, because empty is a list the dropdown can genuinely
  // hold — everybody already in the order — and the first build has to happen
  // even then, to put the placeholder in and take the clicks off it.
  let knownTokenIds: string | null = null;

  let collapsed = readCollapsed();
  // The last frame this panel was handed, so the chevron can redraw without one
  // arriving. Nothing else needs it: everything else that changes this panel
  // comes off the wire and brings its own.
  let last: { initiative: Initiative; scene: Scene } | null = null;
  /** The DM is looking at the table's board, so this shows the table's rows. */
  let mirrored = false;

  /** Redraws from whatever was last handed over. Two things need it now: the
   *  chevron, and the mirror going up or coming down. */
  const repaint = (): void => {
    if (last !== null) panel.update(last.initiative, last.scene);
  };

  ui.collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    storeCollapsed(collapsed);
    repaint();
  });

  const panel: Panel = {
    mirror(on) {
      if (on === mirrored) return;
      mirrored = on;
      repaint();
    },

    update(initiative, scene) {
      // What the room said, kept before the mirror narrows it: putting the
      // mirror down has to redraw from the room rather than from a filtered
      // copy of it, and a filtered copy filtered again is what storing the
      // other order would give.
      last = { initiative, scene };
      if (mirrored) {
        // The order first, from the scene the DM actually holds — it is the
        // unfiltered token list that says which rows have to go, and asking the
        // filtered one would find nothing to drop.
        initiative = tableInitiative(initiative, scene);
        scene = asTable(scene);
      }

      ui.collapse.setAttribute('aria-expanded', String(!collapsed));
      ui.collapse.title = collapsed ? 'Show the whole order' : 'Show only whose turn it is';

      // Collapsed is the current row and nothing else — the same row, built by
      // the same code below, so the folded panel is the unfolded one's
      // highlighted line rather than a second rendering of it.
      const entries = collapsed
        ? initiative.entries.filter((entry) => entry.token === initiative.current)
        : initiative.entries;

      // A fight is running and whoever is up is not on this client's board — a
      // hidden creature's row is filtered out of the table's copy server-side,
      // so the collapsed list has nothing to draw. The placeholder must not call
      // that "no combat".
      ui.list.classList.toggle('is-quiet', collapsed && initiative.entries.length > 0);

      const tokenFor = (id: string): Token | undefined =>
        scene.tokens.find((t: Token) => t.id === id);
      const nameOf = (id: string): string => tokenFor(id)?.name ?? id;

      ui.round.textContent = `Round ${initiative.round}`;

      ui.list.replaceChildren(
        ...entries.map((entry) => {
          const token = tokenFor(entry.token);

          const row = document.createElement('li');
          row.className = 'init-row';
          if (entry.token === initiative.current) row.classList.add('is-current');
          // Only ever on the DM's panel — a hidden creature's row is filtered
          // out of the table's copy server-side. It is marked because the two
          // panels now differ, and the DM is the one who has to know that this
          // row is a name only they can read.
          if (token?.hidden === true) row.classList.add('is-unseen');

          // The number is the DM's to correct in place. A misheard roll used to
          // be re-entered through the form below, which worked because
          // `set_initiative` re-values a token already in the order — and that
          // is exactly the path the dropdown gave up when it stopped listing
          // one. The command is the same either way; only where it is typed
          // changed.
          const value = isDm
            ? valueField(entry.value, nameOf(entry.token), (next) => {
                send({ type: 'set_initiative', token: entry.token, value: next });
              })
            : (() => {
                const span = document.createElement('span');
                span.className = 'init-value';
                span.textContent = String(entry.value);
                return span;
              })();

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
        //
        // Nor is a token that has already rolled. `set_initiative` would still
        // re-value one, but that is what the row's own field is for now, and a
        // list that goes on offering the six creatures already in the order is a
        // list the DM has to read past to find the seventh.
        const rolled = new Set(initiative.entries.map((e) => e.token));
        const rollable = scene.tokens.filter((t) => !t.stagedOnly && !rolled.has(t.id));

        // Only rebuild the dropdown when the token list itself changes, so a
        // half-made selection survives every turn advance. Names are part of
        // that: renaming a token has to reach the option that shows it. So is
        // the order, now that entering a roll takes a token out of the list —
        // the key is built from what is left rather than from every token, so
        // it moves when either of them does.
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

          // Everybody is in the fight. An empty picker beside a live button is a
          // control that looks armed and can do nothing, which is the rail's
          // rule about inert tabs in the one place on screen that is not a tab.
          // The placeholder carries no value, so a submit through it is the
          // no-op the form already declines.
          ui.tokenSelect.disabled = rollable.length === 0;
          if (rollable.length === 0) {
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = 'everyone has rolled';
            ui.tokenSelect.append(empty);
          }
        }
      }

      // The DM's editing controls fold away with the rows they edit. The turn
      // buttons deliberately do not: advancing the turn from a folded panel is
      // most of what folding it is for.
      if (isDm) {
        ui.form.hidden = collapsed;
        ui.clear.hidden = collapsed;
      }

      // Players only see the panel once there is something in it; the DM always
      // needs it, since that is where combat gets started.
      ui.root.hidden = !isDm && initiative.entries.length === 0;
    },
  };

  return panel;
}
