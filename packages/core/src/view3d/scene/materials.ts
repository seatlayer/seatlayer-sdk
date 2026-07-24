/**
 * Inline GLSL (WebGL2 / GLSL ES 3.00) for the three scene programs. Zero
 * textures, zero shadow maps, zero post: a procedural matcap-style hemisphere +
 * warm key + fresnel rim on solids, a soft top-lit round dot for seats, and a
 * vertical-gradient + vignette background. OGL injects the built-in matrix
 * uniforms (modelViewMatrix / projectionMatrix / normalMatrix) by name.
 */

import { Program } from 'ogl';
import type { OGLRenderingContext } from 'ogl';

const SOLID_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vColor;
out vec3 vNormalView;
out vec3 vPosView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPosView = mv.xyz;
  vNormalView = normalize(normalMatrix * normal);
  vColor = color;
  gl_Position = projectionMatrix * mv;
}`;

const SOLID_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormalView;
in vec3 vPosView;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormalView);
  vec3 V = normalize(-vPosView);
  float hemi = 0.5 + 0.5 * N.y;                 // sky/ground gradient
  vec3 L = normalize(vec3(0.4, 0.85, 0.55));    // warm key, view space
  float key = max(dot(N, L), 0.0);
  vec3 base = vColor * (0.60 + 0.32 * hemi) + vColor * key * 0.32;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  base += vec3(0.26, 0.31, 0.38) * fres * 0.35; // cool rim, restrained
  fragColor = vec4(base, 1.0);
}`;

const SEAT_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 position;      // quad corner in [-1,1]
in vec3 iOffset;       // per-instance world position
in vec3 iColor;        // per-instance state colour (resolved CPU-side)
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSeatRadius;
uniform float uSeatScale;
uniform float uMinPixels;
uniform float uPixelToWorld;   // (2*tan(fovY/2)) / viewportHeightPx
out vec2 vUv;
out vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float depth = max(-mv.z, 0.001);
  float minR = uMinPixels * depth * uPixelToWorld;      // screen-space floor
  float r = max(uSeatRadius * uSeatScale, minR);
  mv.xy += position * r;                                 // camera-facing billboard
  vUv = position;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}`;

const SEAT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
uniform float uSeatFade;      // fade toward tier colour with distance (LOD)
uniform vec3 uFadeColor;
out vec4 fragColor;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float alpha = smoothstep(1.0, 0.72, d);
  float shade = 0.80 + 0.28 * (0.5 - vUv.y * 0.5);       // subtle top-lit
  vec3 c = vColor * shade;
  c = mix(c, uFadeColor, uSeatFade);
  fragColor = vec4(c, alpha);
}`;

const BG_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.999, 1.0);
}`;

const BG_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
out vec4 fragColor;
void main() {
  vec3 col = mix(uBottom, uTop, vUv.y);
  vec2 c = vUv - 0.5;
  float vig = 1.0 - dot(c, c) * 0.85;                    // soft vignette
  fragColor = vec4(col * vig, 1.0);
}`;

// --- GPU pick pass ---------------------------------------------------------
// Seats encode gl_InstanceID+1 as an RGB colour (no extra per-instance buffer);
// solids write pure black + depth first so a seat occluded by a tier reads as
// "no hit". Same billboard maths as the display seat program.
const SEAT_PICK_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 position;
in vec3 iOffset;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSeatRadius;
uniform float uSeatScale;
uniform float uMinPixels;
uniform float uPixelToWorld;
out vec2 vUv;
flat out vec3 vPick;
void main() {
  int id = gl_InstanceID + 1;                 // 0 reserved for no-hit
  vPick = vec3(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255)) / 255.0;
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float depth = max(-mv.z, 0.001);
  float minR = uMinPixels * depth * uPixelToWorld;
  float r = max(uSeatRadius * uSeatScale, minR);
  mv.xy += position * r;
  vUv = position;
  gl_Position = projectionMatrix * mv;
}`;

const SEAT_PICK_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec3 vPick;
out vec4 fragColor;
void main() {
  if (length(vUv) > 1.0) discard;             // round hit-mask matches the dot
  fragColor = vec4(vPick, 1.0);
}`;

const PICK_DEPTH_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PICK_DEPTH_FRAG = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0, 0.0, 0.0, 1.0); }`;

export function createSeatPickProgram(gl: OGLRenderingContext): Program {
  return new Program(gl, {
    vertex: SEAT_PICK_VERT,
    fragment: SEAT_PICK_FRAG,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    cullFace: false,
    uniforms: {
      uSeatRadius: { value: 0.22 },
      uSeatScale: { value: 1 },
      uMinPixels: { value: 2.5 },
      uPixelToWorld: { value: 0.002 },
    },
  });
}

/** Occluder pass: solids to black + depth so occluded seats read as no-hit. */
export function createPickDepthProgram(gl: OGLRenderingContext): Program {
  return new Program(gl, {
    vertex: PICK_DEPTH_VERT,
    fragment: PICK_DEPTH_FRAG,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    cullFace: false,
  });
}

export function createSolidProgram(gl: OGLRenderingContext): Program {
  return new Program(gl, {
    // No backface culling: free-hand section polygons are stored in raw click
    // order (either winding), so a culled solid would render see-through. The
    // shader lights both faces and closed opaque prisms + depth test keep
    // overdraw negligible; extrudePrism also normalises winding as a belt.
    vertex: SOLID_VERT,
    fragment: SOLID_FRAG,
    cullFace: false,
    depthTest: true,
    depthWrite: true,
  });
}

export function createSeatProgram(gl: OGLRenderingContext): Program {
  return new Program(gl, {
    vertex: SEAT_VERT,
    fragment: SEAT_FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    cullFace: false,
    uniforms: {
      uSeatRadius: { value: 0.22 },
      uSeatScale: { value: 1 },
      uMinPixels: { value: 2.5 },
      uPixelToWorld: { value: 0.002 },
      uSeatFade: { value: 0 },
      uFadeColor: { value: new Float32Array([0.32, 0.37, 0.43]) },
    },
  });
}

export function createBackgroundProgram(gl: OGLRenderingContext, top: number[], bottom: number[]): Program {
  return new Program(gl, {
    vertex: BG_VERT,
    fragment: BG_FRAG,
    depthTest: false,
    depthWrite: false,
    cullFace: false,
    uniforms: {
      uTop: { value: new Float32Array(top) },
      uBottom: { value: new Float32Array(bottom) },
    },
  });
}
