// The drawing toolbar: pick a shape, pick a colour, sweep it out on the map.
//
// The first panel a player has ever been given. Everything above it — the map
// tool, the token panel — exists only on a DM connection; this one is built for
// everyone, because anyone may draw. What differs by identity is one button:
// only the DM is offered "clear all", since that reaches into five other
// people's drawings.
//
// Which tool is in hand decides three things and no more:
//
//   what gets swept   the kind on every frame
//   what a release does  the measure tool keeps nothing; the three area tools
//                        follow the release with an `add_shape`
//   what colour it is  the measure tool is drawn in the sweeper's own hue; the
//                      three area tools take the swatch that is picked
//
// That second one is entirely ours. The server takes all four kinds, stores
// whichever it is told to store, and never learns which tool was in hand — the
// same way it never learns the DM is previewing. A "keep this line" toggle
// would be a change to this file and to nothing else.

import type { ClientMsg, ShapeKind } from './protocol.js';

export interface DrawToolUi {
  root: HTMLElement;
  /** One button per tool, plus the off switch. */
  tools: HTMLElement;
  swatches: HTMLElement;
  clear: HTMLButtonElement;
  hint: HTMLElement;
}

export interface DrawTool {
  /** The kind being drawn, or null when the tool is put away and the pointer
   *  goes back to panning and dragging tokens. */
  readonly kind: ShapeKind | null;
  readonly color: string;
  /** Whether a release keeps what was swept. False for the measuring line,
   *  which is the whole of "ephemeral" on this side of the wire. */
  readonly keeps: boolean;
  /** Puts the tool away — what Escape and a lost pointer both mean. */
  stop(): void;
}

/**
 * How hard everything this panel draws reads, as the `aa` of `#rrggbbaa`.
 *
 * Baked into every entry of the palette below rather than offered — how hard a
 * spell area reads is a thing to get right once, and the renderer multiplies it
 * down again for the fill. It is a named constant rather than six literals'
 * worth of tail because the measure tool has to say it about a colour that came
 * from somewhere else: `colourOf` answers in `#rrggbb` and the server accepts no
 * shape but the eight-digit one.
 */
const SHAPE_ALPHA = 'e6';

/**
 * The palette, as `#rrggbbaa`.
 *
 * The hues deliberately avoid the ring vocabulary on the tokens — gold is
 * ownership, blue is in progress, white is the turn, violet is hidden, teal is
 * staged-only — so a shape can never be mistaken for something the board is
 * saying about a creature. They avoid `PLAYER_HUES` for no such reason: a
 * measure line is now drawn in one of those and it is *meant* to be read as
 * whose it is, and nothing it could be confused with outlives the release.
 */
const PALETTE: readonly { value: string; name: string }[] = [
  { value: '#ff8c42e6', name: 'ember' },
  { value: '#e5484de6', name: 'blood' },
  { value: '#8b5cf6e6', name: 'arcane' },
  { value: '#22c55ee6', name: 'poison' },
  { value: '#38bdf8e6', name: 'frost' },
  { value: '#e8e6e1e6', name: 'chalk' },
];

const TOOLS: readonly { kind: ShapeKind; label: string; hint: string }[] = [
  {
    kind: 'line',
    label: 'measure',
    hint: 'Drag to measure, in your own colour. Everyone sees it while you hold it; it vanishes when you let go.',
  },
  { kind: 'circle', label: 'circle', hint: 'Drag from the centre out. Stays until somebody erases it.' },
  { kind: 'cone', label: 'cone', hint: 'Drag from the point outwards. It is as wide as it is long.' },
  { kind: 'rect', label: 'square', hint: 'Drag corner to corner.' },
];

/** What a line does on release, and the only thing that separates a measuring
 *  shape from a spell area anywhere in this project. */
const EPHEMERAL: ShapeKind = 'line';

