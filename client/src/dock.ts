/**
 * The right dock: everybody's panels, under the initiative panel.
 *
 * `rail.ts` on the other edge of the screen, and the resemblance is deliberate —
 * a tab strip is the shape this project already uses, and inventing a floating
 * window for the second one would have been two answers to one question. What
 * is *not* shared is the code, and that is worth saying once here rather than
 * being rediscovered:
 *
 * - **The rail is the DM's furniture and this is everybody's.** Every tab here
 *   is built on every connection, which is the first time the two sides of this
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
 * - **And these stack.** One rail panel is open at a time because they are
 *   *editing modes* — two armed tools would be two meanings for one mouse
 *   button. Nothing here is a mode: a scratchpad and a log are both things you
 *   read while something else is going on, and milestone 24's whole complaint
 *   about the rail was that a panel there disappears the moment you reach for
 *   anything. Making notes close the chat would have rebuilt that complaint on
 *   the other edge of the screen.
 *
 * The one rule it does share with the rail is the one that comes from being a
 * strip: clicking an open tab closes it, and nothing is open on connect. That
 * second one matters more here than there — the board is the point, and a panel
 * that opens itself on every refresh has taken a slice of it by default.
 *
 * **The panels stack in document order and never in the order they were
 * opened.** Notes above, chat against the strip — a dock whose layout depended
 * on which tab somebody pressed first would put a panel somewhere different
 * every session, which is the same complaint as the buttons moving and a worse
 * one. So this file hides and shows panels and has no opinion about where they
 * sit; `index.html` is the single place that says.
 *
 * **The strip is the last thing in the dock, not the first**, which is the one
 * piece of this that is upside down from the rail and is not a style choice.
 * This dock grows *upward* from the bottom of the rail, so its top edge moves
 * every time a panel opens and its bottom edge never does — with the strip on
 * top, every toggle slid the buttons out from under the pointer that was aiming
 * at them, and that is worse the more tabs there are to swap between. The rail
 * grows downward and puts its strip on top for the same reason read the other
 * way round.
 */

/** Which panels the dock can show. */
export type DockTab = 'chat' | 'notes';

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
  /** Which panels are open, which is any number of them including none. */
  readonly open: ReadonlySet<DockTab>;
  /** Open a shut panel or shut an open one, leaving its neighbours alone. */
  toggle(tab: DockTab): void;
  /**
   * Put a count on a shut tab, or clear it with 0.
   *
   * **The badge is what a whisper nobody notices fails through**, which is why
   * it is on the dock rather than inside the panel that counts: the panel is
   * hidden at exactly the moment the number matters. It is ignored while that
   * tab is open, because a count of things you are looking at is noise.
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
    // With everything shut the dock is its strip and nothing else — so it stops
    // eating the height it would otherwise hold open under the initiative panel.
    ui.root.classList.toggle('is-open', open.size > 0);
  };

  const toggle = (tab: DockTab): void => {
    if (open.has(tab)) {
      open.delete(tab);
      paint();
      return;
    }
    open.add(tab);
    // Zeroed before the panel is told it opened: what is on screen has been
    // read by definition, and leaving the count to the panel would be a second
    // place to remember it.
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

    // Clicking an open tab closes it, which is the rail's gesture and the
    // fastest way back to a whole board.
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
