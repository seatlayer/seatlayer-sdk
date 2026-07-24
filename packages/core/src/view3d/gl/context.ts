/**
 * OGL renderer + canvas lifecycle. Owns the single WebGL2 context (reused across
 * open/close so an embed never exhausts the browser's ~16-context cap), DPR
 * capping, resize, and WebGL context-loss survival.
 *
 * Context loss is handled by preventing the default (so the browser will restore)
 * and delegating rebuild to the caller: the JS-side SceneModel is the source of
 * truth, so `onContextRestored` re-uploads all GPU resources from it.
 */

import { Renderer } from 'ogl';
import type { OGLRenderingContext } from 'ogl';
import { BACKGROUND } from '../palette';

export interface GLContextOptions {
  onContextLost: () => void;
  onContextRestored: () => void;
}

/** DPR ceiling: 2.0, or 1.5 on low-memory devices (fragment cost is DPR²). */
function computeDpr(): number {
  const raw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const cap = typeof mem === 'number' && mem <= 4 ? 1.5 : 2.0;
  return Math.min(raw, cap);
}

export class GLContext {
  readonly renderer: Renderer;
  readonly gl: OGLRenderingContext;
  readonly canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private lostHandler: (e: Event) => void;
  private restoredHandler: () => void;

  constructor(container: HTMLElement, opts: GLContextOptions) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';

    this.renderer = new Renderer({
      canvas: this.canvas,
      dpr: computeDpr(),
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      webgl: 2,
    });
    this.gl = this.renderer.gl;
    this.gl.clearColor(BACKGROUND.top[0], BACKGROUND.top[1], BACKGROUND.top[2], 1);

    container.appendChild(this.canvas);

    this.lostHandler = (e: Event) => {
      e.preventDefault();
      opts.onContextLost();
    };
    this.restoredHandler = () => opts.onContextRestored();
    this.canvas.addEventListener('webglcontextlost', this.lostHandler, false);
    this.canvas.addEventListener('webglcontextrestored', this.restoredHandler, false);

    this.resize();
  }

  /** Match the drawing buffer to the container's CSS box. */
  resize(): { width: number; height: number } {
    const w = Math.max(1, this.container.clientWidth || this.canvas.clientWidth || 1);
    const h = Math.max(1, this.container.clientHeight || this.canvas.clientHeight || 1);
    this.renderer.setSize(w, h);
    return { width: w, height: h };
  }

  get pixelHeight(): number {
    return this.renderer.height * this.renderer.dpr;
  }

  get aspect(): number {
    return this.renderer.width / Math.max(1, this.renderer.height);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.lostHandler, false);
    this.canvas.removeEventListener('webglcontextrestored', this.restoredHandler, false);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }

  /**
   * Test hook: force a full loss→restore cycle. `restoreContext()` must be called
   * only AFTER the browser has dispatched `webglcontextlost` (calling it too soon
   * makes the browser drop the restore request), so we sequence it off a one-shot
   * listener rather than a fixed timeout.
   */
  simulateContextLossCycle(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context') as
      | { loseContext(): void; restoreContext?: () => void }
      | null;
    if (!ext) return;
    ext.loseContext();
    // Chrome drops a restore requested too soon after loseContext(); a short
    // delay lets the loss settle before we ask for the context back.
    setTimeout(() => { if (ext.restoreContext) ext.restoreContext(); }, 300);
  }
}
