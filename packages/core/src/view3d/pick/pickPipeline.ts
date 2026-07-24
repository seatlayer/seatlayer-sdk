/**
 * GPU color-pick (Slice 2). On a TAP (not hover, not drag) the seat instance
 * index is rendered as RGB into a small scissored offscreen target and a single
 * pixel is read back → O(1) regardless of seat count. Solids are drawn first as
 * black + depth so a seat occluded by a tier reads as "no hit".
 *
 * The pick meshes reuse the display geometry buffers (iOffset / position), so no
 * per-seat data is duplicated on the GPU.
 */

import { Geometry, Mesh, Program, RenderTarget, Transform } from 'ogl';
import type { Camera, OGLRenderingContext, Renderer } from 'ogl';
import { createPickDepthProgram, createSeatPickProgram } from '../scene/materials';
import { BACKGROUND } from '../palette';
import { pickNearestFromBuffer } from './encode';

const SYNC_KEYS = ['uSeatRadius', 'uSeatScale', 'uMinPixels', 'uPixelToWorld'] as const;

export class PickPipeline {
  private gl: OGLRenderingContext;
  private renderer: Renderer;
  private seatProg: Program;
  private depthProg: Program;
  private seatScene = new Transform();
  private solidScene = new Transform();
  private target: RenderTarget | null = null;
  private maxIndex: number;

  constructor(renderer: Renderer, seatGeo: Geometry, solidGeo: Geometry, seatCount: number) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.maxIndex = seatCount;
    this.seatProg = createSeatPickProgram(this.gl);
    this.depthProg = createPickDepthProgram(this.gl);
    const seatMesh = new Mesh(this.gl, { geometry: seatGeo, program: this.seatProg });
    seatMesh.frustumCulled = false;
    seatMesh.setParent(this.seatScene);
    const solidMesh = new Mesh(this.gl, { geometry: solidGeo, program: this.depthProg });
    solidMesh.frustumCulled = false;
    solidMesh.setParent(this.solidScene);
  }

  /** Match the display seat sizing so the pick mask lines up with the dots. */
  syncFromSeatProgram(seatProgram: Program): void {
    for (const k of SYNC_KEYS) this.seatProg.uniforms[k].value = seatProgram.uniforms[k].value;
  }

  private ensureTarget(): RenderTarget {
    const w = this.gl.drawingBufferWidth;
    const h = this.gl.drawingBufferHeight;
    if (this.target && (this.target.width !== w || this.target.height !== h)) {
      this.destroyTarget();
    }
    if (!this.target) {
      this.target = new RenderTarget(this.gl, { width: w, height: h, depth: true });
    }
    return this.target;
  }

  private destroyTarget(): void {
    if (!this.target) return;
    const gl = this.gl;
    if (this.target.buffer) gl.deleteFramebuffer(this.target.buffer);
    for (const t of this.target.textures ?? []) if (t.texture) gl.deleteTexture(t.texture);
    if (this.target.depthBuffer) gl.deleteRenderbuffer(this.target.depthBuffer);
    this.target = null;
  }

  /**
   * Read back the seat instance index NEAREST framebuffer pixel (px, py), or -1.
   * `radius` is the tap tolerance in buffer px: a box of side (2·radius+1) is
   * rendered + read so a tap that lands between the ~2px overview dots still
   * finds the closest seat. px/py/radius are bottom-left-origin buffer pixels.
   */
  pick(camera: Camera, px: number, py: number, radius: number): number {
    const gl = this.gl;
    const target = this.ensureTarget();
    const bw = gl.drawingBufferWidth;
    const bh = gl.drawingBufferHeight;
    const x0 = Math.max(0, px - radius);
    const y0 = Math.max(0, py - radius);
    const boxW = Math.max(1, Math.min(bw, px + radius + 1) - x0);
    const boxH = Math.max(1, Math.min(bh, py + radius + 1) - y0);

    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, boxW, boxH);
    // Clear the pick target to TRUE BLACK so empty + occluded pixels decode to
    // no-hit structurally (not by a range guard). Occluders drawn black + depth
    // first, then seats (pick colours) depth-tested.
    const [br, bg, bb] = BACKGROUND.top;
    gl.clearColor(0, 0, 0, 1);
    this.renderer.render({ scene: this.solidScene, camera, target, clear: true });
    this.renderer.render({ scene: this.seatScene, camera, target, clear: false });
    gl.clearColor(br, bg, bb, 1); // restore the display clear colour
    gl.disable(gl.SCISSOR_TEST);

    const buf = new Uint8Array(boxW * boxH * 4);
    this.renderer.bindFramebuffer(target);
    gl.readPixels(x0, y0, boxW, boxH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.renderer.bindFramebuffer();

    return pickNearestFromBuffer(buf, boxW, boxH, px - x0, py - y0, this.maxIndex);
  }

  dispose(): void {
    this.destroyTarget();
    this.seatProg.remove();
    this.depthProg.remove();
  }
}
