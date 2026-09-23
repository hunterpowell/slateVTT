// The initiative panel. Read-only for players; the DM gets the controls.
//
// Rebuilt whole on every change, not diffed. It is at most a dozen rows and
// only changes when the DM does something.

import type { Identity } from './identity.js';
import { markerRow } from './markers.js';
import { asTable, tableInitiative } from './mirror.js';
import type { ClientMsg, Hp, Initiative } from './protocol.js';
// The only import from the renderer, so the bar in a row and the bar over the
// token agree on which monster is nearly down. See `hpColour`.
import { hpColour, hpFilled } from './render.js';
import type { Scene, Token } from './scene.js';
import { typingIn } from './undo.js';

export interface Panel {
  update(initiative: Initiative, scene: Scene): void;
  /**
   * Draw the rows the table has, not the ones the DM has.
   *
   * The board is redrawn every frame from a scene main.ts narrows on the way
   * in. This panel is redrawn only when something arrives, so it has to be
   * told. Both go through the same two functions (see `mirror.ts`).
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
 * Commits on `change`, not `input`. The order re-sorts on every value the
 * server accepts, so a keystroke that committed would move the row out from
 * under the caret while the second digit was still being typed.
 */
function valueField(value: number, name: string, commit: (value: number) => void): HTMLElement {
  const field = document.createElement('input');
  field.type = 'number';
  field.step = '1';
  field.className = 'init-value init-value-edit';
  field.value = String(value);
  field.setAttribute('aria-label', `${name}'s initiative`);
  field.title = `${name}'s initiative`;

  // A click on the row underneath moves the camera to the creature. Clicking
  // the number to correct it shouldn't. The `×` stops propagation for the same
  // reason.
  field.addEventListener('click', (e) => e.stopPropagation());

  field.addEventListener('change', () => {
    const next = Number.parseInt(field.value, 10);
    // Emptied, or otherwise not a number. Put the row's value back instead of
    // sending something the server would have to guess at.
    if (Number.isNaN(next)) {
      field.value = String(value);
      return;
    }
    commit(next);
  });

  // Escape abandons the edit. A blur commits, so this puts the number back
  // first, and the blur that follows has nothing to report.
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    field.value = String(value);
    field.blur();
  });

  return field;
}

/**
 * What the DM typed into a row's damage box, resolved against the total the row
 * is showing.
 *
 * A signed entry is a delta and a bare one is the new total: `-12` is twelve
 * damage, `+7` is seven back, `35` sets it to 35. The signed form is what the
 * box is for, so the DM doesn't do the subtraction. It is also why the token
 * panel's own field stays absolute: `-3` there sets a creature to minus three,
 * which the server allows and this box can't express.
 *
 * `null` means send nothing, as in `valueField`: put the row back instead of
 * sending the server something it would have to guess at.
 */
export function parseHpEntry(text: string, current: number): number | null {
  const t = text.trim();
  if (/^[+-]\d+$/.test(t)) return current + Number.parseInt(t, 10);
  if (/^\d+$/.test(t)) return Number.parseInt(t, 10);
  return null;
}

/**
 * The DM's damage box: type `-12`, press Enter, the monster is twelve down.
 *
 * **Built with no check for who is reading it**, like the bar beside it. This
 * function is only called inside the `hp !== null` branch, and a player's copy
 * of every token has a null `hp` because `view_for` redacts it. The mirror
 * strips it the same way. So a player never gets this box, and if the redaction
 * broke, the failure would be a visible box, not a leak (invariant 4).
 *
 * `type="text"`, not `number`: a number input's handling of a leading `+` isn't
 * dependable, and it would bring back the spinner this box replaces.
 *
 * Three rules come from `valueField`, for the same reasons: commit on `change`
 * so a keystroke doesn't fire mid-entry, stop the click so correcting a total
 * doesn't also move the camera, and let Escape out. The fourth is stopping
 * keydown: four rail tools disarm on Escape from a `window` listener, and
 * typing a number here shouldn't reach them. `chat.ts` does the same for its
 * input.
 */
function damageField(token: Token, hp: Hp, send: (msg: ClientMsg) => void): HTMLInputElement {
  const field = document.createElement('input');
  field.type = 'text';
  field.inputMode = 'numeric';
  field.className = 'init-damage';
  field.placeholder = '±';
  field.autocomplete = 'off';
  // Which row this is, so a rebuild can put the caret back where it was. See
  // `typingHpFor` in `update`.
  field.dataset.hpFor = token.id;
  const label = `Damage or heal ${token.name}: -12, +7, or a new total`;
  field.setAttribute('aria-label', label);
  field.title = label;

  field.addEventListener('click', (e) => e.stopPropagation());

  field.addEventListener('change', () => {
    const next = parseHpEntry(field.value, hp.current);
    // Cleared either way. The box holds an instruction, not a value, so
    // leaving `-6` in it after the hit landed invites sending it twice.
    field.value = '';
    if (next === null) return;
    // Read-modify-write off the token the row already resolved. `UpdateToken`
    // carries every editable field together, so there is no `SetHp`. See
    // `docs/tokens.md`.
    send({
      type: 'update_token',
      id: token.id,
      name: token.name,
      img: token.img,
      size: token.size,
      owner: token.owner,
      hidden: token.hidden,
      hp: { current: next, max: hp.max },
      // Carried through unchanged, like every other field this row isn't
      // about. `update_token` replaces the token whole, so leaving a field out
      // here would clear the token's light or wipe its markers on the next
      // hit.
      light_ft: token.lightFt,
      markers: token.markers,
    });
  });

  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    // Escape abandons the entry. A blur commits, so this empties the box first
    // and the blur has nothing to report.
    field.value = '';
    field.blur();
  });

  return field;
}

