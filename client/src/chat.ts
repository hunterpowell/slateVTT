/**
 * Whisper and shout: one log, two destinations, and a box that says which one
 * it is pointed at.
 *
 * **It is not chat and the difference is the whole design.** A player says
 * something to the table or to the DM; the DM says it to the table or to one
 * player. There is no player-to-player message, no channel, no history between
 * sessions, no formatting, no emotes, no commands and no dice — see the non-goal
 * in `.claude/CLAUDE.md`, which is the specification and whose boundary is most
 * of it. Everything here is refused a second time on the server, which is where
 * the rule actually lives.
 *
 * Three things about this module are decisions rather than detail.
 *
 * **Nothing is predicted locally.** Every other panel that sends a command
 * either waits for the room or draws its own preview; this one only ever waits.
 * A log is a *sequence*, and where a line lands in it is the room's to decide —
 * a client appending its own would have two orderings to reconcile the first
 * time two people typed at once. That is why the server echoes a line to
 * whoever sent it, which no other relayed frame in this project does.
 *
 * **The destination is sticky and it is shown twice.** One chip is armed, and
 * Enter sends there — which is the shape that makes a back-and-forth whisper
 * one keystroke each way, and which has exactly one failure: forgetting the box
 * is pointed at the DM and shouting something private, or the reverse. So the
 * armed chip is not the only marker. The input itself changes colour and says
 * where it is going in its placeholder, because the thing somebody is looking at
 * while they type is the thing they are typing into.
 *
 * **A line renders the same on both screens.** "Saelyn → DM: i pick the lock"
 * is what the sender sees and what the recipient sees, so there is no "am I the
 * sender" branch anywhere in here — one shape, read correctly from either end.
 */

import type { Identity } from './identity.js';
import { colourOf, nameOf } from './pings.js';
import type { Presence } from './presence.js';
import { ownerOf, sameOwner } from './presence.js';
import type { ChatTo, ClientMsg, Owner, RosterEntry, WireChatLine } from './protocol.js';

/** How long an arriving line sits beside a collapsed dock. Long enough to read
 *  a sentence and notice it, short enough that six initiative rolls do not
 *  become a wall over the board. */
const TOAST_MS = 6000;

export interface ChatUi {
  root: HTMLElement;
  log: HTMLElement;
  /** The destination chips. Empty in the document — which ones exist depends on
   *  who is connected, so they are built here. */
  destinations: HTMLElement;
  form: HTMLFormElement;
  text: HTMLInputElement;
  /** The box beside the dock that an arriving line surfaces in. Outside the
   *  panel in the document, because it is what shows when the panel does not. */
  toast: HTMLElement;
}

export interface Chat {
  /** A line arrived — ours or somebody else's; the server has already decided
   *  we are party to it. */
  said(line: WireChatLine): void;
  /** The panel came on screen: catch up to the bottom of the log. */
  opened(): void;
  /**
   * Somebody joined, left, or changed colour — redraw what says so.
   *
   * Two things move: a destination chip dims for somebody who is not connected,
   * and every line already in the log is written in its sender's colour. The
   * second is why this rebuilds the log rather than only repainting the chips —
   * a log in yesterday's colours would attribute half a conversation to the
   * wrong person, which is worse than the colour never having changed.
   */
  repaint(): void;
}

/** What a destination is called in a sentence. */
function toName(to: ChatTo, roster: readonly RosterEntry[]): string {
  if (to.kind === 'table') return 'the table';
  if (to.kind === 'dm') return 'DM';
  return nameOf({ kind: 'player', id: to.id }, roster);
}

/**
 * Where this client may send.
 *
 * The table plus one, in both cases, and the asymmetry is the feature: a player
 * has one person to whisper and the DM has six. Nobody has another *player* on
 * their list, which is the boundary drawn in one place rather than checked in
 * several.
 */
function destinations(identity: Identity, roster: readonly RosterEntry[]): ChatTo[] {
  const table: ChatTo = { kind: 'table' };
  if (!identity.isDm) return [table, { kind: 'dm' }];
  return [table, ...roster.map((slot): ChatTo => ({ kind: 'player', id: slot.id }))];
}

function sameTo(a: ChatTo, b: ChatTo): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'player' && b.kind === 'player' ? a.id === b.id : true;
}

/** The person a destination names, or null for the table — which is everybody
 *  and is therefore never away. */
function personAt(to: ChatTo): Owner | null {
  if (to.kind === 'table') return null;
  return to.kind === 'dm' ? { kind: 'dm' } : { kind: 'player', id: to.id };
}

