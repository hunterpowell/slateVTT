/**
 * The right dock: everybody's panels, one at a time, under the initiative panel.
 *
 * `rail.ts` on the other edge of the screen, and the resemblance is deliberate —
 * a tab strip with one panel open at a time is the shape this project already
 * uses, and inventing a floating window for the second one would have been two
 * answers to one question. What is *not* shared is the code, and that is worth
 * saying once here rather than being rediscovered:
 *
 * - **The rail is the DM's furniture and this is everybody's.** Both tabs are
 *   built on every connection, which is the first time the two sides of this
 *   application have had the same thing on screen.
 * - **The rail's `stop` rule does not apply.** It exists because the map, wall
 *   and fog panels take the left mouse button, and a tool armed under a hidden
 *   panel is a click doing something with nothing on screen saying why. Nothing
 *   in this dock touches the canvas at all, so a panel here can simply be
 *   hidden. There is no `stop` in this file, and one would mean something has
 *   gone wrong.
 * - **A tab here can carry a count**, which no rail tab has ever needed. The
 *   rail's tabs describe what you could do; these describe what happened while
 *   you were not looking.
 *
 * The two rules the rail *does* share are the two that come from being a strip:
 * clicking the open tab closes it, and nothing is open on connect. The second
 * matters more here than there — the board is the point, and a chat panel that
 * opens itself every refresh is a panel that has taken a slice of it by default.
 */

/** Which panel the dock can show. Milestone 24's notes are the second entry. */
export type DockTab = 'chat';

export interface DockUi {
  root: HTMLElement;
  /** The strip. Empty in the document — the buttons are built here, like the
   *  rail's, so the tab list lives in one place. */
  tabs: HTMLElement;
}

export interface DockPanel {
  tab: DockTab;
  label: string;
  root: HTMLElement;
  /** Called when this panel comes on screen. The chat log scrolls to the
   *  bottom and clears its unread count from here — both are things that can
   *  only be done once the panel has a height. */
  opened?: () => void;
}

export interface Dock {
  /** The open tab, or `null` when the dock is just its strip. */
  readonly open: DockTab | null;
  show(tab: DockTab | null): void;
  /**
   * Put a count on a collapsed tab, or clear it with 0.
   *
   * **The badge is what a whisper nobody notices fails through**, which is why
   * it is on the dock rather than inside the panel that counts: the panel is
   * hidden at exactly the moment the number matters. It is ignored while that
   * tab is open, because a count of things you are looking at is noise.
   */
  badge(tab: DockTab, count: number): void;
}

export function createDock(ui: DockUi, panels: DockPanel[]): Dock {
  let open: DockTab | null = null;

  const buttons = new Map<DockTab, HTMLButtonElement>();
  const badges = new Map<DockTab, HTMLElement>();
  const counts = new Map<DockTab, number>();

  const paintBadge = (tab: DockTab): void => {
    const badge = badges.get(tab);
    if (badge === undefined) return;
    const count = tab === open ? 0 : (counts.get(tab) ?? 0);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  };

  const paint = (): void => {
    for (const panel of panels) {
      panel.root.hidden = panel.tab !== open;
      const button = buttons.get(panel.tab);
      if (button !== undefined) {
        button.classList.toggle('is-open', panel.tab === open);
        button.setAttribute('aria-expanded', String(panel.tab === open));
      }
      paintBadge(panel.tab);
    }
    // Collapsed, the dock is its strip and nothing else — so it stops eating
    // the height it would otherwise hold open under the initiative panel.
    ui.root.classList.toggle('is-open', open !== null);
  };

  const show = (tab: DockTab | null): void => {
    if (tab === open) return;
    open = tab;
    // Zeroed before the panel is told it opened: what is on screen has been
    // read by definition, and leaving the count to the panel would be a second
    // place to remember it.
    if (tab !== null) counts.set(tab, 0);
    paint();
    if (tab !== null) panels.find((p) => p.tab === tab)?.opened?.();
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

    button.addEventListener('click', () => {
      // Clicking the open tab closes it, which is the rail's gesture and the
      // fastest way back to a whole board.
      show(open === panel.tab ? null : panel.tab);
    });
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
    show,
    badge(tab, count) {
      counts.set(tab, count);
      paintBadge(tab);
    },
  };
}
