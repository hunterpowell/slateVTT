// Drives the DM putting music on, with a player listening.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-sound.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and changes what it is playing, but the music is
// session memory rather than persisted state — so a server restart also puts it
// back. Point `SLATE_STATE` at a scratch file anyway: the pick writes a copy
// into `uploads/`. It stops the music again at the end.
//
// Why a browser, and why two of them. Everything this milestone claims that the
// server suite cannot see is about an `<audio>` element on a machine the DM's
// client knows nothing about: that the player's element ends up pointed at the
// same track, that it stays pointed there through an unrelated undo, and that a
// browser refusing to start audio produces a lit button rather than silence.
//
// **The two sessions are opened differently on purpose.** The DM's browser is
// launched with the autoplay gesture requirement dropped, so playback genuinely
// starts and `.paused` can be asserted. The player's is not, so the blocked
// state is reachable — a browser that can never refuse can never show it, and
// that state is half of what this file exists to check.
//
// A caveat worth reading before trusting a red line here: headless Chrome with
// no audio device is expected to play into a null sink and report `.paused ===
// false`, but that has not been confirmed on every platform this repo is run
// on. The `src` assertions do not depend on it, and the toggle check accepts
// either outcome and reports which it saw.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333, autoplay: true });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check(
  'the player is on the board',
  await player.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]'),
  'Saelyn',
);

const src = (session) =>
  session.evaluate(`document.getElementById('sound-player').getAttribute('src')`);
const paused = (session) => session.evaluate(`document.getElementById('sound-player').paused`);

/**
 * What the speaker is saying, as the three things that have to agree: whether
 * the waves are drawn, whether the cross is, and what it calls itself.
 *
 * The icon is the only thing telling somebody which state they are in, so a
 * class that stopped being toggled would be invisible to every other assertion
 * here — the audio would still play and every `src` check would still pass.
 */
const speaker = (session) =>
  session.evaluate(`(() => {
    const b = document.getElementById('sound-toggle');
    const seen = (sel) => getComputedStyle(b.querySelector(sel)).display !== 'none';
    return {
      waves: seen('.sound-waves'),
      cross: seen('.sound-cross'),
      label: b.getAttribute('aria-label'),
      blockedShown: !document.getElementById('sound-blocked').hidden,
    };
  })()`);

const soundTab = async (session) => {
  await session.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
    .find(b => b.textContent.startsWith('sound')).click(); "ok"`);
  await session.wait(200);
};

const tableTab = async () => {
  await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
    .find(b => b.textContent === 'table').click(); "ok"`);
  await dm.wait(200);
};

// --- it starts off, on every screen -----------------------------------------
//
// Not a nicety: a browser refuses to start audio no gesture asked for, so a
// design where sound was on by default would be a design that mostly does not
// work. It is also just correct, since everyone here is already listening to
// voice chat.

check('the DM starts silent', await paused(dm), true);
check('and so does the player', await paused(player), true);
check('with nothing loaded either', await src(player), null);
// Nobody has told either of them what is playing, because nothing is.
check(
  'the panel says so rather than saying nothing',
  await player.evaluate('document.getElementById("sound-now").textContent'),
  'nothing playing',
);

// --- everybody gets the panel, only the DM gets the picker -------------------

await soundTab(player);
check(
  'the player has the sound panel',
  await player.evaluate('document.getElementById("sound").hidden'),
  false,
);
// The volume is this browser's opinion and is not on the wire at all, so there
// is nothing for the DM to set and no panel for a player to be refused.
check(
  'and their own volume control',
  await player.evaluate('document.getElementById("sound-volume") !== null'),
  true,
);
// **Exactly one of the two is ever drawn.** A muted speaker is the whole of what
// tells somebody why they cannot hear anything, so "both" and "neither" are
// failures that nothing else in this file would notice.
check('the speaker starts crossed out, not sounding', await speaker(player), {
  waves: false,
  cross: true,
  label: 'Turn the music on',
  blockedShown: false,
});
check(
  'the player has no table panel to pick a track from',
  await player.evaluate('document.querySelector("#tabletool").hidden'),
  true,
);

// --- putting music on --------------------------------------------------------

await tableTab();
check(
  'the picker is on the table panel, beside the backdrop',
  await dm.evaluate(`document.getElementById('table-track').offsetParent !== null`),
  true,
);
check(
  'and there is nothing to stop yet',
  await dm.evaluate('document.getElementById("table-track-clear").hidden'),
  true,
);

await dm.evaluate('document.getElementById("table-track").click(); "ok"');
await dm.wait(700); // the listing request
const files = await dm.evaluate(
  `document.querySelectorAll('#table-track-list .map-library-pick').length`,
);
note(`${files} track(s) in the library`);
check('the library listed something to pick', files > 0, true);

await dm.evaluate(`document.querySelector('#table-track-list .map-library-pick').click(); "ok"`);
await dm.wait(1800); // the pick copies the file, then the round trip

const dmSrc = await src(dm);
const playerSrc = await src(player);
note(`the DM is pointed at ${dmSrc}`);

