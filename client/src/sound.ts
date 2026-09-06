/**
 * The room's music: one looping track, and this browser's opinion about it.
 *
 * **The room holds a URL and this file holds everything else.** What is on the
 * wire is which track, and nothing more — not the level, not whether anybody can
 * hear it, not where in the track this browser has got to. That split is the
 * feature rather than an omission: everyone at this table is already listening
 * to voice chat, and a DM who set one volume for seven pairs of headphones would
 * be setting it wrong for six of them.
 *
 * Three pieces of state, and that there are three is the whole design:
 *
 * - `playing` is what the element's source is actually pointed at. It is the
 *   idempotency key — see `update`.
 * - `wanted` is whether this person wants to hear anything, in `localStorage`
 *   because it is a preference and not a fact about the room. The initiative
 *   fold and the open rail tab are the precedent, and they are in storage partly
 *   for the reason this one has to be: a dropped socket reloads the page.
 * - `blocked` is "wanted, and the browser said no". It is not an error state, it
 *   is the ordinary one — see below.
 *
 * **Autoplay is the thing that makes this harder than it looks.** A browser
 * refuses to start audio that no gesture asked for, and Slate reloads the page
 * whenever a socket drops, so every reconnect throws away whatever gesture this
 * page had. That is not an edge case at a table on domestic broadband; it is
 * Tuesday. So the rule here is that the attempt is always made and **never fails
 * silently**: if `play()` rejects, the button lights up and says what to do. A
 * feature that goes quiet with nothing on screen to explain it is worse than one
 * that was never built, because the person it happened to has no way to tell
 * those two apart.
 *
 * Chrome's Media Engagement Index means a site somebody has played media on
 * often enough *will* usually be allowed to start without a gesture, so this
 * will look intermittent and will be hard to reproduce deliberately. Do not
 * build on it. The lit button is the half that is always correct.
 *
 * **Off means paused, never muted.** A muted element still fetches the file, and
 * the file comes off a Raspberry Pi through a tunnel — so muting six players who
 * are not listening would cost the room exactly as much as playing to them.
 *
 * See `docs/sound.md`.
 */

/** Where this browser's opinions are kept. */
const ON_KEY = 'slate.sound.on';
const VOLUME_KEY = 'slate.sound.volume';

/**
 * Quiet enough to sit under a conversation, which is the only place this music
 * is ever going. Somebody who wants it louder says so once and is remembered.
 */
const DEFAULT_VOLUME = 0.35;

export interface SoundUi {
  root: HTMLElement;
  /** The element itself, out of the document rather than built here — one
   *  element for the life of the page, because an element built per track is an
   *  element that can end up playing two at once. */
  player: HTMLAudioElement;
  /** The speaker. Carries no text — the icon inside it is the state, and the
   *  accessible name is set from here so it says the *action* where the icon
   *  shows the state. */
  toggle: HTMLButtonElement;
  volume: HTMLInputElement;
  /** What is playing. Only ever the track's name or "nothing playing" — the
   *  reason it is not coming out lives in `blocked` below, so this line never
   *  has to be two things at once. */
  now: HTMLElement;
  /** Shown only when the browser refused to start. The one part of this panel
   *  an icon cannot say. */
  blocked: HTMLElement;
}

export interface Sound {
  /** The room's answer, applied. The only way in from the wire. */
  update(url: string | null): void;
}

function readOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === '1';
  } catch {
    return false;
  }
}

function storeOn(on: boolean): void {
  try {
    localStorage.setItem(ON_KEY, on ? '1' : '0');
  } catch {
    /* it still plays; it just forgets by the next load */
  }
}

function readVolume(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_KEY));
    // `Number(null)` is 0, which is a legal volume and a terrible default, so
    // an absent value has to be told apart from a stored silence.
    return localStorage.getItem(VOLUME_KEY) !== null && stored >= 0 && stored <= 1
      ? stored
      : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function storeVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    /* as above */
  }
}

/** The last segment of a track URL, which is the closest thing to a name the
 *  room ever sends. The library writes `track-boss-1a2b3c4d.ogg`, so the hash
 *  and the extension come off and what is left is what the DM called it. */
function nameOf(url: string): string {
  const file = url.slice(url.lastIndexOf('/') + 1);
  const stem = file.replace(/\.[^.]+$/, '');
  return stem.replace(/^track-/, '').replace(/-[0-9a-f]{8}$/, '');
}

