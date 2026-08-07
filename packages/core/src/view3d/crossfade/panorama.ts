/**
 * Slice 3 hand-off — the DOM panorama overlay the fly-to-seat cinematic
 * dissolves into. Decoupled by design: the CALLER supplies the equirectangular
 * image (via mountVenue3D's getSeatView), so view3d never imports the app's
 * panorama generator and the chunk stays lean.
 *
 * Technique (mirrors SeatPicker.openSeatView, reimplemented small): an equirect
 * image panned with `repeat-x`; the initial horizontal offset is set so the
 * panorama's bearing matches the final camera yaw — the dissolve reads as the
 * same view sharpening, not a cut. CSS opacity fade is compositor-only.
 */

import type { SeatViewCoverage } from '../../core/types';
import {
  browserPanoramaConstraints,
  loadPanoramaImage,
  planPanoramaDelivery,
  schedulePanoramaUpgrade,
} from '../../view/panoramaDelivery';

export interface SeatView {
  url: string;
  /** Lightweight equirect used for first paint before `url` replaces it. */
  previewUrl?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  previewWidth?: number;
  previewHeight?: number;
  /**
   * True when `url` is a SYNTHESISED panorama rather than a real photograph.
   *
   * It decides which of two very different things the buyer gets, so the caller
   * must say rather than the renderer guess. A generated equirect is a picture
   * of a 3D scene the renderer already has: at 2048×1024 it covers 106° of
   * horizontal view in ~600 source pixels, which a 3072-device-pixel viewport
   * magnifies FIVE times, and no amount of art survives that. So a generated
   * view is not drawn as an image at all — the camera simply looks around the
   * real scene, which has no resolution ceiling.
   *
   * A real photo has no such substitute and goes on the sphere, where a 5760 or
   * 8192-wide capture has three to four times the detail to give.
   */
  generated?: boolean;
  /** Bearing (deg, 0 = facing the focal/stage) the panorama should open centred
   * on, to match the camera's final yaw. Default 0 (both face the stage). */
  initialBearingDeg?: number;
  /** Initial vertical orientation. Positive looks up; clamped to the viewer's
   * safe pitch range. Uploaded captures use this to match the live seat pose. */
  initialPitchDeg?: number;
  /** How specifically this image represents the selected inventory unit. */
  coverage?: SeatViewCoverage;
  /** ISO capture date/time when known. Unknown is preferable to invented age. */
  capturedAt?: string;
  /** Optional buyer-safe provenance, for example "Provided by the venue". */
  sourceLabel?: string;
}

/** Honest, compact buyer disclosure for the panorama currently on screen. */
export function seatViewDisclosure(view: SeatView): string {
  const coverage = view.generated
    ? 'Live 3D · exact seat-eye'
    : view.coverage === 'exact-seat'
      ? 'Exact seat photo'
      : view.coverage === 'row-representative'
        ? 'Representative row view'
        : view.coverage === 'section-representative'
          ? 'Representative section view'
          : view.coverage === 'venue-representative'
            ? 'Representative venue view'
            : 'Venue photo';
  const year = view.capturedAt && /^\d{4}/.test(view.capturedAt) ? view.capturedAt.slice(0, 4) : '';
  return [coverage, year ? `captured ${year}` : '', view.sourceLabel ?? ''].filter(Boolean).join(' · ');
}

/** True only when the panorama should be presented as organizer-authored media.
 * Representative AI demo assets travel through the same URL field as venue
 * photos, so provenance—not URL presence—must decide the buyer badge. */
export function isAuthoredSeatView(view: SeatView): boolean {
  if (view.generated) return false;
  const source = view.sourceLabel?.trim() ?? '';
  return !/^(?:AI[- ]generated|generated\s+(?:demo|preview))/i.test(source);
}

export interface PanoramaHandle {
  /** Fade out and return to the (frozen) 3D view; calls opts.onClose after. */
  close(): void;
  /** Immediate teardown (dispose) — no fade, no onClose. */
  dispose(): void;
}

/**
 * Vertical field of view (deg) the windowed panorama shows. The source image is
 * a full 180° equirect sphere; showing it raw wastes ~⅔ of the frame on dead sky
 * and black floor, with the horizon content band squished into the middle. We
 * instead scale the image so only this central slice fills the viewport height,
 * horizon-centred, and let the user drag pitch within ±`MAX_PITCH_DEG`.
 */
export const VFOV_DEG = 70;
export const MIN_VFOV_DEG = 35;
export const MAX_VFOV_DEG = 90;

