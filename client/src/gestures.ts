/**
 * Whether this browser reads the wheel as a mouse or a trackpad, and the hint
 * line that says so.
 *
 * A trackpad sends everything as `wheel` events: a two-finger slide sets
 * `deltaX`/`deltaY`, and a pinch sets `deltaY` with `ctrlKey` (Chromium and
 * Firefox; Safari not checked). Nothing says which device sent an event, so
 * the person says, once. Off by default, so a mouse wheel zooms as it always
 * has. Guessing from the size of the deltas was rejected: it depends on OS
 * scroll settings and display scaling, and a wrong guess makes a mouse wheel
 * pan.
 *
 * The switch is the hint line itself. Someone on a trackpad with this off
 * can't pan at all (a click-drag boxes, a slide zooms, and most touchpads have
 * no right-drag), and the line that says how to pan is where they will look.
 *
 * In `localStorage`, like the initiative fold and the volume: how someone's
 * hand moves is theirs alone, and nothing in the room has to agree about it.
 *
 * See *The bottom-right corner* in `docs/frontend.md`.
 */

const TRACKPAD_KEY = 'slate.gestures.trackpad';

const TEXT = {
  mouse: 'drag token to move · drag map to select · right-drag to pan · wheel to zoom',
  trackpad: 'drag token to move · drag map to select · two-finger slide to pan · pinch to zoom',
} as const;

export interface Gestures {
  /** A plain wheel event pans and only a pinch (or ctrl+wheel) zooms. */
  readonly trackpad: boolean;
}

function readTrackpad(): boolean {
  try {
    return localStorage.getItem(TRACKPAD_KEY) === '1';
  } catch {
    return false;
  }
}

function storeTrackpad(on: boolean): void {
  try {
    localStorage.setItem(TRACKPAD_KEY, on ? '1' : '0');
  } catch {
    /* it still switches; it just forgets by the next load */
  }
}

export function createGestures(hint: HTMLButtonElement): Gestures {
  const state = { trackpad: readTrackpad() };

  const show = (): void => {
    const mode = state.trackpad ? 'trackpad' : 'mouse';
    const word = document.createElement('span');
    word.className = 'hint-mode';
    word.textContent = mode;
    hint.replaceChildren(word, `: ${TEXT[mode]}`);
    hint.title = state.trackpad ? 'Switch to mouse gestures' : 'Switch to trackpad gestures';
  };

  hint.addEventListener('click', () => {
    state.trackpad = !state.trackpad;
    storeTrackpad(state.trackpad);
    show();
  });

  show();
  return state;
}
