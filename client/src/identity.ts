// Who this browser is. Not authentication (this is a private game among
// friends), just enough to survive a refresh without orphaning a token.

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
 * **Scoped by room.** A player in two campaigns has two slugs (the same person
 * is `cleodara` in one room and somebody else in the other), so a single key
 * would hold the wrong answer for whichever room they opened second. It
 * wouldn't leak anything, since the server refuses a slug that names no slot in
 * the room being joined, but it would send them back to the picker every time
 * they switched.
 */
function playerKey(roomId: string): string {
  return `slate.player_id.${roomId}`;
}

/**
 * The key from before there were several rooms.
 *
 * Read as a fallback so that players who picked a character before rooms were
 * scoped don't have to pick again. This is invariant 2 applied to the
 * browser's own state instead of the save file. It is only ever read: the
 * first `Welcome` writes the scoped key, and after that nothing consults this
 * one.
 *
 * It is safe against the wrong room because the server decides. A campaign
 * slug offered to the one-shot names no slot in that room's roster, so `hello`
 * answers with the picker, which is what a player with no stored id gets
 * anyway. It can never admit somebody as somebody else.
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
 * Whether this token *belongs* to you, which isn't the same as being able to
 * move it. The DM can move everything, so a ring on everything would tell the
 * DM nothing; the ring marks the DM's own monsters instead.
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
    // the picker every load is better than a crash.
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
    // Otherwise "switch" would hand the old choice straight back on the next
    // load.
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
 * Reads `?room=<id>` and leaves it in the address bar, unlike `takeDmSecret`
 * below.
 *
 * A DM secret is a credential and is stripped immediately. A room id isn't one:
 * the server checks it against `ROOMS` and returns a 404 for anything else, and
 * knowing a room exists gets you no further than the picker already does.
 * Keeping it in the URL gives the DM a link that opens straight into the
 * one-shot, and lets a driver skip the picker.
 *
 * A URL that names a room beats the remembered one and replaces it.
 */
export function takeRoomFromUrl(): string | null {
  return new URL(location.href).searchParams.get('room');
}

/**
 * Where the DM secret lives once it has been taken out of the address bar.
 *
 * **`localStorage`, not `sessionStorage`.** Don't switch it to per-tab
 * storage: `sessionStorage` survives `location.reload()` (the reconnect) and
 * nothing else, so a DM who opens their bookmark or a new tab when the board
 * goes stale lands on the character picker. That happened on the Pi.
 *
 * The cost: the secret sits in the DM's browser until site data is cleared, so
 * anyone with that browser profile opens the room as the DM. That is
 * acceptable here because `.claude/CLAUDE.md` says this is a private game among
 * friends and not to build real authentication, and the unguessable subdomain
 * is the deployment's access control. A DM sharing a browser profile with a
 * player needs a separate profile, not a login.
 */
const DM_SECRET_KEY = 'slate.dm_secret';

/**
 * The DM secret for this browser: from `?dm=<secret>` if the link carried one,
 * otherwise from the one it was already holding.
 *
 * **The secret is always stripped from the address bar.** The DM screen-shares
 * constantly, so a secret in the URL is one alt-tab away from being shown to
 * the table. Storage isn't on screen, so remembering it there doesn't weaken
 * that.
 *
 * Storing it is what makes the reconnect work. `net.ts` recovers from a
 * dropped socket by calling `location.reload()`, and a secret kept only in a
 * closure wouldn't survive it: the DM's page would drop to the character
 * picker mid-session.
 *
 * A URL beats what is stored, so a DM opening a fresh link is never handed a
 * stale secret by a browser that held an old one.
 */
export function takeDmSecret(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('dm');
  if (fromUrl !== null) {
    url.searchParams.delete('dm');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    try {
      localStorage.setItem(DM_SECRET_KEY, fromUrl);
    } catch {
      // Private browsing modes can throw, as above. All that is lost is coming
      // back as the DM after a reload; this load is fine.
    }
    return fromUrl;
  }

  try {
    return localStorage.getItem(DM_SECRET_KEY);
  } catch {
    return null;
  }
}
