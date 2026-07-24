/**
 * view3d — the sole dynamic-import boundary for the lazy OGL venue-view chunk.
 *
 *   const { mountVenue3D } = await import('../view3d');
 *   const handle = mountVenue3D(container, { doc, seats }, { onSeatPick, getSeatView });
 *   await handle.flyToSeat(seatId);
 *
 * Read-only 3D of any chart, fed entirely from the existing height contract.
 * Slice 1: orbit camera, extruded tiers/stage/GA, instanced seat dots, sub-range
 * availability, dispose + context-loss survival. Slice 2: GPU color-pick. Slice
 * 3: the fly-to-seat cinematic that dissolves into the view-from-seat panorama.
 */

import { Quat, Vec3 } from 'ogl';
import type { ChartDoc, ExpandedSeat } from '../core/types';
import { GLContext } from './gl/context';
import { OrbitCamera } from './camera/orbit';
import { RenderLoop, type RenderLoopStats } from './loop';
import { computeSeatLod } from './lod';
import { buildSceneModel, type SceneModel } from './scene/sceneModel';
import { buildGpuScene, type GpuScene } from './scene/build';
import { applySeatStates } from './scene/seatInstances';
import { PickPipeline } from './pick/pickPipeline';
import { pickPixelCoords } from './pick/encode';
import { diffSelection, mergeAvailabilityIntoSelection } from './pick/selection';
import { Cinematic, buildWaypoints, lookAtQuat, FLIGHT_DURATION_MS, FOV_END, type Vec3Arr } from './camera/cinematic';
import { mountPanorama, type PanoramaHandle, type SeatView } from './crossfade/panorama';
import { Analytics3D, type Analytics3DCallback } from './analytics';
import type { SeatState3D } from './palette';

export type { SeatState3D } from './palette';
export type { SeatView } from './crossfade/panorama';
export type { Analytics3DCallback } from './analytics';
export { buildSceneModel } from './scene/sceneModel';

/** Seat eye height above its deck: SEATED_EYE_HEIGHT_M (1.2) − seat lift (0.18). */
const SEAT_EYE_ABOVE_DECK = 1.02;

export interface Venue3DInput {
  doc: ChartDoc;
  /** Expanded seats (from `expandChart`) — carry x/y + resolved eyeHeightM. */
  seats: ExpandedSeat[];
  /** Optional initial per-seat state (default all available). */
  initialState?: (seat: ExpandedSeat) => SeatState3D;
}

export interface Venue3DOptions {
  /** Fired on a tap that hits a seat (GPU color-pick). Not fired on empty taps. */
  onSeatPick?: (seatId: string) => void;
  /**
   * Supplies the view-from-seat panorama for the cinematic hand-off. Decoupled:
   * the caller (app/harness) owns panorama generation; view3d never imports it.
   * Called at PICK time to pre-render, so flyToSeat has zero wait on landing.
   */
  getSeatView?: (seatId: string) => SeatView | Promise<SeatView>;
  /**
   * Decoupled analytics sink. Emits the venue-view journey: `3d_opened`,
   * `3d_orbit_engaged` (first user gesture), `3d_seat_picked`,
   * `3d_cinematic_played`/`_skipped`/`_cancelled`, `3d_panorama_opened`/`_closed`.
   * Every invocation is wrapped in try/catch — a throwing sink never breaks
   * rendering. Absent = no events emitted.
   */
  onAnalytics?: Analytics3DCallback;
}

export interface Venue3DStats extends RenderLoopStats {
  drawCalls: number;
  seatCount: number;
}

export interface Venue3DHandle {
  dispose(): void;
  setAvailability(updates: { seatId: string; state: SeatState3D }[]): void;
  setSelection(seatIds: string[]): void;
  /** Fly the camera from the overview into `seatId` and dissolve into its
   * view-from-seat panorama. Resolves at flight end; a drag cancels it, a second
   * call retargets, dispose resolves early. Reduced-motion → a short fade. */
  flyToSeat(seatId: string): Promise<void>;
  resize(): void;
  stats(): Venue3DStats;
  loseContextForTest(): void;
  /** Test hook: force (or clear) the reduced-motion path. */
  setReducedMotionForTest(value: boolean | null): void;
}

