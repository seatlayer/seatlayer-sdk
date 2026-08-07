import type { Point } from '../../core/types';
import { M } from '../scene/geometry';
import type { Vec3Arr } from './cinematicMath';

/** Seated eye height above the rendered seat deck. */
export const SEAT_EYE_ABOVE_DECK_M = 1.02;

/** The authored focal is a floor point; aim at show/stage eye level. */
export const FOCAL_LOOK_HEIGHT_M = 1.5;

/**
 * Resolve the truthful pose for an in-scene view from a selected seat.
 *
 * The cinematic deliberately arrives behind and above this pose. Entering 360
 * is the point at which the camera must move to the buyer's actual seated eye,
 * while still looking at the focal resolved for that seat's zone/floor.
 */
export function seatViewPose(
  seatDeckWorld: Vec3Arr,
  focalPoint: Point,
  floorBaseHeightM = 0,
): { eye: Vec3Arr; focal: Vec3Arr } {
  return {
    eye: [seatDeckWorld[0], seatDeckWorld[1] + SEAT_EYE_ABOVE_DECK_M, seatDeckWorld[2]],
    focal: [
      focalPoint.x * M,
      floorBaseHeightM + FOCAL_LOOK_HEIGHT_M,
      focalPoint.y * M,
    ],
  };
}
