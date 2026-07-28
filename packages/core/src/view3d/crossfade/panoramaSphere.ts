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
import { MAX_PITCH_DEG, VFOV_DEG } from './panorama';
import type { OGLRenderingContext, Transform, Camera } from 'ogl';

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

/** Load an image element, resolving only once it is decoded and safe to upload. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Panoramas are served from R2/CDN on another origin; without this the
    // texture upload taints nothing but simply fails on some browsers.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('panorama_image_failed'));
    img.src = url;
  });
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
  let pitch = 0;
  let disposed = false;

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
    let image: HTMLImageElement;
    try {
      image = await loadImage(view.url);
    } catch {
      return null;
    }
    try {
      sphere = createPanoSphere(deps.gl, image);
    } catch {
      return null;
    }
    // Drawn last and without depth, so it composites over the venue during the
    // fade instead of being occluded by whatever sits between the camera and
    // the far wall of the sphere.
    sphere.mesh.renderOrder = 999;
    sphere.mesh.setParent(deps.scene);
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
  deps.camera.perspective({ fov: VFOV_DEG, aspect: deps.camera.aspect });

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
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', opts.seatLabel ? `View from ${opts.seatLabel}` : 'View from seat');
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
    width: '34px', height: '34px', borderRadius: '999px', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(8,12,18,0.6)',
    color: '#e6edf3', fontSize: '15px', lineHeight: '1',
  } as CSSStyleDeclaration);
  root.appendChild(closeBtn);

  const hint = document.createElement('div');
  hint.textContent = 'Drag to look around · Esc to close';
  Object.assign(hint.style, {
    position: 'absolute', bottom: '12px', left: '0', right: '0', textAlign: 'center',
    color: 'rgba(230,237,243,0.7)', font: '12px ui-sans-serif, system-ui, sans-serif',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  root.appendChild(hint);
  container.appendChild(root);

  // --- look-around --------------------------------------------------------
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (e: PointerEvent): void => {
    if (e.target === closeBtn) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    root.setPointerCapture?.(e.pointerId);
    root.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent): void => {
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
  const onUp = (): void => { dragging = false; root.style.cursor = 'grab'; };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);

  // Escape closes. On `window`, not on `root`, because the hint promises it
  // unconditionally and a div only receives keys while focused — the DOM viewer
  // this replaces bound it the same way, and dropping it made the hint lie.
  // `stopPropagation` so the host page's own Escape handling (closing a modal,
  // leaving 3D) does not also fire on the same press.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || disposed) return;
    e.stopPropagation();
    handle.close();
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
    cancelAnimationFrame(raf);
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey);
    root.remove();
    sphere?.dispose();
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
