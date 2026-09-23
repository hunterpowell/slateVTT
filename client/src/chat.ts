/**
 * Whisper and shout: one log, two destinations, and a box that says which one
 * it is pointed at.
 *
 * **This is not general chat.** A player says something to the table or to the
 * DM; the DM says it to the table or to one player. There is no
 * player-to-player message, no channel, no history between sessions, no
 * formatting, no emotes, no commands and no dice beyond the loaner. The
 * non-goal in `.claude/CLAUDE.md` is the specification. The server refuses
 * everything outside it a second time, and that is where the rule is enforced.
 *
 * Three design decisions:
 *
 * Nothing is predicted locally. Every other panel that sends a command either
 * waits for the room or draws its own preview; this one only waits. A log is
 * ordered, and the room decides where a line lands. A client appending its own
 * would have two orderings to reconcile the first time two people typed at
 * once. That is why the server echoes a line to its sender, which no other
 * relayed frame in this project does.
 *
 * The destination is sticky and shown twice. One chip is armed, and Enter
 * sends there, so a back-and-forth whisper is one keystroke each way. The
 * failure is forgetting the box points at the DM and shouting something
 * private, or the reverse. So the input itself also changes colour and names
 * the destination in its placeholder, because the box is what someone looks at
 * while they type.
 *
 * A line renders the same on both screens. "Saelyn → DM: i pick the lock" is
 * what the sender and the recipient both see, so there is no "am I the sender"
 * branch in here.
 */

import type { Identity } from './identity.js';
import { colourOf, nameOf } from './pings.js';
import type { Presence } from './presence.js';
import { ownerOf, sameOwner } from './presence.js';
import type { ChatTo, ClientMsg, Owner, RosterEntry, WireChatLine } from './protocol.js';

/** How long an arriving line shows beside a collapsed dock. Long enough to
 *  notice and read a sentence, short enough that six initiative rolls don't
 *  pile up over the board. */
const TOAST_MS = 6000;

/** The dice in the bag, and how many of one may be thrown at once.
 *
 *  Mirrors `DICE_SIDES` and `MAX_DICE` in `room.rs`, which enforces them. The
 *  buttons are built from this, as `MAX_FILL_CELLS` mirrors the room's override
 *  cap. A die missing from here is one nobody can ask for; a die here that the
 *  room doesn't know is a red banner. */
const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
const MAX_DICE = 20;

export interface ChatUi {
  root: HTMLElement;
  log: HTMLElement;
  /** The destination chips. Empty in the document: which ones exist depends on
   *  the roster, so they are built here. */
  destinations: HTMLElement;
  /** The die row. Empty in the document: the buttons are built here from
   *  `DICE_SIDES`, which mirrors the room's list. */
  dice: HTMLElement;
  form: HTMLFormElement;
  text: HTMLInputElement;
  /** The box beside the dock where an arriving line appears. Outside the panel
   *  in the document, because it shows when the panel doesn't. */
  toast: HTMLElement;
}