/**
 * Whether this browser had the list folded away last time.
 *
 * In `localStorage`, not the room. Compare `diagonals`, which is on `RoomState`
 * because six clients have to agree on a rule. How much of a panel someone
 * wants on their own screen is theirs alone, and nothing has to agree about it.
 *
 * Wrapped in `try` for the same reason as the reads in `identity.ts`: a private
 * browsing mode can throw on the property itself. Falling back to the expanded
 * panel is better than a crash.
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
   * may be looking for whoever just went too, and the panel only lists what
   * that client may see.
   *
   * A callback, not the camera itself, because the camera belongs to main.ts.
   * The panel knows which row was clicked and nothing about coordinates.
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

    // Next turn is the button the DM presses most in a fight, so it gets the
    // first unmodified letter key in this client. Bare `n` only: with Ctrl or
    // Cmd held it opens a browser window, and inside a field it is a letter.
    // Not guarded on an empty order, like the button, since the room's
    // `next_turn` is a no-op there, not a refusal. Never on auto-repeat: a
    // held key would spin the order several rounds and, since every turn is an
    // undo step, empty the undo ring. A click can't repeat, so the button is
    // safe.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (typingIn(e.target)) return;
      e.preventDefault();
      send({ type: 'next_turn' });
    });

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

  // Null, not empty: empty is a real state of the dropdown (everyone is
  // already in the order), and the first build has to happen even then, to
  // add the placeholder and disable the select.
  let knownTokenIds: string | null = null;

  let collapsed = readCollapsed();
  // The last state this panel was handed, so the chevron can redraw without a
  // new one arriving. Everything else that changes this panel comes off the
  // wire and brings its own.
  let last: { initiative: Initiative; scene: Scene } | null = null;
  /** The DM is looking at the table's board, so this shows the table's rows. */
  let mirrored = false;

  /** Redraws from whatever was last handed over. Used by the chevron and by
   *  the mirror turning on or off. */
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
      // Kept before the mirror narrows it. Turning the mirror off has to
      // redraw from the room's copy, not a filtered one; storing the filtered
      // copy would filter it twice.
      last = { initiative, scene };
      if (mirrored) {
        // The order first, from the scene the DM holds. The unfiltered token
        // list says which rows have to go; the filtered one would find nothing
        // to drop.
        initiative = tableInitiative(initiative, scene);
        scene = asTable(scene);
      }

      ui.collapse.setAttribute('aria-expanded', String(!collapsed));
      ui.collapse.title = collapsed ? 'Show the whole order' : 'Show only whose turn it is';

      // Collapsed shows only the current row, built by the same code below, so
      // the folded panel is the unfolded one's highlighted line and not a
      // second rendering of it.
      const entries = collapsed
        ? initiative.entries.filter((entry) => entry.token === initiative.current)
        : initiative.entries;

      // A fight is running but whoever is up isn't on this client's board. A
      // hidden creature's row is filtered out of the table's copy server-side,
      // so the collapsed list has nothing to draw. The placeholder must not call
      // that "no combat".
      ui.list.classList.toggle('is-quiet', collapsed && initiative.entries.length > 0);

      const tokenFor = (id: string): Token | undefined =>
        scene.tokens.find((t: Token) => t.id === id);
      const nameOf = (id: string): string => tokenFor(id)?.name ?? id;

      ui.round.textContent = `Round ${initiative.round}`;

      // Which damage box the DM was typing in, so the rebuild below can put the
      // caret back where it was.
      //
      // This list is replaced whole on every token delta, including the
      // server's echo of the hit that was just applied, which arrives through
      // `afterTokens` in main.ts. Without this, landing two hits on the same
      // creature means clicking its box again between them, and the second
      // number goes into a box that no longer exists. Drag frames don't
      // matter here: `onTokenMoved` doesn't rebuild this panel.
      const typingHpFor =
        document.activeElement instanceof HTMLElement && ui.list.contains(document.activeElement)
          ? (document.activeElement.dataset.hpFor ?? null)
          : null;

      ui.list.replaceChildren(
        ...entries.map((entry) => {
          const token = tokenFor(entry.token);

          const row = document.createElement('li');
          row.className = 'init-row';
          if (entry.token === initiative.current) row.classList.add('is-current');
          // Only ever on the DM's panel, since a hidden creature's row is
          // filtered out of the table's copy server-side. It is marked because
          // the two panels differ, and the DM needs to know this row is a name
          // only they can read.
          if (token?.hidden === true) row.classList.add('is-unseen');

          // The DM corrects a misheard roll in place, here. The form below
          // can't do it, because its dropdown doesn't list tokens already in
          // the order. Both send the same `set_initiative`, which re-values a
          // token already in the order.
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
          // through when there is no art, so a token without a picture looks
          // the same as it does on the board. No image cache and no second
          // download, since the browser already has this URL from the canvas.
          const art = document.createElement('span');
          art.className = 'init-art';
          const src = token?.img ?? '';
          if (src !== '') art.style.backgroundImage = `url("${src}")`;

          // Name over bar. Two lines, not one row of three things, because the
          // panel is narrow and the name has to stay readable when a monster is
          // called "Bugbear Chieftain".
          const body = document.createElement('span');
          body.className = 'init-body';

          const line = document.createElement('span');
          line.className = 'init-line';

          const name = document.createElement('span');
          name.className = 'init-name';
          name.textContent = nameOf(entry.token);
          line.append(name);

          // No check for who is reading this. `hp` is redacted server-side, so
          // a player's copy of the token has null and nothing is drawn
          // (invariant 4). `drawHitPoints` needs no guard for the same reason.
          // The damage box is built inside the same branch (see `damageField`).
          // `token` is narrowed alongside `hp` only because TypeScript can't
          // see through the optional chain above.
          const hp = token?.hp ?? null;
          if (hp !== null && token !== undefined) {
            const filled = hpFilled(hp);

            const total = document.createElement('span');
            total.className = 'init-hp-text';
            total.textContent = `${hp.current}/${hp.max}`;
            line.append(total, damageField(token, hp, send));

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

          // **The one control on this row that needs a real check for who is
          // reading it**, which is why it isn't inside the `hp` branch above.
          // The bar and the damage box need none because `view_for` nulls `hp`
          // for a player. Markers are public, so a player's copy carries them
          // and the toggles have to be withheld here. `valueField` follows the
          // same rule: a player's initiative number is a plain span.
          //
          // On the row because the row is what the DM looks at mid-fight, as
          // with the damage box. The token tab is two clicks and a tab away,
          // and nobody uses a control that costs that much during a turn. The
          // token tab keeps its own copy, for building a creature.
          if (isDm && token !== undefined) {
            const marks = token;
            body.append(
              markerRow(
                marks.markers,
                (marker) => `Mark ${marks.name} ${marker}`,
                (next) => {
                  // Read-modify-write off the token the row already resolved,
                  // as `damageField` does, and for the same reason:
                  // `update_token` carries every editable field together, so
                  // there is no `set_markers`.
                  send({
                    type: 'update_token',
                    id: marks.id,
                    name: marks.name,
                    img: marks.img,
                    size: marks.size,
                    owner: marks.owner,
                    hidden: marks.hidden,
                    hp: marks.hp,
                    light_ft: marks.lightFt,
                    markers: next,
                  });
                },
              ),
            );
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
          // `look` handles that. But a row that can't be looked at shouldn't
          // offer to be, so the pointer changes only where it can.
          if (token !== undefined) {
            row.classList.add('is-lookable');
            row.title = `Look at ${nameOf(entry.token)}`;
            row.addEventListener('click', () => look(token));
          }

          return row;
        }),
      );

      if (typingHpFor !== null) {
        ui.list
          .querySelector<HTMLInputElement>(`.init-damage[data-hp-for="${CSS.escape(typingHpFor)}"]`)
          ?.focus();
      }

      if (isDm) {
        // A token built on the next map isn't in this fight. The server
        // refuses it, so offering it would be offering an error. Next room's
        // order needs rolls nobody has made yet.
        //
        // Nor is a token that has already rolled. `set_initiative` would still
        // re-value one, but the row's own field does that, and a list that
        // keeps offering the six creatures already in the order makes the DM
        // read past them to find the seventh.
        const rolled = new Set(initiative.entries.map((e) => e.token));
        const rollable = scene.tokens.filter((t) => !t.stagedOnly && !rolled.has(t.id));

        // Only rebuild the dropdown when the token list itself changes, so a
        // half-made selection survives every turn advance. Names are part of
        // the key, so renaming a token reaches its option. So is the order,
        // since entering a roll takes a token out of the list: the key is
        // built from what is left, not every token, so it changes when either
        // does.
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

          // Everybody is in the fight. An empty picker beside a live button
          // looks usable and does nothing, so it is disabled, as the rail does
          // with inert tabs. The placeholder has no value, so a submit through
          // it hits the form's existing empty-token check.
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
      // buttons don't: advancing the turn from a folded panel is most of what
      // folding it is for.
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
