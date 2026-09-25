// The DM's token panel: build a token, edit the one that is selected, delete it.
//
// One form does both jobs. With nothing selected it describes a token that does
// not exist yet and the button says "create"; select a token on the map and the
// same fields fill in with what that token is, and the button says "save".
// Don't add a separate creation dialog: it would be a second form for the same
// fields, and the two would drift.
//
// Nothing here is predicted locally. A create can't be, because the server
// invents the id, and an edit is a click, not a drag, so there is no round trip
// anyone can feel. The panel changes what is on screen only when the server
// says so.
//
// The panel works in preview mode as well as on the board, and which slot it is
// pointed at decides only one thing: whether a *new* token is built on the map
// being prepared or on the one everyone is looking at. Every other field it
// sends is shared by both boards, so an edit lands everywhere at once; only
// position and existence fork. The panel has to make that clear, because a
// board where some things are shared and others aren't is worse than either.
//
// Players never see this. It is only created for a DM connection, and the
// server re-checks every command regardless.

import type { Vec2 } from './coords.js';
import { createLibraryList } from './library.js';
import { markerRow } from './markers.js';
import type { ClientMsg, Hp, Marker, Owner, RosterEntry } from './protocol.js';
import type { Scene, Token } from './scene.js';
import { shownBoard, shownPos } from './scene.js';

export interface TokenToolUi {
  root: HTMLElement;
  head: HTMLElement;
  name: HTMLInputElement;
  size: HTMLSelectElement;
  owner: HTMLSelectElement;
  hidden: HTMLInputElement;
  hp: HTMLInputElement;
  hpMax: HTMLInputElement;
  light: HTMLInputElement;
  art: HTMLInputElement;
  artText: HTMLElement;
  artPreview: HTMLElement;
  artClear: HTMLButtonElement;
  library: HTMLButtonElement;
  libraryList: HTMLElement;
  markers: HTMLElement;
  save: HTMLButtonElement;
  duplicate: HTMLButtonElement;
  remove: HTMLButtonElement;
  fresh: HTMLButtonElement;
  hint: HTMLElement;
}

export interface TokenTool {
  /** The token being edited, for the selection ring. Null while building one. */
  readonly selectedId: string | null;
  /** From a click on the map, or from this panel's own "new token" button. */
  select(id: string | null): void;
  /**
   * Deletes these tokens, after asking. The panel's own button is this with
   * one id; the Delete key in main.ts is it with everything wearing a ring.
   * Ids that name nothing on the board are dropped, not sent.
   */
  remove(ids: Iterable<string>): void;
  /** Called on Welcome and after every token delta. */
  update(scene: Scene): void;
  /** The DM edited the cast. The roster passed in at creation is the same
   *  array, already changed in place; this refills the owner dropdown. */
  recast(): void;
  /**
   * Puts the panel down, called by the rail as it closes this tab.
   *
   * Closes only the portrait list, so the tab reopens on the panel instead of
   * mid-browse. Unlike the map and wall panels this one arms nothing on the
   * canvas, and the selection it holds is a ring the DM can still see.
   */
  stop(): void;
}

/** The DM option in the owner dropdown. A player id is never empty. */
const DM_OWNER = '';
/** How far out to look for somewhere to put a new token, in cells. */
const MAX_SEARCH_RINGS = 6;

