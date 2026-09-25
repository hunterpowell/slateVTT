// Just enough Chrome DevTools Protocol to drive the real client in a real
// browser, and nothing more.
//
// There is no Playwright here on purpose. The client is a canvas application:
// almost everything worth asserting is a pointer event going in and pixels
// coming out, and both of those are two CDP methods. A browser automation
// framework would be a large dependency for `Input.dispatchMouseEvent` and
// `Runtime.evaluate`, and this project weighs dependencies against "could this
// be 40 lines instead". It could.
//
// Node's own `WebSocket` and `fetch` are the only things used, so there is
// nothing to install: the browser is the one already on the machine.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// **Every profile is deleted when its browser goes, and nobody should have to
// clear them by hand.** Each is a fresh directory in the temp folder, around 40 MB
// once Chrome has written its caches, and a full loop opens thirty of them. Before
// this they were never removed, and a week of driver runs filled the disk.
//
// Three layers, because a driver can end three ways. `close()` is the ordinary
// one. The `exit` handler covers a driver that threw or called `process.exit`
// without closing, and Ctrl+C, which is turned into an exit below. The sweep in
// `open()` covers the one nothing in-process can: node itself killed outright,
// which leaves the browser running and its profile locked until it dies.
const PROFILE_PREFIX = 'slate-cdp-';
const live = new Set();

/** Kills the browser's whole process tree and deletes its profile.
 *
 *  The tree rather than the process: Chrome's renderers and GPU process hold
 *  files in the profile too, and on Windows a file that is open cannot be
 *  deleted. Synchronous throughout, because an `exit` handler cannot wait. The
 *  delete retries for a second while the last handles close, and a profile that
 *  is still locked after that is left for the next run's sweep. */
function shutdown(entry) {
  if (!live.delete(entry)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(entry.browser.pid)], { stdio: 'ignore' });
  } else {
    entry.browser.kill('SIGKILL');
  }
  try {
    rmSync(entry.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Still locked; `sweep` gets it next time.
  }
}

process.on('exit', () => {
  for (const entry of [...live]) shutdown(entry);
});
// Ctrl+C ends a node process without firing `exit` unless something handles it.
process.on('SIGINT', () => process.exit(130));

let swept = false;

/** Deletes profiles an earlier run left behind. Only ones untouched for half an
 *  hour: drivers run one at a time and the longest takes about a minute, so
 *  anything that old belongs to no browser still being driven. */
function sweep() {
  if (swept) return;
  swept = true;
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Locked by a browser that outlived its driver, or already gone.
    }
  }
}

/** Where a browser might be, in the order worth trying. `SLATE_BROWSER` wins. */
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findBrowser() {
  const named = process.env['SLATE_BROWSER'];
  if (named !== undefined) return named;
  const found = BROWSERS.find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error('no Chrome or Edge found — set SLATE_BROWSER to one');
  }
  return found;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens `url` in a headless browser and returns a session speaking CDP to it.
 *
 * The profile is a throwaway directory, so a run never inherits `localStorage`
 * from the last one — which matters more here than it looks: the client
 * remembers a claimed roster slot there, and a player session that reclaimed
 * last run's identity would skip the picker this is trying to test.
 *
 * `autoplay` drops the gesture requirement for media, which one driver needs
 * and the rest must not have. It is an option rather than a default on purpose:
 * a browser that can never refuse to start audio can never show the blocked
 * state, and that state is half of what `drive-sound.mjs` is there to check.
 *
 * Note for anyone reaching for a synthetic click to unblock audio instead:
 * `evaluate` below does not pass `userGesture`, so a `.click()` from a driver
 * is not a user activation and will not do it. Adding that flag is a one-line
 * change and is arguably right in general — but it silently changes what every
 * existing driver's clicks mean, so it wants its own argument rather than
 * riding in on a feature.
 */