export function createSound(ui: SoundUi): Sound {
  let playing: string | null = null;
  let wanted = readOn();
  let blocked = false;

  ui.player.volume = readVolume();
  ui.volume.value = String(ui.player.volume);

  const paint = (): void => {
    // **The icon shows the state and the label says the action**, which is the
    // whole reason this stopped being a button with a word on it: "sound on" as
    // a label reads as a statement of what is currently true exactly as easily
    // as an offer to change it, and a crossed-out speaker cannot be read the
    // wrong way round. The two must not drift — the button is on when the waves
    // are drawn, so both come off `hearing`.
    const stopped = blocked && wanted;
    const hearing = wanted && !blocked;
    ui.toggle.classList.toggle('is-on', hearing);
    ui.toggle.setAttribute('aria-pressed', String(wanted));

    // Three states and not two: the middle one is wanting to hear it and not
    // hearing it, which is the case somebody would otherwise sit through
    // wondering whether the feature is broken.
    ui.toggle.classList.toggle('is-blocked', stopped);
    ui.blocked.hidden = !stopped;

    const label = stopped
      ? 'Start the music'
      : wanted
        ? 'Turn the music off'
        : 'Turn the music on';
    // Both, and not just one: `title` is the hover and `aria-label` is what a
    // screen reader gets, and a button with an icon and no text has neither by
    // default.
    ui.toggle.title = label;
    ui.toggle.setAttribute('aria-label', label);

    ui.now.textContent = playing === null ? 'nothing playing' : nameOf(playing);
    ui.now.classList.toggle('is-quiet', playing === null);
  };

  /**
   * Ask the browser to start, and take no for an answer visibly.
   *
   * Called straight out of the click handler when it is a click that asked, and
   * never after an `await` — the user activation a gesture grants is spent by
   * the time a promise resolves, so an attempt made later is an attempt made
   * without one.
   */
  const attempt = (): void => {
    blocked = false;
    paint();
    // A rejection here means one of two things and the panel says the same for
    // both, because to the person looking at it they are the same thing: the
    // button is lit and nothing is coming out. `warn` and pointedly not `error`
    // — `cdp.mjs` collects `console.error` and fails a driver on it, and a
    // browser declining to start audio nobody asked for is the ordinary case
    // after every reconnect rather than something that went wrong.
    void ui.player.play().catch((err: unknown) => {
      console.warn('the music did not start:', err);
      blocked = true;
      paint();
    });
  };

  // A 404 on a track the DM removed from the library lands here rather than in
  // the rejection above, and it deserves the same treatment for the same reason.
  ui.player.addEventListener('error', () => {
    if (playing === null) return;
    console.warn('the music could not be loaded:', ui.player.currentSrc);
    blocked = true;
    paint();
  });

  ui.toggle.addEventListener('click', () => {
    wanted = !wanted;
    storeOn(wanted);
    if (wanted) {
      // The gesture, spent immediately. This is the click the whole autoplay
      // story is waiting for.
      attempt();
      return;
    }
    // Paused rather than muted: a muted element goes on pulling the file off
    // the Pi for somebody who has said they do not want it.
    ui.player.pause();
    blocked = false;
    paint();
  });

  ui.volume.addEventListener('input', () => {
    ui.player.volume = Number(ui.volume.value);
  });
  ui.volume.addEventListener('change', () => {
    storeVolume(Number(ui.volume.value));
  });

  paint();

  return {
    update(url) {
      // **The whole idempotency rule, and it is load-bearing rather than an
      // optimisation.** `Stage.reloadBackdrop` opens with the same line to save
      // a fetch; here it saves the track. Re-assigning `src` starts the file
      // again from the top, and a `restored` view carries the same URL as the
      // one already playing — so without this the DM undoing a wall trace
      // restarts the boss theme on seven machines.
      if (url === playing) return;
      playing = url;

      if (url === null) {
        ui.player.pause();
        // `removeAttribute` and `load`, never `src = ''` — an empty string
        // resolves against the document URL, which makes the element fetch the
        // page it is sitting in and report it as a decode error.
        ui.player.removeAttribute('src');
        ui.player.load();
        blocked = false;
        paint();
        return;
      }

      ui.player.src = url;
      if (wanted) {
        attempt();
      } else {
        paint();
      }
    },
  };
}
