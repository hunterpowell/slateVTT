// Everything that can be checked without a browser, in one command.
//
// `npm run check` is the client's half and `cargo test` is the server's, and
// running one and forgetting the other is how `cargo fmt` drifts. This is the
// four of them in sequence, and it reports every failure rather than stopping at
// the first — a formatting diff should not hide a failing test.
//
// **Deliberately not the browser drivers.** Those need Chrome, a running server
// and a scratch `SLATE_STATE`, they share debug ports so they cannot run in
// parallel, and they take five minutes. The README documents running them and
// that stays a separate, deliberate act.
//
//   node tools/check.mjs

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const CLIENT = join(ROOT, 'client');

const steps = [
  ['server tests', 'cargo', ['test'], SERVER],
  ['server formatting', 'cargo', ['fmt', '--', '--check'], SERVER],
  ['server lints', 'cargo', ['clippy', '--all-targets', '--', '-D', 'warnings'], SERVER],
  ['client typecheck, tests and build', 'npm', ['run', 'check'], CLIENT],
];

const failed = [];
for (const [name, cmd, args, cwd] of steps) {
  console.log(`\n=== ${name} ===`);
  // `shell: true` because npm is a shim on Windows and will not exec directly.
  const run = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
  if (run.status !== 0) failed.push(name);
}

console.log();
if (failed.length === 0) {
  console.log('all green');
} else {
  for (const name of failed) console.log(`FAILED: ${name}`);
  process.exit(1);
}
