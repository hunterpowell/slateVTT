// Who this browser is. Not authentication — a private game among friends — just
// enough to survive a refresh without orphaning a token.

import type { Owner } from './protocol.js';
import type { Token } from './scene.js';

/**
 * Which room this browser last played in.
 *
 * One value, unlike the key below it: you are in one room at a time, and the
 * one you were last in is the one to open again.
 */
const ROOM_KEY = 'slate.room';

/**
 * The slot claimed in one particular room.
 *
 * **Scoped by room, which is the fiddly half of multi-room on this side.** A
 * player in two campaigns is two slugs — the same person is `cleodara` in one
 * room and somebody else in the other — so one key could only hold the wrong
 * answer for whichever room they opened second. The server refuses a slug that
 * names no slot in the room being joined, so a single key would not have leaked
 * anything; it would just have sent them back to the picker every time they
 * switched.
 */
function playerKey(roomId: string): string {
  return `slate.player_id.${roomId}`;
}

/**
 * What this key was called when there was one room.
 *
 * Read as a fallback so that six people do not each have to find themselves
 * again on the first evening after multi-room lands — invariant 2's argument
 * applied to the browser's own state rather than the save file's. It is only
 * ever *read*: the first `Welcome` writes the scoped key, and from then on this
 * one is dead weight in `localStorage` that nothing consults.
 *
 * It is safe against the wrong room because the server is the thing that
 * decides. A campaign slug offered to the one-shot names no slot in that room's
 * roster, so `hello` answers with the picker — which is what a player with no
 * stored id gets anyway. There is no case where this admits somebody as
 * somebody else.
 */
const LEGACY_PLAYER_KEY = 'slate.player_id';

export interface Identity {
  isDm: boolean;
  /** The roster slot this browser claimed, or null for the DM. */
  playerId: string | null;
}

export const ANONYMOUS: Identity = { isDm: false, playerId: null };

/**
 * Mirrors `can_move` in server/src/room.rs. The server is authoritative and
 * re-checks every command; this exists only so the UI can show what is yours
 * before you try to drag it.
 */
export function canMove(identity: Identity, token: Token): boolean {
  if (identity.isDm) return true;
  return isOwnedBy(token.owner, identity.playerId);
}

/**
 * Whether this token *belongs* to you, which is not the same as being able to
 * move it. The DM can move everything, so ringing everything told the DM
 * nothing; the ring marks the DM's own monsters instead.
 */
export function ownsToken(identity: Identity, token: Token): boolean {
  if (identity.isDm) return token.owner.kind === 'dm';
  return isOwnedBy(token.owner, identity.playerId);
}

function isOwnedBy(owner: Owner, playerId: string | null): boolean {
  return playerId !== null && owner.kind === 'player' && owner.id === playerId;
}

export function readStoredPlayerId(roomId: string): string | null {
  try {
    return localStorage.getItem(playerKey(roomId)) ?? localStorage.getItem(LEGACY_PLAYER_KEY);
  } catch {
    // Private browsing modes can throw on localStorage access. Falling back to
    // the picker every load is worse than a crash only in theory.
    return null;
  }
}

export function storePlayerId(roomId: string, id: string): void {
  try {
    localStorage.setItem(playerKey(roomId), id);
  } catch {
    console.warn('could not remember your character; you will be asked again next load');
  }
}

export function forgetPlayerId(roomId: string): void {
  try {
    localStorage.removeItem(playerKey(roomId));
    // Or "switch" would hand the picker's choice straight back on the next load.
    localStorage.removeItem(LEGACY_PLAYER_KEY);
  } catch {
    /* nothing to do */
  }
}

export function readStoredRoom(): string | null {
  try {
    return localStorage.getItem(ROOM_KEY);
  } catch {
    return null;
  }
}

export function storeRoom(id: string): void {
  try {
    localStorage.setItem(ROOM_KEY, id);
  } catch {
    console.warn('could not remember the room; you will be asked again next load');
  }
}

export function forgetRoom(): void {
  try {
    localStorage.removeItem(ROOM_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Reads `?room=<id>` and **leaves it in the address bar**, which is the whole
 * difference between this and the function below.
 *
 * A DM secret is a credential and is stripped on sight. A room id is not one —
 * the server checks it against `ROOMS` and hands back a 404 for anything else,
 * and knowing a room exists gets you no further than the picker already does.
 * What a URL that keeps it buys is a link the DM can send the table that opens
 * straight into the one-shot, and a driver that can skip the picker.
 *
 * A URL that names a room beats the remembered one and replaces it.
 */
export function takeRoomFromUrl(): string | null {
  return new URL(location.href).searchParams.get('room');
}

/**
 * Where the DM secret lives once it has been taken out of the address bar.
 *
 * **`sessionStorage`, not `localStorage`**, and the difference is the whole
 * decision. It dies with the tab, so it survives exactly one thing —
 * `location.reload()` — and that is the case this exists for. Nothing outlives
 * the evening, and closing the tab is how you stop being the DM.
 */
const DM_SECRET_KEY = 'slate.dm_secret';

/**
 * The DM secret for this tab: from `?dm=<secret>` if the link carried one,
 * otherwise from the one this tab was already holding.
 *
 * **The strip is unchanged and is still the point.** The DM screen-shares
 * constantly, so a secret sitting in the URL is one alt-tab away from being
 * handed to the table — and `sessionStorage` is not on screen, so remembering
 * it there costs that argument nothing.
 *
 * **What it buys is the reconnect.** `net.ts` comes back from a dropped socket
 * by calling `location.reload()`, and a secret that lived only in a closure did
 * not survive one: the DM's own page reloaded mid-session and landed on the
 * character picker. `docs/rooms.md` carried that as a known bug for a milestone.
 *
 * **A URL wins over what is stored**, so a DM opening a fresh link is never
 * handed a stale secret by a tab that had one earlier.
 */
export function takeDmSecret(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('dm');
  if (fromUrl !== null) {
    url.searchParams.delete('dm');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    try {
      sessionStorage.setItem(DM_SECRET_KEY, fromUrl);
    } catch {
      // Private browsing modes can throw, exactly as they can above. All that
      // is lost is coming back as the DM after a reload; this load is fine.
    }
    return fromUrl;
  }

  try {
    return sessionStorage.getItem(DM_SECRET_KEY);
  } catch {
    return null;
  }
}