export function createChat(
  ui: ChatUi,
  identity: Identity,
  roster: readonly RosterEntry[],
  history: readonly WireChatLine[],
  /** Who is here and what colour they picked. Read at draw time rather than
   *  copied, so a line drawn after somebody changes their mind is drawn in the
   *  new colour without this holding a second copy of the table. */
  presence: Presence,
  send: (msg: ClientMsg) => void,
  /** Tells the dock how many lines have arrived since this panel was last on
   *  screen. The dock ignores it while the panel is open. */
  unread: (count: number) => void,
): Chat {
  const me = ownerOf(identity);
  let missed = 0;
  let toastAt: number | undefined;

  // The dock sets `hidden` on this panel, so the panel's own element is the
  // single answer to "is anybody looking at this" — no second flag to keep in
  // step with the tab strip.
  const visible = (): boolean => !ui.root.hidden;

  // --- the log --------------------------------------------------------------

  // Every line on screen, so a colour change can redraw them. The log is capped
  // on the server, so this is a few hundred short strings at worst.
  const lines: WireChatLine[] = [...history];

  const draw = (line: WireChatLine): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'chat-line';
    // A whisper reads differently from a shout at a glance, which is the only
    // thing `to` is used for here — the filtering happened in the room.
    if (line.to.kind !== 'table') row.classList.add('is-whisper');

    const who = document.createElement('span');
    who.className = 'chat-who';
    who.style.color = colourOf(line.by, roster, presence.colours);
    who.textContent = nameOf(line.by, roster);
    row.append(who);

    if (line.to.kind !== 'table') {
      const arrow = document.createElement('span');
      arrow.className = 'chat-arrow';
      arrow.textContent = ` → ${toName(line.to, roster)}`;
      row.append(arrow);
    }

    const text = document.createElement('span');
    text.className = 'chat-text';
    // `textContent`, and it is the only rule this feature has about content:
    // there is no formatting, so there is nothing here that ever becomes markup.
    text.textContent = line.text;
    row.append(document.createTextNode(': '), text);
    return row;
  };

  const toBottom = (): void => {
    ui.log.scrollTop = ui.log.scrollHeight;
  };

  const append = (line: WireChatLine): void => {
    lines.push(line);
    // Read before the append: somebody scrolled up reading what was said a
    // minute ago should not be yanked to the bottom by an arrival. While the
    // panel is hidden this is false and `opened` catches up instead.
    const following = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 8;
    ui.log.append(draw(line));
    if (following) toBottom();
  };

  for (const line of history) ui.log.append(draw(line));

  // --- the box beside the dock ---------------------------------------------

  const surface = (line: WireChatLine): void => {
    ui.toast.replaceChildren(draw(line));
    ui.toast.hidden = false;
    window.clearTimeout(toastAt);
    toastAt = window.setTimeout(() => {
      ui.toast.hidden = true;
    }, TOAST_MS);
  };

  // --- where it is going ----------------------------------------------------

  let to: ChatTo = { kind: 'table' };
  const chips = new Map<ChatTo, HTMLButtonElement>();

  const showDestination = (): void => {
    for (const [dest, chip] of chips) {
      chip.classList.toggle('is-armed', sameTo(dest, to));
      // Dimmed, never disabled. A whisper to somebody who stepped away is a
      // reasonable thing to type — they will read it when they come back, since
      // the log is the session's — and a chip that could not be pressed would
      // move the armed destination out from under somebody mid-sentence.
      const person = personAt(dest);
      chip.classList.toggle('is-away', person !== null && !presence.connected(person));
    }
    // Said twice on purpose. The chip is where the choice was made; the box is
    // where the eyes are while the sentence is being typed, and a whisper that
    // goes to the table because the box looked like any other box is the one
    // way this feature does harm.
    const whisper = to.kind !== 'table';
    ui.form.classList.toggle('is-whisper', whisper);
    ui.text.placeholder = whisper ? `whisper ${toName(to, roster)}…` : 'shout to the table…';
  };

  for (const dest of destinations(identity, roster)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-chip';
    // The slug rather than the display name: it is what the DM already calls
    // each character, it fits, and it matches the lowercase labels the rail's
    // tabs use. The full name is on the tooltip for anybody who wants it.
    chip.textContent = dest.kind === 'player' ? dest.id : dest.kind === 'dm' ? 'DM' : 'table';
    chip.title = `Send to ${toName(dest, roster)}.`;
    chip.addEventListener('click', () => {
      to = dest;
      showDestination();
      // Arming a destination is the first half of saying something, so the
      // cursor goes where the second half is typed.
      ui.text.focus();
    });
    chips.set(dest, chip);
    ui.destinations.append(chip);
  }
  showDestination();

  // --- saying it ------------------------------------------------------------

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.text.value.trim();
    // The server refuses this too. Stopping here is about not sending a frame
    // that comes back as a red banner for pressing Enter on an empty box.
    if (text === '') return;
    send({ type: 'say', to, text });
    // Cleared on send rather than on the echo: what is in the box is what has
    // not been said yet, and holding the sentence until a round trip completes
    // is how somebody types it twice. A refusal arrives as the banner every
    // other refused command uses.
    ui.text.value = '';
  });

  // A keystroke in this box belongs to this box. Every tool in the project
  // listens on `window` — the calibration box applies on Enter, four tools
  // disarm on Escape — and none of them should be reachable from a sentence
  // somebody is typing. `undo.ts` makes the same argument from the other side
  // with `typingIn`.
  ui.text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // The way out, since nothing else here takes the key: Escape puts the
    // keyboard back on the board.
    if (e.key === 'Escape') ui.text.blur();
  });

  ui.root.hidden = true;

  return {
    said(line) {
      append(line);
      // Our own is never news: we just typed it, and it is on screen either
      // way. Everything else is, including a shout — the case this feature
      // exists for is six people posting initiative rolls, and a badge nobody
      // is looking at is how that gets missed.
      if (sameOwner(line.by, me)) return;
      if (visible()) return;
      missed += 1;
      unread(missed);
      surface(line);
    },
    opened() {
      missed = 0;
      unread(0);
      // Whatever arrived while this was shut is at the bottom of it.
      toBottom();
      ui.toast.hidden = true;
      ui.text.focus();
    },
    repaint() {
      showDestination();
      // Read and put back, because rebuilding the log resets it — and somebody
      // scrolled up reading what was said a minute ago should stay there when
      // a name three rows down changes colour.
      const wasAt = ui.log.scrollTop;
      ui.log.replaceChildren(...lines.map(draw));
      ui.log.scrollTop = wasAt;
    },
  };
}