export interface Chat {
  /** A line arrived, ours or somebody else's. The server has already decided
   *  we are party to it. */
  said(line: WireChatLine): void;
  /** The panel came on screen: catch up to the bottom of the log. */
  opened(): void;
  /**
   * Somebody joined, left, or changed colour. Redraw what shows it.
   *
   * Two things change: a destination chip dims for somebody who isn't
   * connected, and every line in the log is written in its sender's colour. The
   * second is why this rebuilds the log, not just the chips. A log in old
   * colours would attribute half a conversation to the wrong person.
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
 * The table, plus whoever may be whispered: a player has one person to whisper
 * and the DM has six. Nobody has another *player* on their list, so the
 * boundary is drawn here once instead of checked in several places.
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

/** The person a destination names, or null for the table, which is everybody
 *  and so is never away. */
function personAt(to: ChatTo): Owner | null {
  if (to.kind === 'table') return null;
  return to.kind === 'dm' ? { kind: 'dm' } : { kind: 'player', id: to.id };
}

export function createChat(
  ui: ChatUi,
  identity: Identity,
  roster: readonly RosterEntry[],
  history: readonly WireChatLine[],
  /** Who is here and what colour they picked. Read at draw time, not copied,
   *  so a line drawn after somebody changes colour uses the new one without
   *  this module holding a second copy. */
  presence: Presence,
  send: (msg: ClientMsg) => void,
  /** Tells the dock how many lines have arrived since this panel was last on
   *  screen. The dock ignores it while the panel is open. */
  unread: (count: number) => void,
): Chat {
  const me = ownerOf(identity);
  let missed = 0;
  let toastAt: number | undefined;

  // The dock sets `hidden` on this panel, so the element itself says whether
  // anyone is looking at it. No second flag to keep in step with the tab strip.
  const visible = (): boolean => !ui.root.hidden;

  // --- the log --------------------------------------------------------------

  // Every line on screen, so a colour change can redraw them. The log is capped
  // on the server, so this is a few hundred short strings at worst.
  const lines: WireChatLine[] = [...history];

  const draw = (line: WireChatLine): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'chat-line';
    // A whisper is styled differently from a shout. That is the only use of
    // `to` here; the filtering happened in the room.
    if (line.to.kind !== 'table') row.classList.add('is-whisper');
    // Likewise a roll: the room threw it, so it is styled differently from a
    // number somebody typed. Nothing here filters on it either.
    if (line.rolled) row.classList.add('is-rolled');

    const who = document.createElement('span');
    who.className = 'chat-who';
    who.style.color = colourOf(line.by, roster, presence.colours);
    who.textContent = nameOf(line.by, roster);
    row.append(who);

    if (line.to.kind !== 'table') {
      const arrow = document.createElement('span');
      arrow.className = 'chat-arrow';
      // Both ends are the DM only for a hidden roll (the room refuses `Say`
      // there), so the label says "hidden" instead of "DM → DM".
      const self = line.by.kind === 'dm' && line.to.kind === 'dm';
      arrow.textContent = self ? ' → hidden' : ` → ${toName(line.to, roster)}`;
      row.append(arrow);
    }

    const text = document.createElement('span');
    text.className = 'chat-text';
    // `textContent`, the only rule this feature has about content. There is no
    // formatting, so nothing here ever becomes markup.
    text.textContent = line.text;
    row.append(document.createTextNode(': '), text);
    return row;
  };

  const toBottom = (): void => {
    ui.log.scrollTop = ui.log.scrollHeight;
  };

