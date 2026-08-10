// The same client joined as a player, checking that the DM's half is absent
// rather than merely hidden.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-player.mjs                    # or: ... http://host:port
//
// This one reads more than it writes: it claims a roster slot and then looks at
// what it was given. It is the counterpart to drive-ui.mjs and the more
// important of the two, because everything it asserts is a thing that would be
// invisible if it broke — a player is not going to notice, or report, that
// their client is holding the dungeon's floor plan.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000'] = process.argv;

const session = await open(base, { port: 9334 });
const { evaluate, wait } = session;
const { check, verdict } = checks();

await wait(2000);

check('the picker is offered', await evaluate('!document.querySelector("#picker").hidden'), true);
await evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await wait(1500);

check('joined as a player', await evaluate('document.querySelector("#whoami-name").textContent'), 'Saelyn');

// The DM's panels are not built on this connection at all — they are not
// styled away, they were never created.
check('no wall panel', await evaluate('document.querySelector("#walltool").hidden'), true);
check('no map panel either', await evaluate('document.querySelector("#maptool").hidden'), true);
check('no token panel', await evaluate('document.querySelector("#tokentool").hidden'), true);
check('the draw panel is still theirs', await evaluate('!document.querySelector("#drawtool").hidden'), true);
check('nothing can arm tracing', await evaluate('document.body.classList.contains("tracing")'), false);

// The board has to still be running: a player's scene carries an empty wall
// list, and anything that assumed otherwise would have thrown by now.
check('the board is drawing', await evaluate('document.querySelector("#hud").textContent.length > 0'), true);

session.close();
process.exit(verdict(session));
