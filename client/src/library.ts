// A folder on the server's disk, listed in a panel and picked from.
//
// Three panels want this and they want exactly the same thing: the map panel
// over `maps/`, the token panel over `portraits/`, the table panel over
// `backdrops/`. What differs is the folder and the word for what is in it — so
// both ride in, and everything below is shared. The server side is the same
// shape for the same reason; see `Library` in `main.rs`.
//
// A pick is not the end of anything. The endpoint copies the file into the
// uploads directory and answers with the URL it is now served at, which is
// byte-for-byte what an upload answers with — so `onPicked` gets a URL and has
// no way to tell where it came from, and neither panel has a second code path
// for library art.
//
// DM-only, like every route under `/api`: the secret is required here, and a
// player has none to offer.

export interface LibraryUi {
  /** The panel. Dimmed while a pick is in flight. */
  root: HTMLElement;
  /** The disclosure button, which also closes the list. */
  button: HTMLButtonElement;
  /** Empty in the document; the rows are built here. */
  list: HTMLElement;
}

export interface LibraryList {
  /**
   * Closes the list without picking anything.
   *
   * Called as the rail closes the panel, so the tab reopens on the panel rather
   * than mid-browse. Nothing is armed on the canvas, so unlike the calibration
   * box this is tidiness rather than a rule.
   */
  close(): void;
}

/** Both endpoints answer with plain text on failure and JSON on success. */
export async function urlFrom(response: Response, whenItFails: string): Promise<string> {
  const body = await response.text();
  if (!response.ok) throw new Error(body || `${whenItFails} (${response.status})`);
  return (JSON.parse(body) as { url: string }).url;
}

export function createLibraryList(
  ui: LibraryUi,
  dmSecret: string,
  /** The path segment under `/api`, and the plural in every message. */
  kind: 'maps' | 'portraits' | 'backdrops',
  /** What the panel does with the URL the copy is now served at. */
  onPicked: (url: string) => void,
  report: (message: string) => void,
): LibraryList {
  /** "map" / "portrait" / "backdrop" — every plural loses exactly one letter. */
  const noun = kind.slice(0, -1);

  let open = false;

  const close = (): void => {
    open = false;
    ui.list.hidden = true;
    ui.button.classList.remove('is-active');
  };

  const note = (text: string): void => {
    const line = document.createElement('p');
    line.className = 'map-library-note';
    line.textContent = text;
    ui.list.replaceChildren(line);
  };

  const entry = (path: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    // The list is one line per file and the panel is narrow, so the full path
    // has to be reachable somewhere.
    button.title = path;

    const cut = path.lastIndexOf('/');
    if (cut !== -1) {
      const folder = document.createElement('span');
      folder.className = 'map-library-dir';
      folder.textContent = path.slice(0, cut + 1);
      button.append(folder);
    }
    button.append(path.slice(cut + 1));

    button.addEventListener('click', () => void pick(path));
    return button;
  };

  ui.button.addEventListener('click', () => {
    if (open) {
      close();
      return;
    }
    open = true;
    ui.button.classList.add('is-active');
    ui.list.hidden = false;
    // Re-read every time rather than caching: someone who drops a file into the
    // folder mid-session should find it by reopening the list.
    void show();
  });

  async function show(): Promise<void> {
    note('reading the library…');
    try {
      const response = await fetch(`/api/${kind}`, {
        headers: { 'x-slate-dm-secret': dmSecret },
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body || `could not read the library (${response.status})`);
      }

      const { files } = JSON.parse(body) as { files: string[] };
      if (files.length === 0) {
        note(`no ${kind} in the library`);
        return;
      }
      ui.list.replaceChildren(...files.map(entry));
    } catch (err) {
      note(err instanceof Error ? err.message : 'could not read the library');
    }
  }

  async function pick(path: string): Promise<void> {
    ui.root.classList.add('is-busy');
    try {
      const url = await urlFrom(
        await fetch(`/api/${kind}/pick`, {
          method: 'POST',
          headers: { 'x-slate-dm-secret': dmSecret, 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        }),
        `could not pick that ${noun}`,
      );
      close();
      onPicked(url);
    } catch (err) {
      report(err instanceof Error ? err.message : `could not pick that ${noun}`);
    } finally {
      ui.root.classList.remove('is-busy');
    }
  }

  return { close };
}
