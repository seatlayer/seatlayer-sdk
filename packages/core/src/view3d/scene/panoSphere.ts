/**
 * The equirectangular panorama, as real geometry inside the venue scene.
 *
 * What this replaces, and why it had to change:
 *
 * `crossfade/panorama.ts` draws the 360 as a DOM div with `background-repeat:
 * repeat-x`, panned by hand and windowed to a 70° vertical slice. To show it,
 * `openPanorama` calls `loop.stop()` — it FREEZES the WebGL venue and fades a
 * flat image over the corpse. So the immersive payoff of the whole 3D flight is
 * the moment the product stops using its renderer.
 *
 * A `repeat-x` background is also not a sphere. It is a cylinder at best: pan is
 * linear in longitude (correct), but pitch is a vertical translation of a flat
 * bitmap, so verticals bow and the image stretches away from the horizon. A real
 * 360 photo looks right in the 2D popover — which uses an actual sphere via
 * Photo Sphere Viewer — and subtly wrong here, on the surface the marketing
 * story leads with.
 *
 * The fix is not to import Photo Sphere Viewer. That is Three.js-based, and this
 * chunk already owns a WebGL stack (OGL) and is deliberately kept at ~71 KB
 * gzipped because it loads only when a buyer opens 3D. Pulling in a second
 * renderer to draw one textured sphere would roughly triple it.
 *
 * So: a unit sphere, inward-facing, sampled equirectangularly, drawn by the
 * scene's own renderer with the scene's own camera. The panorama stops being an
 * overlay and becomes somewhere the camera can be, which is also what makes the
 * fly-to-seat handoff a continuous move rather than a cut between two different
 * rendering technologies.
 *
 * Everything below the `mount` function is pure and unit-tested; the GL parts
 * are a thin wrapper over it.
 */

import { Geometry, Mesh, Program, Texture } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

/**
 * Longitude/latitude tessellation of the sphere.
 *
 * The sphere is viewed from its exact centre, so silhouette smoothness never
 * matters — only how much the equirect sampling is distorted by interpolating
 * UVs across a triangle. 64×32 keeps the worst-case angular error under a third
 * of a degree at the horizon, which is far below a pixel at any sane FOV, for
 * 4,096 triangles. Going finer costs vertices to fix an error nothing can see.
 */
export const PANO_SEGMENTS_LON = 64;
export const PANO_SEGMENTS_LAT = 32;

/**
 * Radius in metres. Arbitrary in principle — the camera sits at the centre and
 * an equirect sphere has no parallax — but it must be large enough to enclose
 * the near clip plane and small enough to stay inside the far plane, or the
 * panorama clips against its own geometry. 500 m clears both for every venue in
 * the catalog, including the 50k-seat stadium.
 */
export const PANO_RADIUS_M = 500;

export interface SphereVertexData {
  position: Float32Array;
  uv: Float32Array;
  index: Uint16Array;
}

/**
 * A UV sphere with INWARD-facing triangles and equirectangular UVs.
 *
 * Inward-facing is done by winding, not by disabling culling: the scene draws
 * with back-face culling on, and turning it off for one mesh would leak that
 * state onto everything drawn after it in the same pass. Reversing the triangle
 * winding makes the inside surface the front face, so the sphere obeys exactly
 * the same pipeline state as the venue.
 *
 * Mapping, matching `generatePanorama.ts` and the 2D viewer so one image reads
 * identically in all three:
 *   u = 0.5 + yaw/360   (u 0.5 is yaw 0, the direction the camera faces)
 *   v = (90 - pitch)/180  (v 0 is the top of the image)
 *
 * The seam at u=0/1 is duplicated rather than wrapped — a shared vertex would
 * have to carry both u=0 and u=1 and would interpolate the whole image backwards
 * across that one column of triangles.
 */
export function buildPanoSphere(
  segmentsLon: number = PANO_SEGMENTS_LON,
  segmentsLat: number = PANO_SEGMENTS_LAT,
  radius: number = PANO_RADIUS_M,
): SphereVertexData {
  const lonCount = segmentsLon + 1; // +1 duplicates the seam column
  const latCount = segmentsLat + 1; // +1 closes both poles
  const vertexCount = lonCount * latCount;
  const position = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);

  for (let iLat = 0; iLat < latCount; iLat++) {
    // v runs 0 (top) → 1 (bottom); polar angle 0 at +Y.
    const v = iLat / segmentsLat;
    const polar = v * Math.PI;
    const sinPolar = Math.sin(polar);
    const cosPolar = Math.cos(polar);
    for (let iLon = 0; iLon < lonCount; iLon++) {
      const u = iLon / segmentsLon;
      // u 0.5 must land on yaw 0. The scene's yaw 0 faces -Z (the camera looks
      // down -Z by default), so offset the azimuth by half a turn.
      const azimuth = (u - 0.5) * Math.PI * 2;
      const i = iLat * lonCount + iLon;
      position[i * 3] = radius * sinPolar * Math.sin(azimuth);
      position[i * 3 + 1] = radius * cosPolar;
      position[i * 3 + 2] = -radius * sinPolar * Math.cos(azimuth);
      uv[i * 2] = u;
      uv[i * 2 + 1] = v;
    }
  }

  // Two triangles per quad, wound so the INSIDE is the front face.
  const index = new Uint16Array(segmentsLon * segmentsLat * 6);
  let w = 0;
  for (let iLat = 0; iLat < segmentsLat; iLat++) {
    for (let iLon = 0; iLon < segmentsLon; iLon++) {
      const a = iLat * lonCount + iLon;
      const b = a + lonCount;
      index[w++] = a; index[w++] = b; index[w++] = a + 1;
      index[w++] = a + 1; index[w++] = b; index[w++] = b + 1;
    }
  }
  return { position, uv, index };
}

