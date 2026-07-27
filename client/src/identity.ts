// Who this browser is. Not authentication — a private game among friends — just
// enough to survive a refresh without orphaning a token.

import type { Owner } from './protocol.js';
import type { Token } from './scene.js';

const STORAGE_KEY = 'slate.player_id';

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

export function readStoredPlayerId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing modes can throw on localStorage access. Falling back to
    // the picker every load is worse than a crash only in theory.
    return null;
  }
}

export function storePlayerId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    console.warn('could not remember your character; you will be asked again next load');
  }
}

export function forgetPlayerId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Reads `?dm=<secret>` and immediately strips it from the address bar. The DM
 * screen-shares constantly; a secret sitting in the URL is one alt-tab away
 * from being handed to the table.
 */
export function takeDmSecretFromUrl(): string | null {
  const url = new URL(location.href);
  const secret = url.searchParams.get('dm');
  if (secret === null) return null;

  url.searchParams.delete('dm');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return secret;
}