check('the DM loaded a track', dmSrc !== null && dmSrc.startsWith('/uploads/'), true);
// **The assertion no single browser can make.** The player's element was
// pointed at this by a frame the DM's client never saw and cannot fake.
check('and the player is pointed at the same one', playerSrc, dmSrc);
check(
  'the DM is told there is something to stop',
  await dm.evaluate('document.getElementById("table-track-clear").hidden'),
  false,
);
// The panel names it rather than leaving somebody to wonder whether the click
// took, which is the whole reason the room's URL is worth putting on screen.
check(
  'and the player is told what it is',
  await player.evaluate(`document.getElementById('sound-now').textContent !== 'nothing playing'`),
  true,
);

// The player has still not asked to hear anything, so nothing is coming out of
// their machine and nothing was fetched for it — `preload="none"` is what keeps
// six people who never turn sound on from each pulling the file off the Pi.
check('the player who never turned sound on is still silent', await paused(player), true);

// --- the DM turns theirs on --------------------------------------------------
//
// Before the undo check rather than after it, because "an undo did not restart
// the music" is only worth asserting on a client that was playing to begin
// with. This browser had the gesture requirement dropped, so it is not allowed
// to be the ambiguous case: it must actually be playing.

await soundTab(dm);
await dm.evaluate('document.getElementById("sound-toggle").click(); "ok"');
await dm.wait(1000);
check('the DM, with no gesture required, is actually playing', await paused(dm), false);
check('and their speaker swapped the cross for the waves', await speaker(dm), {
  waves: true,
  cross: false,
  label: 'Turn the music off',
  blockedShown: false,
});

// --- an undo must not restart it ---------------------------------------------
//
// **The check this driver exists for.** `restored` carries a whole `RoomView`,
// so an undo hands every client the URL it is already playing — and re-assigning
// `src` starts a file again from the top. The guard is one line in `sound.ts`
// and nothing else in the suite can see whether it is there.

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'table').click(); "ok"`);
await dm.wait(200);
// Something persisted and unrelated, so the ring has a step to take back.
await dm.evaluate(`document.getElementById('table-names').click(); "ok"`);
await dm.wait(600);

const undoable = await dm.evaluate('document.getElementById("undo").hidden === false');
if (undoable) {
  await dm.evaluate('document.getElementById("undo-button").click(); "ok"');
  await dm.wait(1200);

  check('the undo left the DM on the same track', await src(dm), dmSrc);
  check('and the player on the same one', await src(player), playerSrc);
  // The symptom, rather than the cause: a restore that re-pointed `src` would
  // have restarted the file, and a restore that cleared it would have stopped
  // it. Either shows up here as the DM no longer playing.
  check('and did not interrupt the DM hearing it', await paused(dm), false);
} else {
  note('nothing was undoable, so the restart check did not run');
}

// --- the player turns theirs on ----------------------------------------------
//
// The gesture. This browser was opened *without* the autoplay flag, so the
// click is the only thing that can start it — and if the click is not enough,
// the button has to say so rather than the page going quietly silent.

await soundTab(player);
await player.evaluate('document.getElementById("sound-toggle").click(); "ok"');
await player.wait(1200);

const playing = (await paused(player)) === false;
const shown = await speaker(player);
note(
  playing
    ? 'the player is hearing it'
    : `the player is blocked; lit and told: ${shown.blockedShown}`,
);
// Either outcome is correct; **silence with nothing on screen is the failure**,
// and it is the one this panel exists to make impossible. So the two branches
// are asserted separately rather than as one disjunction that a half-correct
// blocked state could still satisfy.
if (playing) {
  check('the player is hearing it, and the speaker says so', shown, {
    waves: true,
    cross: false,
    label: 'Turn the music off',
    blockedShown: false,
  });
} else {
  check('the player is told why not, in words as well as colour', shown, {
    waves: false,
    cross: true,
    label: 'Start the music',
    blockedShown: true,
  });
}
check(
  'and the preference was remembered for the reload a dropped socket causes',
  await player.evaluate(`localStorage.getItem('slate.sound.on')`),
  '1',
);

// --- stopping it -------------------------------------------------------------

await tableTab();
await dm.evaluate('document.getElementById("table-track-clear").click(); "ok"');
await dm.wait(1200);

check('the DM stopped', await paused(dm), true);
check('and nothing is loaded on the DM', await src(dm), null);
check('and the player stopped too', await paused(player), true);
check('with nothing loaded there either', await src(player), null);
check(
  'and the stop button went with it',
  await dm.evaluate('document.getElementById("table-track-clear").hidden'),
  true,
);
check(
  'and the panel went back to saying nothing is playing',
  await player.evaluate('document.getElementById("sound-now").textContent'),
  'nothing playing',
);

const failures = verdict(dm);
const alsoPlayer = player.errors.length > 0;
if (alsoPlayer) console.log(`the player's page logged errors: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(failures === 0 && !alsoPlayer ? 0 : 1);
