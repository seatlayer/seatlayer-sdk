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
import { buildSceneModel, type SceneModel, type SceneZone, type SceneSection, type SceneFloor, type SceneRow } from './scene/sceneModel';
import { LabelOverlay } from './labelOverlay';
import { projectToScreen } from './labels';
import { buildGpuScene, type GpuScene } from './scene/build';
import { applySeatStates } from './scene/seatInstances';
import { PickPipeline } from './pick/pickPipeline';
import { pickPixelCoords } from './pick/encode';
import { diffSelection, mergeAvailabilityIntoSelection } from './pick/selection';
import { Cinematic, buildWaypoints, lookAtQuat, FLIGHT_DURATION_MS, FOV_END, type Vec3Arr } from './camera/cinematic';
import { seatViewPose } from './camera/seatViewPose';
import { mountPanorama, seatViewDisclosure, type PanoramaHandle, type SeatView } from './crossfade/panorama';
import { mountPanoramaSphere } from './crossfade/panoramaSphere';
import { Analytics3D, type Analytics3DCallback } from './analytics';
import type { SeatState3D } from './palette';
import { establishPositioningContext } from './positioningContext';
import type { PreparedVenue3D } from './prepareScene';

export { prepareVenue3D } from './prepareScene';

export type { SeatState3D } from './palette';
export type { SeatView } from './crossfade/panorama';
export type { Analytics3DCallback } from './analytics';
export { buildSceneModel } from './scene/sceneModel';

export interface Venue3DInput {
  doc: ChartDoc;
  /** Expanded seats (from `expandChart`) — carry x/y + resolved eyeHeightM. */
  seats: ExpandedSeat[];
  /** Optional initial per-seat state (default all available). */
  initialState?: (seat: ExpandedSeat) => SeatState3D;
  /** CPU scene prepared by `prepareVenue3D`; avoids rebuilding on mount. */
  prepared?: PreparedVenue3D;
}

export interface Venue3DOptions {
  /** Fired on a tap that hits a seat (GPU color-pick). Not fired on empty taps. */
  onSeatPick?: (seatId: string) => void;
  /** Overview → section drill state. A stand tap reports its owning section;
   * Overview reports null so host navigation can stay in sync. */
  onSectionFocusChange?: (sectionId: string | null) => void;
  /** Camera target changes, including internal next/previous and Overview UI. */
  onViewTargetChange?: (seatId: string | null) => void;
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
  /**
   * Let portrait overview framing crop the venue's far edges within a bounded
   * landscape fit so seats stay discoverable instead of shrinking the whole
   * bowl to fit. Opt-in because designer/editor previews still prefer strict
   * contain framing; validated for the buyer across `/dev/3d` fixtures.
   */
  portraitOverviewCrop?: boolean;
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
  /** Cancel a seat flight/panorama and frame the complete venue. */
  focusOverview(): void;
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
  /** Rows in the venue, optionally narrowed to a section. */
  rows(sectionId?: string): SceneRow[];
  /** Seats in one row, in authored order. */
  seatsInRow(rowId: string): Array<{ id: string; label: string }>;
  /** Frame a row closely enough for its on-demand seat numbers to be legible. */
  focusRow(rowId: string): boolean;
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
  const buildStartedAt = performance.now();
  const model: SceneModel = input.prepared?.model ?? buildSceneModel(input);
  const analytics = new Analytics3D(opts.onAnalytics);

  const seatIdByIndex: string[] = new Array(model.seats.count);
  for (const [id, idx] of model.seats.idToIndex) seatIdByIndex[idx] = id;
  const expandedSeatById = new Map(input.seats.map((seat) => [seat.id, seat]));
  const seatIdsByRow = new Map<string, string[]>();
  for (const seat of input.seats) {
    if (!seat.rowId) continue;
    const row = seatIdsByRow.get(seat.rowId);
    if (row) row.push(seat.id);
    else seatIdsByRow.set(seat.rowId, [seat.id]);
  }

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
  let panoramaLoadAbort: AbortController | null = null;
  let panoramaPriorZIndex: string | null = null;
  const prefetch = new Map<string, Promise<SeatView>>();
  let flightGen = 0;
  let reducedForced: boolean | null = null;
  /** Focused floor, or -1 for the whole venue. Survives a context restore. */
  let focusedFloor = -1;

