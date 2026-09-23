/**
 * The right dock: everybody's panels, under the initiative panel.
 *
 * Like `rail.ts` on the other edge of the screen: a tab strip is the shape this
 * project already uses, and a floating window for the second one would be two
 * answers to one question. The code isn't shared, for four reasons:
 *
 * - The rail is the DM's and this is everybody's. Every tab here is built
 *   on every connection.
 * - The rail's `stop` rule doesn't apply. It exists because the map, wall
 *   and fog panels take the left mouse button, and a tool armed under a hidden
 *   panel makes a click do something with nothing on screen saying why.
 *   Nothing in this dock touches the canvas, so a panel here can simply be
 *   hidden. A `stop` in this file would mean something has gone wrong.
 * - A tab here can carry a count, which no rail tab has needed. The rail's
 *   tabs describe what you could do; these describe what happened while you
 *   weren't looking.
 * - These stack. One rail panel is open at a time because they are editing
 *   modes, and two armed tools would give one mouse button two meanings.
 *   Nothing here is a mode: a scratchpad and a log are both things you read
 *   while something else is going on. Don't make opening notes close the chat.
 *
 * It shares the strip's gesture with the rail: clicking an open tab closes it.
 * Unlike the rail, nothing is open on connect and nothing is remembered. The
 * board comes first, and a panel that opened itself on every refresh would
 * take a slice of it by default.
 *
 * **The panels stack in document order, never in the order they were
 * opened.** Notes above, chat against the strip. A layout that depended on
 * which tab somebody pressed first would put a panel somewhere different every
 * session. So this file hides and shows panels and has no say in where they
 * sit; `index.html` is the one place that decides.
 *
 * The strip is the last thing in the dock, not the first, the reverse of the
 * rail. This dock grows upward from the bottom of the column, so its top edge
 * moves every time a panel opens and its bottom edge never does. With the
 * strip on top, every toggle would slide the buttons out from under the
 * pointer. The rail grows downward and puts its strip on top for the same
 * reason. See `docs/frontend.md`.
 */

/** Which panels the dock can show. */
export type DockTab = 'chat' | 'notes' | 'sound';

export interface DockUi {
  root: HTMLElement;
  /** The strip. Empty in the document: the buttons are built here, like the
   *  rail's, so the tab list lives in one place. */
  tabs: HTMLElement;
}

export interface DockPanel {
  tab: DockTab;
  label: string;
  root: HTMLElement;
  /** Called when this panel comes on screen. The chat log scrolls to the
   *  bottom and clears its unread count from here; scrolling can only be done
   *  once the panel has a height. */
  opened?: () => void;
}

export interface Dock {
  /** Which panels are open: any number of them, including none. */
  readonly open: ReadonlySet<DockTab>;
  /** Open a shut panel or shut an open one, leaving its neighbours alone. */
  toggle(tab: DockTab): void;
  /**
   * Put a count on a shut tab, or clear it with 0.
   *
   * **The badge is how a whisper gets noticed**, so it is on the dock, not
   * inside the panel that counts: the panel is hidden when the number matters.
   * It is ignored while that tab is open, because a count of things you are
   * looking at is noise.
   */
  badge(tab: DockTab, count: number): void;
}

export function createDock(ui: DockUi, panels: DockPanel[]): Dock {
  const open = new Set<DockTab>();

  const buttons = new Map<DockTab, HTMLButtonElement>();
  const badges = new Map<DockTab, HTMLElement>();
  const counts = new Map<DockTab, number>();

  const paintBadge = (tab: DockTab): void => {
    const badge = badges.get(tab);
    if (badge === undefined) return;
    const count = open.has(tab) ? 0 : (counts.get(tab) ?? 0);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  };

  const paint = (): void => {
    for (const panel of panels) {
      panel.root.hidden = !open.has(panel.tab);
      const button = buttons.get(panel.tab);
      if (button !== undefined) {
        button.classList.toggle('is-open', open.has(panel.tab));
        button.setAttribute('aria-expanded', String(open.has(panel.tab)));
      }
      paintBadge(panel.tab);
    }
    // With everything shut the dock is just its strip, so it stops taking the
    // height it would otherwise hold open under the initiative panel.
    ui.root.classList.toggle('is-open', open.size > 0);
  };

  const toggle = (tab: DockTab): void => {
    if (open.has(tab)) {
      open.delete(tab);
      paint();
      return;
    }
    open.add(tab);
    // Zeroed before the panel is told it opened: what is on screen counts as
    // read, and leaving the count to the panel would be a second place to
    // remember it.
    counts.set(tab, 0);
    paint();
    panels.find((p) => p.tab === tab)?.opened?.();
  };

  for (const panel of panels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock-tab';
    button.dataset['tab'] = panel.tab;

    const label = document.createElement('span');
    label.textContent = panel.label;
    const badge = document.createElement('span');
    badge.className = 'dock-badge';
    badge.hidden = true;
    button.append(label, badge);

    // Clicking an open tab closes it, as on the rail. It is the fastest way
    // back to a whole board.
    button.addEventListener('click', () => toggle(panel.tab));
    buttons.set(panel.tab, button);
    badges.set(panel.tab, badge);
    ui.tabs.append(button);
  }

  paint();
  ui.root.hidden = false;

  return {
    get open() {
      return open;
    },
    toggle,
    badge(tab, count) {
      counts.set(tab, count);
      paintBadge(tab);
    },
  };
}
