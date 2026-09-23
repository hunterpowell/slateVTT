// A folder on the server's disk, listed in a panel and picked from.
//
// Four folders use this in the same way: the map panel over `maps/`, the token
// panel over `portraits/`, and the table panel over `backdrops/` and
// `tracks/`. Only the folder and the word for what is in it differ, so both are
// passed in and everything below is shared. The server side is shaped the same
// way for the same reason; see `Library` in `main.rs`.
//
// The endpoint copies a pick into the uploads directory and answers with the
// URL it is served at. So `onPicked` gets a URL and can't tell where it came
// from, and no panel has a second code path for library art.
//
// Adding and removing live here too, so there is one implementation, not one
// per panel. Each panel's upload button belongs to this widget: it writes the
// file into the folder and then picks it, so what comes back is a pick's URL,
// and an uploaded map is as durable as one that was in the folder all along.
//
// DM-only, like every route under `/api`: the secret is required, and a player
// has none.

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
   * Outside the list, not in it: the DM adds a file without browsing first.
   */
  file: HTMLInputElement;
  /** The label on that button, which says `adding…` while one is in flight. */
  fileText: HTMLElement;
}

export interface LibraryList {
  /**
   * Closes the list without picking anything.
   *
   * Called as the rail closes the panel, so the tab reopens on the panel and
   * not mid-browse. Nothing is armed on the canvas, so unlike the calibration
   * box this is tidiness, not a rule.
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
  kind: 'maps' | 'portraits' | 'backdrops' | 'tracks',
  /** What the panel does with the URL the copy is now served at. */
  onPicked: (url: string) => void,
  report: (message: string) => void,
): LibraryList {
  /** "map" / "portrait" / "backdrop" / "track": each plural loses a letter. */
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
    // Given a class so nothing has to find it as "the first button in the
    // row". Two buttons share a row and one of them deletes a file, so code
    // that finds a button by position is one off from deleting something.
    // `drive-backdrop.mjs` once did.
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

    // A row, not a bare button, because a button can't hold another one. The
    // remove button is small and to one side: picking is what this list is for,
    // so the pick button takes the whole row except the last few pixels.
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
    // Re-read every time, not cached: someone who drops a file into the folder
    // mid-session should find it by reopening the list.
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
   * The name goes in the query string and the bytes are the body. The server
   * refuses a name with a separator in it instead of taking the last segment,
   * so `file.name` can only ever be a name, never a path. What comes back is a
   * pick's URL, because the endpoint finishes by picking what it just wrote.
   *
   * The list is only re-read if it is already open. Adding isn't browsing, and
   * opening it here would put an unrequested list in front of the DM just as
   * the map lands on the board.
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
   * The confirm prompt names the file and says what survives. There is no undo
   * (this is a file on the server's disk, not room state). It doesn't touch the
   * copy already served out of `uploads/`, so a map on the board keeps working
   * and everything the DM prepared on it is still there. The prompt says so,
   * because "remove" sounds like it does more than it does.
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
