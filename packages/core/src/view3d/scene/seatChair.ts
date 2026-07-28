/**
 * The near-field seat: a three-box extruded silhouette (pedestal, pad, back)
 * and the per-seat facing that aims it at the stage.
 *
 * Why this exists at all: every seat in the venue was a camera-facing disc, and
 * a disc has no front. That is fine across a bowl and wrong at the one moment
 * the 3D view is selling — the buyer lands ON their seat and the row they are
 * sitting in is a line of coloured blobs rather than chairs. The renderer's own
 * programme notes call it the biggest visual gap at close range.
 *
 * What it deliberately is NOT: furniture. There are no armrests, no cushion
 * bevel, no legs. At 3–10 m what the eye needs is a pad at seat height and a
 * back rising behind it, facing the right way — the silhouette, not the detail.
 * Everything here is one instanced mesh over a 72-vertex base, because the third
 * draw call is the budget.
 */

/** Local-space part id, so the fragment stage can treat the three boxes apart. */
export const CHAIR_PART = { pedestal: 0, pad: 1, back: 2 } as const;

export interface ChairMesh {
  /**
   * Local vertex positions. x and z are in units of the seat's own chair
   * half-width (`iChairWidth`); y is in METRES and is not scaled.
   *
   * The split matters: a chart authored at a tight seat pitch needs narrower
   * chairs or they interpenetrate, but it does not need SHORTER ones — a tight
   * row is still full of adult-sized people. A uniform scale would have produced
   * a doll's-house block on exactly the densest charts.
   */
  position: Float32Array;
  normal: Float32Array;
  /** Per-vertex CHAIR_PART. */
  part: Float32Array;
  index: Uint16Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * A chair's half-width as a fraction of its seat's own spacing.
 *
 * NOT the dot's `SEAT_PITCH_FRACTION` (0.42), and the difference matters. That
 * constant exists to keep round dots visually separate, so it is deliberately
 * conservative and it is capped at SEAT_DOT_RADIUS_M on top. Sizing a chair from
 * it produced tall narrow slabs — a 0.34 m chair with a 0.95 m back, an aspect
 * ratio of nearly 3:1, which reads as a gravestone rather than as seating.
 *
 * Real auditorium seats very nearly touch: at a 0.53 m pitch (the measured mean)
 * a seat is about 0.48 m across. 0.44 reproduces that — the pair occupies 0.88
 * of the pitch and the remaining 12 % is the gap you actually see in a venue.
 */
export const CHAIR_PITCH_FRACTION = 0.44;

/**
 * Bounds on the resolved half-width, world metres.
 *
 * The floor is the honest compromise in this file. The amphitheatre measures a
 * 0.21 m minimum seat spacing, and at that spacing NO chair both fits between
 * its neighbours and reads as a chair — 21 cm is not a real seat pitch, it is a
 * chart authored tighter than the units claim. Given the choice between chairs
 * that overlap slightly and chairs that are legible, the overlap wins: it is
 * invisible from any angle a buyer actually looks from, whereas a 9 cm-wide
 * 0.95 m-tall slab is wrong from every angle. The ceiling stops a sparse box
 * seat from inflating into an armchair.
 */
export const CHAIR_HALF_WIDTH_MIN_M = 0.15;
export const CHAIR_HALF_WIDTH_MAX_M = 0.30;
/** Used when a seat has no resolvable neighbour at all. */
export const CHAIR_HALF_WIDTH_DEFAULT_M = 0.24;

/**
 * The world half-width of one seat's chair, from its own spacing in metres.
 *
 * Everything horizontal about the chair scales from this single number, so a
 * chair's depth tracks its width and the proportions hold at any pitch. Height
 * does not — see `ChairMesh.position`.
 */
export function chairHalfWidth(pitchM: number | undefined): number {
  if (pitchM === undefined || !Number.isFinite(pitchM) || pitchM <= 0) {
    return CHAIR_HALF_WIDTH_DEFAULT_M;
  }
  return Math.min(CHAIR_HALF_WIDTH_MAX_M, Math.max(CHAIR_HALF_WIDTH_MIN_M, pitchM * CHAIR_PITCH_FRACTION));
}

/**
 * Backward lean of the seat back, as a slope (metres of z per metre of rise).
 *
 * The first build had a vertical back and the result read as a crate: a flat top
 * face, a flat wall behind it, and nothing to say which way was up or which way
 * was forward. A rake is the cheapest possible chair cue — it costs a shear —
 * and it puts a lit face at an angle to every other surface in the venue, which
 * is what breaks the block up.
 *
 * Applied in the SHADER, in world metres, and deliberately not baked into the
 * base mesh. The mesh's x/z are in half-width units, so a lean baked there would
 * scale with the seat's width: the same chair would lean 20° on a wide-pitch
 * stadium row and 6° on a tight theatre row. 0.21 is about 12° from vertical,
 * which is roughly a real fixed auditorium seat.
 */
export const BACK_RAKE_SLOPE = 0.21;

/**
 * Air between the top of the pad and the bottom of the back, world metres.
 *
 * The other half of "crate vs chair". Two boxes sharing a face silhouette as one
 * solid; separate them and the eye reads a seat with a back behind it, even at
 * 10 m where the gap itself is barely a pixel — because it breaks the outline.
 */
const PAD_BACK_GAP_M = 0.05;

const PAD_TOP_M = 0.45;
/** World height at which the back starts, and therefore where the rake pivots. */
export const BACK_BASE_M = PAD_TOP_M + PAD_BACK_GAP_M;

/**
 * Chair dimensions. +Z is the direction the seat FACES, so the back panel lives
 * at negative z. x/z are half-width units; y is metres above the seat's own deck
 * point, chosen against the height contract the rest of the renderer uses — a
 * seated eye sits SEAT_EYE_ABOVE_DECK (1.02 m) up, so a 0.45 m pad and a 0.92 m
 * back top put the occupant's shoulders just over the seat back.
 */
const BOXES: Array<{
  part: number;
  min: [number, number, number];
  max: [number, number, number];
}> = [
  // Pedestal — a plain column under the pad. Without it the pad floats 0.36 m
  // over the deck and the row reads as hovering trays.
  { part: CHAIR_PART.pedestal, min: [-0.30, 0.00, -0.30], max: [0.30, 0.36, 0.30] },
  // Seat pad — a full seat width across and about as deep, which is what a real
  // one is. Its depth is bounded by the same pitch as its width, because the
  // pitch measure is the tighter of the in-row and row-to-row spacings, so a
  // tightly-raked tier cannot drive a pad into the back of the row in front.
  { part: CHAIR_PART.pad, min: [-1.00, 0.36, -0.95], max: [1.00, PAD_TOP_M, 1.00] },
  // Back panel — thin, raked, and the tallest thing in the row, so it is what
  // carries the state colour when you look along a row from behind.
  {
    part: CHAIR_PART.back,
    min: [-1.00, BACK_BASE_M, -1.00],
    max: [1.00, 0.92, -0.72],
  },
];

/** The six axis-aligned faces of a box, as (normal, corner order). */
const FACES: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
  // +X
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  // -X
  { n: [-1, 0, 0], c: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  // +Y
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  // -Y
  { n: [0, -1, 0], c: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  // +Z
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  // -Z
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * Build the shared chair base mesh. Called once per GPU scene; the result is
 * 72 vertices and 108 indices, i.e. ~1.7 KB of GPU memory total however many
 * seats the venue has.
 */
export function buildChairMesh(): ChairMesh {
  const vertexCount = BOXES.length * FACES.length * 4;
  const indexCount = BOXES.length * FACES.length * 6;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const part = new Float32Array(vertexCount);
  const index = new Uint16Array(indexCount);
  let v = 0;
  let t = 0;
  for (const box of BOXES) {
    for (const face of FACES) {
      const base = v;
      const corner3 = new Float32Array(12);
      for (let ci = 0; ci < 4; ci++) {
        const corner = face.c[ci];
        for (let a = 0; a < 3; a++) {
          corner3[ci * 3 + a] = corner[a] ? box.max[a] : box.min[a];
        }
      }
      // Face normal derived from the quad rather than asserted. The boxes are
      // axis-aligned today so this reproduces face.n exactly; deriving it means
      // a future non-axis-aligned part cannot ship silently mis-lit.
      const ax = corner3[3] - corner3[0], ay = corner3[4] - corner3[1], az = corner3[5] - corner3[2];
      const bx = corner3[6] - corner3[0], by = corner3[7] - corner3[1], bz = corner3[8] - corner3[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; }
      else { nx = face.n[0]; ny = face.n[1]; nz = face.n[2]; }
      // Keep the authored outward sense — the cross product's sign depends on
      // corner order, and a flipped normal would light the face from inside.
      if (nx * face.n[0] + ny * face.n[1] + nz * face.n[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (let ci = 0; ci < 4; ci++) {
        position[v * 3] = corner3[ci * 3];
        position[v * 3 + 1] = corner3[ci * 3 + 1];
        position[v * 3 + 2] = corner3[ci * 3 + 2];
        normal[v * 3] = nx;
        normal[v * 3 + 1] = ny;
        normal[v * 3 + 2] = nz;
        part[v] = box.part;
        v++;
      }
      index[t++] = base; index[t++] = base + 1; index[t++] = base + 2;
      index[t++] = base; index[t++] = base + 2; index[t++] = base + 3;
    }
  }
  return { position, normal, part, index, vertexCount, indexCount };
}

/**
 * Per-seat facing yaw, radians, such that the chair's local +Z points at what
 * the seat looks at.
 *
 * Derived from the ROW, not from the seat alone. Aiming every seat individually
 * at the focal point is the obvious rule and it is wrong for the commonest case:
 * a straight row in a theatre fans out into a shallow arc of chairs pointing
 * slightly inward, which no real auditorium does. Taking the row's local tangent
 * and turning perpendicular to it gives BOTH cases for free — a straight row
 * comes out uniformly forward, and a curved arena row keeps the genuine radial
 * fan it is built with.
 *
 * The focal only picks the SIGN (which of the two perpendiculars faces the
 * show), so a mis-authored focal can never rotate a row sideways, only flip it.
 * A row with a single seat has no tangent and falls back to facing the focal
 * directly.
 *
 * Row membership is read as RUNS of equal `rowId` rather than through a map:
 * expanded seats come out row-contiguous, the scan is O(n) with no allocation,
 * and a chart that somehow interleaved rows degrades to shorter runs rather than
 * to wrong answers.
 */
export function computeSeatYaw(
  iPosition: Float32Array,
  count: number,
  rowIdAt: (index: number) => string | undefined,
  focal: (index: number) => readonly [number, number],
): Float32Array {
  const yaw = new Float32Array(count);
  const px = (i: number): number => iPosition[i * 3];
  const pz = (i: number): number => iPosition[i * 3 + 2];

  let runStart = 0;
  const flushRun = (start: number, end: number): void => {
    // [start, end) share a rowId.
    const n = end - start;
    for (let i = start; i < end; i++) {
      const [fx, fz] = focal(i);
      let dx = fx - px(i);
      let dz = fz - pz(i);
      if (n >= 2) {
        // Central difference where possible; one-sided at the row ends.
        const a = Math.max(start, i - 1);
        const b = Math.min(end - 1, i + 1);
        const tx = px(b) - px(a);
        const tz = pz(b) - pz(a);
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-6) {
          // Perpendicular to the row, signed toward the focal.
          let nx = -tz / tl;
          let nz = tx / tl;
          if (nx * dx + nz * dz < 0) { nx = -nx; nz = -nz; }
          dx = nx;
          dz = nz;
        }
      }
      // atan2(x, z): the yaw that rotates local +Z onto (dx, dz).
      yaw[i] = (dx === 0 && dz === 0) ? 0 : Math.atan2(dx, dz);
    }
  };

  for (let i = 1; i <= count; i++) {
    if (i === count || rowIdAt(i) !== rowIdAt(runStart)) {
      flushRun(runStart, i);
      runStart = i;
    }
  }
  return yaw;
}
