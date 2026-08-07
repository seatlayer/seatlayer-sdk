/**
 * Inline GLSL (WebGL2 / GLSL ES 3.00) for the three scene programs. Zero
 * textures, zero shadow maps, zero post: a procedural matcap-style hemisphere +
 * warm key + fresnel rim on solids, a soft top-lit round dot for seats, and a
 * vertical-gradient + vignette background. OGL injects the built-in matrix
 * uniforms (modelViewMatrix / projectionMatrix / normalMatrix) by name.
 */

import { Program } from 'ogl';
import { SEAT_DOT_RADIUS_M } from './seatInstances';
import { CHAIR_FULL_M, CHAIR_NONE_M, SEAT_MIN_PIXELS_NEAR } from '../lod';
import { BACK_BASE_M, BACK_RAKE_SLOPE } from './seatChair';
import type { OGLRenderingContext } from 'ogl';

/**
 * The near-field weight, shared verbatim by the chair and the dot so the two
 * always sum to one at every depth and no seat can be drawn twice or not at all.
 * Mirrors `chairWeight()` in lod.ts.
 */
const CHAIR_WEIGHT_GLSL = /* glsl */ `
float chairWeight(float depth) {
  return 1.0 - smoothstep(uChairFull, uChairNone, depth);
}`;

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
in float iPhysicalSeat;// 1 = chair; 0 = empty wheelchair bay
in vec3 iRing;         // accommodation ring colour; (0,0,0) = not accessible
in float iFloor;       // owning floor index
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSeatRadius;
uniform float uSeatScale;
uniform float uMinPixels;
uniform float uPixelToWorld;   // (2*tan(fovY/2)) / viewportHeightPx
uniform float uFocusFloor;     // -1 = show every floor
uniform float uChairFull;      // view depth at which the chair mesh is full size
uniform float uChairNone;      // ...and at which it has scaled away entirely
out vec2 vUv;
out vec3 vColor;
out float vBudget;     // 1 = dot holds its minimum pixel size, <1 = it cannot
out vec3 vRing;
out float vDim;
out float vDotWeight;  // 1 = the dot IS this seat, 0 = the chair has taken over
out float vPhysicalSeat;
${CHAIR_WEIGHT_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float depth = max(-mv.z, 0.001);
  // Hand the seat over to the chair mesh as it comes into range. Derived from
  // this instance's OWN depth rather than from a global uniform, so a row two
  // metres away and the far side of the bowl resolve differently in the same
  // frame — which is the entire point of a ladder over a switch.
  vDotWeight = 1.0 - chairWeight(depth);
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
  vPhysicalSeat = iPhysicalSeat;
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
in float vDotWeight;
in float vPhysicalSeat;
uniform float uSeatFade;      // fade toward tier colour with distance (LOD)
uniform vec3 uFadeColor;
out vec4 fragColor;
void main() {
  // Empty wheelchair provision is a square bay, never a round chair marker.
  float d = mix(max(abs(vUv.x), abs(vUv.y)), length(vUv), vPhysicalSeat);
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
  // Yield to the chair. The chair grows out of this exact point, so through the
  // band the dot is always at least as big as the chair inside it and the seat
  // never thins out to nothing in between.
  alpha *= vDotWeight;
  if (alpha <= 0.0) discard;
  fragColor = vec4(c, alpha);
}`;

// --- Near-field seat chairs ------------------------------------------------
// One instanced draw over the 72-vertex base mesh in ./seatChair.ts, carrying
// only the seats the CPU gathered as near (see ./nearField.ts). Lit by the same
// rig as the solids so a chair reads as part of the room and not as a decal.
const CHAIR_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 position;      // local: x/z in units of the seat radius, y in METRES
in vec3 normal;
in float part;         // 0 = pedestal, 1 = pad, 2 = back, 3 = body, 4 = head
in vec3 iOffset;       // per-instance world deck point (identical to the dot's)
in vec3 iColor;        // per-instance state colour
in float iRadius;      // per-instance horizontal half-width, world metres
in float iYaw;         // per-instance facing, radians (local +Z -> facing dir)
in vec3 iRing;         // accommodation ring colour; (0,0,0) = not accessible
in float iFloor;
in float iSeed;        // <0 = seat is empty; else per-person hash in [0,1)
in float iPhysicalSeat;// 1 = chair; 0 = empty wheelchair bay
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uChairFull;
uniform float uChairNone;
uniform float uFocusFloor;
uniform float uBackRake;   // metres of z per metre of rise, above uBackBase
uniform float uBackBase;   // local height at which the back starts
out vec3 vColor;
out vec3 vNormalWorld;
out vec3 vNormalView;
out vec3 vPosView;
out float vPart;
out float vHeight;   // local height in metres, for the vertical occlusion ramp
out vec3 vRing;
out float vDim;
out float vOccupant; // 1 = this vertex belongs to a person, not to the chair
out vec3 vOccupantTint;
${CHAIR_WEIGHT_GLSL}
void main() {
  vec4 anchor = modelViewMatrix * vec4(iOffset, 1.0);
  float w = chairWeight(max(-anchor.z, 0.001));
  // 1. Local units -> world metres. Only x/z scale: narrow rows get narrow
  //    chairs, but nobody gets a short one (people are the same height at every
  //    seat pitch).
  vec3 p = position;
  // The occupant. Parts 3 and 4 are a person; everything below is furniture.
  //
  // One instanced mesh draws both an empty seat and a taken one, because the
  // alternative — a second geometry and a second draw call gathered per frame —
  // would double the near-field cost to show what is already known per instance.
  // An unoccupied seat collapses its person to a point at the seat, which the
  // rasteriser discards, exactly as the chair itself collapses at w=0.
  float occupant = step(2.5, part);
  float taken = step(0.0, iSeed);
  vOccupant = occupant;
  if (iPhysicalSeat < 0.5) {
    p = vec3(0.0);            // sellable space, but no physical chair/person
  } else if (occupant > 0.5) {
    if (taken < 0.5) {
      p = vec3(0.0);          // empty seat: no person
    } else {
      // Vary the build so a sold-out row is people rather than a rank of
      // identical mannequins: +/-6% height and +/-8% width off the hash.
      p.y *= 0.94 + 0.12 * iSeed;
      p.xz *= 0.92 + 0.16 * fract(iSeed * 7.13);
    }
  }
  p.xz *= iRadius;
  // 2. Lean the back. Done here rather than in the base mesh so the lean is a
  //    real angle in METRES — baked into the mesh it would scale with the seat's
  //    width and the same chair would lean 20 degrees on a wide stadium row and
  //    6 on a tight theatre one.
  // Only the BACK panel rakes. The old test (part > 1.5) meant "the back", and
  // now also catches the occupant — leaning a person by the panel's rule would
  // translate their head backwards by a rake measured from the panel's base.
  float rake = (part > 1.5 && part < 2.5) ? max(p.y - uBackBase, 0.0) * uBackRake : 0.0;
  p.z -= rake;
  // 3. Scale-in. At w=0 the chair is a point at the seat, under a dot at full
  //    opacity — which is what makes the handover invisible. sqrt front-loads
  //    the growth so the chair is already near full size while the dot is still
  //    half there; see chairScale() in lod.ts.
  p *= sqrt(w);
  float c = cos(iYaw), s = sin(iYaw);
  vec3 rp = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
  // Normals under the same two transforms, in reverse and inverted-transposed.
  // The xz scale is non-uniform, so an axis-aligned normal does NOT survive it
  // unchanged; and the rake is a shear, whose normal transform adds a y term.
  // Skipping either lights the raked back as though it were still vertical.
  vec3 n = vec3(normal.x / iRadius, normal.y, normal.z / iRadius);
  if (part > 1.5 && part < 2.5) n.y += uBackRake * n.z;
  n = normalize(n);
  vec3 rn = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  vec4 mv = modelViewMatrix * vec4(iOffset + rp, 1.0);
  vPosView = mv.xyz;
  vNormalWorld = rn;
  vNormalView = normalize(mat3(modelViewMatrix) * rn);
  vColor = iColor;
  // Occupant colour, resolved here so the fragment stage needs no extra
  // varyings beyond this one. A person is NOT painted in the seat's state
  // colour: a sold seat is red, and a hall of red people reads as a warning,
  // not an audience. Hair/clothing for the body, a warm tone for the head,
  // both varied by the same per-person hash.
  float t = fract(iSeed * 3.71);
  vec3 clothes = mix(vec3(0.13, 0.15, 0.20), vec3(0.34, 0.30, 0.36), t);
  vec3 skin = mix(vec3(0.52, 0.38, 0.29), vec3(0.86, 0.70, 0.58), fract(iSeed * 11.3));
  vOccupantTint = (part > 3.5) ? skin : clothes;
  vPart = part;
  vHeight = position.y;
  vRing = iRing;
  vDim = (uFocusFloor < -0.5 || abs(iFloor - uFocusFloor) < 0.5) ? 0.0 : 1.0;
  gl_Position = projectionMatrix * mv;
}`;

const CHAIR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vNormalWorld;
in vec3 vNormalView;
in vec3 vPosView;
in float vPart;
in float vHeight;
in vec3 vRing;
in float vDim;
in float vOccupant;
in vec3 vOccupantTint;
uniform vec3 uKeyDir;
uniform vec3 uFadeColor;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormalWorld);
  vec3 V = normalize(-vPosView);
  // The solids' rig, unchanged, so the chairs sit in the venue's light.
  float hemi = 0.5 + 0.5 * N.y;
  float key = max(dot(N, uKeyDir), 0.0);
  vec3 fillDir = normalize(vec3(-uKeyDir.x, 0.25, -uKeyDir.z));
  float fill = max(dot(N, fillDir), 0.0);
  vec3 tint = vColor;
  if (vOccupant > 0.5) tint = vOccupantTint;
  // The accommodation ring, kept legible once the dot (which drew it) is gone:
  // an accessible seat's PEDESTAL is painted in the ring colour, so the marker
  // survives to close range instead of vanishing exactly when the buyer arrives.
  float ringMask = step(0.001, dot(vRing, vRing));
  if (vPart < 0.5 && ringMask > 0.5) tint = vRing;
  // Pad brightest, back a step below it, pedestal darkest. Three untextured
  // boxes only read as one object if they are separated tonally — with a single
  // flat colour the chair silhouettes as a crate.
  // A person is lit as a person, not as upholstery: no part shading, and less
  // of the pad's sheen, so a head does not read as a polished box.
  float partShade = vOccupant > 0.5 ? 0.95 : (vPart < 0.5 ? 0.50 : (vPart < 1.5 ? 1.10 : 0.80));
  // Cheap vertical occlusion: a chair is in a dense row, so the closer a surface
  // sits to the deck the less sky it can actually see. This is the depth cue —
  // without it the pad top, the back and the deck all resolve to the same flat
  // value and the row loses its form entirely.
  // Occupants rise above the 0.92 m chair back, so their ramp uses their own
  // height or every head would clamp to full brightness and float.
  float ao = mix(0.58, 1.0, clamp(vHeight / (vOccupant > 0.5 ? 1.30 : 0.92), 0.0, 1.0));
  vec3 base = tint * partShade * ao * (0.52 + 0.40 * hemi) + tint * key * 0.38 + tint * fill * 0.10;
  float fres = pow(1.0 - max(dot(normalize(vNormalView), V), 0.0), 3.0);
  // A brighter rim than the solids get: it picks out every chair's own edge,
  // which is what stops a block of them merging into one mass up close.
  base += vec3(0.26, 0.31, 0.38) * fres * 0.55;
  base = mix(base, uFadeColor, vDim * 0.75);
  fragColor = vec4(base, 1.0);
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
in float iPhysicalSeat;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSeatRadius;
uniform float uSeatScale;
uniform float uMinPixels;
uniform float uPixelToWorld;
out vec2 vUv;
out float vPhysicalSeat;
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
  vPhysicalSeat = iPhysicalSeat;
  gl_Position = projectionMatrix * mv;
}`;

const SEAT_PICK_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in float vPhysicalSeat;
flat in vec3 vPick;
out vec4 fragColor;
void main() {
  float d = mix(max(abs(vUv.x), abs(vUv.y)), length(vUv), vPhysicalSeat);
  if (d > 1.0) discard;                        // hit-mask matches chair/bay shape
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
      uMinPixels: { value: SEAT_MIN_PIXELS_NEAR },
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
      uMinPixels: { value: SEAT_MIN_PIXELS_NEAR },
      uPixelToWorld: { value: 0.002 },
      uSeatFade: { value: 0 },
      uFocusFloor: { value: -1 },
      uFadeColor: { value: new Float32Array([0.32, 0.37, 0.43]) },
      uChairFull: { value: CHAIR_FULL_M },
      uChairNone: { value: CHAIR_NONE_M },
    },
  });
}

/**
 * The near-field chair program.
 *
 * OPAQUE and depth-writing, unlike the dots. That is the reason the transition
 * is a scale-in and not a cross-fade: a translucent chair either writes depth
 * and punches its own silhouette through the chairs behind it, or does not and
 * shows its own back panel through its own seat pad. Growing an opaque chair out
 * of the seat point avoids both, and it composes correctly with the dot, which
 * still draws afterwards in the transparent pass.
 *
 * `cullFace` stays off to match the rest of the renderer — the meshes are closed
 * opaque boxes, so the depth test already suppresses the back faces' cost, and a
 * winding mistake here would silently blank the chairs rather than fail loudly.
 */
export function createChairProgram(gl: OGLRenderingContext): Program {
  return new Program(gl, {
    vertex: CHAIR_VERT,
    fragment: CHAIR_FRAG,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    cullFace: false,
    uniforms: {
      uKeyDir: { value: new Float32Array([0.38, 0.86, 0.34]) },
      uFadeColor: { value: new Float32Array([0.32, 0.37, 0.43]) },
      uChairFull: { value: CHAIR_FULL_M },
      uChairNone: { value: CHAIR_NONE_M },
      uBackRake: { value: BACK_RAKE_SLOPE },
      uBackBase: { value: BACK_BASE_M },
      uFocusFloor: { value: -1 },
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
