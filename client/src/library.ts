// A folder on the server's disk, listed in a panel and picked from.
//
// Three panels want this and they want exactly the same thing: the map panel
// over `maps/`, the token panel over `portraits/`, the table panel over
// `backdrops/`. What differs is the folder and the word for what is in it — so
// both ride in, and everything below is shared. The server side is the same
// shape for the same reason; see `Library` in `main.rs`.
//
// A pick is not the end of anything. The endpoint copies the file into the
// uploads directory and answers with the URL it is now served at — so
// `onPicked` gets a URL and has no way to tell where it came from, and no panel
// has a second code path for library art.
//
// **Adding and removing live here too, which is what makes them one
// implementation rather than three.** The upload button each panel already had
// is now this widget's: it writes the file into the folder and then picks it, so
// what comes back is a pick's URL and an uploaded map is exactly as durable as
// one that was in the folder all along. The backdrop panel had no upload at all
// and gets one for free, which is the argument for putting it here.
//
// DM-only, like every route under `/api`: the secret is required here, and a
// player has none to offer.

export interface LibraryUi {
  /** The panel. Dimmed while a pick, an add or a remove is in flight. */
  root: HTMLElement;
  /** The disclosure button, which also closes the list. */
  button: HTMLButtonElement;
  /** Empty in the document; the rows are built here. */
  list: HTMLElement;
  /**
   * The hidden file input behind the panel's upload button.
   *
   * Outside the list rather than in it, and deliberately: adding is something
   * the DM does without browsing first, and every panel already had this
   * control sitting there. What changed is where the bytes land.
   */
  file: HTMLInputElement;
  /** The label on that button, which says `adding…` while one is in flight. */
  fileText: HTMLElement;
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

  const entry = (path: string): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    // Named rather than left to be "the first button in the row". Two buttons
    // now share a row and one of them deletes a file, so anything reaching for
    // a row by position is one off from destroying something — which is not
    // hypothetical: it is what `drive-backdrop.mjs` did the first time this
    // list grew a second button.
    button.className = 'map-library-pick';
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

    // A row rather than a bare button, because a button cannot hold another
    // one. The remove is small and to one side: picking is what this list is
    // for and it stays the whole width of the row bar the last few pixels.
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'map-library-remove';
    remove.title = `remove ${path} from the library`;
    remove.textContent = '×';
    remove.addEventListener('click', () => void drop(path));

    const row = document.createElement('div');
    row.className = 'map-library-row';
    row.append(button, remove);
    return row;
  };

  ui.file.addEventListener('change', () => {
    const file = ui.file.files?.[0];
    // Cleared so that choosing the same file twice still fires a change event.
    ui.file.value = '';
    if (file !== undefined) void add(file);
  });

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

  /**
   * Writes a file into the library folder, and uses it.
   *
   * The name goes in the query string and the bytes are the body — the server
   * refuses anything with a separator in it rather than taking the last
   * segment, so `file.name` reaching a path is a name and never a path. What
   * comes back is a pick's URL, because the endpoint finishes by picking what it
   * just wrote.
   *
   * The list is only re-read if it happens to be open. Adding is not browsing,
   * and opening it here would put a list in front of the DM that they did not
   * ask for at the moment the map lands on the board.
   */
  async function add(file: File): Promise<void> {
    const label = ui.fileText.textContent;
    ui.root.classList.add('is-busy');
    ui.fileText.textContent = 'adding…';
    try {
      const url = await urlFrom(
        await fetch(`/api/${kind}/add?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'x-slate-dm-secret': dmSecret },
          body: file,
        }),
        `could not add that ${noun}`,
      );
      if (open) void show();
      onPicked(url);
    } catch (err) {
      report(err instanceof Error ? err.message : `could not add that ${noun}`);
    } finally {
      ui.root.classList.remove('is-busy');
      ui.fileText.textContent = label;
    }
  }

  /**
   * Deletes a file from the library folder.
   *
   * **Named in the prompt, and honest about what survives.** There is no undo
   * here — this is a file on the server's disk, not room state — and what it
   * does *not* touch is the copy already served out of `uploads/`, so a map on
   * the board goes on working and everything the DM prepared on it is still
   * there. The prompt says so, because "remove" reads like more than it is.
   */
  async function drop(path: string): Promise<void> {
    const ok = window.confirm(
      `Remove ${path} from the ${kind} library?\n\n` +
        `The file is deleted from the server's folder. Anything already on the ` +
        `board keeps working, and re-adding it later brings back what you ` +
        `prepared on it.`,
    );
    if (!ok) return;

    ui.root.classList.add('is-busy');
    try {
      const response = await fetch(`/api/${kind}/remove`, {
        method: 'POST',
        headers: { 'x-slate-dm-secret': dmSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `could not remove that ${noun}`);
      }
      void show();
    } catch (err) {
      report(err instanceof Error ? err.message : `could not remove that ${noun}`);
    } finally {
      ui.root.classList.remove('is-busy');
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
