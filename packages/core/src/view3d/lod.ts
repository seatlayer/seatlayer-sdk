/**
 * The seat level-of-detail ladder.
 *
 * Three rungs, all driven by how far a seat is from the CAMERA rather than by a
 * global switch, so one venue can be showing all three at once — chairs in the
 * row you are sitting in, dots across the bowl, a dissolving tint on the far
 * side:
 *
 *   near (≤ CHAIR_FULL_M)   extruded chair silhouettes  (scene/seatChair.ts)
 *   band (…CHAIR_NONE_M)    chair scales in / dot fades out — no pop
 *   far                     the instanced billboard dot, as before
 *
 * Everything below is pure so the thresholds can be reasoned about (and tested)
 * without a GL context. The shaders re-derive the same weight per instance from
 * view depth; these constants are the single source both sides read.
 */

export interface SeatLod {
  /** Multiplier on the seat world radius (1 = full). */
  scale: number;
  /** Fade toward the tier/fade colour (0 = pure state colour). */
  fade: number;
  /**
   * Minimum screen size a dot is allowed to demand, in pixels.
   *
   * The shader holds this floor by GROWING a dot's world radius with depth, and
   * that growth is what smears neighbouring rows into one mass at range: measured
   * mean seat spacing is 0.53–0.58 m against a 0.44 m dot diameter, so a dot only
   * has to grow ~20 % before it touches its neighbour. `iMaxRadius` caps each dot
   * at its own pitch, but a capped dot then sits at its ceiling across the whole
   * far half of the venue, which is exactly the solid-mass look.
   *
   * So the DEMAND is tapered as well as the growth capped. Past the far knee the
   * requested floor relaxes toward SEAT_MIN_PIXELS_FAR, the dots stop pressing
   * against their ceilings, and the gap between rows survives to the back wall.
   * Legibility past that point is the tier tint's job, not the dot's — which is
   * what `fade` above is for.
   */
  minPixels: number;
}

/** Pixel floor a dot demands in the near/mid field — unchanged from v1. */
export const SEAT_MIN_PIXELS_NEAR = 2.5;
/**
 * Pixel floor a dot demands at full distance.
 *
 * Not zero: a dot that demands nothing shrinks below a pixel, aliases, and
 * shimmers as the camera moves. 1.15 keeps a sub-pixel dot anchored while
 * leaving it far enough under its pitch ceiling that its neighbour stays
 * separate. The fragment stage already dissolves anything that cannot afford
 * even this (`vBudget`).
 */
export const SEAT_MIN_PIXELS_FAR = 1.15;

/**
 * View depth, in metres, at or below which a seat draws as a full chair.
 *
 * 12 m is roughly "the far end of your own block". At the arrival pose the
 * camera sits at the seat, so the whole neighbourhood a buyer is actually
 * looking at is inside this.
 */
export const CHAIR_FULL_M = 12;

/**
 * View depth at and beyond which a seat is a dot again.
 *
 * The 10 m band between this and CHAIR_FULL_M is the transition. It is wide on
 * purpose: the fly-to-seat cinematic crosses it in well under a second, and a
 * narrow band would read as a wave of furniture sweeping over the venue.
 */
export const CHAIR_NONE_M = 22;

/**
 * Radius, in metres, of the CPU gather that decides which seats are handed to
 * the chair mesh at all.
 *
 * Strictly greater than CHAIR_NONE_M + CHAIR_REBUILD_M. That inequality is the
 * whole no-pop argument: a seat always enters the instanced set while it is
 * still beyond the fade band (weight 0, drawn as nothing), so by the time it is
 * close enough to be visible it has already been in the set for a while. A seat
 * can never blink into existence mid-band, whatever the camera does between two
 * gathers. `chairGatherCoversFadeBand()` asserts it.
 */
export const CHAIR_GATHER_M = 30;

/**
 * How far the camera may travel before the gathered set is rebuilt.
 *
 * The gather is the only per-frame CPU cost the near field adds, so it is not
 * run per frame. 4 m against an 8 m slack (GATHER − NONE) leaves a 2× margin.
 */
export const CHAIR_REBUILD_M = 4;