/** Keep wheel, keyboard and pinch zoom inside a useful, non-disorienting range. */
export function clampPanoramaFov(fovDeg: number): number {
  return Math.max(MIN_VFOV_DEG, Math.min(MAX_VFOV_DEG, fovDeg));
}
/** Users may look this far up/down from the horizon; well inside the image so
 *  the clamp never reveals past its top/bottom edge. */
export const MAX_PITCH_DEG = 35;

/**
 * Horizontal background-position (px) that centres `bearingDeg` in the viewport,
 * assuming the equirect image's yaw 0 sits at its horizontal centre. `bgW` is the
 * full scaled image width representing 360° — so this is invariant to the vertical
 * FOV windowing (which scales width and height by the same factor). `repeat-x`
 * handles the wrap, so any real value is valid.
 */
export function bearingToOffsetPx(bearingDeg: number, viewportW: number, bgW: number): number {
  const col = (0.5 + bearingDeg / 360) * bgW; // image column (px) for the bearing
  return viewportW / 2 - col;
}

/**
 * Full scaled image height (px) so that a `vfovDeg`-tall slice fills `viewportH`.
 * The image spans 180° vertically, so height = viewportH · 180/vfov.
 */
export function windowedBgHeight(viewportH: number, vfovDeg: number = VFOV_DEG): number {
  return viewportH * (180 / vfovDeg);
}

/**
 * background-position Y (px) that centres the image's horizon (its vertical
 * centre) in the viewport, offset by `pitchPx` (deviation from the horizon,
 * clamped to ±`MAX_PITCH_DEG`). Positive `pitchPx` looks up.
 */
export function horizonOffsetPy(viewportH: number, bgH: number, pitchPx: number): number {
  return (viewportH - bgH) / 2 + clampPitchPx(pitchPx, bgH);
}

/** Clamp a pitch drag (px) to ±MAX_PITCH_DEG of image travel, and never past the
 *  image edge. `bgH` px map the full 180°, so a degree is `bgH/180` px. */
export function clampPitchPx(pitchPx: number, bgH: number): number {
  const limit = (MAX_PITCH_DEG / 180) * bgH;
  return Math.max(-limit, Math.min(limit, pitchPx));
}

export interface PanoramaOptions {
  fadeMs?: number;
  seatLabel?: string;
  disclosure?: string;
  onClose?: () => void;
  /** Cancels stale preview/full-resolution image work when a flight is retargeted. */
  signal?: AbortSignal;
}

