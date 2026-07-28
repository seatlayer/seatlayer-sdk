/**
 * Builds (and rebuilds) all GPU resources from a SceneModel. Kept separate from
 * the model so a context-loss restore can throw the old GpuScene away and call
 * `buildGpuScene(gl, model)` again — the model never changes.
 *
 * Draw calls: background (1) + merged solids (1) + instanced seats (1) = 3, plus
 * ONE more instanced draw for the near-field chairs whenever the camera is close
 * enough that any seat qualifies. That mesh is attached and detached from the
 * scene graph rather than drawn empty, so an overview frame still costs exactly
 * the three calls it always did.
 */

import { Geometry, Mesh, Program, Transform, type OGLRenderingContext } from 'ogl';
import { SEAT_STATES, upholsteryTone, type RGB } from '../palette';
import { createBackgroundProgram, createChairProgram, createSeatProgram, createSolidProgram } from './materials';
import { CHAIR_MAX_INSTANCES } from '../lod';
import { buildChairMesh } from './seatChair';
import type { SceneModel } from './sceneModel';
import { seatOccupantSeed, type DirtyRun } from './seatInstances';

/**
 * Fill an iColor buffer range from the current iState values (state → colour).
 *
 * Reads the THEME's colours, not the module palette, so an organizer's brand
 * selection colour applies to the 3D seats as it already does in the picker.
 */
function writeSeatColors(
  iColor: Float32Array,
  iState: Float32Array,
  start: number,
  count: number,
  states: readonly RGB[],
  /** Per-instance category colours; an AVAILABLE seat wears its own. */
  iCategory?: Float32Array,
): void {
  for (let i = start; i < start + count; i++) {
    // State index 0 is 'available'. It is the only state that defers to the
    // category, exactly as 2D does: `paintSeat` fills a free seat with
    // `seatBaseColor(categoryKey)` and only overrides once it is held, sold or
    // selected. Those overrides carry information the category cannot, so they
    // must keep winning.
    const useCategory = iCategory && iState[i] === 0;
    const c = useCategory ? null : (states[iState[i]] ?? states[0]);
    iColor[i * 3] = c ? c[0] : iCategory![i * 3];
    iColor[i * 3 + 1] = c ? c[1] : iCategory![i * 3 + 1];
    iColor[i * 3 + 2] = c ? c[2] : iCategory![i * 3 + 2];
  }
}

// Two-triangle quad in [-1,1] (billboard base).
const SEAT_QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
// Fullscreen triangle.
const BG_TRI = new Float32Array([-1, -1, 3, -1, -1, 3]);

export interface GpuScene {
  /** Main scene (solids + seats), drawn with the camera. */
  main: Transform;
  /** Background scene, drawn first without depth. */
  background: Transform;
  seatProgram: Program;
  solidProgram: Program;
  /** Near-field chair program (shares uFocusFloor / fade-band uniforms). */
  chairProgram: Program;
  /** Shared instanced seat geometry (reused by the pick pass — no buffer copy). */
  seatGeometry: Geometry;
  /** Merged solid geometry (reused as the pick occluder). */
  solidGeometry: Geometry;
  drawCalls: number;
  /** Upload only the changed instance-state ranges (never the whole buffer). */
  uploadSeatStateRuns(runs: DirtyRun[]): void;
  /**
   * Hand the chair mesh the seat indices the near-field gather selected.
   *
   * `indices[0…count)` are instance indices into the seat cloud — the SAME
   * indices the dots and the pick pass use, which is what guarantees a chair and
   * its dot are always the same seat. Passing count 0 detaches the mesh.
   */
  setNearSeats(indices: Int32Array, count: number): void;
  /** How many chairs are currently instanced (0 = the near field is off). */
  nearSeatCount(): number;
  dispose(): void;
}