/**
 * Hard ceiling on instances handed to the chair mesh.
 *
 * The cap is what makes the near field's cost bounded rather than proportional
 * to venue size, and seats are gathered nearest-first, so it only ever drops the
 * OUTER edge of the disc.
 *
 * Its value is not a round number picked for comfort — it is sized against
 * measured venue density, because a cap that bites inside the fade band would
 * silently reintroduce popping on exactly the biggest venues. Worst-case seats
 * within a radius, measured by standing on 60 sampled seats of each shipped
 * chart:
 *
 *            21 m    26 m    30 m
 *   megaStadium   4,278   5,905   7,297
 *   uberArena     2,670   3,690   4,585
 *   amphitheatre  2,326   2,873   3,211
 *
 * megaStadium's figures fell slightly when its ROW_GAP went 28 → 30 to clear the
 * corner-row spacing floor (see `src/core/megaStadium.ts`): rows further apart
 * is strictly less dense, so the headroom below only grew.
 *
 * The binding requirement is that the kept disc still reach CHAIR_NONE_M +
 * CHAIR_REBUILD_M (26 m), which megaStadium meets at 5,905. An earlier 4,096
 * capped megaStadium's disc at roughly 22 m — inside that margin, and the defect
 * would only ever have shown up on the largest chart. 8,192 leaves ~30 % headroom
 * for a denser chart than any shipped today. `chairCapCoversFadeBand()` is the
 * executable form of this.
 */
export const CHAIR_MAX_INSTANCES = 8192;

/**
 * The near/far ladder invariant, as a value rather than a comment.
 *
 * Exported so the test suite asserts the actual constants instead of restating
 * them: if someone widens the fade band or slows the rebuild without widening
 * the gather, seats start popping in mid-band and this goes false.
 */
export function chairGatherCoversFadeBand(): boolean {
  return CHAIR_GATHER_M > CHAIR_NONE_M + CHAIR_REBUILD_M;
}

/** The radius the gathered set must still reach after the cap has bitten. */
export const CHAIR_REQUIRED_COVER_M = CHAIR_NONE_M + CHAIR_REBUILD_M;

/**
 * Does a venue holding `seatsWithinRequiredCover` seats inside
 * CHAIR_REQUIRED_COVER_M still get every one of them into the capped set?
 *
 * The companion to `chairGatherCoversFadeBand`. That one checks the RADIUS is
 * generous enough; this checks the CAP is, which is the failure mode that only
 * appears on the densest chart and is therefore the one most likely to ship.
 */
export function chairCapCoversFadeBand(seatsWithinRequiredCover: number): boolean {
  return seatsWithinRequiredCover <= CHAIR_MAX_INSTANCES;
}

/** GLSL `smoothstep`, so the JS side and the shaders agree exactly. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much chair a seat at `depth` metres of view depth shows: 1 = full
 * silhouette, 0 = nothing drawn (the dot carries it).
 *
 * The chair SCALES IN rather than fading in. A cross-fade would need the chairs
 * to be transparent through the whole band, and a transparent chair either
 * writes depth (and punches holes in the chairs behind it) or does not (and
 * shows its own back panel through its own seat pad). Growing an OPAQUE chair
 * out of the seat point has neither problem, and it lands where the dot already
 * is: at weight 0 the chair is a zero-size nub exactly at the seat centre, under
 * a dot at full opacity.
 *
 * Mirrored in CHAIR_VERT / SEAT_VERT — keep the three in step.
 */
export function chairWeight(depth: number): number {
  return 1 - smoothstep(CHAIR_FULL_M, CHAIR_NONE_M, depth);
}

/** The dot's share of a seat: the exact complement of `chairWeight`. */
export function dotWeight(depth: number): number {
  return 1 - chairWeight(depth);
}

/**
 * The chair's linear size at `depth`, as a fraction of full size.
 *
 * NOT the same curve as `chairWeight`, and the difference is what the middle of
 * the band actually looks like. Scaling linearly with the weight put a
 * quarter-size chair inside a full-opacity dot for most of the crossover: the
 * dot is ~0.44 m across and holds its size until it is handed over, so a chair
 * at 25 % read as a speck floating inside a blob rather than as a seat.
 *
 * The square root front-loads the growth — half a weight is 71 % of full size —
 * so by the time the dot has faded to half, the chair underneath it is nearly
 * the same size and the two genuinely overlay each other. It still passes
 * through exactly 0 at CHAIR_NONE_M, so nothing pops into existence.
 */
export function chairScale(depth: number): number {
  return Math.sqrt(chairWeight(depth));
}

export function computeSeatLod(distance: number, radius: number): SeatLod {
  const near = radius * 1.4;
  const far = radius * 3.2;
  if (distance <= near) return { scale: 1, fade: 0, minPixels: SEAT_MIN_PIXELS_NEAR };
  const t = Math.min(1, (distance - near) / Math.max(1e-3, far - near));
  return {
    scale: 1 - t * 0.4,
    fade: t * 0.55,
    // Tapered on the same ramp as the fade: as the block starts reading by its
    // tier tint, the dots stop fighting each other for pixels.
    minPixels: SEAT_MIN_PIXELS_NEAR + t * (SEAT_MIN_PIXELS_FAR - SEAT_MIN_PIXELS_NEAR),
  };
}