export function mountPanorama(container: HTMLElement, view: SeatView, opts: PanoramaOptions = {}): PanoramaHandle {
  const fadeMs = opts.fadeMs ?? 400;
  const bearing = view.initialBearingDeg ?? 0;

  const delivery = planPanoramaDelivery(view, browserPanoramaConstraints());
  const loadAbort = new AbortController();
  const abortFromCaller = (): void => loadAbort.abort();
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const root = document.createElement('div');
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', opts.seatLabel ? `View from ${opts.seatLabel}` : 'View from seat');
  root.tabIndex = -1;
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '10', opacity: '0',
    transition: `opacity ${fadeMs}ms ease`, background: '#05070c',
    overflow: 'hidden', touchAction: 'none',
  } as CSSStyleDeclaration);

  const pano = document.createElement('div');
  Object.assign(pano.style, {
    position: 'absolute', inset: '0',
    backgroundImage: `url("${delivery.initialUrl}")`, backgroundRepeat: 'repeat-x',
    cursor: 'grab',
  } as CSSStyleDeclaration);
  root.appendChild(pano);

  // Close affordance.
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

  // Layout: window a ~70° vertical slice of the sphere (horizon-centred) so the
  // venue fills the frame instead of floating in dead sky + black floor. The
  // image is scaled so that slice is exactly the viewport height; width scales by
  // the same factor, so `bearingToOffsetPx` stays correct. `pitchPx` is the
  // vertical drag deviation from the horizon, clamped to ±35°.
  let bgW = 0;
  let bgH = 0;
  let posX = 0;
  let pitchPx = 0;
  let viewFov = VFOV_DEG;
  const layout = (): void => {
    const vh = root.clientHeight || 1;
    const vw = root.clientWidth || 1;
    const natW = img.naturalWidth || vw * 2;
    const natH = img.naturalHeight || vh;
    const centredImageRatio = bgW > 0 ? (vw / 2 - posX) / bgW : 0;
    const pitchRatio = bgH > 0 ? pitchPx / bgH : 0;
    bgH = windowedBgHeight(vh, viewFov);
    bgW = bgH * (natW / natH);
    pano.style.backgroundSize = `${bgW}px ${bgH}px`;
    if (!posInitialised) {
      posX = bearingToOffsetPx(bearing, vw, bgW);
      pitchPx = clampPitchPx(((view.initialPitchDeg ?? 0) / 180) * bgH, bgH);
      posInitialised = true;
    }
    else posX = vw / 2 - centredImageRatio * bgW;
    pitchPx = clampPitchPx(pitchRatio * bgH, bgH);
    pano.style.backgroundPosition = `${posX}px ${horizonOffsetPy(vh, bgH, pitchPx)}px`;
  };
  let posInitialised = false;

  const applyPos = (): void => {
    const vh = root.clientHeight || 1;
    pitchPx = clampPitchPx(pitchPx, bgH);
    pano.style.backgroundPosition = `${posX}px ${horizonOffsetPy(vh, bgH, pitchPx)}px`;
  };

  let img = new Image();
  img.onload = layout;
  img.src = delivery.initialUrl;
  let cancelUpgrade = (): void => {};
  if (delivery.upgradeUrl) {
    cancelUpgrade = schedulePanoramaUpgrade(() => {
      void loadPanoramaImage(delivery.upgradeUrl!, loadAbort.signal).then((full) => {
        if (disposed || loadAbort.signal.aborted) return;
        img = full;
        pano.style.backgroundImage = `url("${delivery.upgradeUrl}")`;
        layout();
      }).catch(() => { /* the preview remains usable */ });
    });
  }
  // If it's already cached, onload may not fire — lay out on next frame too.
  requestAnimationFrame(layout);

  // Pan: horizontal (repeat-x wraps seamlessly) + vertical pitch (clamped ±35°).
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
    layout();
  };
  const onDown = (e: PointerEvent): void => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = pointers.size === 1;
    lastX = e.clientX; lastY = e.clientY;
    if (pointers.size === 2) pinchDistance = distanceBetweenPointers();
    pano.style.cursor = 'grabbing';
    try { pano.setPointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
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
    posX += e.clientX - lastX;
    pitchPx += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyPos();
  };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchDistance = pointers.size === 2 ? distanceBetweenPointers() : 0;
    const remaining = pointers.values().next().value as { x: number; y: number } | undefined;
    dragging = pointers.size === 1;
    if (remaining) { lastX = remaining.x; lastY = remaining.y; }
    else pano.style.cursor = 'grab';
    try { pano.releasePointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    setViewFov(viewFov + e.deltaY * 0.04);
  };
  pano.addEventListener('pointerdown', onDown);
  pano.addEventListener('pointermove', onMove);
  pano.addEventListener('pointerup', onUp);
  pano.addEventListener('pointercancel', onUp);
  pano.addEventListener('wheel', onWheel, { passive: false });

  let closed = false;
  let disposed = false;
  let fadeTimer = 0;
  const removeListeners = (): void => {
    pano.removeEventListener('pointerdown', onDown);
    pano.removeEventListener('pointermove', onMove);
    pano.removeEventListener('pointerup', onUp);
    pano.removeEventListener('pointercancel', onUp);
    pano.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
  };
  const teardown = (): void => {
    cancelUpgrade();
    loadAbort.abort();
    opts.signal?.removeEventListener('abort', abortFromCaller);
    if (fadeTimer) { window.clearTimeout(fadeTimer); fadeTimer = 0; }
    removeListeners();
    if (root.parentNode) root.parentNode.removeChild(root);
    if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.style.opacity = '0';
    // Guard the fade callback: a dispose() (or a retarget that disposes us) inside
    // the fade window clears the timer AND flips `disposed`, so a stray fire can
    // never call onClose into a newer flight/panorama.
    const done = (): void => {
      fadeTimer = 0;
      if (disposed) return;
      teardown();
      opts.onClose?.();
    };
    fadeTimer = window.setTimeout(done, fadeMs);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus({ preventScroll: true }); return; }
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      posX += e.key === 'ArrowLeft' ? -32 : 32;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      pitchPx += (e.key === 'ArrowUp' ? 4 : -4) * (bgH / 180);
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
    applyPos();
  };
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);

  // Fade in on the next frame (0 → 1).
  requestAnimationFrame(() => { root.style.opacity = '1'; });

  return {
    close,
    dispose(): void { closed = true; disposed = true; teardown(); },
  };
}
