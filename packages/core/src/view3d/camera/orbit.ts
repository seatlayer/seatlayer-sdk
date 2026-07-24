/**
 * Orbit + dolly camera, damped, always centred on the venue focal point. Drag =
 * azimuth/polar; wheel/pinch = dolly. Touch: 1-finger orbit, 2-finger pinch
 * dolly (+ pan). No desktop pan for v1. Polar clamped [15°,80°]; distance clamped
 * to bounds-derived limits; initial framing = a 3/4 view fitted to bounds.
 */

import { Camera, Vec3 } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

const DEG = Math.PI / 180;
const POLAR_MIN = 15 * DEG;
const POLAR_MAX = 80 * DEG;
const DAMP = 0.12;
const FOV = 35;
/** Fit multiplier past a tight bounds-sphere fit. The 3/4 tilt makes the near
 * ground edge overhang below the fitted sphere, so a wide-shallow layout needs
 * more than a nominal 10% or its front row clips — this clears it while keeping
 * the venue centred with a comfortable margin. */
const FRAME_MARGIN = 1.25;

export interface OrbitBounds {
  center: [number, number, number];
  radius: number;
}

export class OrbitCamera {
  readonly camera: Camera;
  readonly fovY = FOV;
  private target = new Vec3();
  private azimuth = -30 * DEG;
  private polar = 55 * DEG;
  private distance = 10;
  private azT = -30 * DEG;
  private polT = 55 * DEG;
  private distT = 10;
  private minDist = 1;
  private maxDist = 100;
  private canvas: HTMLElement;
  private requestRender: () => void;
  /** Fired on the FIRST real user-driven orbit/dolly gesture (drag/wheel/pinch),
   * latched so it can drive a one-shot analytics event. Not the intro ease. */
  private onGesture?: () => void;
  private gestureFired = false;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private activePointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private onPointerDown: (e: PointerEvent) => void;
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerUp: (e: PointerEvent) => void;
  private onWheel: (e: WheelEvent) => void;