export function createDrawTool(
  ui: DrawToolUi,
  isDm: boolean,
  send: (msg: ClientMsg) => void,
  /**
   * This client's own hue as `#rrggbb`, which is what the measure tool draws in.
   *
   * A function rather than a value because it has two ways of going stale: this
   * panel is built before the one that holds the colour table, and a player may
   * change their mind at any point after that. Asked at the moment a sweep
   * starts, so the next line measured is in whatever they last picked.
   *
   * Passed in rather than reached for. `colourOf` wants a roster and the live
   * table, and this file has never needed to know that either exists — what it
   * is being told is one string.
   */
  mine: () => string,
  /**
   * Called when a tool is picked up here, so whatever else had taken the left
   * button can let go of it.
   *
   * Two tools armed at once is not a state anything downstream could resolve:
   * input.ts would have to pick one, and the panel that lost would sit there
   * looking armed. Told rather than asked, because a tool knows when it is
   * picked up and cannot know what else exists.
   */
  onArm: () => void = () => {},
): DrawTool {
  let kind: ShapeKind | null = null;
  let color = PALETTE[0]?.value ?? '#ff8c42e6';

  const buttons = new Map<ShapeKind, HTMLButtonElement>();

  const showTool = (): void => {
    for (const [k, button] of buttons) {
      button.classList.toggle('is-on', k === kind);
      button.setAttribute('aria-pressed', String(k === kind));
    }
    // The body class is what tells the rest of the page a sweep is armed: the
    // canvas takes the left button while it is set, so saying so loudly is
    // worth more than any label in this panel.
    document.body.classList.toggle('drawing', kind !== null);
    ui.hint.textContent =
      kind === null
        ? 'Pick a shape to draw. Click one on the map to erase it.'
        : (TOOLS.find((t) => t.kind === kind)?.hint ?? '');
  };

  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'draw-tool';
    button.textContent = tool.label;
    button.title = tool.hint;
    button.addEventListener('click', () => {
      // Clicking the tool you are holding puts it down, which is the fastest
      // way back to panning and dragging tokens.
      kind = kind === tool.kind ? null : tool.kind;
      if (kind !== null) onArm();
      showTool();
      showColor();
    });
    buttons.set(tool.kind, button);
    ui.tools.append(button);
  }

  const showColor = (): void => {
    // Inert while the measure tool is in hand, because the swatch it is showing
    // as picked is not what would be drawn. A panel that looks armed and is not
    // is the same lie a live tab on a dead panel would be — and it is dimmed
    // rather than hidden, since the pick is still there and comes back with the
    // next area tool.
    const inert = kind === EPHEMERAL;
    ui.swatches.classList.toggle('is-inert', inert);
    for (const swatch of ui.swatches.querySelectorAll('button')) {
      swatch.disabled = inert;
      swatch.classList.toggle('is-on', swatch.dataset['color'] === color);
    }
  };

  for (const entry of PALETTE) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'draw-swatch';
    swatch.dataset['color'] = entry.value;
    swatch.title = entry.name;
    swatch.setAttribute('aria-label', entry.name);
    // The stored alpha is deliberately not applied here: a swatch is a label
    // for a colour, and a translucent one is a label that is hard to read.
    swatch.style.background = entry.value.slice(0, 7);
    swatch.addEventListener('click', () => {
      color = entry.value;
      showColor();
    });
    ui.swatches.append(swatch);
  }

  // Only the DM is offered it, and the server refuses it from anyone else
  // regardless — this is the affordance, not the permission.
  ui.clear.hidden = !isDm;
  ui.clear.addEventListener('click', () => {
    if (!window.confirm('Erase every drawing on the board?')) return;
    send({ type: 'clear_shapes' });
  });

  // The way out that does not need the panel. A tool that has taken the left
  // button over must always be droppable from the keyboard, because the reason
  // to drop it is usually that you wanted to drag a token instead.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || kind === null) return;
    kind = null;
    showTool();
    showColor();
  });

  showTool();
  showColor();
  ui.root.hidden = false;

  return {
    get kind() {
      return kind;
    },
    get color() {
      // The measure tool is whose it is rather than what was picked: a line
      // that vanishes on release is a gesture, like a ping, and the question
      // its watchers have is who is measuring. The three area tools keep the
      // palette, because a shape that stays on the board is a thing rather
      // than somebody, and six players' worth of hue is not a vocabulary for
      // spell areas.
      return kind === EPHEMERAL ? mine() + SHAPE_ALPHA : color;
    },
    get keeps() {
      return kind !== null && kind !== EPHEMERAL;
    },
    stop() {
      kind = null;
      showTool();
      showColor();
    },
  };
}
