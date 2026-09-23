/**
 * The DM's editing panels, one at a time.
 *
 * Don't stack them. Stacked panels ran out of height at a short window, with
 * `#tokentool` squeezed to a scrollbar and a heading. These are editing panels,
 * and nobody needs two of them open together. Staging a map and then planning
 * where the tokens land is sequential: `staged_pos` is set by dragging on the
 * preview, not from the token panel.
 *
 * The draw tool isn't one of these. It is the one panel everybody has, it is
 * used in the middle of a fight, and it is pinned to the bottom of the rail
 * like a toolbar. `docs/walls.md` makes the same point about doors: a
 * play-time action behind a mode goes unused. So a player's rail has the strip
 * hidden and the draw tool as its only content.
 *
 * See `docs/frontend.md`.
 */

/**
 * Which of the DM's editing panels the rail can show.
 *
 * Adding one is an entry here and an entry in the array `main.ts` passes in.
 * The next panel costs a tab, not a share of the rail's height.
 */
export type RailTab = 'map' | 'token' | 'walls' | 'fog' | 'table';

export interface RailUi {
  /**
   * The strip. Empty in the document: the buttons are built here, as the draw
   * and wall tools build theirs, so the tab list lives in one place.
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
   * Required, not just tidy, where a panel arms the canvas. The wall editor and
   * the calibration box both take the left mouse button, and a tool still
   * holding it with its panel hidden makes a click do something the DM can't
   * see the reason for. The token panel arms nothing and closes only its
   * portrait list, so the tab reopens on the panel and not mid-browse. It keeps
   * its selection, which is a ring on the board and still on screen.
   */
  stop?: () => void;
}

/**
 * `createRail` returns nothing, so nothing outside this module can change the
 * tab: a tab changes when the DM clicks a tab. Don't add a `show` for the board
 * to call (selecting a token once opened the token tab, and swapped the panel
 * out from under a half-traced wall). If a panel ever needs opening from
 * outside, first ask whether the DM asked for it. See `docs/frontend.md`.
 */

/**
 * Which tab this browser had open last time.
 *
 * In `localStorage`, not the room, like the initiative fold in `panel.ts`: how
 * much of a panel someone wants on their own screen is theirs alone, and
 * nothing has to agree about it.
 *
 * Remembered, not reset to closed on connect, because a dropped socket reloads
 * the page (see `docs/presence.md`). "On connect" also happens mid-fight, and
 * the DM shouldn't lose the panel they were tracing with.
 *
 * Wrapped in `try` like every other read of this API here: a private browsing
 * mode can throw on the property itself, and a closed rail is a fine fallback.
 */
const OPEN_KEY = 'slate.rail.open';

function readOpen(panels: RailPanel[]): RailTab | null {
  try {
    const stored = localStorage.getItem(OPEN_KEY);
    // Checked against the panels actually built, not cast: a tab renamed or
    // removed since this was written would otherwise hide the rail behind a
    // panel that doesn't exist.
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
  // Where the DM left it. Nothing outside this module moves the rail: a tab
  // changes when a tab is clicked, never because something happened on the
  // board.
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
      // Clicking the open tab closes it, as clicking the armed draw tool puts
      // it down. It is the fastest way back to a clear board.
      show(open === panel.tab ? null : panel.tab);
    });
    buttons.set(panel.tab, button);
    ui.tabs.append(button);
  }

  paint();
  ui.tabs.hidden = false;
}
