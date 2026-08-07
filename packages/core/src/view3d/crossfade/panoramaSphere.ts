/**
 * The panorama, mounted as scene geometry instead of as a div over a corpse.
 *
 * `panorama.ts` (still here, still used as the fallback) freezes the render loop
 * and fades a `repeat-x` bitmap over the last WebGL frame. This mounts the same
 * image on the inward-facing sphere from `scene/panoSphere.ts`, leaves the loop
 * running, and moves the camera instead of a background-position. Three things
 * follow from that, and they are the reason for the rewrite:
 *
 *  - It is a real sphere. Pitch is a camera rotation, not a vertical translation
 *    of a flat bitmap, so verticals stay vertical and nothing stretches away
 *    from the horizon.
 *  - The venue is still being drawn underneath, so the arrival is a CROSS-FADE
 *    between two views of the same place from the same camera, not a cut
 *    between two rendering technologies.
 *  - Escape/close costs nothing to reverse: the camera is already where it needs
 *    to be, because it never went anywhere.
 *
 * The DOM chrome (close button, hint, dialog semantics) is kept deliberately —
 * it is the accessible surface, and none of it belongs in GL.
 */

import { createPanoSphere, bearingPitchToDirection, type PanoSphereHandle } from '../scene/panoSphere';
import type { PanoramaHandle, PanoramaOptions, SeatView } from './panorama';
import { clampPanoramaFov, MAX_PITCH_DEG, VFOV_DEG } from './panorama';
import type { OGLRenderingContext, Transform, Camera } from 'ogl';
import {
  browserPanoramaConstraints,
  loadPanoramaImage,
  planPanoramaDelivery,
  schedulePanoramaUpgrade,
} from '../../view/panoramaDelivery';

/**
 * Degrees of look per pixel dragged. Matched to the DOM viewer's feel: a drag
 * across the full width of a 1200 px viewport turns roughly 180°.
 */
const DEG_PER_PX = 0.15;

export interface PanoramaSceneDeps {
  gl: OGLRenderingContext;
  /** The scene the venue is drawn into; the sphere joins it and leaves on close. */
  scene: Transform;
  camera: Camera;
  /** Ask for another frame — the loop is render-on-demand, not free-running. */
  requestRender(): void;
  /**
   * Exact world-space eye point for scene mode. The camera is moved here while
   * the buyer looks around, then restored to the cinematic arrival on close.
   */
  cameraOriginWorld?: readonly [number, number, number];
  /**
   * The venue focal (stage/pitch centre) in world metres.
   *
   * Only scene mode needs it, and it genuinely cannot do without it. A generated
   * panorama is DRAWN with the stage at bearing 0, so opening at bearing 0 faces
   * the stage for free. The real scene has no such convention — bearing 0 is
   * world −Z, which points wherever the venue happened to be authored — so
   * opening there stares at whatever is behind the buyer. The bearing is derived
   * from the seat's own line to the focal instead.
   */
  focalWorld?: readonly [number, number, number];
}

/**
 * Mount the panorama sphere. Returns null if the image cannot be decoded, so the
 * caller can fall back to the DOM viewer rather than stranding the buyer on a
 * black screen — a 360 that fails to load must never be worse than no 360.
 */