  constructor(gl: OGLRenderingContext, canvas: HTMLElement, requestRender: () => void, onGesture?: () => void) {
    this.camera = new Camera(gl, { fov: FOV, near: 0.1, far: 5000, aspect: 1 });
    this.canvas = canvas;
    this.requestRender = requestRender;
    this.onGesture = onGesture;

    this.onPointerDown = (e) => {
      // Guard: a synthetic/stale pointer id has no active pointer to capture.
      try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activePointers.size === 1) {
        this.dragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      } else if (this.activePointers.size === 2) {
        this.dragging = false;
        this.pinchDist = this.currentPinchDistance();
      }
    };
    this.onPointerMove = (e) => {
      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activePointers.size >= 2) {
        const d = this.currentPinchDistance();
        // Fingers apart (d grows) → zoom in (distance shrinks).
        if (this.pinchDist > 0) { this.dollyBy(Math.exp((this.pinchDist - d) * 0.005)); this.fireGesture(); }
        this.pinchDist = d;
        return;
      }
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (dx !== 0 || dy !== 0) this.fireGesture();
      this.azT -= dx * 0.006;
      this.polT = Math.max(POLAR_MIN, Math.min(POLAR_MAX, this.polT - dy * 0.006));
      this.requestRender();
    };
    this.onPointerUp = (e) => {
      this.activePointers.delete(e.pointerId);
      try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
      if (this.activePointers.size < 2) this.pinchDist = 0;
      if (this.activePointers.size === 0) this.dragging = false;
    };
    this.onWheel = (e) => {
      e.preventDefault();
      // Normalise wheel delta across px / line / page modes to ~±1 per notch,
      // then zoom multiplicatively so every notch makes a real difference.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const norm = (e.deltaY * unit) / 100;
      this.dollyBy(Math.exp(norm * 0.4));
      this.fireGesture();
    };

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** One-shot: notify the first real user gesture (drives 3d_orbit_engaged). */
  private fireGesture(): void {
    if (this.gestureFired) return;
    this.gestureFired = true;
    this.onGesture?.();
  }

  private currentPinchDistance(): number {
    const pts = [...this.activePointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /** Multiply target distance by `factor` (proportional zoom — same feel near
   * and far), clamped so you can swoop right down among the seats. */
  private dollyBy(factor: number): void {
    this.distT = Math.max(this.minDist, Math.min(this.maxDist, this.distT * factor));
    this.requestRender();
  }

  /**
   * Fit a flattering 3/4 view to the bounds sphere. With `intro`, the camera
   * STARTS nearly top-down (matching the 2D map's orientation) and further out,
   * then the damped `update()` eases it up into the 3/4 architectural angle and
   * dollies in — the venue "stands up" instead of teleporting (~600ms).
   */
  frame(bounds: OrbitBounds, intro = false): void {
    this.target.set(bounds.center[0], bounds.center[1], bounds.center[2]);
    const r = Math.max(1, bounds.radius);
    // Aspect-aware fit: the bounds sphere must clear BOTH the vertical and the
    // (aspect-narrowed) horizontal FOV, so a wide designer canvas frames the
    // chart centred with margin instead of parking it low-left. `setAspect` must
    // run before `frame` for the horizontal term to be correct.
    const halfV = (this.fovY * DEG) / 2;
    const aspect = this.camera.aspect || 1;
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const fit = Math.max(r / Math.tan(halfV), r / Math.tan(halfH));
    this.azT = -30 * DEG;
    this.polT = 55 * DEG;
    this.distT = fit * FRAME_MARGIN;
    // Low min so you can swoop down close enough that seat dots are big, tappable
    // targets ("into your section"); generous max to pull right back out.
    this.minDist = Math.max(2, r * 0.12);
    this.maxDist = fit * 4;
    if (intro) {
      this.azimuth = this.azT;      // no spin — just tilt up + dolly in
      this.polar = 12 * DEG;        // near top-down, like the flat 2D view
      this.distance = this.distT * 1.7;
    } else {
      this.azimuth = this.azT;
      this.polar = this.polT;
      this.distance = this.distT;
    }
    this.applyPosition();
  }

  setAspect(aspect: number): void {
    this.camera.perspective({ aspect });
  }

  /** Damp toward targets; returns true while still moving. */
  update(): boolean {
    const da = this.azT - this.azimuth;
    const dp = this.polT - this.polar;
    const dd = this.distT - this.distance;
    const moving = Math.abs(da) > 1e-4 || Math.abs(dp) > 1e-4 || Math.abs(dd) > 1e-4;
    this.azimuth += da * DAMP;
    this.polar += dp * DAMP;
    this.distance += dd * DAMP;
    if (moving) this.applyPosition();
    return moving;
  }

  /** Distance from camera to target (for LOD). */
  get currentDistance(): number {
    return this.distance;
  }

  /**
   * Re-derive the orbit's spherical state from the camera's CURRENT pose (after a
   * cinematic flight leaves it somewhere arbitrary), so a subsequent drag damps
   * from where it actually is with no snap. Does not move the camera.
   */
  syncFromCamera(): void {
    const dx = this.camera.position.x - this.target.x;
    const dy = this.camera.position.y - this.target.y;
    const dz = this.camera.position.z - this.target.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const polar = Math.max(POLAR_MIN, Math.min(POLAR_MAX, Math.acos(Math.max(-1, Math.min(1, dy / dist)))));
    // Distance is NOT clamped here: a flight can park closer than minDist, and
    // clamping would jump the camera radially on the very first drag. The clamp
    // applies lazily from the next user-driven dolly (see dollyBy).
    this.distance = this.distT = dist;
    this.polar = this.polT = polar;
    this.azimuth = this.azT = Math.atan2(dx, dz);
  }

  /** Point the orbit pivot at a new world target without moving the camera. */
  setTarget(target: [number, number, number]): void {
    this.target.set(target[0], target[1], target[2]);
  }

  /** Restore the base FOV (a flight ends pushed-in) and re-sync orbit state. A
   * flight ends looking at `target` (the venue focal), so re-pivot there first —
   * otherwise the first drag would `lookAt(bounds.center)` and pop the aim. */
  resumeAfterFlight(target?: [number, number, number]): void {
    this.camera.perspective({ fov: this.fovY, aspect: this.camera.aspect });
    if (target) this.target.set(target[0], target[1], target[2]);
    this.syncFromCamera();
  }

  private applyPosition(): void {
    const sp = Math.sin(this.polar);
    const x = this.target.x + this.distance * sp * Math.sin(this.azimuth);
    const y = this.target.y + this.distance * Math.cos(this.polar);
    const z = this.target.z + this.distance * sp * Math.cos(this.azimuth);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.activePointers.clear();
  }
}
