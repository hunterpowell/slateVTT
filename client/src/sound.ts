/**
 * The room's music: one looping track, and this browser's settings for it.
 *
 * The room holds a URL and this file holds everything else. The wire carries
 * which track and nothing more: not the volume, not whether anybody can hear
 * it, not the playback position. Everyone at the table is already on voice
 * chat, and a DM who set one volume for seven pairs of headphones would set it
 * wrong for six of them.
 *
 * Three pieces of state:
 *
 * - `playing` is what the element's source points at. It is the idempotency
 *   key (see `update`).
 * - `wanted` is whether this person wants to hear anything. It is in
 *   `localStorage` because it is a preference, not a fact about the room, like
 *   the initiative fold and the open rail tab. It has to be stored anyway,
 *   because a dropped socket reloads the page.
 * - `blocked` means wanted, and the browser refused. It isn't an error state;
 *   it is the ordinary one (see below).
 *
 * Autoplay is what makes this harder than it looks. A browser refuses to start
 * audio that no gesture asked for, and Slate reloads the page whenever a
 * socket drops, so every reconnect loses whatever gesture this page had. On
 * home broadband that happens most sessions. So the attempt is always made and
 * **never fails silently**: if `play()` rejects, the button lights up and says
 * what to do. Silence with nothing on screen to explain it is worse than no
 * feature, because the person can't tell a failure from the feature being
 * absent.
 *
 * Chrome's Media Engagement Index lets a site where somebody has played media
 * often enough start without a gesture, so the refusal looks intermittent and
 * is hard to reproduce. Don't rely on it. The lit button is always correct.
 *
 * Off means paused, never muted. A muted element still fetches the file, and
 * the file comes off a Raspberry Pi through a tunnel, so muting six players who
 * aren't listening would cost the room as much as playing to them.
 *
 * See `docs/sound.md`.
 */

/** Where this browser's settings are kept. */
const ON_KEY = 'slate.sound.on';
const VOLUME_KEY = 'slate.sound.volume';

/**
 * Quiet enough to sit under a conversation, which is always where this music
 * plays. Somebody who wants it louder sets it once and it is remembered.
 */
const DEFAULT_VOLUME = 0.35;

export interface SoundUi {
  root: HTMLElement;
  /** The element itself, from the document, not built here. One element for
   *  the life of the page, because an element built per track could end up
   *  playing two at once. */
  player: HTMLAudioElement;
  /** The speaker. Has no text: the icon inside it shows the state, and the
   *  accessible name, set from here, says the action. */
  toggle: HTMLButtonElement;
  volume: HTMLInputElement;
  /** What is playing: the track's name or "nothing playing", never anything
   *  else. Why it isn't audible goes in `blocked` below. */
  now: HTMLElement;
  /** Shown only when the browser refused to start. The one part of this panel
   *  an icon can't say. */
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
    // `Number(null)` is 0, which is a legal volume and a bad default, so an
    // absent value has to be told apart from a stored silence.
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

/** The last segment of a track URL, the closest thing to a name the room
 *  sends. The library writes `track-boss-1a2b3c4d.ogg`, so the prefix, hash and
 *  extension come off and what is left is what the DM called it. */
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
    // The icon shows the state and the label says the action. Don't put a word
    // on the button: "sound on" reads as easily as a statement of what is true
    // as an offer to change it, and a crossed-out speaker can't be misread. The
    // two must not drift: the button is on when the waves are drawn, so both
    // come from `hearing`.
    const stopped = blocked && wanted;
    const hearing = wanted && !blocked;
    ui.toggle.classList.toggle('is-on', hearing);
    ui.toggle.setAttribute('aria-pressed', String(wanted));

    // Three states, not two. The middle one is wanting to hear it and not
    // hearing it, where somebody would otherwise sit wondering whether the
    // feature is broken.
    ui.toggle.classList.toggle('is-blocked', stopped);
    ui.blocked.hidden = !stopped;

    const label = stopped
      ? 'Start the music'
      : wanted
        ? 'Turn the music off'
        : 'Turn the music on';
    // Both: `title` is the hover and `aria-label` is what a screen reader
    // gets, and a button with an icon and no text has neither by default.
    ui.toggle.title = label;
    ui.toggle.setAttribute('aria-label', label);

    ui.now.textContent = playing === null ? 'nothing playing' : nameOf(playing);
    ui.now.classList.toggle('is-quiet', playing === null);
  };

  /**
   * Ask the browser to start, and show it if the browser refuses.
   *
   * When a click asked, this is called straight from the click handler, never
   * after an `await`. The user activation a gesture grants is used up by the
   * time a promise resolves, so a later attempt has none.
   */
  const attempt = (): void => {
    blocked = false;
    paint();
    // A rejection here has more than one cause, and the panel shows the same
    // thing for all of them, because to the person looking they are the same:
    // the button is lit and nothing is coming out. `warn`, not `error`:
    // `cdp.mjs` collects `console.error` and fails a driver on it, and a
    // browser declining unprompted audio is the ordinary case after every
    // reconnect, not something that went wrong.
    void ui.player.play().catch((err: unknown) => {
      console.warn('the music did not start:', err);
      blocked = true;
      paint();
    });
  };

  // A 404 on a track the DM removed from the library lands here, not in the
  // rejection above, and gets the same treatment for the same reason.
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
      // Use the gesture immediately. This click is what the browser's
      // autoplay rule needs.
      attempt();
      return;
    }
    // Paused, not muted: a muted element keeps pulling the file off the Pi
    // for somebody who has said they don't want it.
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
      // **This check is required, not an optimisation.** `Stage.reloadBackdrop`
      // opens with the same line to save a fetch; here it saves the track.
      // Re-assigning `src` restarts the file from the top, and a `restored`
      // view carries the same URL as the one already playing, so without this
      // the DM undoing a wall trace restarts the boss theme on seven machines.
      if (url === playing) return;
      playing = url;

      if (url === null) {
        ui.player.pause();
        // `removeAttribute` and `load`, never `src = ''`. An empty string
        // resolves against the document URL, so the element fetches the page
        // it is on and reports it as a decode error.
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
