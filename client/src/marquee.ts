import type { Vec2 } from './coords.js';
import { gridToWorld } from './coords.js';
import type { Identity } from './identity.js';
import { canMove } from './identity.js';
import type { Scene } from './scene.js';
import { shownBoard, shownPos } from './scene.js';

/**
 * The tokens a box dragged from `from` to `to` gathers, in draw order.
 *
 * The box is in world coordinates, as drawn, so it is a rectangle on screen
 * over an isometric grid as well as a square one. A token is in if its centre
 * is, however much of its body hangs outside.
 *
 * Membership is what `tokenAt` in input.ts asks of a click: tokens this client
 * can't move are skipped, so a player's box gathers only their own and the
 * group needs no permission rule of its own. Positions are `shownPos`, so over
 * a preview the box gathers the staged plans, and a token with no place on the
 * board on screen isn't in it.
 */
export function inMarquee(scene: Scene, identity: Identity, from: Vec2, to: Vec2): string[] {
  const grid = shownBoard(scene).grid;
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);

  const ids: string[] = [];
  for (const token of scene.tokens) {
    if (!canMove(identity, token)) continue;
    const at = shownPos(scene, token);
    if (at === null) continue;
    const centre = gridToWorld(grid, at.x, at.y);
    if (centre.x >= left && centre.x <= right && centre.y >= top && centre.y <= bottom) {
      ids.push(token.id);
    }
  }
  return ids;
}
