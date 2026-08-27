// The board as a driver sees it: where the grid falls on screen, and which token
// is standing on a given square.
//
// This is the layer `cdp.mjs` deliberately is not. That file is the protocol and
// knows nothing about this project; everything in here knows about `#hud`,
// `#stage` and the DM's token panel. Keeping them apart is what lets the
// protocol wrapper stay the forty lines it claims to be.
//
// It exists because four drivers need to click a token they just built, and the
// obvious way to do it — click the middle of the canvas, since that is where a
// new token lands — is wrong twice over. A token lands in the first *free* cell
// out from the middle, which is the middle only when the middle happened to be
// free; and the middle of that cell is not the middle of the view, so at the
// zoom a whole dungeon is framed at the click lands on the token's edge and
// reads as a pan. Three drivers had that bug and it stayed invisible until
// `drive-staged.mjs`, which promotes a different map onto the board, ran first.
//
// The same rule has a second half that lives in the drivers rather than here,
// and it is worth stating in the same breath: a *pixel* reading is a difference
// too. How blue or how dark a stretch of board is depends on what the map was
// painted, so a threshold against zero measures the art. Read the box before,
// read it after, and assert on the change.
//
// Both halves are one rule: **a driver may not assume the map it was written
// against.** Measure the grid, click cells, and compare against what was already
// there.

/** One wheel notch, which is about 1.57× either way. */
const ZOOM_IN = -300;
const ZOOM_OUT = 300;

/**
 * Measures the grid on one client's screen, wheeling the zoom until it can work
 * at one.
 *
 * `reach` is how many cells out from the middle of the view the caller intends
 * to click, and `halo` is the widest pixel box it intends to read — together
 * they set how far in the zoom may go, because a cell wide enough to push
 * either off the canvas is no use however precisely it was measured. `smallest`
 * is the other end: below it a click meant for a token lands on its edge.
 *
 * **`zoom: false` measures and changes nothing**, and it is not a shortcut. A
 * driver that wants *distance* — a corner of the map the party's light has
 * never reached — wants the board framed wide, and zooming in to make a token
 * easy to click would pull that corner inside the vision radius and quietly
 * turn its sharpest check into a skip. Clicking a cell centre is exact at any
 * zoom, so precision is only ever needed by the callers that also need room.
 *
 * Throws rather than returning null. Nothing a driver checks after a failed
 * calibration means anything — see `latticeOrBail`.
 */
