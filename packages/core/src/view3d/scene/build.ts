/**
 * Builds (and rebuilds) all GPU resources from a SceneModel. Kept separate from
 * the model so a context-loss restore can throw the old GpuScene away and call
 * `buildGpuScene(gl, model)` again — the model never changes.
 *
 * Draw calls: background (1) + merged solids (1) + instanced seats (1) = 3.
 */

import { Geometry, Mesh, Program, Transform, type OGLRenderingContext } from 'ogl';
import { BACKGROUND, seatStateColorByIndex } from '../palette';
import { createBackgroundProgram, createSeatProgram, createSolidProgram } from './materials';
import type { SceneModel } from './sceneModel';
import type { DirtyRun } from './seatInstances';

/** Fill an iColor buffer range from the current iState values (state → colour). */
function writeSeatColors(iColor: Float32Array, iState: Float32Array, start: number, count: number): void {
  for (let i = start; i < start + count; i++) {
    const c = seatStateColorByIndex(iState[i]);
    iColor[i * 3] = c[0];
    iColor[i * 3 + 1] = c[1];
    iColor[i * 3 + 2] = c[2];
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
  /** Shared instanced seat geometry (reused by the pick pass — no buffer copy). */
  seatGeometry: Geometry;
  /** Merged solid geometry (reused as the pick occluder). */
  solidGeometry: Geometry;
  drawCalls: number;
  /** Upload only the changed instance-state ranges (never the whole buffer). */
  uploadSeatStateRuns(runs: DirtyRun[]): void;
  dispose(): void;
}

export function buildGpuScene(gl: OGLRenderingContext, model: SceneModel): GpuScene {
  const main = new Transform();
  const background = new Transform();

  // --- Background ---
  const bgGeo = new Geometry(gl, { position: { size: 2, data: BG_TRI } });
  const bgProg = createBackgroundProgram(gl, BACKGROUND.top as unknown as number[], BACKGROUND.bottom as unknown as number[]);
  const bgMesh = new Mesh(gl, { geometry: bgGeo, program: bgProg });
  bgMesh.frustumCulled = false;
  bgMesh.setParent(background);

  // --- Solids (floor + tiers + stage + décor + GA, merged) ---
  const solidGeo = new Geometry(gl, {
    position: { size: 3, data: model.solids.position },
    normal: { size: 3, data: model.solids.normal },
    color: { size: 3, data: model.solids.color },
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
  writeSeatColors(iColor, model.seats.iState, 0, model.seats.count);
  const seatGeo = new Geometry(gl, {
    position: { size: 2, data: SEAT_QUAD },
    iOffset: { size: 3, data: model.seats.iPosition, instanced: 1 },
    iColor: { size: 3, data: iColor, instanced: 1 },
  });
  const seatMesh = new Mesh(gl, { geometry: seatGeo, program: seatProg });
  seatMesh.frustumCulled = false;
  if (model.seats.count > 0) seatMesh.setParent(main);

  const colorAttr = seatGeo.attributes.iColor;

  return {
    main,
    background,
    seatProgram: seatProg,
    seatGeometry: seatGeo,
    solidGeometry: solidGeo,
    drawCalls: 3,
    uploadSeatStateRuns(runs: DirtyRun[]): void {
      if (!runs.length) return;
      // Refresh only the changed instance colours from the (already-mutated)
      // iState, then upload just those contiguous ranges — never the whole buffer.
      for (const run of runs) writeSeatColors(iColor, model.seats.iState, run.start, run.length);
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
    },
  };
}
