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

export interface SeatView {
  url: string;
  /** Bearing (deg, 0 = facing the focal/stage) the panorama should open centred
   * on, to match the camera's final yaw. Default 0 (both face the stage). */
  initialBearingDeg?: number;
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
  onClose?: () => void;
}

export function mountPanorama(container: HTMLElement, view: SeatView, opts: PanoramaOptions = {}): PanoramaHandle {
  const fadeMs = opts.fadeMs ?? 400;
  const bearing = view.initialBearingDeg ?? 0;

  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', opts.seatLabel ? `View from ${opts.seatLabel}` : 'View from seat');
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '10', opacity: '0',
    transition: `opacity ${fadeMs}ms ease`, background: '#05070c',
    overflow: 'hidden', touchAction: 'none',
  } as CSSStyleDeclaration);

  const pano = document.createElement('div');
  Object.assign(pano.style, {
    position: 'absolute', inset: '0',
    backgroundImage: `url("${view.url}")`, backgroundRepeat: 'repeat-x',
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

  // Layout: window a ~70° vertical slice of the sphere (horizon-centred) so the
  // venue fills the frame instead of floating in dead sky + black floor. The
  // image is scaled so that slice is exactly the viewport height; width scales by
  // the same factor, so `bearingToOffsetPx` stays correct. `pitchPx` is the
  // vertical drag deviation from the horizon, clamped to ±35°.
  let bgW = 0;
  let bgH = 0;
  let posX = 0;
  let pitchPx = 0;
  const layout = (): void => {
    const vh = root.clientHeight || 1;
    const vw = root.clientWidth || 1;
    const natW = img.naturalWidth || vw * 2;
    const natH = img.naturalHeight || vh;
    bgH = windowedBgHeight(vh);
    bgW = bgH * (natW / natH);
    pano.style.backgroundSize = `${bgW}px ${bgH}px`;
    if (!posInitialised) { posX = bearingToOffsetPx(bearing, vw, bgW); posInitialised = true; }
    pitchPx = clampPitchPx(pitchPx, bgH);
    pano.style.backgroundPosition = `${posX}px ${horizonOffsetPy(vh, bgH, pitchPx)}px`;
  };
  let posInitialised = false;

  const applyPos = (): void => {
    const vh = root.clientHeight || 1;
    pitchPx = clampPitchPx(pitchPx, bgH);
    pano.style.backgroundPosition = `${posX}px ${horizonOffsetPy(vh, bgH, pitchPx)}px`;
  };

  const img = new Image();
  img.onload = layout;
  img.src = view.url;
  // If it's already cached, onload may not fire — lay out on next frame too.
  requestAnimationFrame(layout);

  // Pan: horizontal (repeat-x wraps seamlessly) + vertical pitch (clamped ±35°).
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onDown = (e: PointerEvent): void => {
    dragging = true; lastX = e.clientX; lastY = e.clientY; pano.style.cursor = 'grabbing';
    try { pano.setPointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    posX += e.clientX - lastX;
    pitchPx += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyPos();
  };
  const onUp = (e: PointerEvent): void => {
    dragging = false; pano.style.cursor = 'grab';
    try { pano.releasePointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
  };
  pano.addEventListener('pointerdown', onDown);
  pano.addEventListener('pointermove', onMove);
  pano.addEventListener('pointerup', onUp);
  pano.addEventListener('pointercancel', onUp);

  let closed = false;
  let disposed = false;
  let fadeTimer = 0;
  const removeListeners = (): void => {
    pano.removeEventListener('pointerdown', onDown);
    pano.removeEventListener('pointermove', onMove);
    pano.removeEventListener('pointerup', onUp);
    pano.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey);
  };
  const teardown = (): void => {
    if (fadeTimer) { window.clearTimeout(fadeTimer); fadeTimer = 0; }
    removeListeners();
    if (root.parentNode) root.parentNode.removeChild(root);
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
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
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