export async function lattice(session, { reach = 4, halo = 100, smallest = 45, zoom = true } = {}) {
  const stage = await session.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top),
             width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  const cx = stage.left + Math.round(stage.width / 2);
  const cy = stage.top + Math.round(stage.height / 2);

  /** The grid cell under a screen point, read off the HUD. Null off the canvas,
   *  which is the only place the client stops naming one. */
  const cellUnder = async (x, y) => {
    await session.move(x, y);
    await session.wait(60);
    const text = await session.evaluate('document.querySelector("#hud").textContent');
    const found = /cell (-?\d+), (-?\d+)/.exec(text);
    return found === null ? null : { x: Number(found[1]), y: Number(found[2]) };
  };

  /** One axis of that, which is all the calibration below ever wants. */
  const indexAt = async (axis, d) => {
    const cell = axis === 'x' ? await cellUnder(cx + d, cy) : await cellUnder(cx, cy + d);
    return cell === null ? null : cell[axis];
  };

  const biggest = Math.floor((Math.min(stage.width, stage.height) / 2 - halo / 2) / reach);
  if (zoom && biggest <= smallest) {
    throw new Error(`a ${stage.width} × ${stage.height} stage cannot hold ${reach} cells either side`);
  }

  /**
   * How many cell boundaries lie within reach along `axis`, and how far away.
   *
   * A *count*, and that is all it is. What lies between two HUD readings a span
   * apart is a floor rather than a ratio: crossing from cell 7 into cell 9 over
   * 400 pixels says a cell is somewhere between 133 and 400 of them, not that
   * it is 200. `calibrate` turns this into an exact size; on its own it says
   * only whether there is enough lattice in view to measure at all.
   */
  const reachAlong = async (axis) => {
    const near = await indexAt(axis, 0);
    if (near === null) throw new Error('the middle of the view is not over the canvas');
    // The span shrinks until it lands somewhere the HUD will still name a cell
    // for — off the canvas, or under the rail, it names none, and how far that
    // is depends on the window and on where the rail has pushed the stage.
    for (const span of [400, 300, 220, 160, 120]) {
      const far = await indexAt(axis, span);
      if (far !== null && far > near) return { span, near, crossed: far - near };
    }
    throw new Error(`could not measure ${axis} anywhere along the axis`);
  };

  const wheel = async (deltaY) => {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY,
    });
    await session.wait(150);
  };

  /** Where along the axis the cell index first reaches `target`, to the pixel.
   *  The index only ever grows along the axis, which is what makes halving the
   *  interval sound — nine probes is the whole cost of an exact answer. */
  const boundaryOf = async (axis, target, lo, hi) => {
    while (hi - lo > 1) {
      const mid = Math.round((lo + hi) / 2);
      const index = await indexAt(axis, mid);
      if (index !== null && index >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  /**
   * The lattice along one axis: how wide a cell is, and where one of them
   * starts.
   *
   * Measured between two *boundaries* a known number of cells apart, and not by
   * dividing a span by the number of cells it crossed. That division was the
   * bug this file was extracted to fix. The count is a floor, so it pins the
   * size down only to one part in that count: five cells to a span it is a few
   * percent out and every click still lands, two cells to a span it is out by
   * half. Which one you get depends on the map that happens to be loaded — so
   * the old code passed on the map it was written against and read a square
   * cell as 150 × 300 on the next one.
   */
  const calibrate = async (axis, found) => {
    const { span, near, crossed } = found ?? (await reachAlong(axis));
    if (crossed < 2) throw new Error(`only one ${axis} boundary in reach — cells too big to measure`);
    const first = await boundaryOf(axis, near + 1, 0, span);
    const last = await boundaryOf(axis, near + crossed, 0, span);
    const size = (last - first) / (crossed - 1);
    return { size, index: near + 1, at: (axis === 'x' ? cx : cy) + first + size / 2 };
  };

  /**
   * Wheels until a cell is a size the caller can work at, and returns the
   * lattice it settled on.
   *
   * Decided on the *exact* size rather than on the cheap count, so a zoom is
   * never accepted or rejected on the strength of a guess. Boundaries fewer
   * than two cells apart cannot be measured at all, which is not a failure but
   * the loudest possible way of being told to zoom out.
   */
  const settle = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const found = await reachAlong('x');
      if (found.crossed < 2) {
        await wheel(ZOOM_OUT);
        continue;
      }
      const measured = await calibrate('x', found);
      if (measured.size >= smallest && measured.size <= biggest) return measured;
      await wheel(measured.size > biggest ? ZOOM_OUT : ZOOM_IN);
    }
    throw new Error(`could not settle a cell between ${smallest} and ${biggest} pixels`);
  };

  const gx = zoom ? await settle() : await calibrate('x');
  const gy = await calibrate('y');
  // A cell is square by construction — one `grid_px` serves both axes — so two
  // different answers here are two wrong answers, and every click after this
  // would land somewhere the caller did not mean. Fifteen mystery failures
  // further down is a much worse way to be told.
  if (Math.abs(gx.size - gy.size) > 0.05 * gx.size) {
    throw new Error(`the lattice came out ${gx.size.toFixed(1)} × ${gy.size.toFixed(1)}, and a cell is square`);
  }

  const screenOfCell = (i, j) => [
    Math.round(gx.at + (i - gx.index) * gx.size),
    Math.round(gy.at + (j - gy.index) * gy.size),
  ];

  const origin = await cellUnder(cx, cy);
  const showing = (await session.evaluate('document.querySelector("#hud").textContent'))
    .trim()
    .split('·')[0]
    .trim();

  return {
    size: gx.size,
    origin,
    stage,
    /** The middle of the canvas, which is what a driver's pixel offsets are
     *  measured from when it has a reason to keep thinking in pixels. */
    middle: { x: cx, y: cy },
    cellUnder,
    screenOfCell,

    /** Whether a cell is somewhere a click would actually reach, `pad` pixels
     *  clear of the edge. Two clients frame the same board differently, so a
     *  cell that is comfortably on one screen can be off the other. */
    onScreen(i, j, pad = 0) {
      const [x, y] = screenOfCell(i, j);
      return (
        x - pad >= stage.left &&
        y - pad >= stage.top &&
        x + pad <= stage.left + stage.width &&
        y + pad <= stage.top + stage.height
      );
    },

    /** One line for the driver to `note`, so a run's log says what it measured
     *  and every later coordinate in it can be read back. */
    describe: `a cell is ${gx.size.toFixed(1)} px at ${showing}, the middle of the view is cell ${origin.x},${origin.y}`,
  };
}

