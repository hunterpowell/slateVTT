/**
 * The DM's fog panel: a switch and a radius.
 *
 * Two controls, and deliberately no third. Fog is per map — a dungeon wants it
 * and the meadow outside does not — and both fields live on `MapInfo`, which is
 * why neither is a command of its own: they go out as a `set_map` through the map
 * tool, which owns the confirmed calibration and is the one place that builds
 * that frame. A `set_fog` would be a second way to write one map, and two writers
 * for one record is how they come to disagree.
 *
 * There is nothing to arm and nothing to put down, unlike the wall and map
 * panels. Fog is not a tool: the party's tokens are what move it, and the DM
 * chooses how far they see rather than where.
 *
 * The panel is inert while previewing, for the reason the wall editor is: the
 * bitsets belong to the live board, the staged map has none, and a panel sitting
 * there looking usable over a map it cannot change is the same lie.
 *
 * Read `docs/fog.md` before changing what this sends.
 */

import type { Scene } from './scene.js';

/** Matches `MIN_VISION_FT` and `MAX_VISION_FT` on the server, which re-checks. */
const MIN_VISION_FT = 5;
const MAX_VISION_FT = 500;
/** The step the buttons move by: one cell, which is the unit that matters. */
const STEP_FT = 5;

export interface FogToolUi {
  root: HTMLElement;
  on: HTMLInputElement;
  vision: HTMLInputElement;
  visionDown: HTMLButtonElement;
  visionUp: HTMLButtonElement;
  hint: HTMLElement;
}

export interface FogTool {
  /**
   * Called on Welcome, on every map_changed, and when a preview starts or ends.
   *
   * The only method. There is no `stop()`, and its absence is the point: the
   * rail calls that to put down whatever a panel armed, and this panel arms
   * nothing — the party's tokens are what move the fog.
   */
  update(scene: Scene): void;
}

export function createFogTool(
  ui: FogToolUi,
  /** Sends the two fields as part of a whole `set_map` for the live slot. */
  setFog: (on: boolean, visionFt: number) => void,
): FogTool {
  let scene: Scene | null = null;

  const clamp = (ft: number): number => {
    if (!Number.isFinite(ft)) return MIN_VISION_FT;
    return Math.min(Math.max(Math.round(ft), MIN_VISION_FT), MAX_VISION_FT);
  };

  const paint = (): void => {
    const board = scene?.live ?? null;
    const previewing = scene?.previewing ?? false;

    ui.on.checked = board?.fog ?? false;
    ui.on.disabled = previewing;
    ui.vision.value = String(board?.visionFt ?? 60);
    // Read-only rather than hidden when fog is off: the radius is still the
    // map's, and hiding it would make turning fog on look like it had also
    // invented a number.
    const locked = previewing || !(board?.fog ?? false);
    for (const control of [ui.vision, ui.visionDown, ui.visionUp]) {
      control.disabled = locked;
    }

    ui.hint.textContent = previewing
      ? 'The map being prepared has no fog of its own — promote it first.'
      : board?.fog === true
        ? `Player tokens light ${ui.vision.value} ft, and walls and shut doors stop it.`
        : 'The table sees the whole board.';
  };

  const send = (): void => {
    const board = scene?.live;
    if (board === undefined || (scene?.previewing ?? false)) return;
    setFog(ui.on.checked, clamp(Number(ui.vision.value)));
  };

  ui.on.addEventListener('change', send);
  // `change` rather than `input`: typing 1 on the way to 100 would otherwise
  // send a radius nobody asked for and recompute the whole board for it. Same
  // split the grid colour slider makes, and for the same reason.
  ui.vision.addEventListener('change', send);

  const nudge = (by: number): void => {
    ui.vision.value = String(clamp(Number(ui.vision.value) + by));
    send();
  };
  ui.visionDown.addEventListener('click', () => nudge(-STEP_FT));
  ui.visionUp.addEventListener('click', () => nudge(STEP_FT));

  return {
    update(next) {
      scene = next;
      paint();
    },
  };
}
