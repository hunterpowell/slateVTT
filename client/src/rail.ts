/**
 * The DM's editing panels, one at a time.
 *
 * The rail used to stack every panel at once, and by the fourth it had run out
 * of room: `#tokentool` was the flex item that gave up height and at a short
 * window it was squeezed to a scrollbar and a heading. Stacking is the wrong
 * shape for these three regardless of how many there are — the map, the token
 * and the wall panels are *editing* panels, and nothing at this table needs two
 * of them open together. Staging a map and then planning where the tokens land
 * is sequential: `staged_pos` is set by dragging on the preview, not from the
 * token panel.
 *
 * The draw tool is deliberately not one of these. It is the one panel everybody
 * has, it is used in the middle of a fight, and it is already pinned to the
 * bottom of the rail like a toolbar. Putting it behind a click would be the
 * thing `docs/walls.md` warns about with doors — a play-time action behind a
 * mode is a feature that goes unused. A player's rail is therefore exactly what
 * it was before this module existed: the strip is hidden and the draw tool is
 * the only thing on it.
 */

/**
 * Which of the DM's editing panels the rail can show.
 *
 * Adding one is an entry here and an entry in the array `main.ts` passes in.
 * That is the whole point of the strip: the next panel costs a tab rather than
 * a share of the rail's height.
 */
export type RailTab = 'map' | 'token' | 'walls' | 'fog' | 'table';

export interface RailUi {
  /**
   * The strip. Empty in the document — the buttons are built here, the way the
   * draw and wall tools build theirs, so the tab list lives in one place.
   */
  tabs: HTMLElement;
}

export interface RailPanel {
  tab: RailTab;
  label: string;
  root: HTMLElement;
  /**
   * Put down whatever this panel armed, called as it closes.
   *
   * Load-bearing rather than tidy where a panel arms the canvas. The wall editor
   * and the calibration box both take the left mouse button, and a tool still
   * holding it with its panel out of sight is a click that does something the DM
   * cannot see the reason for. The token panel arms nothing and closes only its
   * portrait list, so the tab reopens on the panel rather than mid-browse — and
   * it keeps its selection, which is a ring on the board and still on screen.
   */
  stop?: () => void;
}

/**
 * Nothing is returned, which is the point rather than an omission.
 *
 * The rail used to hand `main.ts` a `show`, and the one caller was the board
 * opening the token tab when a token was picked up. With that gone there is no
 * second hand on the strip at all: a tab changes when the DM clicks a tab. If
 * some panel ever needs opening from outside, this is the line to reconsider —
 * and the question to ask first is whether the DM asked for it.
 */

/**
 * Which tab this browser had open last time.
 *
 * `localStorage` and deliberately not the room, the line `panel.ts` draws for
 * the initiative fold and for the same reason: how much of a panel somebody
 * wants on their own screen is nobody else's business and nothing has to agree
 * about it.
 *
 * The rail used to open nothing on connect, on the argument that the change was
 * about giving the board back. What that missed is that a dropped socket reloads
 * the page — see `docs/presence.md` — so "on connect" is not only the start of
 * an evening, and losing the panel you were tracing with is the reload making
 * itself felt in the middle of a fight.
 *
 * Wrapped like every other read of this API here: a private browsing mode can
 * throw on the property itself, and a closed rail is a fine thing to fall back
 * to.
 */
const OPEN_KEY = 'slate.rail.open';

function readOpen(panels: RailPanel[]): RailTab | null {
  try {
    const stored = localStorage.getItem(OPEN_KEY);
    // Checked against the panels actually built rather than cast: a tab that was
    // renamed or removed since this was written would otherwise hide the rail
    // behind a panel that does not exist.
    return panels.find((p) => p.tab === stored)?.tab ?? null;
  } catch {
    return null;
  }
}

function storeOpen(tab: RailTab | null): void {
  try {
    if (tab === null) localStorage.removeItem(OPEN_KEY);
    else localStorage.setItem(OPEN_KEY, tab);
  } catch {
    /* the rail still opens and closes; it just forgets by the next load */
  }
}

export function createRail(ui: RailUi, panels: RailPanel[]): void {
  // Where the DM left it, and *only* where the DM left it: nothing outside this
  // module moves the rail. A tab changes when a tab is clicked, and never
  // because something happened on the board.
  let open: RailTab | null = readOpen(panels);

  const buttons = new Map<RailTab, HTMLButtonElement>();

  const paint = (): void => {
    for (const panel of panels) {
      panel.root.hidden = panel.tab !== open;
      const button = buttons.get(panel.tab);
      if (button === undefined) continue;
      button.classList.toggle('is-open', panel.tab === open);
      button.setAttribute('aria-expanded', String(panel.tab === open));
    }
  };

  const show = (tab: RailTab | null): void => {
    if (tab === open) return;
    panels.find((p) => p.tab === open)?.stop?.();
    open = tab;
    storeOpen(open);
    paint();
  };

  for (const panel of panels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-tab';
    button.textContent = panel.label;
    button.dataset['tab'] = panel.tab;
    button.addEventListener('click', () => {
      // Clicking the open tab closes it, which is the same gesture the draw
      // tool uses to put a shape down and the fastest way back to a clear board.
      show(open === panel.tab ? null : panel.tab);
    });
    buttons.set(panel.tab, button);
    ui.tabs.append(button);
  }

  paint();
  ui.tabs.hidden = false;
}
