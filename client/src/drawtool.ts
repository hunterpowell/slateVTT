// The drawing toolbar: pick a shape, pick a colour, sweep it out on the map.
//
// Unlike the rail's panels (the map tool, the token panel), which exist only on
// a DM connection, this one is built for everyone, because anyone may draw.
// One button differs by identity: only the DM is offered "clear all", since
// that erases five other people's drawings.
//
// Which tool is in hand decides three things:
//
//   what gets swept   the kind on every frame
//   what a release does  the measure tool keeps nothing; the three area tools
//                        follow the release with an `add_shape`
//   what colour it is  the measure tool is drawn in the sweeper's own hue; the
//                      three area tools take the swatch that is picked
//
// The second is decided only here. The server takes all four kinds, stores
// whichever it is told to, and never learns which tool was in hand, as it never
// learns the DM is previewing. A "keep this line" toggle would change this file
// and nothing else.

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
  /** Whether a release keeps what was swept. False for the measuring line; on
   *  the client, that is all "ephemeral" means. */
  readonly keeps: boolean;
  /** Puts the tool away: what Escape and a lost pointer both mean. */
  stop(): void;
}

/**
 * How hard everything this panel draws reads, as the `aa` of `#rrggbbaa`.
 *
 * Baked into every entry of the palette below, not offered as a choice: how
 * strongly a spell area reads is set once, and the renderer multiplies it down
 * again for the fill. It is a named constant because the measure tool has to
 * append it to a colour from elsewhere: `colourOf` answers in `#rrggbb`, and
 * the server accepts only the eight-digit form for a shape.
 */
const SHAPE_ALPHA = 'e6';

/**
 * The palette, as `#rrggbbaa`.
 *
 * The hues avoid the ring colours on the tokens (gold is ownership, blue is in
 * progress, white is the turn, violet is hidden, teal is staged-only), so a
 * shape can't be mistaken for something the board is saying about a creature.
 * They don't need to avoid `PLAYER_HUES`: a measure line is drawn in one of
 * those so it reads as whose it is, and it vanishes on release.
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

/** The kind that keeps nothing on release. This is the only thing in the
 *  project that separates a measuring shape from a spell area. */
const EPHEMERAL: ShapeKind = 'line';

export function createDrawTool(
  ui: DrawToolUi,
  isDm: boolean,
  send: (msg: ClientMsg) => void,
  /**
   * This client's own hue as `#rrggbb`, which is what the measure tool draws in.
   *
   * A function, not a value, because a value would go stale two ways: this
   * panel is built before the one that holds the colour table, and a player
   * may change colour at any point after that. Asked when a sweep starts, so
   * the next line measured is in whatever they last picked.
   *
   * Passed in, not looked up here. `colourOf` needs a roster and the live
   * colour table, and this file needs neither; it only needs one string.
   */
  mine: () => string,
  /**
   * Called when a tool is picked up here, so whatever else had taken the left
   * button can let go of it.
   *
   * Nothing downstream can resolve two tools armed at once: input.ts would
   * have to pick one, and the panel that lost would still look armed. A
   * callback, because a tool knows when it is picked up but not what other
   * tools exist.
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
    // The body class tells the rest of the page a sweep is armed: the canvas
    // takes the left button while it is set, so it needs to be obvious.
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
      // Clicking the tool you are holding puts it down, the quickest way back
      // to panning and dragging tokens.
      kind = kind === tool.kind ? null : tool.kind;
      if (kind !== null) onArm();
      showTool();
      showColor();
    });
    buttons.set(tool.kind, button);
    ui.tools.append(button);
  }

  const showColor = (): void => {
    // Inert while the measure tool is in hand, because the swatch shown as
    // picked is not what would be drawn, and a control that looks active but
    // does nothing is a bug (as with a live tab on an inert panel). Dimmed, not
    // hidden, since the pick is kept and applies again with the next area tool.
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
    // The stored alpha isn't applied here: a swatch labels a colour, and a
    // translucent one is hard to read.
    swatch.style.background = entry.value.slice(0, 7);
    swatch.addEventListener('click', () => {
      color = entry.value;
      showColor();
    });
    ui.swatches.append(swatch);
  }

  // Only the DM is offered it, and the server refuses it from anyone else
  // regardless: this is the affordance, not the permission.
  ui.clear.hidden = !isDm;
  ui.clear.addEventListener('click', () => {
    if (!window.confirm('Erase every drawing on the board?')) return;
    send({ type: 'clear_shapes' });
  });

  // A way out that doesn't need the panel. A tool that has taken the left
  // button must always be droppable from the keyboard, because the reason to
  // drop it is usually that you wanted to drag a token instead.
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
      // The measure tool uses the sweeper's colour, not the picked one: a line
      // that vanishes on release is a gesture, like a ping, and watchers want
      // to know who is measuring. The three area tools keep the palette,
      // because a shape that stays on the board marks a spell area, not a
      // person, and six player colours don't say anything about spells.
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