  const raisePanoramaLayer = (): void => {
    if (panoramaPriorZIndex !== null) return;
    panoramaPriorZIndex = container.style.zIndex;
    // Buyer chrome sits outside this stacking context at z-index 5. A panorama
    // is modal, so raise the complete 3D layer while it owns the interaction.
    container.style.zIndex = '20';
  };
  const restorePanoramaLayer = (): void => {
    if (panoramaPriorZIndex === null) return;
    if (container.style.zIndex === '20') container.style.zIndex = panoramaPriorZIndex;
    panoramaPriorZIndex = null;
  };

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
      if (!disposed) analytics.contextLost();
      contextLost = true;
      loop.stop();
      gpu = null;
      pick = null;
    },
    onContextRestored: () => {
      rebuildGpu();
      contextLost = false;
      if (!disposed) analytics.contextRestored();
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
  orbit.frame(model.bounds, true, stageAzimuth, opts.portraitOverviewCrop === true);

  const cinematic = new Cinematic(orbit.camera);

  // Labels are DOM, projected from world anchors — see labels.ts for why. The
  // container must establish a positioning context or the overlay would anchor
  // to the page instead of the canvas.
  const restoreContainerPosition = establishPositioningContext(container);
  const labelOverlay = new LabelOverlay(container, {
    fontFamily: input.doc.theme?.fontFamily,
    ink: input.doc.theme?.textColor,
  });
  labelOverlay.setLabels(model.labels);
  const baseLabels = model.labels;
  // While a buyer is inside a section, taps are deliberately scoped to that
  // section. Nearby tiers remain visible as spatial context, but must not steal
  // a tap through the GPU depth buffer when their projected dots overlap.
  let focusedSectionId: string | null = null;
  const showSectionSeatLabels = (sectionId: string | null): void => {
    focusedSectionId = sectionId;
    labelOverlay.setForcedDense(!!sectionId);
    if (!sectionId) {
      labelOverlay.setLabels(baseLabels);
      return;
    }
    const sectionSeats = input.seats.filter((seat) => seat.sectionId === sectionId);
    const seatIds = new Set(sectionSeats.map((seat) => seat.id));
    const rowIds = new Set(sectionSeats.map((seat) => seat.rowId));
    const focusedBase = baseLabels.filter((label) => (
      label.kind !== 'row' && label.kind !== 'seat'
    ) || (
      label.kind === 'row' ? rowIds.has(label.id.slice('row:'.length)) : seatIds.has(label.id.slice('seat:'.length))
    ));
    if (model.seatCount <= 6_000) {
      labelOverlay.setLabels(focusedBase);
      return;
    }
    const labels = sectionSeats.flatMap((seat) => {
      const index = model.seats.idToIndex.get(seat.id);
      if (index === undefined) return [];
      const offset = index * 3;
      return [{
        id: `seat:${seat.id}`,
        kind: 'seat' as const,
        text: seat.displayLabel || seat.label,
        anchor: [
          model.seats.iPosition[offset],
          model.seats.iPosition[offset + 1] + 0.55,
          model.seats.iPosition[offset + 2],
        ] as [number, number, number],
      }];
    });
    labelOverlay.setLabels([...focusedBase, ...labels]);
  };

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
      // A network/decode failure must not poison this seat for the lifetime of
      // the 3D mount. Drop only the promise that actually failed; a newer retry
      // may already have replaced it by the time this rejection settles.
      void p.catch(() => {
        if (prefetch.get(seatId) === p) prefetch.delete(seatId);
      });
      // Bound the cache (LRU-ish): drop the oldest inserted entries past the cap.
      while (prefetch.size > PREFETCH_CAP) {
        const oldest = prefetch.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        prefetch.delete(oldest);
      }
    }
    return p;
  };

  const resolvedSeatViewPose = (seatId: string, idx: number): { eye: Vec3Arr; focal: Vec3Arr } => {
    const seat = expandedSeatById.get(seatId);
    const floorIndex = Math.max(0, Math.round(model.seats.iFloor[idx] ?? 0));
    const floor = input.doc.floors?.[floorIndex];
    const focalPoint = seat?.focalPoint ?? floor?.focalPoint ?? input.doc.focalPoint;
    const deck: Vec3Arr = [
      model.seats.iPosition[idx * 3],
      model.seats.iPosition[idx * 3 + 1],
      model.seats.iPosition[idx * 3 + 2],
    ];
    return seatViewPose(deck, focalPoint, floor?.baseHeightM ?? 0);
  };

  const placeCameraFinal = (finalPos: Vec3Arr, focal: Vec3Arr): void => {
    orbit.camera.position.set(finalPos[0], finalPos[1], finalPos[2]);
    orbit.camera.lookAt(new Vec3(focal[0], focal[1], focal[2]));
    orbit.camera.fov = FOV_END;
    orbit.camera.updateProjectionMatrix();
  };

  // --- arrival chip: the flight HOLDS in the live scene; the painted 360 is
  // an explicit tap away. (Owner call 2026-07-24: the real scene at the seat
  // IS the payoff; the generated panorama undersold it as an auto-landing.)
  let arriveChip: HTMLDivElement | null = null;
  const layoutArriveChip = (): void => {
    if (!arriveChip) return;
    const narrow = (container.clientWidth || glctx.canvas.clientWidth) <= 520;
    Object.assign(arriveChip.style, narrow ? {
      left: '12px', right: '12px', bottom: '70px', transform: 'none', justifyContent: 'center',
    } : {
      left: '50%', right: 'auto', bottom: '18px', transform: 'translateX(-50%)', justifyContent: 'initial',
    });
  };
  const removeArriveChip = (): void => {
    arriveChip?.remove();
    arriveChip = null;
  };
  const showArriveChip = (seatId: string, gen: number, retry = false): HTMLDivElement | null => {
    removeArriveChip();
    if (disposed) return null;
    const controls = document.createElement('div');
    controls.setAttribute('role', 'group');
    Object.assign(controls.style, {
      position: 'absolute',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', zIndex: '4',
    } as Partial<CSSStyleDeclaration>);

    const seat = expandedSeatById.get(seatId);
    const section = seat?.sectionId ? model.sections.find((candidate) => candidate.id === seat.sectionId) : undefined;
    const seatLabel = seat?.label ?? seatId;
    controls.setAttribute('aria-label', `Explore views near ${section?.label ? `${section.label}, ` : ''}seat ${seatLabel}`);
    const location = document.createElement('span');
    location.textContent = ['Live 3D seat view', section?.label, seatLabel].filter(Boolean).join(' · ');
    Object.assign(location.style, {
      maxWidth: 'min(320px, calc(100vw - 32px))', padding: '5px 10px', borderRadius: '999px',
      overflow: 'hidden', color: '#d9e3f5', background: 'rgba(12,18,32,0.72)',
      font: '600 11px/1.2 inherit', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      backdropFilter: 'blur(6px)',
    } as Partial<CSSStyleDeclaration>);
    controls.appendChild(location);
    const actions = document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    } as Partial<CSSStyleDeclaration>);
    controls.appendChild(actions);
    const row = seat?.rowId ? seatIdsByRow.get(seat.rowId) : undefined;
    const at = row?.indexOf(seatId) ?? -1;
    const neighbours = at >= 0 ? [row?.[at - 1], row?.[at + 1]] : [undefined, undefined];
    const addButton = (label: string, ariaLabel: string, action: () => void, primary = false): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', ariaLabel);
      Object.assign(button.style, {
        minHeight: '44px', padding: primary ? '10px 16px' : '10px',
        borderRadius: '999px', background: 'rgba(12,18,32,0.78)', color: '#eef1f8',
        border: '1px solid rgba(150,165,205,0.4)', backdropFilter: 'blur(6px)',
        font: '600 13px/1 inherit', cursor: 'pointer', whiteSpace: 'nowrap',
      } as Partial<CSSStyleDeclaration>);
      if (!primary) button.style.minWidth = '44px';
      if (primary) button.dataset.panoramaTrigger = '';
      button.addEventListener('click', action);
      actions.appendChild(button);
    };
    if (neighbours[0]) {
      const label = expandedSeatById.get(neighbours[0])?.label ?? neighbours[0];
      addButton('‹', `View previous seat ${label}`, () => { void flyToSeat(neighbours[0]!); });
    }
    if (opts.getSeatView) {
      addButton(retry ? '↻ Retry 360° panorama' : '◉ Open 360° panorama', `${retry ? 'Retry' : 'Open'} the 360° panorama from seat ${seatLabel}`, () => {
        if (disposed || gen !== flightGen) { removeArriveChip(); return; }
        removeArriveChip();
        void openPanorama(seatId, 400, gen);
      }, true);
    }
    if (neighbours[1]) {
      const label = expandedSeatById.get(neighbours[1])?.label ?? neighbours[1];
      addButton('›', `View next seat ${label}`, () => { void flyToSeat(neighbours[1]!); });
    }
    if (!actions.childElementCount) return null;
    container.appendChild(controls);
    arriveChip = controls;
    layoutArriveChip();
    return controls;
  };

  // --- explicit navigation mode ----------------------------------------------
  // Panning existed from day one, but only behind Shift/right/middle drag and
  // two fingers. That made the venue feel bolted to its dark ground plane. Keep
  // both gestures visible and make Move the default once a stand is entered.
  const navigationModeChip = document.createElement('div');
  navigationModeChip.setAttribute('role', 'group');
  navigationModeChip.setAttribute('aria-label', '3D navigation mode');
  Object.assign(navigationModeChip.style, {
    position: 'absolute', left: '14px', top: '62px', display: 'flex', gap: '3px',
    padding: '3px', borderRadius: '999px', zIndex: '4',
    background: 'rgba(12,18,32,0.72)', border: '1px solid rgba(150,165,205,0.35)',
    backdropFilter: 'blur(6px)',
  } as Partial<CSSStyleDeclaration>);
  const rotateModeButton = document.createElement('button');
  rotateModeButton.type = 'button';
  rotateModeButton.textContent = '↻ Rotate';
  rotateModeButton.setAttribute('aria-label', 'Drag to rotate the 3D venue');
  const moveModeButton = document.createElement('button');
  moveModeButton.type = 'button';
  moveModeButton.textContent = '✥ Move';
  moveModeButton.setAttribute('aria-label', 'Drag to move the 3D venue left, right, up or down');
  const zoomOutButton = document.createElement('button');
  zoomOutButton.type = 'button';
  zoomOutButton.textContent = '−';
  zoomOutButton.setAttribute('aria-label', 'Zoom out of the 3D venue');
  zoomOutButton.title = 'Zoom out';
  const zoomInButton = document.createElement('button');
  zoomInButton.type = 'button';
  zoomInButton.textContent = '+';
  zoomInButton.setAttribute('aria-label', 'Zoom into the 3D venue');
  zoomInButton.title = 'Zoom in';
  for (const button of [rotateModeButton, moveModeButton, zoomOutButton, zoomInButton]) {
    Object.assign(button.style, {
      minHeight: '34px', padding: '6px 10px', border: '0', borderRadius: '999px',
      color: '#c9d4ea', background: 'transparent', font: '600 11px/1 inherit',
      cursor: 'pointer', whiteSpace: 'nowrap',
    } as Partial<CSSStyleDeclaration>);
    if (button === zoomOutButton || button === zoomInButton) {
      button.style.minWidth = '34px';
      button.style.padding = '6px';
      button.style.fontSize = '17px';
    }
    navigationModeChip.appendChild(button);
  }
  const setNavigationMode = (mode: 'orbit' | 'pan'): void => {
    orbit.setPrimaryDragMode(mode);
    const rotateActive = mode === 'orbit';
    rotateModeButton.setAttribute('aria-pressed', String(rotateActive));
    moveModeButton.setAttribute('aria-pressed', String(!rotateActive));
    rotateModeButton.style.background = rotateActive ? 'rgba(96,110,150,0.48)' : 'transparent';
    moveModeButton.style.background = rotateActive ? 'transparent' : 'rgba(96,110,150,0.48)';
    navigationModeChip.title = rotateActive
      ? 'Drag to rotate · Shift-drag to move'
      : 'Drag to move · Shift-drag to rotate';
  };
  rotateModeButton.addEventListener('click', () => setNavigationMode('orbit'));
  moveModeButton.addEventListener('click', () => setNavigationMode('pan'));
  zoomOutButton.addEventListener('click', () => orbit.zoomBy(1.22));
  zoomInButton.addEventListener('click', () => orbit.zoomBy(0.82));
  setNavigationMode('orbit');
  container.appendChild(navigationModeChip);

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
  const focusOverview = (): void => {
    // The panorama owns the screen whenever it is up. Guarding on `frozen`
    // alone was equivalent only while every panorama froze the loop; the
    // in-scene sphere deliberately does not, so ask about the panorama itself.
    if (disposed) return;
    if (panorama) {
      panorama.dispose();
      panorama = null;
      analytics.panoramaClosed();
    }
    panoramaLoadAbort?.abort();
    panoramaLoadAbort = null;
    restorePanoramaLayer();
    overviewChip.style.display = '';
    labelOverlay.setVisible(true);
    frozen = false;
    cancelFlight();
    removeArriveChip();
    setNavigationMode('orbit');
    if (reducedMotion()) orbit.frame(model.bounds, false, stageAzimuth, opts.portraitOverviewCrop === true);
    else orbit.frameSoft(model.bounds, stageAzimuth, opts.portraitOverviewCrop === true);
    opts.onViewTargetChange?.(null);
    showSectionSeatLabels(null);
    opts.onSectionFocusChange?.(null);
    loop.requestRender();
  };
  overviewChip.addEventListener('click', focusOverview);
  container.appendChild(overviewChip);

  const openPanorama = async (seatId: string, fadeMs: number, gen: number): Promise<void> => {
    panoramaLoadAbort?.abort();
    const loadAbort = new AbortController();
    panoramaLoadAbort = loadAbort;
    const seatIndex = model.seats.idToIndex.get(seatId);
    if (seatIndex === undefined) { orbit.syncFromCamera(); return; }
    const seatLabel = expandedSeatById.get(seatId)?.label ?? seatId;
    const seatPose = resolvedSeatViewPose(seatId, seatIndex);
    const viewPromise = ensureSeatView(seatId);
    if (!viewPromise) {
      loadAbort.abort();
      if (panoramaLoadAbort === loadAbort) panoramaLoadAbort = null;
      orbit.syncFromCamera();
      return;
    } // no panorama source
    frozen = true;
    loop.stop(); // freeze the GL at the seat pose; panorama fades in over it
    let view: SeatView;
    try {
      view = await viewPromise;
    } catch {
      if (panoramaLoadAbort === loadAbort) panoramaLoadAbort = null;
      analytics.panoramaFailed(seatId, 'source');
      // Only unfreeze if we still own the flight — a retarget during the await
      // has already reset `frozen` and taken over the loop.
      if (!disposed && gen === flightGen) {
        frozen = false;
        orbit.resumeAfterFlight(seatPose.focal);
        loop.requestRender();
        const controls = showArriveChip(seatId, gen, true);
        requestAnimationFrame(() => controls?.querySelector<HTMLButtonElement>('[data-panorama-trigger]')?.focus());
      }
      return;
    }
    // Superseded during the await (retarget/cancel) or disposed: bail WITHOUT
    // touching frozen/loop — the newer flight owns the freeze state now, and
    // mounting this stale seat's panorama would be wrong.
    if (disposed || gen !== flightGen) {
      loadAbort.abort();
      if (panoramaLoadAbort === loadAbort) panoramaLoadAbort = null;
      return;
    }
    removeArriveChip();
    const onClose = (): void => {
      loadAbort.abort();
      if (panoramaLoadAbort === loadAbort) panoramaLoadAbort = null;
      panorama = null;
      restorePanoramaLayer();
      overviewChip.style.display = '';
      labelOverlay.setVisible(true);
      frozen = false;
      analytics.panoramaClosed();
      orbit.resumeAfterFlight(seatPose.focal);
      loop.requestRender();
      // Back in the live scene at the seat — offer the 360 again.
      const controls = showArriveChip(seatId, flightGen);
      requestAnimationFrame(() => controls?.querySelector<HTMLButtonElement>('[data-panorama-trigger]')?.focus());
    };
    // Prefer the in-scene sphere: it keeps the loop running, so the arrival is a
    // cross-fade between two views of the same place from the same camera
    // rather than a bitmap dropped over a frozen frame. It needs the image to
    // decode and a GL context that still exists, so it can decline — and the
    // DOM viewer stays as the fallback because a 360 that fails to mount must
    // never leave the buyer worse off than no 360 at all.
    // A GENERATED panorama is a 2048×1024 picture of the very scene already on
    // screen. Through a 106° window on a 3072-device-pixel viewport that is a
    // 5× magnification of ~600 source pixels, and it reads soft next to the
    // arrival frame the buyer was just looking at. So it is not drawn: the
    // camera looks around the real geometry instead, which is sharp at any
    // field of view and gets better every time the scene does. Real photographs
    // still go on the sphere, where their 5760–8192 px capture has detail worth
    // showing.
    const sceneMode = view.generated === true;
    const disclosure = seatViewDisclosure(view);
    raisePanoramaLayer();
    overviewChip.style.display = 'none';
    const effectiveFadeMs = reducedMotion() ? 0 : fadeMs;
    const spherical = gpu && !contextLost
      ? await mountPanoramaSphere(container, sceneMode ? null : view, {
        gl: glctx.gl,
        scene: gpu.main,
        camera: orbit.camera,
        requestRender: () => loop.requestRender(),
        cameraOriginWorld: sceneMode ? seatPose.eye : undefined,
        focalWorld: seatPose.focal,
      }, { fadeMs: effectiveFadeMs, seatLabel, disclosure, onClose, signal: loadAbort.signal })
      : null;
    // Superseded while the image was decoding — the newer flight owns the state.
    if (disposed || gen !== flightGen) {
      loadAbort.abort();
      if (panoramaLoadAbort === loadAbort) panoramaLoadAbort = null;
      spherical?.dispose();
      overviewChip.style.display = '';
      restorePanoramaLayer();
      return;
    }
    if (spherical) {
      // The venue keeps rendering behind the sphere, so the freeze that the DOM
      // path depends on must be lifted or the cross-fade has nothing to fade
      // from. The sphere itself pins the camera.
      //
      // Sync orbit to where the flight actually parked the camera FIRST. Its
      // damped pose is still whatever it was before the flight, so the next
      // `orbit.update()` would read that as movement, call `applyPosition()`
      // and yank the camera off the seat mid-fade. Syncing equalises pose and
      // target so `update()` reports "not moving" and leaves the camera alone —
      // which is what makes it safe to run the loop at all here.
      orbit.syncFromCamera();
      // Labels are DOM and the sphere is GL, so every row and seat label would
      // otherwise float on top of the panorama.
      labelOverlay.setVisible(false);
      frozen = false;
      loop.requestRender();
      panorama = spherical;
    } else {
      analytics.panoramaFallback(seatId);
      panorama = mountPanorama(container, view, {
        fadeMs: effectiveFadeMs, seatLabel, disclosure, onClose, signal: loadAbort.signal,
      });
    }
    analytics.panoramaOpened();
  };

  const cancelFlight = (): void => {
    flightGen++; // supersede any pending .then(openPanorama)
    panoramaLoadAbort?.abort();
    panoramaLoadAbort = null;
    if (cinematic.active) {
      cinematic.cancel();
      orbit.resumeAfterFlight(model.focalWorld);
    }
  };

  const flyToSeat = (seatId: string): Promise<void> => {
    if (disposed || !gpu) return Promise.resolve();
    const idx = model.seats.idToIndex.get(seatId);
    if (idx === undefined) return Promise.resolve();
    opts.onViewTargetChange?.(seatId);
    // Reset the freeze unconditionally: a previous flight may have set frozen=true
    // inside openPanorama's pre-await window without a panorama ever mounting.
    if (panorama) {
      panorama.dispose();
      panorama = null;
      overviewChip.style.display = '';
      restorePanoramaLayer();
    }
    panoramaLoadAbort?.abort();
    panoramaLoadAbort = null;
    frozen = false;

    const gen = ++flightGen;
    removeArriveChip();
    const { eye: seatEye, focal } = resolvedSeatViewPose(seatId, idx);
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
      orbit.resumeAfterFlight(focal);
      loop.requestRender();
      showArriveChip(seatId, gen);
    });
  };

  /** Enter the stand itself. This is intentionally separate from picking a
   * ticket: overview tap → section, focused-section tap → seat. */
  const focusSectionCamera = (sectionId: string): boolean => {
    const sec = model.sections.find((candidate) => candidate.id === sectionId);
    if (!sec || sec.seatCount === 0) return false;
    cinematic.cancel();
    removeArriveChip();
    setNavigationMode('pan');
    showSectionSeatLabels(sectionId);
    const dx = sec.focalWorld[0] - sec.center[0];
    const dz = sec.focalWorld[2] - sec.center[2];
    const azimuth = Math.hypot(dx, dz) > sec.radius * 0.12 ? Math.atan2(dx, dz) : undefined;
    // Deliberately crop the section edges: this is an ENTER-section action,
    // not a second overview. Seats become practical tap targets and the row /
    // sampled seat numbers are readable.
    orbit.frame({ center: sec.center, radius: Math.max(5, sec.radius * 0.5) }, false, azimuth);
    opts.onSectionFocusChange?.(sectionId);
    loop.requestRender();
    return true;
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
  /**
   * Pick the visible seat target nearest a tap while drilled into a section.
   *
   * The overview uses the O(1) GPU colour pass. In a close raked section the
   * chair/deck depth geometry can win that pass even though the buyer clearly
   * tapped the large seat dot. Projecting just the focused section's seats is a
   * bounded, tap-only fallback (normally a few hundred points) and, critically,
   * prevents the neighbouring tier retained for context from stealing the tap.
   */
  const pickNearestProjectedSeat = (
    clientX: number,
    clientY: number,
    sectionId: string | null,
    maxDistance: number,
    bookableOnly: boolean,
  ): number => {
    const rect = glctx.canvas.getBoundingClientRect();
    const width = glctx.canvas.clientWidth || rect.width || 1;
    const height = glctx.canvas.clientHeight || rect.height || 1;
    const tapX = clientX - rect.left;
    const tapY = clientY - rect.top;
    // The caller chooses a section/overview tolerance. Distance wins; depth
    // only breaks near-ties.
    const maxDistanceSq = maxDistance * maxDistance;
    let bestIndex = -1;
    let bestDistanceSq = maxDistanceSq;
    let bestDepth = Infinity;
    for (const seat of input.seats) {
      if (sectionId && seat.sectionId !== sectionId) continue;
      const index = model.seats.idToIndex.get(seat.id);
      if (index === undefined) continue;
      // The focused view is a buying surface, not an inventory inspector. Snap
      // the finger target to the nearest bookable (or already-selected) seat;
      // held, sold and filtered seats stay visible but cannot produce a dead
      // optimistic pick that the authoritative picker immediately rejects.
      if (bookableOnly) {
        const state = Math.round(model.seats.iState[index] ?? 0);
        if (state !== 0 && state !== 3) continue;
      }
      const offset = index * 3;
      const screen = projectToScreen(
        orbit.camera.projectionViewMatrix as unknown as ArrayLike<number>,
        [
          model.seats.iPosition[offset],
          // Match the visible chair/number rather than the deck-level instance
          // origin. At strong zoom the vertical difference is dozens of pixels
          // and a perfectly reasonable click on the chair otherwise misses.
          model.seats.iPosition[offset + 1] + 0.55,
          model.seats.iPosition[offset + 2],
        ],
        width,
        height,
      );
      if (!screen.visible) continue;
      const dx = screen.x - tapX;
      const dy = screen.y - tapY;
      const distanceSq = dx * dx + dy * dy;
      if (
        distanceSq < bestDistanceSq
        || (Math.abs(distanceSq - bestDistanceSq) < 1 && screen.depth < bestDepth)
      ) {
        bestIndex = index;
        bestDistanceSq = distanceSq;
        bestDepth = screen.depth;
      }
    }
    return bestIndex;
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== downId) return;
    const isTap = !moved && performance.now() - downT < TAP_MS;
    downId = -1;
    if (suppressTap) { suppressTap = false; return; }
    if (!isTap || !gpu || !pick) return;
    let idx = focusedSectionId
      ? pickNearestProjectedSeat(e.clientX, e.clientY, focusedSectionId, 44, true)
      : -1;
    if (focusedSectionId && idx < 0) {
      // A buyer may wheel back out instead of pressing Overview. In that case
      // the first section is still the active seat-picking scope, but other
      // stands are visible and should remain valid navigation targets. If the
      // tap misses a bookable seat in the active section, transfer focus to the
      // visible stand under the pointer rather than silently retaining the old
      // section forever.
      // This is a stand-navigation target, not an exact ticket target: allow a
      // little space around dots so the tier/deck itself still feels clickable.
      const sectionIndex = pickNearestProjectedSeat(e.clientX, e.clientY, null, 72, false);
      const sectionSeatId = sectionIndex >= 0 ? seatIdByIndex[sectionIndex] : undefined;
      const nextSectionId = sectionSeatId ? sectionIdBySeatId.get(sectionSeatId) : undefined;
      if (nextSectionId && nextSectionId !== focusedSectionId && focusSectionCamera(nextSectionId)) return;
    }
    if (!focusedSectionId) {
      pick.syncFromSeatProgram(gpu.seatProgram);
      const rect = glctx.canvas.getBoundingClientRect();
      const dpr = glctx.renderer.dpr;
      const { x, y } = pickPixelCoords(e.clientX, e.clientY, rect, dpr, glctx.gl.drawingBufferWidth, glctx.gl.drawingBufferHeight);
      const radius = Math.max(2, Math.round(8 * dpr));
      idx = pick.pick(orbit.camera, x, y, radius);
      // Labels and the gaps between overview dots are still visibly part of a
      // stand. If the exact GPU mask misses, use a larger section-level target.
      if (idx < 0) idx = pickNearestProjectedSeat(e.clientX, e.clientY, null, 42, false);
      const overviewSeatId = idx >= 0 ? seatIdByIndex[idx] : undefined;
      const sectionId = overviewSeatId ? sectionIdBySeatId.get(overviewSeatId) : undefined;
      if (sectionId && focusSectionCamera(sectionId)) return;
    }
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
    focusOverview,
    resize() {
      const { width, height } = glctx.resize();
      orbit.setAspect(width / Math.max(1, height));
      layoutArriveChip();
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
      setNavigationMode('orbit');
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
      setNavigationMode('orbit');
      showSectionSeatLabels(null);
      opts.onSectionFocusChange?.(null);
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
      return focusSectionCamera(sectionId);
    },
    rows(sectionId?: string): SceneRow[] {
      return sectionId ? model.rows.filter((row) => row.sectionId === sectionId) : model.rows;
    },
    seatsInRow(rowId: string): Array<{ id: string; label: string }> {
      return input.seats
        .filter((seat) => seat.rowId === rowId)
        .map((seat) => ({ id: seat.id, label: seat.displayLabel || seat.label }));
    },
    focusRow(rowId: string): boolean {
      const row = model.rows.find((candidate) => candidate.id === rowId);
      if (!row || row.seatCount === 0) return false;
      cinematic.cancel();
      setNavigationMode('pan');
      if (row.sectionId) {
        showSectionSeatLabels(row.sectionId);
        opts.onSectionFocusChange?.(row.sectionId);
      }
      orbit.frame({ center: row.center, radius: Math.max(2.5, row.radius * 0.65) });
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
      navigationModeChip.remove();
      cancelFlight();
      loop.stop();
      labelOverlay.dispose();
      ro?.disconnect();
      if (panorama) { panorama.dispose(); panorama = null; }
      restorePanoramaLayer();
      restoreContainerPosition();
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

  analytics.opened(model.seatCount, hasHeights, input.prepared?.buildMs ?? performance.now() - buildStartedAt);
  return handle;
}
