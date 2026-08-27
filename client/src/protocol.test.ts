/**
 * The client's half of the protocol drift check. `server/src/protocol.rs` holds
 * the other.
 *
 * The two wire unions are written out by hand twice, once per language, and
 * nothing generates either from the other — so a variant added on one side and
 * forgotten on the other used to surface as a `console.warn` in a browser and
 * nowhere else. `protocol-tags.json` is a third copy that both sides are
 * measured against, and the enforcement on this side is `Record<Msg['type'],
 * true>`: a variant added to the union stops this file typechecking until it is
 * named below, exactly as the exhaustive `match` does in Rust.
 *
 * **Variant-level only.** A renamed field keeps its tag and passes — see the
 * note in the fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClientMsg, ServerMsg } from './protocol.js';

/** `protocol-tags.json`, injected by `test.mjs` at bundle time.
 *
 *  The fixture is shared with the server, so it sits at the repo root — outside
 *  `tsconfig`'s `include`. Reading it here would mean `node:fs` and so
 *  `@types/node`, which is a dependency for one string. */
declare const __PROTOCOL_TAGS__: { client: string[]; server: string[] };
const tags = __PROTOCOL_TAGS__;

/** The compiler is the point of these two. A missing key is an error, and so is
 *  a key that is not a member of the union. */
const CLIENT_TAGS: Record<ClientMsg['type'], true> = {
  add_shape: true,
  add_walls: true,
  clear_initiative: true,
  clear_shapes: true,
  clear_staged: true,
  clear_walls: true,
  create_token: true,
  delete_token: true,
  hello: true,
  move_cursor: true,
  move_token: true,
  next_turn: true,
  ping: true,
  previous_turn: true,
  promote_staged: true,
  remove_from_initiative: true,
  remove_shape: true,
  remove_wall: true,
  reset_fog: true,
  say: true,
  set_backdrop: true,
  set_colour: true,
  set_diagonals: true,
  set_fog_override: true,
  set_initiative: true,
  set_map: true,
  set_notes: true,
  set_show_cursors: true,
  set_show_dm_cursor: true,
  set_show_names: true,
  sketch: true,
  toggle_door: true,
  undo: true,
  update_token: true,
};

const SERVER_TAGS: Record<ServerMsg['type'], true> = {
  backdrop_changed: true,
  choose_identity: true,
  colours_changed: true,
  cursor_moved: true,
  cursors_changed: true,
  diagonals_changed: true,
  dm_cursor_changed: true,
  error: true,
  fog_changed: true,
  initiative_changed: true,
  map_changed: true,
  names_changed: true,
  notes_changed: true,
  overrides_changed: true,
  pinged: true,
  presence: true,
  restored: true,
  said: true,
  shapes_changed: true,
  sketch: true,
  sketch_ended: true,
  staged_changed: true,
  token_changed: true,
  token_moved: true,
  token_removed: true,
  undo_changed: true,
  walls_changed: true,
  welcome: true,
};

test('every client command the server knows is one this client can send', () => {
  assert.deepEqual(Object.keys(CLIENT_TAGS).sort(), [...tags.client].sort());
});

test('every frame the server can send is one this client handles', () => {
  assert.deepEqual(Object.keys(SERVER_TAGS).sort(), [...tags.server].sort());
});
