/**
 * view3d analytics — a tiny, decoupled event emitter for the venue view. The
 * caller (app/harness) supplies `onAnalytics`; this class owns the per-mount
 * state (first-orbit latch, panorama dwell timing) and, crucially, wraps EVERY
 * callback invocation in try/catch so a throwing analytics sink can never break
 * rendering. No DOM, no GL — unit-testable in isolation.
 */

export type Analytics3DCallback = (event: string, props?: Record<string, unknown>) => void;

/**
 * Where the CPU scene was compiled, as a closed enum (never free text).
 * - `worker` — built off the UI thread by `prepareVenue3D`.
 * - `main`   — `prepareVenue3D` ran but the worker was unavailable or failed
 *              (no `Worker`, a host CSP blocking the module worker, a throw, or
 *              the 15s timeout) and the same pure compiler ran on the UI thread.
 * - `inline` — the caller never used `prepareVenue3D`; the scene was compiled
 *              synchronously inside `mountVenue3D`. Kept distinct from `main`
 *              so worker uptake is not diluted by callers that never asked.
 */
export type Scene3DPrepSource = 'worker' | 'main' | 'inline';

const now = (): number =>
  (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export class Analytics3D {
  private cb?: Analytics3DCallback;
  private orbitLatched = false;
  private panoramaOpenedAt = 0;

  constructor(cb?: Analytics3DCallback) {
    this.cb = cb;
  }

  /** The single guarded emit point — analytics must never throw into the loop. */
  private emit(event: string, props?: Record<string, unknown>): void {
    if (!this.cb) return;
    try {
      this.cb(event, props);
    } catch {
      /* analytics sink threw — swallow so rendering is never affected */
    }
  }

  opened(
    seats: number,
    hasHeights: boolean,
    buildMs?: number,
    prepSource?: Scene3DPrepSource,
  ): void {
    this.emit('3d_opened', {
      seats,
      hasHeights,
      ...(buildMs === undefined ? {} : { buildMs: Math.round(buildMs) }),
      ...(prepSource === undefined ? {} : { prepSource }),
    });
  }

  /** First user-driven orbit/dolly per mount only (the intro ease is not user
   * input, so callers must gate this on real pointer/wheel gestures). */
  orbitEngaged(): void {
    if (this.orbitLatched) return;
    this.orbitLatched = true;
    this.emit('3d_orbit_engaged');
  }

  seatPicked(seatId: string, sectionId: string | undefined): void {
    this.emit('3d_seat_picked', { seatId, sectionId });
  }

  cinematicPlayed(durationMs: number): void {
    this.emit('3d_cinematic_played', { durationMs, reducedMotion: false });
  }

  cinematicSkipped(): void {
    this.emit('3d_cinematic_skipped', { reducedMotion: true });
  }

  cinematicCancelled(): void {
    this.emit('3d_cinematic_cancelled');
  }

  panoramaOpened(): void {
    this.panoramaOpenedAt = now();
    this.emit('3d_panorama_opened');
  }

  panoramaClosed(): void {
    const viewMs = this.panoramaOpenedAt ? Math.round(now() - this.panoramaOpenedAt) : 0;
    this.panoramaOpenedAt = 0;
    this.emit('3d_panorama_closed', { viewMs });
  }

  panoramaFailed(seatId: string, phase: 'source' | 'mount'): void {
    this.emit('3d_panorama_failed', { seatId, phase });
  }

  panoramaFallback(seatId: string): void {
    this.emit('3d_panorama_fallback', { seatId });
  }

  contextLost(): void {
    this.emit('3d_context_lost');
  }

  contextRestored(): void {
    this.emit('3d_context_restored');
  }
}