export async function mountPanoramaSphere(
  container: HTMLElement,
  // NULL means "look around the real scene": no image, no sphere, just the
  // camera at the seat. That is the right answer for a generated panorama,
  // which is only ever a low-resolution picture of the geometry already on
  // screen — see `SeatView.generated`. Everything else below (framing,
  // look-around, Escape, restoring the camera) is identical, which is why the
  // two modes share one code path rather than diverging into two viewers that
  // drift apart.
  view: SeatView | null,
  deps: PanoramaSceneDeps,
  opts: PanoramaOptions = {},
): Promise<PanoramaHandle | null> {
  const fadeMs = opts.fadeMs ?? 400;
  let bearing = view?.initialBearingDeg ?? 0;
  let pitch = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, view?.initialPitchDeg ?? 0));
  let viewFov = VFOV_DEG;
  let disposed = false;
  const loadAbort = new AbortController();
  const abortFromCaller = (): void => loadAbort.abort();
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
  let cancelUpgrade = (): void => {};

  // Scene mode is the real venue viewed from the selected seat, not from the
  // deliberately flattering cinematic arrival behind and above it. Preserve
  // that arrival so closing 360 returns to the exact pre-view camera.
  const priorPosition: [number, number, number] = [
    deps.camera.position.x,
    deps.camera.position.y,
    deps.camera.position.z,
  ];
  if (!view && deps.cameraOriginWorld) {
    deps.camera.position.set(
      deps.cameraOriginWorld[0],
      deps.cameraOriginWorld[1],
      deps.cameraOriginWorld[2],
    );
  }

  // Scene mode opens on the stage, derived from where this seat actually is.
  // The pitch matters as much as the yaw: from a balcony the stage is well below
  // eye level, and opening level puts the whole venue in the bottom of the frame
  // with dead air above it.
  if (!view && deps.focalWorld) {
    const p = deps.camera.position;
    const dx = deps.focalWorld[0] - p.x;
    const dy = deps.focalWorld[1] - p.y;
    const dz = deps.focalWorld[2] - p.z;
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-3) {
      bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      pitch = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, (Math.atan2(dy, flat) * 180) / Math.PI));
    }
  }

  let sphere: PanoSphereHandle | null = null;
  if (view) {
    const maxTextureSize = deps.gl.getParameter(deps.gl.MAX_TEXTURE_SIZE) as number;
    const delivery = planPanoramaDelivery(view, browserPanoramaConstraints(maxTextureSize));
    let image: HTMLImageElement;
    try {
      image = await loadPanoramaImage(delivery.initialUrl, loadAbort.signal);
    } catch {
      opts.signal?.removeEventListener('abort', abortFromCaller);
      return null;
    }
    try {
      sphere = createPanoSphere(deps.gl, image);
    } catch {
      loadAbort.abort();
      opts.signal?.removeEventListener('abort', abortFromCaller);
      return null;
    }
    // Drawn last and without depth, so it composites over the venue during the
    // fade instead of being occluded by whatever sits between the camera and
    // the far wall of the sphere.
    sphere.mesh.renderOrder = 999;
    sphere.mesh.setParent(deps.scene);
    if (delivery.upgradeUrl) {
      cancelUpgrade = schedulePanoramaUpgrade(() => {
        void loadPanoramaImage(delivery.upgradeUrl!, loadAbort.signal).then((full) => {
          if (disposed || loadAbort.signal.aborted) return;
          sphere?.setImage(full);
          deps.requestRender();
        }).catch(() => { /* retain the decoded preview */ });
      });
    }
  }

  // A cinematic flight ENDS pushed in — it narrows the FOV to close the last of
  // the distance to the seat, and `resumeAfterFlight` is what normally restores
  // it. The DOM viewer never noticed because it never used the camera; drawing
  // the panorama through that same camera inherits the zoom and magnifies the
  // equirect to a few unreadable degrees of arc.
  //
  // So the sphere sets its own field of view — the same 70° the DOM viewer
  // windowed to, which is what makes the two paths frame a panorama alike — and
  // puts back whatever it found on the way out, so closing hands the flight's
  // camera back exactly as it was.
  const priorFov = deps.camera.fov;
  deps.camera.perspective({ fov: viewFov, aspect: deps.camera.aspect });

  // Looking around REPLACES the camera's orientation, and orbit only re-aims on
  // a frame it considers "moving". So closing the panorama used to hand back a
  // camera still pointing wherever the buyer had dragged, at a venue that was no
  // longer in front of it — a black screen until the first orbit drag snapped it
  // home. Capture the orientation on the way in and put it back on the way out,
  // exactly as the FOV is handled.
  const priorQuat = deps.camera.quaternion.slice() as unknown as number[];

  /** Keep the camera at the sphere's exact centre — an equirect has no parallax,
   *  and any offset would shear the image. */
  const aim = (): void => {
    const p = deps.camera.position;
    sphere?.mesh.position.set(p.x, p.y, p.z);
    const [dx, dy, dz] = bearingPitchToDirection(bearing, pitch);
    deps.camera.lookAt([p.x + dx, p.y + dy, p.z + dz]);
    deps.requestRender();
  };
  aim();

  // --- chrome -------------------------------------------------------------
  const root = document.createElement('div');
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', opts.seatLabel ? `View from ${opts.seatLabel}` : 'View from seat');
  root.tabIndex = -1;
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '10',
    cursor: 'grab', touchAction: 'none',
  } as CSSStyleDeclaration);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    position: 'absolute', top: '12px', right: '12px', zIndex: '2',
    width: '44px', height: '44px', borderRadius: '999px', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(8,12,18,0.6)',
    color: '#e6edf3', fontSize: '15px', lineHeight: '1',
  } as CSSStyleDeclaration);
  root.appendChild(closeBtn);

  if (opts.disclosure) {
    const disclosure = document.createElement('div');
    disclosure.textContent = `360° panorama · ${opts.disclosure}`;
    Object.assign(disclosure.style, {
      position: 'absolute', top: '12px', left: '12px', zIndex: '2',
      maxWidth: 'calc(100% - 88px)', padding: '8px 11px', borderRadius: '999px',
      overflow: 'hidden', color: '#dce6f8', background: 'rgba(8,12,18,0.68)',
      font: '600 11px/1.2 ui-sans-serif, system-ui, sans-serif', textOverflow: 'ellipsis',
      whiteSpace: 'nowrap', pointerEvents: 'none', backdropFilter: 'blur(6px)',
    } as CSSStyleDeclaration);
    root.appendChild(disclosure);
  }

  const hint = document.createElement('div');
  hint.textContent = 'Drag to look · pinch or scroll to zoom · Esc to close';
  Object.assign(hint.style, {
    position: 'absolute', bottom: '12px', left: '0', right: '0', textAlign: 'center',
    color: 'rgba(230,237,243,0.7)', font: '12px ui-sans-serif, system-ui, sans-serif',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  root.appendChild(hint);
  container.appendChild(root);
  closeBtn.focus({ preventScroll: true });

  // --- look-around --------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pinchDistance = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  const distanceBetweenPointers = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const setViewFov = (nextFov: number): void => {
    const clamped = clampPanoramaFov(nextFov);
    if (clamped === viewFov) return;
    viewFov = clamped;
    deps.camera.perspective({ fov: viewFov, aspect: deps.camera.aspect });
    aim();
  };
  const onDown = (e: PointerEvent): void => {
    if (e.target === closeBtn) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = pointers.size === 1;
    lastX = e.clientX; lastY = e.clientY;
    if (pointers.size === 2) pinchDistance = distanceBetweenPointers();
    root.setPointerCapture?.(e.pointerId);
    root.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const nextDistance = distanceBetweenPointers();
      if (pinchDistance > 0 && nextDistance > 0) setViewFov(viewFov * (pinchDistance / nextDistance));
      pinchDistance = nextDistance;
      dragging = false;
      return;
    }
    if (!dragging) return;
    // Horizontal follows the HAND: drag right, turn right. The vertical below
    // stays grab-style (drag down to look up), which is the mix the owner asked
    // for after using it — and worth stating because it looks inconsistent in
    // the source and is not. The DOM viewer this replaces dragged the image on
    // both axes; the yaw was the one that read backwards in a real venue.
    bearing += (e.clientX - lastX) * DEG_PER_PX;
    // Clamped to the same ±35° the DOM viewer allowed. A generated panorama has
    // nothing meaningful at the poles, and letting the buyer tumble to straight
    // up reads as a broken control rather than a feature.
    pitch = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, pitch + (e.clientY - lastY) * DEG_PER_PX));
    lastX = e.clientX; lastY = e.clientY;
    aim();
  };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchDistance = pointers.size === 2 ? distanceBetweenPointers() : 0;
    const remaining = pointers.values().next().value as { x: number; y: number } | undefined;
    dragging = pointers.size === 1;
    if (remaining) { lastX = remaining.x; lastY = remaining.y; }
    else root.style.cursor = 'grab';
    try { root.releasePointerCapture?.(e.pointerId); } catch { /* pointer already released */ }
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    setViewFov(viewFov + e.deltaY * 0.04);
  };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  root.addEventListener('wheel', onWheel, { passive: false });

  // Escape closes. On `window`, not on `root`, because the hint promises it
  // unconditionally and a div only receives keys while focused — the DOM viewer
  // this replaces bound it the same way, and dropping it made the hint lie.
  // `stopPropagation` so the host page's own Escape handling (closing a modal,
  // leaving 3D) does not also fire on the same press.
  const onKey = (e: KeyboardEvent): void => {
    if (disposed) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      closeBtn.focus({ preventScroll: true });
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      handle.close();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      bearing += e.key === 'ArrowLeft' ? -4 : 4;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      pitch = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, pitch + (e.key === 'ArrowUp' ? 4 : -4)));
    } else if (e.key === '+' || e.key === '=') {
      setViewFov(viewFov - 5);
      e.preventDefault();
      return;
    } else if (e.key === '-') {
      setViewFov(viewFov + 5);
      e.preventDefault();
      return;
    } else {
      return;
    }
    e.preventDefault();
    aim();
  };
  window.addEventListener('keydown', onKey);

  // --- fade ---------------------------------------------------------------
  let raf = 0;
  const fadeTo = (target: number, done?: () => void): void => {
    // Scene mode has nothing to fade — the buyer is already looking at the
    // venue — so the transition is the FOV widening, not a dissolve.
    if (!sphere) { done?.(); return; }
    const from = target === 1 ? 0 : 1;
    const start = performance.now();
    const step = (): void => {
      if (disposed) return;
      const t = fadeMs <= 0 ? 1 : Math.min(1, (performance.now() - start) / fadeMs);
      sphere?.setOpacity(from + (target - from) * t);
      deps.requestRender();
      if (t < 1) raf = requestAnimationFrame(step);
      else done?.();
    };
    raf = requestAnimationFrame(step);
  };
  fadeTo(1);

  const teardown = (): void => {
    if (disposed) return;
    disposed = true;
    cancelUpgrade();
    loadAbort.abort();
    opts.signal?.removeEventListener('abort', abortFromCaller);
    cancelAnimationFrame(raf);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
    root.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    root.remove();
    if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
    sphere?.dispose();
    deps.camera.position.set(priorPosition[0], priorPosition[1], priorPosition[2]);
    deps.camera.perspective({ fov: priorFov, aspect: deps.camera.aspect });
    deps.camera.quaternion.set(priorQuat[0], priorQuat[1], priorQuat[2], priorQuat[3]);
    deps.requestRender();
  };

  const handle: PanoramaHandle = {
    close(): void {
      if (disposed) return;
      const finish = (): void => { teardown(); opts.onClose?.(); };
      cancelAnimationFrame(raf);
      fadeTo(0, finish);
    },
    dispose: teardown,
  };
  closeBtn.addEventListener('click', () => handle.close());
  return handle;
}