export function createTokenTool(
  ui: TokenToolUi,
  dmSecret: string,
  roster: RosterEntry[],
  send: (msg: ClientMsg) => void,
  report: (message: string) => void,
  /** Middle of the DM's view in grid units, or null before the board exists. */
  viewCentre: () => Vec2 | null,
): TokenTool {
  let scene: Scene | null = null;
  let selectedId: string | null = null;
  /** The art the form currently describes. Empty means a plain named disc. */
  let art = '';
  /** The marks the form currently describes. Form state like `art`, so a
   *  creature can be built already marked and a duplicate keeps them. */
  let marks: Marker[] = [];

  /** The board on screen is the staged one, so a new token belongs to it. */
  const previewing = (): boolean => scene !== null && scene.previewing && scene.staged !== null;

  const fillOwners = (): void => {
    const was = ui.owner.value;
    ui.owner.replaceChildren(
      option(DM_OWNER, 'DM'),
      ...roster.map((entry) => option(entry.id, entry.name)),
    );
    // Kept across a refill, so a rename doesn't reset the form under the DM.
    // A slot that went can't have owned a token (the room refuses that), so
    // the only thing that can lose its owner here is a token not yet built.
    ui.owner.value = was;
    if (ui.owner.value !== was) ui.owner.value = DM_OWNER;
  };
  fillOwners();

  // --- reading and writing the form ----------------------------------------

  const selected = (): Token | null =>
    scene?.tokens.find((t) => t.id === selectedId) ?? null;

  const showArt = (): void => {
    // No art leaves the grey disc the stylesheet puts underneath, which is the
    // same one the canvas draws for a token without a picture.
    ui.artPreview.style.backgroundImage = art === '' ? 'none' : `url("${art}")`;
    ui.artClear.hidden = art === '';
  };

  /** Puts a token into the form, or clears it back to a token-to-be. */
  const show = (token: Token | null): void => {
    ui.name.value = token?.name ?? '';
    ui.size.value = String(token?.size ?? 1);
    ui.owner.value = token === null ? DM_OWNER : ownerValue(token.owner);
    // Both blank means the DM keeps no total on this one, which is most tokens
    // most of the time (see `hitPoints`).
    ui.hp.value = token?.hp === undefined || token.hp === null ? '' : String(token.hp.current);
    ui.hpMax.value = token?.hp === undefined || token.hp === null ? '' : String(token.hp.max);
    ui.light.value =
      token?.lightFt === undefined || token.lightFt === null ? '' : String(token.lightFt);
    ui.hidden.checked = token?.hidden ?? false;
    art = token?.img ?? '';
    marks = token?.markers ?? [];

    ui.head.textContent = token === null ? headingForNew() : token.name;
    ui.save.textContent = token === null ? 'create' : 'save';
    ui.duplicate.hidden = token === null;
    ui.remove.hidden = token === null;
    ui.fresh.hidden = token === null;
    ui.hint.textContent = hintFor(token);
    showArt();
    showMarks();
  };

  /**
   * The marker toggles, rebuilt wholesale instead of updated in place.
   *
   * `markerRow` is shared with the initiative panel so that the swatch here and
   * the pip on the board can't disagree about which colour `blue` is, the same
   * reason `hpColour` is shared.
   */
  const showMarks = (): void => {
    ui.markers.replaceChildren(
      markerRow(
        marks,
        (marker) => `Mark this creature ${marker}`,
        (next) => {
          marks = next;
          showMarks();
          // Committed on the spot for a token that exists, like the hidden
          // switch and a chosen portrait: marking a creature happens *while*
          // something is going on, and a mark that needs a second click to take
          // lands a beat after the thing it is about.
          if (selected() !== null) save();
        },
      ),
    );
  };

  // **Once at startup, which nothing else in this form needs.** Every other
  // field is initialised by the markup and only rewritten by `show`, and `show`
  // doesn't run until something is selected or "+ new token" is pressed, so a
  // panel opened on a fresh page would offer no swatches at all until the DM
  // clicked a token. There is no markup for the generated buttons, so this is
  // where their empty state comes from.
  showMarks();

  /** Names the slot a token would be built into, since the two differ in what
   *  they produce: one goes on the board, the other on the next map only. */
  const headingForNew = (): string => (previewing() ? 'New token · next map' : 'New token');

  /**
   * What the DM can do with what is selected, and, in preview, what a drag
   * there will mean, since the same gesture writes a different field.
   */
  const hintFor = (token: Token | null): string => {
    if (token === null) {
      return previewing()
        ? 'Built on the next map only. The table meets it on promote.'
        : 'Click a token on the map to edit it.';
    }
    if (!previewing()) return 'Drag it on the map to move it.';
    return token.stagedOnly
      ? 'Drag it to place it for the next map.'
      : 'Drag it to plan where it lands on promote.';
  };

  function select(id: string | null): void {
    selectedId = id;
    show(selected());
  }

  ui.fresh.addEventListener('click', () => {
    select(null);
    ui.name.focus();
  });

  // --- saving ---------------------------------------------------------------

  const size = (): number => Number(ui.size.value);

  const owner = (): Owner =>
    ui.owner.value === DM_OWNER ? { kind: 'dm' } : { kind: 'player', id: ui.owner.value };

  /**
   * The two boxes read as one total, or as none at all.
   *
   * Filling one in and leaving the other alone is the common case (a DM types
   * a monster's total once and then only ever edits the left-hand number), so
   * an empty box copies the one that was filled instead of refusing to save.
   * Both empty is `null`, which is what a party member the DM keeps no total
   * for looks like.
   */
  const hitPoints = (): Hp | null => {
    const current = Number.parseInt(ui.hp.value, 10);
    const max = Number.parseInt(ui.hpMax.value, 10);
    if (Number.isNaN(current) && Number.isNaN(max)) return null;
    if (Number.isNaN(current)) return { current: max, max };
    if (Number.isNaN(max)) return { current, max: current };
    return { current, max };
  };

  /**
   * How far this token lights the board, or null for one carrying no light.
   *
   * Blank is the ordinary answer, and it is why this is one box instead of a
   * switch and a number beside it: most tokens carry nothing, a player's own
   * falls back to the map's radius, and there is no third state.
   */
  const lightFt = (): number | null => {
    const ft = Number.parseFloat(ui.light.value);
    return Number.isFinite(ft) ? ft : null;
  };

  const save = (): void => {
    const name = ui.name.value.trim();
    if (name === '') {
      report('a token needs a name');
      ui.name.focus();
      return;
    }

    const token = selected();
    if (token !== null) {
      send({
        type: 'update_token',
        id: token.id,
        name,
        img: art,
        size: size(),
        owner: owner(),
        hidden: ui.hidden.checked,
        hp: hitPoints(),
        light_ft: lightFt(),
        markers: marks,
      });
      return;
    }

    const at = spaceFor(scene, viewCentre());
    if (at === null) {
      report('the board is still loading');
      return;
    }
    send({
      type: 'create_token',
      name,
      img: art,
      size: size(),
      owner: owner(),
      x: at.x,
      y: at.y,
      hidden: ui.hidden.checked,
      hp: hitPoints(),
      light_ft: lightFt(),
      markers: marks,
      // The slot on screen, the same way `set_map` reads it. Building the
      // ambush for next week's room means standing on next week's map.
      staged: previewing(),
    });
    // Stays on "new token" with the fields as they are: six goblins is six
    // clicks, and `spaceFor` puts each one in its own cell.
    ui.name.select();
  };

  ui.save.addEventListener('click', save);

  // Enter anywhere in the form saves, so a name can be typed and committed
  // without reaching for the mouse.
  const saveOnEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') save();
  };
  ui.name.addEventListener('keydown', saveOnEnter);
  ui.size.addEventListener('keydown', saveOnEnter);
  ui.owner.addEventListener('keydown', saveOnEnter);
  // The two that get typed into mid-combat. Subtracting a hit is: click the
  // token, type the new total, Enter.
  ui.hp.addEventListener('keydown', saveOnEnter);
  ui.hpMax.addEventListener('keydown', saveOnEnter);

  // Committed on the spot without waiting for save, the way an uploaded
  // portrait is. The party has just walked in; a hide that needs a second click
  // to take effect happens a beat too late.
  ui.hidden.addEventListener('change', () => {
    if (selected() !== null) save();
  });

  /**
   * The seventh goblin, when it is a copy of one already built.
   *
   * The form keeps its fields after a create, so a run of identical monsters
   * is already cheap. What it can't keep is the art, the total, the radius and
   * the owner of a creature built earlier in the evening, because those are
   * read out of a *token*, not typed. This is the same send with the fields
   * taken off the selection instead of the form.
   *
   * **No `duplicate_token` on the wire.** The server already invents the id and
   * already snaps the position, so a command of its own would add a protocol
   * tag and four enumerated arms and do nothing new.
   *
   * `create_token` carries every field but the plan, so the copy arrives
   * unplanned. That is correct: a plan is a cell, and two creatures don't want
   * the same one.
   *
   * It searches out from the *original*, where a create searches from the
   * middle of the view; that is the one difference between the two. The second
   * goblin belongs beside the first, not wherever the camera is pointed.
   */
  ui.duplicate.addEventListener('click', () => {
    const token = selected();
    if (token === null || scene === null) return;

    // The view centre is the fallback for a token standing nowhere on the board
    // on screen, which is what `spaceFor` would have been given anyway.
    const at = spaceFor(scene, shownPos(scene, token) ?? viewCentre());
    if (at === null) {
      report('the board is still loading');
      return;
    }

    send({
      type: 'create_token',
      name: token.name,
      img: token.img,
      size: token.size,
      owner: token.owner,
      x: at.x,
      y: at.y,
      hidden: token.hidden,
      hp: token.hp,
      light_ft: token.lightFt,
      markers: token.markers,
      // The slot on screen, the same way the create above reads it. Copying
      // the ambush's first goblin means standing on next week's map.
      staged: previewing(),
    });
    // The panel stays on the token that was copied instead of following the
    // copy: the server invents the id and it hasn't arrived yet, and
    // duplicating twice is the ordinary case.
  });

  /**
   * One confirm for however many, naming them. A deleted token takes its
   * initiative row and its anchored drawings with it; undo can bring it back,
   * but a step per token, and the confirm is what stands between a stray
   * keypress and six of those. Deleting from preview is still deleting:
   * existence forks, but a token on the board exists there too, and saying so
   * beats a DM discovering it afterwards.
   */
  function remove(ids: Iterable<string>): void {
    if (scene === null) return;
    const wanted = new Set(ids);
    const tokens = scene.tokens.filter((t) => wanted.has(t.id));
    if (tokens.length === 0) return;

    const names = tokens.map((t) => t.name).join(', ');
    const onBoard = previewing() && tokens.some((t) => !t.stagedOnly);
    const what = tokens.length === 1 ? `Delete ${names}?` : `Delete ${tokens.length} tokens (${names})?`;
    const warning = onBoard
      ? `${what} ${tokens.length === 1 ? 'It is' : 'Some are'} on the board now, not only on the next map.`
      : what;
    if (!window.confirm(warning)) return;

    // N ordinary deletes, like the group drag: the room already takes them one
    // at a time and a batch would do nothing differently.
    for (const token of tokens) send({ type: 'delete_token', id: token.id });
    if (selectedId !== null && wanted.has(selectedId)) select(null);
  }

  ui.remove.addEventListener('click', () => {
    const token = selected();
    if (token !== null) remove([token.id]);
  });

  // --- art ------------------------------------------------------------------

  ui.artClear.addEventListener('click', () => {
    art = '';
    showArt();
  });

  /**
   * Both ways of getting a portrait end here, because from this side they are
   * the same thing: some bytes are now served at `url`. Picking one out of
   * `portraits/` is a copy into the uploads directory, so what lands on the
   * token is the same kind of URL an upload produces, as with maps.
   *
   * Committed on the spot for a token that already exists, without waiting for
   * save: choosing a face for the creature on screen is almost never something
   * the DM then wants to press a second button for.
   */
  const useArt = (url: string): void => {
    art = url;
    showArt();
    if (selected() !== null) save();
  };

  // The party's portraits are the same six files every session, so they live in
  // a folder instead of being uploaded once per token. The upload button is the
  // library's, so uploading one puts it in the folder, and the art a DM drags
  // in for one monster is there for the next one.
  const library = createLibraryList(
    {
      root: ui.root,
      button: ui.library,
      list: ui.libraryList,
      file: ui.art,
      fileText: ui.artText,
    },
    dmSecret,
    'portraits',
    useArt,
    report,
  );

  return {
    get selectedId() {
      return selectedId;
    },

    select,
    remove,

    stop() {
      library.close();
    },

    recast() {
      fillOwners();
    },

    update(next) {
      scene = next;
      const token = selected();

      // Greyed while the board it would light carries no fog, the way the fog
      // panel greys its own radius: a light casts nothing where there is no fog
      // to push back, and a number that silently does nothing is worse than a
      // box that won't take one. The placeholder carries the reason, because
      // the hint below is only rewritten when a token is put into the form.
      const fogged = shownBoard(next).fog;
      ui.light.disabled = !fogged;
      ui.light.placeholder = fogged ? 'none' : 'unfogged map';

      // A token deleted out from under the panel (by this DM on another tab,
      // or by this one) leaves the form describing something that is gone.
      if (selectedId !== null && token === null) {
        select(null);
        return;
      }

      // Only the heading, never the fields. The heading names the token as the
      // server has it, so a rename has to reach it; the fields hold what the DM
      // has typed but not yet saved, and reloading those would eat the edit.
      if (token !== null) ui.head.textContent = token.name;
    },
  };
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function ownerValue(owner: Owner): string {
  return owner.kind === 'player' ? owner.id : DM_OWNER;
}