  const append = (line: WireChatLine): void => {
    lines.push(line);
    // Read before the append: someone scrolled up reading earlier lines
    // shouldn't be pulled to the bottom by an arrival. While the panel is
    // hidden this is false and `opened` catches up instead.
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
      // Dimmed, never disabled. A whisper to somebody who stepped away is
      // reasonable: they read it when they come back, since the log lasts the
      // session. Disabling the chip would move the armed destination out from
      // under somebody mid-sentence.
      const person = personAt(dest);
      chip.classList.toggle('is-away', person !== null && !presence.connected(person));
    }
    // Shown on the box as well as the chip. The chip is where the choice was
    // made; the box is where the eyes are while typing. A whisper sent to the
    // table because the box looked ordinary is the one way this feature does
    // harm.
    const whisper = to.kind !== 'table';
    ui.form.classList.toggle('is-whisper', whisper);
    ui.text.placeholder = whisper ? `whisper ${toName(to, roster)}…` : 'shout to the table…';
  };

  for (const dest of destinations(identity, roster)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-chip';
    // The slug, not the display name: it is what the DM already calls each
    // character, it fits, and it matches the rail's lowercase tab labels. The
    // full name is on the tooltip.
    chip.textContent = dest.kind === 'player' ? dest.id : dest.kind === 'dm' ? 'DM' : 'table';
    chip.title = `Send to ${toName(dest, roster)}.`;
    chip.addEventListener('click', () => {
      to = dest;
      showDestination();
      // Picking a destination is the first step of saying something, so focus
      // moves to the text box.
      ui.text.focus();
    });
    chips.set(dest, chip);
    ui.destinations.append(chip);
  }
  showDestination();

  // --- the loaner die -------------------------------------------------------

  // DM-only: a throw nobody else is told about.
  //
  // On the die row, not among the destination chips. Privacy here belongs to
  // the throw, not the conversation, and the room refuses `Say` to the DM's
  // own ear. A chip for it would leave the text box pointing somewhere it
  // can't send, like a rail tab that opens a panel that can do nothing.
  let hiddenRoll = false;

  // How many of the next die. A bag only has whole dice, so this is a count
  // and never an expression. **There is no modifier here and there must not be
  // one.** See `docs/dice.md`.
  const count = document.createElement('input');
  count.type = 'number';
  count.id = 'chat-dice-count';
  count.min = '1';
  count.max = String(MAX_DICE);
  count.value = '1';
  count.title = `How many dice, up to ${MAX_DICE}.`;
  count.setAttribute('aria-label', 'How many dice');
  // Stops keydown for the same reason as `ui.text` below: every tool in the
  // project listens on `window`, and none should fire because somebody typed a
  // 2 in here.
  count.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') count.blur();
  });
  ui.dice.append(count);

  for (const sides of DICE_SIDES) {
    const die = document.createElement('button');
    die.type = 'button';
    die.className = 'chat-die';
    // `d%` for the hundred, which is what the two ten-sided dice it replaces
    // are called at a table, and which keeps seven buttons on one row.
    die.textContent = sides === 100 ? 'd%' : `d${sides}`;
    die.title = `Throw d${sides}.`;
    // One click throws. The common case is one die to the table, and a second
    // control in front of that would make throwing a d20 a form.
    die.addEventListener('click', () => {
      const many = Math.min(Math.max(Math.round(Number(count.value) || 1), 1), MAX_DICE);
      // Written back so the box agrees with what was thrown. The room would
      // refuse a 0 or a 40, and a refusal is worse than the box correcting
      // itself.
      count.value = String(many);
      // Sent wherever the armed chip points, unless the DM armed a hidden
      // roll. That is how a whispered roll works, so there is no second
      // picker here.
      send({ type: 'roll', sides, count: many, to: hiddenRoll ? { kind: 'dm' } : to });
    });
    ui.dice.append(die);
  }

  if (identity.isDm) {
    const secret = document.createElement('button');
    secret.type = 'button';
    secret.className = 'chat-hide';
    secret.textContent = 'hidden roll';
    secret.title = 'Throw where only you see the result.';
    secret.setAttribute('aria-pressed', 'false');
    secret.addEventListener('click', () => {
      hiddenRoll = !hiddenRoll;
      secret.classList.toggle('is-armed', hiddenRoll);
      secret.setAttribute('aria-pressed', String(hiddenRoll));
      // Shown on the dice as well as the button, as a whisper is shown on the
      // box. The button is where the choice was made; the dice are what the DM
      // looks at when picking one. A sticky setting fails when someone forgets
      // it is on.
      ui.dice.classList.toggle('is-hidden-roll', hiddenRoll);
    });
    ui.dice.append(secret);
  }

  // --- saying it ------------------------------------------------------------

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.text.value.trim();
    // The server refuses this too. Stopping here avoids a red banner for
    // pressing Enter on an empty box.
    if (text === '') return;
    send({ type: 'say', to, text });
    // Cleared on send, not on the echo. The box holds what hasn't been said
    // yet, and holding the sentence until the round trip completes is how
    // somebody sends it twice. A refusal arrives as the usual error banner.
    ui.text.value = '';
  });

  // A keystroke in this box stays in this box. Every tool in the project
  // listens on `window` (the calibration box applies on Enter, four tools
  // disarm on Escape), and none should be reachable from a sentence being
  // typed. `typingIn` in `undo.ts` handles the same problem from the
  // listener's side.
  ui.text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // Since nothing else gets the key, Escape blurs the box and puts the
    // keyboard back on the board.
    if (e.key === 'Escape') ui.text.blur();
  });

  ui.root.hidden = true;

  return {
    said(line) {
      append(line);
      // Our own line is never unread: we just typed it. Everything else
      // counts, including a shout. The main case is six people posting
      // initiative rolls, and without the badge and toast those get missed.
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
      // Read and put back, because rebuilding the log resets the scroll.
      // Someone scrolled up reading earlier lines should stay there when a
      // name changes colour.
      const wasAt = ui.log.scrollTop;
      ui.log.replaceChildren(...lines.map(draw));
      ui.log.scrollTop = wasAt;
    },
  };
}
