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
import { computeSeatLod, CHAIR_GATHER_M, CHAIR_MAX_INSTANCES, CHAIR_REBUILD_M } from './lod';
import { NearFieldIndex } from './scene/nearField';
import { SEAT_DOT_RADIUS_M } from './scene/seatInstances';
import { buildSceneModel, type SceneModel, type SceneZone, type SceneSection, type SceneFloor } from './scene/sceneModel';
import { LabelOverlay } from './labelOverlay';
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
  /** The venue's zones (id, label, colour, seat count) in authored order. */
  zones(): SceneZone[];
  /**
   * Frame a zone: the camera moves to sit over that zone looking at what the
   * zone faces. Returns false for an unknown or empty zone.
   *
   * This is the navigation the venue's own structure implies — a buyer picks
   * "Grand Circle", not a set of coordinates — and it is what the 2D renderer's
   * farthest LOD rung already offers. Approaching from the zone's focal side
   * means the seats face the camera rather than presenting their backs.
   */
  focusZone(zoneId: string): boolean;
  /** The venue's seated sections (id, name, seat count) in authored order. */
  sections(): SceneSection[];
  /**
   * Frame a section — the middle rung of the venue ladder, and the one every
   * chart has. Zones are optional and a chart may author none or one; sections
   * are what a buyer picks between when "which part of the venue" has already
   * been answered. Returns false for an unknown or empty section.
   */
  focusSection(sectionId: string): boolean;
  /** The venue's floors (id, name, seat count) in authored order. */
  floors(): SceneFloor[];
  /**
   * Isolate one floor, or pass null to show the whole venue.
   *
   * Every shipped multi-floor chart puts its floors at the same base height and
   * takes relief from the sections, so all three of an opera house draw at once
   * and the balcony sits over the parterre. Unfocused floors are DIMMED rather
   * than hidden, so the buyer keeps the venue as context while looking at the
   * level they are booking. Returns false for an unknown index.
   */
  focusFloor(index: number | null): boolean;
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
  /** Focused floor, or -1 for the whole venue. Survives a context restore. */
  let focusedFloor = -1;

  const rebuildGpu = (): void => {
    gpu = buildGpuScene(glctx.gl, model);
    pick = new PickPipeline(glctx.renderer, gpu.seatGeometry, gpu.solidGeometry, model.seats.count);
    // Apply the chart's authored theme to everything outside the scene graph:
    // the clear colour (visible for a frame before the background draws, and on
    // any frame the scene does not cover) and the pick pass's restore.
    glctx.setClearColor(model.theme.background.top);
    pick.setRestoreClear(model.theme.background.top);
    // Seat size is authored too (`ChartTheme.seatScale`) — bigger seats for
    // charts with longer labels.
    gpu.seatProgram.uniforms.uSeatRadius.value = SEAT_DOT_RADIUS_M * model.theme.seatScale;
    // A context restore rebuilds the GPU scene, so re-apply the focused floor
    // rather than silently reverting the buyer to the whole venue.
    gpu.seatProgram.uniforms.uFocusFloor.value = focusedFloor;
    gpu.solidProgram.uniforms.uFocusFloor.value = focusedFloor;
    gpu.chairProgram.uniforms.uFocusFloor.value = focusedFloor;
    // A rebuilt scene has an empty chair set; force the next frame to re-gather
    // instead of trusting the last camera position.
    lastGatherX = Infinity;
  };

  // --- near field ------------------------------------------------------------
  // The spatial index is constructed here but its grid is built lazily, on the
  // first gather — a session that never leaves the overview never pays for it.
  const nearIndex = new NearFieldIndex(model.seats.iPosition, model.seats.count);
  const nearBuf = new Int32Array(CHAIR_MAX_INSTANCES);
  let lastGatherX = Infinity;
  let lastGatherZ = Infinity;

  /**
   * Re-gather the near set when the camera has moved far enough to invalidate
   * it — not every frame.
   *
   * The cheap early-out is the venue bound: if the camera is further from the
   * whole seat cloud than the gather radius, nothing can qualify and the grid is
   * never even touched. That is the state the overview, the intro ease and every
   * frame of a wide orbit are in, so the common case costs one distance test.
   */
  const updateNearField = (): void => {
    if (!gpu) return;
    const cam = orbit.camera.position;
    const moved = Math.hypot(cam.x - lastGatherX, cam.z - lastGatherZ);
    if (moved < CHAIR_REBUILD_M) return;
    lastGatherX = cam.x;
    lastGatherZ = cam.z;
    const outside = Math.hypot(cam.x - model.bounds.center[0], cam.z - model.bounds.center[2])
      - model.bounds.radius;
    if (outside > CHAIR_GATHER_M) {
      if (gpu.nearSeatCount()) gpu.setNearSeats(nearBuf, 0);
      return;
    }
    const n = nearIndex.gather(cam.x, cam.z, CHAIR_GATHER_M, nearBuf);
    if (n === 0 && gpu.nearSeatCount() === 0) return;
    gpu.setNearSeats(nearBuf, n);
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
  // Enter from the stage side (camera behind the stage, every tier facing you).
  // When the focal sits at the centre (in-the-round) there is no stage side —
  // fall back to the fixed architectural angle.
  const stageAzimuth = ((): number | undefined => {
    const dx = model.focalWorld[0] - model.bounds.center[0];
    const dz = model.focalWorld[2] - model.bounds.center[2];
    return Math.hypot(dx, dz) > model.bounds.radius * 0.12 ? Math.atan2(dx, dz) : undefined;
  })();
  orbit.frame(model.bounds, true, stageAzimuth);

  const cinematic = new Cinematic(orbit.camera);

  // Labels are DOM, projected from world anchors — see labels.ts for why. The
  // container must establish a positioning context or the overlay would anchor
  // to the page instead of the canvas.
  if (!container.style.position || container.style.position === 'static') {
    container.style.position = 'relative';
  }
  const labelOverlay = new LabelOverlay(container, {
    fontFamily: input.doc.theme?.fontFamily,
    ink: input.doc.theme?.textColor,
  });
  labelOverlay.setLabels(model.labels);

  rebuildGpu();

  const loop = new RenderLoop((/* dt */) => {
    if (contextLost || !gpu || frozen) return false;
    const flying = cinematic.active;
    const moving = flying ? cinematic.update(performance.now()) : orbit.update();

    const lod = computeSeatLod(orbit.currentDistance, model.bounds.radius);
    const u = gpu.seatProgram.uniforms;
    u.uSeatScale.value = lod.scale;
    u.uSeatFade.value = lod.fade;
    // Relax the dot's pixel floor as the venue recedes — see SeatLod.minPixels
    // for why holding 2.5 px all the way out is what welds distant rows into one
    // mass. The pick pass syncs this same value, so the hit mask never drifts
    // off the drawn dot.
    u.uMinPixels.value = lod.minPixels;
    u.uPixelToWorld.value = (2 * Math.tan((orbit.camera.fov * DEG) / 2)) / Math.max(1, glctx.pixelHeight);
    updateNearField();

    glctx.renderer.render({ scene: gpu.background, clear: true });
    glctx.renderer.render({ scene: gpu.main, camera: orbit.camera, clear: false });
    // After the render, so the camera's matrices are the ones just drawn with —
    // projecting from stale matrices makes labels lag the venue by a frame.
    labelOverlay.update(
      orbit.camera.projectionViewMatrix as unknown as ArrayLike<number>,
      glctx.canvas.clientWidth || 1,
      glctx.canvas.clientHeight || 1,
      orbit.currentDistance,
      model.bounds.radius,
      // The dense label rungs rank by real distance from the eye, not by the
      // orbit radius — at the arrival pose those are wildly different numbers.
      [orbit.camera.position.x, orbit.camera.position.y, orbit.camera.position.z],
    );
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

  // --- arrival chip: the flight HOLDS in the live scene; the painted 360 is
  // an explicit tap away. (Owner call 2026-07-24: the real scene at the seat
  // IS the payoff; the generated panorama undersold it as an auto-landing.)
  let arriveChip: HTMLButtonElement | null = null;
  const removeArriveChip = (): void => {
    arriveChip?.remove();
    arriveChip = null;
  };
  const showArriveChip = (seatId: string, gen: number): void => {
    removeArriveChip();
    if (disposed || !opts.getSeatView) return; // no 360 source → nothing to offer
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = '◉ View in 360°';
    chip.setAttribute('aria-label', `Open the 360° view from seat ${seatId}`);
    Object.assign(chip.style, {
      position: 'absolute', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      minHeight: '44px', padding: '10px 18px', borderRadius: '999px',
      background: 'rgba(12,18,32,0.78)', color: '#eef1f8',
      border: '1px solid rgba(150,165,205,0.4)', backdropFilter: 'blur(6px)',
      font: '600 13px/1 inherit', cursor: 'pointer', zIndex: '4',
    } as Partial<CSSStyleDeclaration>);
    chip.addEventListener('click', () => {
      if (disposed || gen !== flightGen) { removeArriveChip(); return; }
      removeArriveChip();
      void openPanorama(seatId, 400, gen);
    });
    container.appendChild(chip);
    arriveChip = chip;
  };

  // --- overview chip: always-available "take me home" control. Free orbit can
  // strand you behind the shell staring at walls; one tap glides back to the
  // stage-side 3/4 framing. (Owner: "we don't have much control in 3D".)
  const overviewChip = document.createElement('button');
  overviewChip.type = 'button';
  overviewChip.textContent = '⌂ Overview';
  overviewChip.setAttribute('aria-label', 'Return to the venue overview');
  Object.assign(overviewChip.style, {
    position: 'absolute', right: '14px', bottom: '18px',
    minHeight: '40px', padding: '8px 14px', borderRadius: '999px',
    background: 'rgba(12,18,32,0.72)', color: '#c9d4ea',
    border: '1px solid rgba(150,165,205,0.35)', backdropFilter: 'blur(6px)',
    font: '600 12.5px/1 inherit', cursor: 'pointer', zIndex: '4',
  } as Partial<CSSStyleDeclaration>);
  overviewChip.addEventListener('click', () => {
    if (disposed || frozen) return; // panorama owns the screen while frozen
    cancelFlight();
    removeArriveChip();
    orbit.frameSoft(model.bounds, stageAzimuth);
    loop.requestRender();
  });
  container.appendChild(overviewChip);

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
    removeArriveChip();
    panorama = mountPanorama(container, view, {
      fadeMs,
      seatLabel: seatId,
      onClose: () => {
        panorama = null;
        frozen = false;
        analytics.panoramaClosed();
        orbit.resumeAfterFlight(model.focalWorld);
        loop.requestRender();
        // Back in the live scene at the seat — offer the 360 again.
        showArriveChip(seatId, flightGen);
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
    removeArriveChip();
    const seatEye = seatEyeWorld(idx);
    const focal = model.focalWorld;
    const start: Vec3Arr = [orbit.camera.position.x, orbit.camera.position.y, orbit.camera.position.z];
    const { waypoints, finalPos } = buildWaypoints(start, seatEye, focal, model.bounds.center, model.bounds.radius);

    if (reducedMotion()) {
      // a11y: no flight — snap straight to the seat pose in the live scene.
      placeCameraFinal(finalPos, focal);
      loop.requestRender();
      analytics.cinematicSkipped();
      if (!disposed) orbit.syncFromCamera();
      showArriveChip(seatId, gen);
      return Promise.resolve();
    }

    const startQuat = new Quat().copy(orbit.camera.quaternion);
    const endQuat = lookAtQuat(orbit.camera, finalPos, focal);
    loop.requestRender();
    return cinematic.start(waypoints, startQuat, endQuat).then(() => {
      if (disposed || gen !== flightGen) return; // disposed or superseded (retarget/cancel)
      analytics.cinematicPlayed(FLIGHT_DURATION_MS);
      // Arrive and HOLD in the live 3D scene — sitting in the crowd, looking at
      // the show, still free to orbit. The painted 360 is the chip, not the
      // landing: the real scene is the payoff moment.
      orbit.resumeAfterFlight(model.focalWorld);
      loop.requestRender();
      showArriveChip(seatId, gen);
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
    floors(): SceneFloor[] {
      return model.floors;
    },
    focusFloor(index: number | null): boolean {
      if (index !== null && !model.floors.some((f) => f.index === index)) return false;
      const value = index ?? -1;
      if (gpu) {
        gpu.seatProgram.uniforms.uFocusFloor.value = value;
        gpu.solidProgram.uniforms.uFocusFloor.value = value;
        gpu.chairProgram.uniforms.uFocusFloor.value = value;
      }
      focusedFloor = value;
      if (index !== null) {
        const f = model.floors[index];
        if (f.seatCount > 0) {
          cinematic.cancel();
          orbit.frame({ center: f.center, radius: f.radius * 1.25 });
        }
      }
      loop.requestRender();
      return true;
    },
    zones(): SceneZone[] {
      return model.zones;
    },
    focusZone(zoneId: string): boolean {
      const zone = model.zones.find((z) => z.id === zoneId);
      if (!zone || zone.seatCount === 0) return false;
      cinematic.cancel();
      // Approach from the side the zone faces, so its seats present their fronts
      // rather than their backs — the same reasoning as the venue's intro shot.
      const dx = zone.focalWorld[0] - zone.center[0];
      const dz = zone.focalWorld[2] - zone.center[2];
      const azimuth = Math.hypot(dx, dz) > zone.radius * 0.12 ? Math.atan2(dx, dz) : undefined;
      // Padded past the zone's own radius: framing exactly to its edge reads as
      // cropped, and a buyer needs the neighbouring geometry to know where in the
      // venue they have landed.
      orbit.frame({ center: zone.center, radius: zone.radius * 1.25 }, false, azimuth);
      loop.requestRender();
      return true;
    },
    sections(): SceneSection[] {
      return model.sections;
    },
    focusSection(sectionId: string): boolean {
      const sec = model.sections.find((s) => s.id === sectionId);
      if (!sec || sec.seatCount === 0) return false;
      cinematic.cancel();
      // Approached from the side it faces, like a zone — a section framed from
      // behind shows the buyer the backs of the seats they are considering.
      const dx = sec.focalWorld[0] - sec.center[0];
      const dz = sec.focalWorld[2] - sec.center[2];
      const azimuth = Math.hypot(dx, dz) > sec.radius * 0.12 ? Math.atan2(dx, dz) : undefined;
      // Tighter padding than a zone's: a section IS the thing being looked at,
      // so it should fill more of the frame, but still with enough around it to
      // place it in the venue.
      orbit.frame({ center: sec.center, radius: sec.radius * 1.45 }, false, azimuth);
      loop.requestRender();
      return true;
    },
    setReducedMotionForTest(value) {
      reducedForced = value;
    },
    dispose() {
      disposed = true;
      removeArriveChip();
      overviewChip.remove();
      cancelFlight();
      loop.stop();
      labelOverlay.dispose();
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