export function buildGpuScene(gl: OGLRenderingContext, model: SceneModel): GpuScene {
  const main = new Transform();
  const background = new Transform();

  // --- Background ---
  const bgGeo = new Geometry(gl, { position: { size: 2, data: BG_TRI } });
  // The chart's own background, not the library's — see theme.ts.
  const bgProg = createBackgroundProgram(gl, model.theme.background.top as number[], model.theme.background.bottom as number[]);
  const bgMesh = new Mesh(gl, { geometry: bgGeo, program: bgProg });
  bgMesh.frustumCulled = false;
  bgMesh.setParent(background);

  // --- Solids (floor + tiers + stage + décor + GA, merged) ---
  const solidGeo = new Geometry(gl, {
    position: { size: 3, data: model.solids.position },
    normal: { size: 3, data: model.solids.normal },
    color: { size: 3, data: model.solids.color },
    floorIndex: { size: 1, data: model.solids.floor },
  });
  const solidProg = createSolidProgram(gl);
  const solidMesh = new Mesh(gl, { geometry: solidGeo, program: solidProg });
  solidMesh.frustumCulled = false;
  solidMesh.setParent(main);

  // --- Seats (one instanced billboard mesh) ---
  // Per-instance colour resolved CPU-side from iState (no dynamically-indexed
  // array uniform — OGL only binds an array uniform whose value is a plain
  // Array, and a dynamic LUT index is best avoided anyway).
  const seatProg = createSeatProgram(gl);
  const iColor = new Float32Array(model.seats.count * 3);
  const stateColors: RGB[] = SEAT_STATES.map((st) => model.theme.seatStates[st]);
  writeSeatColors(iColor, model.seats.iState, 0, model.seats.count, stateColors, model.seats.iCategory);
  const seatGeo = new Geometry(gl, {
    position: { size: 2, data: SEAT_QUAD },
    iOffset: { size: 3, data: model.seats.iPosition, instanced: 1 },
    iColor: { size: 3, data: iColor, instanced: 1 },
    // Per-seat world-radius ceiling: what stops distant rows merging into one
    // mass when the shader grows a dot to hold its minimum pixel size.
    iMaxRadius: { size: 1, data: model.seats.iMaxRadius, instanced: 1 },
    // Accommodation ring colour; (0,0,0) means the seat carries no access type.
    iRing: { size: 3, data: model.seats.iRing, instanced: 1 },
    iFloor: { size: 1, data: model.seats.iFloor, instanced: 1 },
  });
  const seatMesh = new Mesh(gl, { geometry: seatGeo, program: seatProg });
  seatMesh.frustumCulled = false;
  if (model.seats.count > 0) seatMesh.setParent(main);

  const colorAttr = seatGeo.attributes.iColor;

  // --- Near-field chairs (one extra instanced draw, only when in range) ------
  // Fixed-capacity instance buffers: the near set is bounded by
  // CHAIR_MAX_INSTANCES whatever the venue holds, so these are allocated once at
  // ~200 KB total and only ever refilled — never grown, never reallocated per
  // frame. `instancedCount` is what varies.
  const chairBase = buildChairMesh();
  const chairProg = createChairProgram(gl);
  const CAP = CHAIR_MAX_INSTANCES;
  const cOffset = new Float32Array(CAP * 3);
  const cColor = new Float32Array(CAP * 3);
  const cRadius = new Float32Array(CAP);
  const cYaw = new Float32Array(CAP);
  const cRing = new Float32Array(CAP * 3);
  const cFloor = new Float32Array(CAP);
  // Occupancy + a stable per-person variation, in one attribute.
  //
  // Negative means the seat is EMPTY and the occupant geometry collapses. A
  // non-negative value is a per-seat hash in [0,1) that varies build and skin
  // tone, so a full row is not a rank of identical mannequins — the same trick
  // the generated panorama used on its silhouettes.
  const cSeed = new Float32Array(CAP);
  const chairGeo = new Geometry(gl, {
    position: { size: 3, data: chairBase.position },
    normal: { size: 3, data: chairBase.normal },
    part: { size: 1, data: chairBase.part },
    index: { data: chairBase.index },
    iOffset: { size: 3, data: cOffset, instanced: 1 },
    iColor: { size: 3, data: cColor, instanced: 1 },
    iRadius: { size: 1, data: cRadius, instanced: 1 },
    iYaw: { size: 1, data: cYaw, instanced: 1 },
    iRing: { size: 3, data: cRing, instanced: 1 },
    iFloor: { size: 1, data: cFloor, instanced: 1 },
    iSeed: { size: 1, data: cSeed, instanced: 1 },
  });
  const chairMesh = new Mesh(gl, { geometry: chairGeo, program: chairProg });
  chairMesh.frustumCulled = false;
  let nearCount = 0;
  /** The gathered set, kept so a state change can recolour it without a re-gather. */
  let nearIndices: Int32Array = new Int32Array(0);

  const writeChairColors = (): void => {
    const src = model.seats;
    for (let k = 0; k < nearCount; k++) {
      const i = nearIndices[k];
      // An available chair wears its category as UPHOLSTERY, not as the map's
      // full-strength tier colour. Only the category case is muted: held, sold
      // and selected are saying something the buyer needs to see from where they
      // are sitting, and quietening those would lose real information.
      const useCategory = src.iCategory && src.iState[i] === 0;
      const c = useCategory ? null : (stateColors[src.iState[i]] ?? stateColors[0]);
      if (c) {
        cColor[k * 3] = c[0];
        cColor[k * 3 + 1] = c[1];
        cColor[k * 3 + 2] = c[2];
      } else {
        const u = upholsteryTone([src.iCategory[i * 3], src.iCategory[i * 3 + 1], src.iCategory[i * 3 + 2]]);
        cColor[k * 3] = u[0];
        cColor[k * 3 + 1] = u[1];
        cColor[k * 3 + 2] = u[2];
      }
    }
    chairGeo.attributes.iColor.needsUpdate = true;
  };

  const scene: GpuScene = {
    main,
    background,
    seatProgram: seatProg,
    solidProgram: solidProg,
    chairProgram: chairProg,
    seatGeometry: seatGeo,
    solidGeometry: solidGeo,
    drawCalls: 3,
    setNearSeats(indices: Int32Array, count: number): void {
      const n = Math.min(count, CAP);
      nearIndices = indices;
      nearCount = n;
      if (n === 0) {
        // Detached rather than drawn with instancedCount 0: an overview frame
        // must cost the same three draw calls it did before the near field
        // existed, and a zero-instance draw is still a state change + a call.
        if (chairMesh.parent) chairMesh.setParent(null);
        chairGeo.instancedCount = 0;
        scene.drawCalls = 3;
        return;
      }
      const src = model.seats;
      for (let k = 0; k < n; k++) {
        const i = indices[k];
        cOffset[k * 3] = src.iPosition[i * 3];
        cOffset[k * 3 + 1] = src.iPosition[i * 3 + 1];
        cOffset[k * 3 + 2] = src.iPosition[i * 3 + 2];
        // The chair's OWN pitch rule, not the dot's ceiling — see iChairWidth.
        cRadius[k] = src.iChairWidth[i];
        cYaw[k] = src.iYaw[i];
        cRing[k * 3] = src.iRing[i * 3];
        cRing[k * 3 + 1] = src.iRing[i * 3 + 1];
        cRing[k * 3 + 2] = src.iRing[i * 3 + 2];
        cFloor[k] = src.iFloor[i];
        cSeed[k] = seatOccupantSeed(src.iState[i], i);
      }
      writeChairColors();
      chairGeo.attributes.iOffset.needsUpdate = true;
      chairGeo.attributes.iRadius.needsUpdate = true;
      chairGeo.attributes.iYaw.needsUpdate = true;
      chairGeo.attributes.iRing.needsUpdate = true;
      chairGeo.attributes.iFloor.needsUpdate = true;
      chairGeo.attributes.iSeed.needsUpdate = true;
      chairGeo.instancedCount = n;
      if (!chairMesh.parent) chairMesh.setParent(main);
      scene.drawCalls = 4;
    },
    nearSeatCount(): number {
      return nearCount;
    },
    uploadSeatStateRuns(runs: DirtyRun[]): void {
      if (!runs.length) return;
      // A selection or availability change has to reach the chairs too, or a
      // seat picked at close range stays available-green under the buyer. The
      // gathered set is small and bounded, so it is simply rewritten rather than
      // diffed against the runs.
      if (nearCount) writeChairColors();
      // Refresh only the changed instance colours from the (already-mutated)
      // iState, then upload just those contiguous ranges — never the whole buffer.
      // iCategory must be passed HERE too, not just on the initial fill: a seat
      // whose hold expires goes back to 'available', and without it that seat
      // would repaint flat green while every untouched neighbour kept its
      // category colour.
      for (const run of runs) {
        writeSeatColors(iColor, model.seats.iState, run.start, run.length, stateColors, model.seats.iCategory);
      }
      const buffer = colorAttr.buffer;
      if (!buffer) {
        // Not uploaded yet (no draw has happened) — full upload on next draw.
        colorAttr.needsUpdate = true;
        return;
      }
      // Direct bufferSubData: OGL's render-state boundBuffer cache is not touched
      // here, which is safe because OGL rebinds attribute buffers per draw via the
      // geometry's VAO; if a future dynamic attribute relies on the cache, rebind
      // through OGL instead. 3 floats per instance (vec3 iColor).
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const run of runs) {
        const sub = iColor.subarray(run.start * 3, (run.start + run.length) * 3);
        gl.bufferSubData(gl.ARRAY_BUFFER, run.start * 3 * Float32Array.BYTES_PER_ELEMENT, sub);
      }
    },
    dispose(): void {
      // OGL geometries/programs delete their GL resources on remove().
      bgGeo.remove();
      bgProg.remove();
      solidGeo.remove();
      solidProg.remove();
      seatGeo.remove();
      seatProg.remove();
      chairGeo.remove();
      chairProg.remove();
    },
  };
  return scene;
}