export async function open(
  url,
  { port = 9333, width = 1280, height = 860, autoplay = false } = {},
) {
  sweep();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const browser = spawn(findBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--disable-gpu',
    ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
    url,
  ]);
  const entry = { browser, profile };
  live.add(entry);

  let target = null;
  for (let attempt = 0; attempt < 40 && target === null; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {
      // Not listening yet. The browser takes a moment to open the port.
    }
    if (target === null) await wait(250);
  }
  if (target === null) {
    shutdown(entry);
    throw new Error('the browser never opened a debugging port');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));

  let nextId = 1;
  const pending = new Map();
  /** Anything the page complained about, which is an assertion in itself. */
  const errors = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(`uncaught: ${msg.params.exceptionDetails.text}`);
    }
    const waiting = pending.get(msg.id);
    if (waiting === undefined) return;
    pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(JSON.stringify(msg.error)));
    else waiting.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');

  // A native dialog deadlocks CDP outright: the click that opens one never
  // returns, so the driver hangs with no output and the last thing in its log is
  // whatever passed just before. Several buttons in this client are guarded by a
  // `confirm`, so every session gets rid of them up front.
  //
  // Both halves are needed and they cover different moments. The first runs
  // before any script in *future* documents, which is the only way to beat a
  // reload; the second covers the document already open, since attaching can win
  // the race against the first navigation and leave a driver stubbing
  // `about:blank`. A driver doing this for itself hits exactly that — it looks
  // like it works, until one run in ten attaches early and hangs somewhere
  // unrelated.
  const noDialogs = 'window.confirm = () => true; window.alert = () => {}; window.prompt = () => null;';
  await send('Page.addScriptToEvaluateOnNewDocument', { source: noDialogs });
  await send('Runtime.evaluate', { expression: `${noDialogs} "ok"` });

  const session = {
    errors,
    send,
    wait,

    /** Runs an expression in the page and returns its value. */
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate threw');
      }
      return result.result.value;
    },

    async move(x, y, modifiers = 0) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
      await wait(30);
    },

    /** Press and release. `clickCount: 2` is how a double-click is spelled. */
    async click(x, y, { clickCount = 1, modifiers = 0 } = {}) {
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount, modifiers,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount, modifiers,
      });
      await wait(60);
    },

    /**
     * Press, move, release. With the left button that moves a token, sweeps a
     * shape, or on bare board draws a selection box; `button: 'right'` is how
     * the map is panned. `buttons` is CDP's held-button bitfield, which it
     * doesn't derive from `button`.
     */
    async drag(fromX, fromY, toX, toY, { button = 'left', modifiers = 0 } = {}) {
      const buttons = { left: 1, right: 2, middle: 4 }[button];
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: fromX, y: fromY, button, buttons, clickCount: 1, modifiers,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: toX, y: toY, button, buttons, modifiers,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: toX, y: toY, button, buttons: 0, clickCount: 1, modifiers,
      });
      await wait(250);
    },

    // `modifiers` is CDP's bitfield: 1 alt, 2 ctrl, 4 meta, 8 shift. Zero by
    // default, so every caller written before undo needed Ctrl+Z is unchanged.
    async key(key, code, windowsVirtualKeyCode, modifiers = 0) {
      const frame = { key, code, windowsVirtualKeyCode, modifiers };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...frame });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...frame });
      await wait(60);
    },

    close() {
      shutdown(entry);
    },
  };

  return session;
}

/**
 * A tally of checks, printed as it goes.
 *
 * Deliberately not an assertion that throws: a failure halfway through a scripted
 * session leaves the rest of it unrun, and the later checks are usually the ones
 * that say what actually broke.
 */
export function checks() {
  const failures = [];
  return {
    check(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      const detail = ok ? '' : `  got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail}`);
      if (!ok) failures.push(label);
      return ok;
    },
    note: (...parts) => console.log('  ', ...parts),
    /** Prints the verdict and returns the exit code to leave with. */
    verdict(session) {
      if (session.errors.length > 0) {
        console.log(`\nthe page logged errors: ${session.errors.join(' | ')}`);
        failures.push('console errors');
      }
      console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
      return failures.length === 0 ? 0 : 1;
    },
  };
}
