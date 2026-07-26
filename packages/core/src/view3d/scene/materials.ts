/**
 * Inline GLSL (WebGL2 / GLSL ES 3.00) for the three scene programs. Zero
 * textures, zero shadow maps, zero post: a procedural matcap-style hemisphere +
 * warm key + fresnel rim on solids, a soft top-lit round dot for seats, and a
 * vertical-gradient + vignette background. OGL injects the built-in matrix
 * uniforms (modelViewMatrix / projectionMatrix / normalMatrix) by name.
 */

import { Program } from 'ogl';
import { SEAT_DOT_RADIUS_M } from './seatInstances';
import type { OGLRenderingContext } from 'ogl';

const SOLID_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 color;
in float floorIndex;
uniform mat4 modelMatrix;
uniform float uFocusFloor;   // -1 = show every floor
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
out vec3 vColor;
out vec3 vNormalWorld;
out vec3 vNormalView;
out vec3 vPosView;
out float vDim;
void main() {
  // Per-floor isolation without splitting the merged mesh into a draw call per
  // floor: a floor that is not the focused one is dimmed, not hidden, so the
  // buyer keeps the whole venue as context while looking at one level.
  vDim = (uFocusFloor < -0.5 || abs(floorIndex - uFocusFloor) < 0.5) ? 0.0 : 1.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPosView = mv.xyz;
  vNormalView = normalize(normalMatrix * normal);
  // World normal drives the key + hemisphere so the lighting stays welded to the
  // venue as the camera orbits (the scene has no non-uniform scale, so mat3 of
  // the model matrix is the correct normal transform).
  vNormalWorld = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  gl_Position = projectionMatrix * mv;
}`;

const SOLID_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormalWorld;
in vec3 vNormalView;
in vec3 vPosView;
in float vDim;
uniform vec3 uKeyDir;                           // WORLD space, unit, points at the light
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormalWorld);
  vec3 V = normalize(-vPosView);
  float hemi = 0.5 + 0.5 * N.y;                 // sky/ground gradient about WORLD up
  float key = max(dot(N, uKeyDir), 0.0);        // fixed key — does not orbit with you
  // Low opposite fill so faces turned away from the key keep their form instead
  // of crushing to a single flat value.
  vec3 fillDir = normalize(vec3(-uKeyDir.x, 0.25, -uKeyDir.z));
  float fill = max(dot(N, fillDir), 0.0);
  vec3 base = vColor * (0.52 + 0.34 * hemi) + vColor * key * 0.34 + vColor * fill * 0.10;
  float fres = pow(1.0 - max(dot(normalize(vNormalView), V), 0.0), 3.0);
  base += vec3(0.26, 0.31, 0.38) * fres * 0.35; // cool rim, restrained (view-dependent by design)
  // Unfocused floors fall back toward the background rather than vanishing.
  base = mix(base, base * 0.45, vDim);
  fragColor = vec4(base, 1.0);
}`;

const SEAT_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 position;      // quad corner in [-1,1]
in vec3 iOffset;       // per-instance world position
in vec3 iColor;        // per-instance state colour (resolved CPU-side)
in float iMaxRadius;   // per-instance world-radius ceiling (seat pitch derived)
in vec3 iRing;         // accommodation ring colour; (0,0,0) = not accessible
in float iFloor;       // owning floor index
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSeatRadius;
uniform float uSeatScale;
uniform float uMinPixels;
uniform float uPixelToWorld;   // (2*tan(fovY/2)) / viewportHeightPx
uniform float uFocusFloor;     // -1 = show every floor
out vec2 vUv;
out vec3 vColor;
out float vBudget;     // 1 = dot holds its minimum pixel size, <1 = it cannot
out vec3 vRing;
out float vDim;
void main() {
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float depth = max(-mv.z, 0.001);
  float minR = uMinPixels * depth * uPixelToWorld;      // screen-space floor
  // Grow to hold the pixel floor, but never past this seat's own pitch ceiling:
  // unbounded growth is what merges neighbouring rows into one mass at range.
  float r = min(max(uSeatRadius * uSeatScale, minR), iMaxRadius);
  // How much of the requested pixel floor the dot could actually afford. Below 1
  // it is losing legibility to distance, and the fragment stage dissolves it
  // toward the tier top rather than letting a sub-pixel dot alias and shimmer.
  vBudget = minR > 0.0 ? clamp(r / minR, 0.0, 1.0) : 1.0;
  mv.xy += position * r;                                 // camera-facing billboard
  // Seat the dot ON the deck instead of centring it in the deck. iOffset is the
  // exact surface point, so half the billboard would otherwise sit below the cap
  // and be clipped by it — and because uMinPixels grows r with distance, no
  // constant world-space lift can prevent that at every range. Offsetting by r
  // along the screen projection of WORLD up is self-correcting: it is full at a
  // grazing view (where slicing happens) and vanishes looking straight down
  // (where the dot must stay centred on its seat).
  mv.xy += normalize(vec3(modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0))).xy * r;
  vUv = position;
  vColor = iColor;
  vRing = iRing;
  vDim = (uFocusFloor < -0.5 || abs(iFloor - uFocusFloor) < 0.5) ? 0.0 : 1.0;
  gl_Position = projectionMatrix * mv;
}`;

const SEAT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vBudget;
in vec3 vRing;
in float vDim;
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
  // Accommodation ring — the 3D echo of the coloured ring 2D draws around every
  // accessible seat. Painted INSIDE the dot's own radius rather than outside it,
  // so an accessible seat still respects the row-pitch ceiling and cannot grow
  // into its neighbour just for carrying a ring.
  float ringMask = step(0.001, dot(vRing, vRing));
  float ring = smoothstep(0.58, 0.70, d) * (1.0 - smoothstep(0.90, 1.0, d));
  c = mix(c, vRing, ring * ringMask * 0.95);
  // A dot that can no longer afford its pixel floor dissolves instead of
  // aliasing; the tier cap underneath already carries the section's category
  // tint, so the block reads as coloured seating rather than empty concrete.
  alpha *= smoothstep(0.35, 1.0, vBudget);
  // Seats on an unfocused floor recede with their structure.
  c = mix(c, uFadeColor, vDim * 0.75);
  alpha *= mix(1.0, 0.30, vDim);
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
in float iMaxRadius;
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
  float r = min(max(uSeatRadius * uSeatScale, minR), iMaxRadius);
  mv.xy += position * r;
  // Must match SEAT_VERT exactly, or the hit mask drifts off the drawn dot.
  mv.xy += normalize(vec3(modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0))).xy * r;
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
      uSeatRadius: { value: SEAT_DOT_RADIUS_M },
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
    uniforms: {
      // High and off-axis, in world space: reads as a house rig rather than a
      // headlamp welded to the camera.
      uKeyDir: { value: new Float32Array([0.38, 0.86, 0.34]) },
      uFocusFloor: { value: -1 },
    },
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
      uSeatRadius: { value: SEAT_DOT_RADIUS_M },
      uSeatScale: { value: 1 },
      uMinPixels: { value: 2.5 },
      uPixelToWorld: { value: 0.002 },
      uSeatFade: { value: 0 },
      uFocusFloor: { value: -1 },
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
