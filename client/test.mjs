// Runs the client's unit tests: bundle each `src/*.test.ts` for node, then hand
// the directory to node's own test runner.
//
// The bundle step is not ceremony. The client imports its own modules as
// `./coords.js` — the TypeScript convention — and node's resolver does not
// rewrite that to `coords.ts`, so `node --experimental-strip-types` cannot load
// a single file of this project. esbuild does the rewrite, is already the
// bundler for `npm run build`, and so this costs no dependency.
//
// What lives under test here is the pure half of the client: geometry, the
// distance rules, the fill, the ruler's state machine. Anything that needs a
// canvas or a socket is the browser drivers' job — see `tools/drive-*.mjs`.

import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const OUT = 'testbuild';

const entryPoints = readdirSync('src')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `src/${name}`);

if (entryPoints.length === 0) {
  console.error('no src/*.test.ts found');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
await build({
  entryPoints,
  outdir: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Inline, so a failure points at the line of TypeScript that failed rather
  // than at a column of the bundle.
  sourcemap: 'inline',
});

// Named explicitly rather than handing over the directory: `--test <dir>` tries
// to load the directory as a module rather than searching it.
const bundles = readdirSync(OUT)
  .filter((name) => name.endsWith('.js'))
  .map((name) => `${OUT}/${name}`);

const run = spawnSync(process.execPath, ['--test', '--enable-source-maps', ...bundles], {
  stdio: 'inherit',
});
process.exit(run.status ?? 1);
