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

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 */
export async function open(url, { port = 9333, width = 1280, height = 860 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'slate-cdp-'));
  const browser = spawn(findBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--disable-gpu',
    url,
  ]);

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
    browser.kill();
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

    /** Press, move, release — a drag, which is how the map is panned. */
    async drag(fromX, fromY, toX, toY) {
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1,
      });
      await wait(250);
    },

    async key(key, code, windowsVirtualKeyCode) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
      await wait(60);
    },

    close() {
      browser.kill();
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