/**
 * Where a new token should go: the middle of the DM's view, stepped aside if
 * something is already standing there.
 *
 * Without this, building six goblins in a row makes one goblin-shaped stack and
 * five invisible tokens underneath it. The offsets are whole cells, so the
 * server's snapping (which the client doesn't duplicate) can't fold two of
 * them back onto each other.
 */
function spaceFor(scene: Scene | null, centre: Vec2 | null): Vec2 | null {
  if (scene === null || centre === null) return null;

  // Against where tokens are *on this board*: a cell is only occupied if
  // something is standing in it here, and a token absent from this board is
  // standing nowhere on it.
  const here: Vec2[] = scene.tokens
    .map((t) => shownPos(scene, t))
    .filter((at): at is Vec2 => at !== null);

  const taken = (x: number, y: number): boolean =>
    here.some((at) => Math.abs(at.x - x) < 0.5 && Math.abs(at.y - y) < 0.5);

  for (let ring = 0; ring <= MAX_SEARCH_RINGS; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        // Only the perimeter: the inside of this ring was searched already.
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        if (!taken(centre.x + dx, centre.y + dy)) {
          return { x: centre.x + dx, y: centre.y + dy };
        }
      }
    }
  }

  // Everything nearby is occupied. Stacking beats refusing to make the token.
  return centre;
}