/**
 * Direction (unit vector, scene axes) the camera looks along for a given
 * bearing and pitch in degrees. Bearing 0 faces the focal/stage, matching
 * `SeatView.initialBearingDeg`; positive pitch looks up.
 *
 * Exported because the transition from the flight has to hand the sphere the
 * camera's final yaw, and a panorama that opens on a different bearing than the
 * flight ended on reads as a cut.
 */
export function bearingPitchToDirection(bearingDeg: number, pitchDeg: number): [number, number, number] {
  const yaw = (bearingDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cosPitch = Math.cos(pitch);
  return [cosPitch * Math.sin(yaw), Math.sin(pitch), -cosPitch * Math.cos(yaw)];
}

const PANO_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PANO_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPano;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  vec3 rgb = texture(uPano, vUv).rgb;
  fragColor = vec4(rgb, uOpacity);
}`;

export interface PanoSphereHandle {
  mesh: Mesh;
  /** Cross-fade control: 0 hides the sphere, 1 fully replaces the venue. */
  setOpacity(value: number): void;
  /** Replace the decoded source on the existing GPU texture. */
  setImage(image: HTMLImageElement | HTMLCanvasElement): void;
  dispose(): void;
}

/**
 * Build the textured sphere mesh. The caller owns adding it to a scene graph and
 * driving `setOpacity` — this module deliberately knows nothing about the flight
 * or the overlay chrome.
 *
 * `depthTest: false` and `depthWrite: false`: the sphere encloses the entire
 * venue, so with depth on it would be occluded by every piece of geometry
 * between the camera and its far wall. It is a backdrop that replaces the view,
 * not a solid in it — so it is drawn without consulting depth, and the caller
 * draws it after the venue when fading in.
 */
export function createPanoSphere(
  gl: OGLRenderingContext,
  // Narrower than `TexImageSource` on purpose: the panorama always arrives as a
  // decoded <img> (a URL or the generator's data URL) or a canvas. OGL's texture
  // type does not accept ImageBitmap, and widening here would only move the
  // failure to runtime.
  image: HTMLImageElement | HTMLCanvasElement,
): PanoSphereHandle {
  const { position, uv, index } = buildPanoSphere();
  const geometry = new Geometry(gl, {
    position: { size: 3, data: position },
    uv: { size: 2, data: uv },
    index: { data: index },
  });
  const texture = new Texture(gl, {
    image,
    // The seam column is duplicated in geometry, so CLAMP is correct and avoids
    // a wrapped bilinear tap bleeding the far edge of the image into it.
    wrapS: gl.CLAMP_TO_EDGE,
    wrapT: gl.CLAMP_TO_EDGE,
    generateMipmaps: true,
    // MUST be false, and this is the one line that decides whether the whole
    // panorama is upside down.
    //
    // OGL defaults `flipY` to true for 2D textures, which is right for the usual
    // case: a UV of 0 means the BOTTOM of a quad, an image's first row is its
    // TOP, and flipping on upload reconciles the two. This sphere is the other
    // case. Its `v` is authored in IMAGE space — v=0 is the top of the equirect
    // and maps to the top of the sphere (`buildPanoSphere`, and the mapping
    // `generatePanorama` and the 2D viewer both use). Flipping on upload as well
    // applies the correction twice: the stadium pitch renders on the ceiling and
    // the audience sits overhead.
    //
    // The geometry tests state the v mapping and pass either way — they never
    // touch GL — so this is not something a unit test can defend. It was caught
    // by looking at a stadium.
    flipY: false,
  });
  const program = new Program(gl, {
    vertex: PANO_VERT,
    fragment: PANO_FRAG,
    uniforms: { uPano: { value: texture }, uOpacity: { value: 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(gl, { geometry, program });
  return {
    mesh,
    setOpacity(value: number): void {
      program.uniforms.uOpacity.value = Math.max(0, Math.min(1, value));
    },
    setImage(nextImage: HTMLImageElement | HTMLCanvasElement): void {
      texture.image = nextImage;
      texture.needsUpdate = true;
    },
    dispose(): void {
      mesh.setParent(null);
      geometry.remove();
      if (texture.texture) gl.deleteTexture(texture.texture);
      program.remove();
    },
  };
}
