/**
 * Dirty-flag render loop. A frame is drawn only while the camera is moving /
 * damping or an availability update arrived; when idle, no rAF is scheduled at
 * all (zero CPU/GPU when parked). Tracks an FPS EMA over frames actually
 * rendered — it reads as "idle" when nothing is scheduled.
 */

export interface RenderLoopStats {
  fps: number;
  rendered: number;
  idle: boolean;
}

export class RenderLoop {
  private frame: (dt: number) => boolean;
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private fpsEma = 0;
  private rendered = 0;

  /** `frame(dt)` renders one frame and returns true if another is needed. */
  constructor(frame: (dt: number) => boolean) {
    this.frame = frame;
  }

  requestRender(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 1 / 60;
    this.lastTime = now;
    if (dt > 0) {
      const instFps = 1 / dt;
      this.fpsEma = this.fpsEma ? this.fpsEma * 0.9 + instFps * 0.1 : instFps;
    }
    this.rendered++;
    const again = this.frame(dt);
    if (again) {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.running = false;
      this.rafId = 0;
    }
  };

  stats(): RenderLoopStats {
    return { fps: this.running ? Math.round(this.fpsEma) : 0, rendered: this.rendered, idle: !this.running };
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.running = false;
  }
}
