/**
 * Slice 3 — the purchase-moment fly-to-seat cinematic controller. One continuous
 * shot from the venue overview into the picked seat: a catmull-rom position
 * spline (smootherstep timing) + a look-at quaternion slerp whose orientation
 * slightly LEADS the position, with a gentle FOV push-in. The pure maths lives
 * in cinematicMath.ts (tested); this drives the OGL camera with it.
 *
 * Technique locked in docs/3d-usp-strategy-2026-07-23.md §3.
 */

import { Quat, Vec3 } from 'ogl';
import type { Camera } from 'ogl';
import {
  FLIGHT_DURATION_MS, ORIENTATION_LEAD,
  sampleFlight, orientationLeadT, type Vec3Arr,
} from './cinematicMath';

export {
  FLIGHT_DURATION_MS, FOV_START, FOV_END, ORIENTATION_LEAD,
  smootherstep, orientationLeadT, catmullRom, buildWaypoints, sampleFlight,
  type Vec3Arr, type FlightSample,
} from './cinematicMath';

/** Look-at quaternion from `from` toward `to`, computed via the OGL camera
 * (save/restore) — no manual quat maths. Synchronous, no render between. */
export function lookAtQuat(camera: Camera, from: Vec3Arr, to: Vec3Arr): Quat {
  const savedPos = camera.position.clone();
  const savedQuat = new Quat().copy(camera.quaternion);
  camera.position.set(from[0], from[1], from[2]);
  camera.lookAt(new Vec3(to[0], to[1], to[2]));
  const q = new Quat().copy(camera.quaternion);
  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  return q;
}

/** Drives the OGL camera along a flight. Integrated with the render loop: the
 * loop calls update() each frame while active. */
export class Cinematic {
  active = false;
  private camera: Camera;
  private waypoints: Vec3Arr[] = [];
  private startQuat = new Quat();
  private endQuat = new Quat();
  private outQuat = new Quat();
  private startTime = 0;
  private duration = FLIGHT_DURATION_MS;
  private resolveFn: (() => void) | null = null;

  constructor(camera: Camera) {
    this.camera = camera;
  }

  /** Begin (or retarget) a flight. Resolves when it lands or is cancelled. */
  start(waypoints: Vec3Arr[], startQuat: Quat, endQuat: Quat, duration = FLIGHT_DURATION_MS): Promise<void> {
    this.settle(); // resolve any in-flight promise before retargeting
    this.waypoints = waypoints;
    this.startQuat.copy(startQuat);
    this.endQuat.copy(endQuat);
    this.duration = duration;
    this.startTime = performance.now();
    this.active = true;
    return new Promise<void>((res) => { this.resolveFn = res; });
  }

  /** Advance the flight, mutating the camera. Returns true while still flying. */
  update(now: number): boolean {
    if (!this.active) return false;
    const u = Math.min(1, (now - this.startTime) / this.duration);
    const { pos, fov, eased } = sampleFlight(this.waypoints, u);
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.outQuat.copy(this.startQuat).slerp(this.endQuat, orientationLeadT(eased, ORIENTATION_LEAD));
    this.camera.quaternion.copy(this.outQuat);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    if (u >= 1) { this.settle(); return false; }
    return true;
  }

  /** Stop where we are (no snap) — the camera keeps its current pose. */
  cancel(): void {
    this.settle();
  }

  private settle(): void {
    this.active = false;
    const r = this.resolveFn;
    this.resolveFn = null;
    if (r) r();
  }
}