/**
 * `lattice`, or a printed reason and a clean exit.
 *
 * Every check after a bad calibration is noise, and an uncaught throw leaves
 * the browsers holding the debug ports — which is what makes the *next* run
 * attach to a stale page and hang. `closing` is every session to shut on the
 * way out.
 */
export async function latticeOrBail(session, closing, options = {}) {
  try {
    return await lattice(session, options);
  } catch (error) {
    console.log(`\nFAILED TO CALIBRATE: ${error.message}`);
    for (const open of closing) open.close();
    process.exit(1);
  }
}

/**
 * Clicks the middle of a cell and returns the name of the token that selected,
 * or null.
 *
 * The panel is put into creation mode first, so an empty box means *this* click
 * selected nothing rather than the last token's name still sitting in it. It
 * reads the form's value rather than the panel, so which rail tab is open does
 * not matter — a board click has not opened one since the strip became the DM's
 * alone — but it does move the selection and clear the form, which is why a
 * driver asserting about either does its looking first.
 */
export async function tokenAt(session, grid, cell) {
  await session.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    return 'ok';
  })()`);
  await session.wait(120);
  const [x, y] = grid.screenOfCell(cell.x, cell.y);
  await session.click(x, y);
  await session.wait(250);
  const name = await session.evaluate('document.getElementById("token-name").value');
  return name === '' ? null : name;
}

/** The cells at exactly `ring` steps out from `centre`, nearest side first. */
function* ring(centre, distance) {
  for (let dx = -distance; dx <= distance; dx++) {
    for (let dy = -distance; dy <= distance; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== distance) continue;
      yield { x: centre.x + dx, y: centre.y + dy };
    }
  }
}

/**
 * Where a token this script built actually landed.
 *
 * Outward from the middle of the view in rings, because the server puts a new
 * token in the first *free* cell out from there — which is the middle only when
 * the middle was free, and whether it was is a fact about whatever map and
 * whatever party this room happens to hold.
 */
export async function findToken(session, grid, name, { from = grid.origin, radius = 3 } = {}) {
  for (let distance = 0; distance <= radius; distance++) {
    for (const cell of ring(from, distance)) {
      if ((await tokenAt(session, grid, cell)) === name) return cell;
    }
  }
  return null;
}

/**
 * A cell near `from` with nothing standing on it and room to measure around it.
 *
 * For the checks that need a patch of bare board — a ping has to be made
 * somewhere a hold cannot grab a creature, and a pixel box has to hold still
 * for reasons other than the one being asserted. Where the party are standing
 * is a property of the room, so it is looked for rather than assumed.
 */
export async function emptyCell(session, grid, from, radius = 4) {
  for (let distance = 0; distance <= radius; distance++) {
    for (const cell of ring(from, distance)) {
      if (!grid.onScreen(cell.x, cell.y, 60)) continue;
      if ((await tokenAt(session, grid, cell)) === null) return cell;
    }
  }
  return null;
}