const DEG = Math.PI / 180;
const TAP_SLOP = 6;
const TAP_MS = 500;

export function mountVenue3D(
  container: HTMLElement,
  input: Venue3DInput,
  opts: Venue3DOptions = {},
): Venue3DHandle {
  const model: SceneModel = buildSceneModel(input);
  const analytics = new Analytics3D(opts.onAnalytics);

  const seatIdByIndex: string[] = new Array(model.seats.count);
  for (const [id, idx] of model.seats.idToIndex) seatIdByIndex[idx] = id;

  // Seat → owning section (for the 3d_seat_picked event); resolved from the
  // expanded seats that already carry sectionId.
  const sectionIdBySeatId = new Map<string, string | undefined>();
  for (const s of input.seats) sectionIdBySeatId.set(s.id, s.sectionId);

  // Whether the chart carries any real 3D relief (authored heights/rake or
  // elevated floors) vs. degrading to flat slabs — reported with 3d_opened.
  const hasHeights = ((): boolean => {
    if (input.doc.floors?.some((f) => (f.baseHeightM ?? 0) > 0)) return true;
    const objs = input.doc.floors?.flatMap((f) => f.objects) ?? input.doc.objects;
    return objs.some((o) => o.type === 'section'
      && (((o as { height?: number }).height ?? 0) > 0 || ((o as { rake?: number }).rake ?? 0) > 0));
  })();

  let gpu: GpuScene | null = null;
  let pick: PickPipeline | null = null;
  let contextLost = false;
  let frozen = false; // GL render paused while the panorama is up
  let disposed = false;
  let selection = new Map<string, number>();
  let panorama: PanoramaHandle | null = null;
  const prefetch = new Map<string, Promise<SeatView>>();
  let flightGen = 0;
  let reducedForced: boolean | null = null;

  const rebuildGpu = (): void => {
    gpu = buildGpuScene(glctx.gl, model);
    pick = new PickPipeline(glctx.renderer, gpu.seatGeometry, gpu.solidGeometry, model.seats.count);
  };

  const glctx = new GLContext(container, {
    onContextLost: () => {
      contextLost = true;
      loop.stop();
      gpu = null;
      pick = null;
    },
    onContextRestored: () => {
      rebuildGpu();
      contextLost = false;
      loop.requestRender();
    },
  });

  const orbit = new OrbitCamera(
    glctx.gl,
    glctx.canvas,
    () => loop.requestRender(),
    () => analytics.orbitEngaged(), // first real drag/wheel/pinch (not the intro ease)
  );
  // setAspect BEFORE frame so the fit clears the horizontal FOV too (centred with
  // margin on a wide designer canvas rather than parked low-left).
  orbit.setAspect(glctx.aspect);
  orbit.frame(model.bounds, true);

  const cinematic = new Cinematic(orbit.camera);

  rebuildGpu();

  const loop = new RenderLoop((/* dt */) => {
    if (contextLost || !gpu || frozen) return false;
    const flying = cinematic.active;
    const moving = flying ? cinematic.update(performance.now()) : orbit.update();

    const lod = computeSeatLod(orbit.currentDistance, model.bounds.radius);
    const u = gpu.seatProgram.uniforms;
    u.uSeatScale.value = lod.scale;
    u.uSeatFade.value = lod.fade;
    u.uPixelToWorld.value = (2 * Math.tan((orbit.camera.fov * DEG) / 2)) / Math.max(1, glctx.pixelHeight);

    glctx.renderer.render({ scene: gpu.background, clear: true });
    glctx.renderer.render({ scene: gpu.main, camera: orbit.camera, clear: false });
    return moving;
  });

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => handle.resize())
    : null;
  ro?.observe(container);

  const setSelection = (ids: string[]): void => {
    const baseStateIndex = (id: string): number | undefined => {
      const idx = model.seats.idToIndex.get(id);
      return idx === undefined ? undefined : model.seats.iState[idx];
    };
    const { updates, next } = diffSelection(selection, ids, baseStateIndex);
    selection = next;
    if (updates.length) {
      const runs = applySeatStates(model.seats, updates);
      if (gpu) gpu.uploadSeatStateRuns(runs);
      loop.requestRender();
    }
  };

  // --- cinematic / panorama ---
  const reducedMotion = (): boolean => {
    if (reducedForced !== null) return reducedForced;
    return typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };

  const PREFETCH_CAP = 8;
  const ensureSeatView = (seatId: string): Promise<SeatView> | null => {
    if (!opts.getSeatView) return null;
    let p = prefetch.get(seatId);
    if (!p) {
      p = Promise.resolve(opts.getSeatView(seatId));
      prefetch.set(seatId, p);
      // Bound the cache (LRU-ish): drop the oldest inserted entries past the cap.
      while (prefetch.size > PREFETCH_CAP) {
        const oldest = prefetch.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        prefetch.delete(oldest);
      }
    }
    return p;
  };

  const seatEyeWorld = (idx: number): Vec3Arr => [
    model.seats.iPosition[idx * 3],
    model.seats.iPosition[idx * 3 + 1] + SEAT_EYE_ABOVE_DECK,
    model.seats.iPosition[idx * 3 + 2],
  ];

  const placeCameraFinal = (finalPos: Vec3Arr, focal: Vec3Arr): void => {
    orbit.camera.position.set(finalPos[0], finalPos[1], finalPos[2]);
    orbit.camera.lookAt(new Vec3(focal[0], focal[1], focal[2]));
    orbit.camera.fov = FOV_END;
    orbit.camera.updateProjectionMatrix();
  };

  const openPanorama = async (seatId: string, fadeMs: number, gen: number): Promise<void> => {
    const viewPromise = ensureSeatView(seatId);
    if (!viewPromise) { orbit.syncFromCamera(); return; } // no panorama source
    frozen = true;
    loop.stop(); // freeze the GL at the seat pose; panorama fades in over it
    let view: SeatView;
    try {
      view = await viewPromise;
    } catch {
      // Only unfreeze if we still own the flight — a retarget during the await
      // has already reset `frozen` and taken over the loop.
      if (!disposed && gen === flightGen) { frozen = false; orbit.resumeAfterFlight(model.focalWorld); loop.requestRender(); }
      return;
    }
    // Superseded during the await (retarget/cancel) or disposed: bail WITHOUT
    // touching frozen/loop — the newer flight owns the freeze state now, and
    // mounting this stale seat's panorama would be wrong.
    if (disposed || gen !== flightGen) return;
    panorama = mountPanorama(container, view, {
      fadeMs,
      seatLabel: seatId,
      onClose: () => {
        panorama = null;
        frozen = false;
        analytics.panoramaClosed();
        orbit.resumeAfterFlight(model.focalWorld);
        loop.requestRender();
      },
    });
    analytics.panoramaOpened();
  };

  const cancelFlight = (): void => {
    flightGen++; // supersede any pending .then(openPanorama)
    if (cinematic.active) {
      cinematic.cancel();
      orbit.resumeAfterFlight(model.focalWorld);
    }
  };

  const flyToSeat = (seatId: string): Promise<void> => {
    if (disposed || !gpu) return Promise.resolve();
    const idx = model.seats.idToIndex.get(seatId);
    if (idx === undefined) return Promise.resolve();
    // Reset the freeze unconditionally: a previous flight may have set frozen=true
    // inside openPanorama's pre-await window without a panorama ever mounting.
    if (panorama) { panorama.dispose(); panorama = null; }
    frozen = false;

    const gen = ++flightGen;
    const seatEye = seatEyeWorld(idx);
    const focal = model.focalWorld;
    const start: Vec3Arr = [orbit.camera.position.x, orbit.camera.position.y, orbit.camera.position.z];
    const { waypoints, finalPos } = buildWaypoints(start, seatEye, focal, model.bounds.center, model.bounds.radius);

    if (reducedMotion()) {
      // a11y: no flight — snap to the seat pose, short dissolve to the panorama.
      placeCameraFinal(finalPos, focal);
      loop.requestRender();
      analytics.cinematicSkipped();
      return openPanorama(seatId, 300, gen).then(() => { if (!disposed) orbit.syncFromCamera(); });
    }

    const startQuat = new Quat().copy(orbit.camera.quaternion);
    const endQuat = lookAtQuat(orbit.camera, finalPos, focal);
    loop.requestRender();
    return cinematic.start(waypoints, startQuat, endQuat).then(() => {
      if (disposed || gen !== flightGen) return; // disposed or superseded (retarget/cancel)
      analytics.cinematicPlayed(FLIGHT_DURATION_MS);
      return openPanorama(seatId, 400, gen);
    });
  };

  // --- Tap → pick / flight-cancel ---
  let downX = 0, downY = 0, downT = 0, downId = -1, moved = false, suppressTap = false;
  const onDown = (e: PointerEvent): void => {
    if (downId !== -1) return;
    downId = e.pointerId; downX = e.clientX; downY = e.clientY; downT = performance.now(); moved = false;
    // A press during a flight cancels it (damped stop) instead of picking.
    suppressTap = cinematic.active;
    if (cinematic.active) { analytics.cinematicCancelled(); cancelFlight(); }
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== downId) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) moved = true;
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== downId) return;
    const isTap = !moved && performance.now() - downT < TAP_MS;
    downId = -1;
    if (suppressTap) { suppressTap = false; return; }
    if (!isTap || !gpu || !pick) return;
    pick.syncFromSeatProgram(gpu.seatProgram);
    const rect = glctx.canvas.getBoundingClientRect();
    const dpr = glctx.renderer.dpr;
    const { x, y } = pickPixelCoords(e.clientX, e.clientY, rect, dpr, glctx.gl.drawingBufferWidth, glctx.gl.drawingBufferHeight);
    const radius = Math.max(2, Math.round(8 * dpr));
    const idx = pick.pick(orbit.camera, x, y, radius);
    if (idx < 0 || idx >= seatIdByIndex.length) {
      if (selection.size) setSelection([]);
      return;
    }
    const seatId = seatIdByIndex[idx];
    if (selection.has(seatId) && selection.size === 1) setSelection([]);
    else setSelection([seatId]);
    ensureSeatView(seatId); // pre-render the panorama the moment the seat is picked
    analytics.seatPicked(seatId, sectionIdBySeatId.get(seatId));
    opts.onSeatPick?.(seatId);
  };
  glctx.canvas.addEventListener('pointerdown', onDown);
  glctx.canvas.addEventListener('pointermove', onMove);
  glctx.canvas.addEventListener('pointerup', onUp);
  glctx.canvas.addEventListener('pointercancel', onUp);

  loop.requestRender();

  const handle: Venue3DHandle = {
    setAvailability(updates) {
      const passthrough = mergeAvailabilityIntoSelection(selection, updates);
      const runs = applySeatStates(model.seats, passthrough);
      if (runs.length && gpu) gpu.uploadSeatStateRuns(runs);
      loop.requestRender();
    },
    setSelection,
    flyToSeat,
    resize() {
      const { width, height } = glctx.resize();
      orbit.setAspect(width / Math.max(1, height));
      loop.requestRender();
    },
    stats() {
      return {
        ...loop.stats(),
        drawCalls: gpu ? gpu.drawCalls : 0,
        seatCount: model.seatCount,
      };
    },
    loseContextForTest() {
      glctx.simulateContextLossCycle();
    },
    setReducedMotionForTest(value) {
      reducedForced = value;
    },
    dispose() {
      disposed = true;
      cancelFlight();
      loop.stop();
      ro?.disconnect();
      if (panorama) { panorama.dispose(); panorama = null; }
      glctx.canvas.removeEventListener('pointerdown', onDown);
      glctx.canvas.removeEventListener('pointermove', onMove);
      glctx.canvas.removeEventListener('pointerup', onUp);
      glctx.canvas.removeEventListener('pointercancel', onUp);
      orbit.dispose();
      if (pick) pick.dispose();
      if (gpu) gpu.dispose();
      gpu = null;
      pick = null;
      glctx.dispose();
    },
  };

  analytics.opened(model.seatCount, hasHeights);
  return handle;
}
