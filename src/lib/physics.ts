/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pure, framework-free physics and collision math for the pseudo-3D racer.
//
// This logic used to live as closures inside GameCanvas, which made it
// impossible to test without spinning up a canvas and an animation loop.
// Everything here takes plain inputs and returns plain values — no React, no
// DOM, no mutable game state — so it can be unit tested in isolation and reused
// by both the player physics and the AI traffic.

export type Gear = 'LOW' | 'HIGH';

// ---------------------------------------------------------------------------
// Drivetrain / speed
// ---------------------------------------------------------------------------
export const LOW_GEAR_TOP_SPEED = 220.0;
export const HIGH_GEAR_TOP_SPEED = 385.0;

// How many world units the car covers per km/h. This is the dominant lever for
// how fast the game *feels*: it controls how quickly road segments rush past
// the camera. The original 5.0 only advanced ~1.3 segments/sec even at the
// low-gear cap (sluggish for a "turbo racer"); 10.0 traverses ~2.8 segments/sec
// in low gear and ~5+ in high gear for a proper sense of speed.
export const SPEED_TO_WORLD_MULTIPLIER = 20.0;

// Curves should only pressure the car once speed builds, so low-speed keyboard
// play doesn't feel like a constant drift before the player has steering
// authority to counter it.
export const CURVE_PULL_START_SPEED = 90.0;
export const CURVE_PULL_FULL_SPEED = 285.0;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Move `value` toward `target` by at most `maxDelta`, without overshooting.
export const approach = (value: number, target: number, maxDelta: number) => {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return value;
};

// Wrap a track-relative Z offset into [-totalLength/2, +totalLength/2] so the
// looping track reports the shortest signed distance between two points.
export const normalizeRelativeZ = (relativeZ: number, totalLength: number) => {
  if (relativeZ < -totalLength / 2) return relativeZ + totalLength;
  if (relativeZ > totalLength / 2) return relativeZ - totalLength;
  return relativeZ;
};

export const topSpeedForGear = (gear: Gear) =>
  gear === 'LOW' ? LOW_GEAR_TOP_SPEED : HIGH_GEAR_TOP_SPEED;

// Convert km/h into world units travelled per second along the track.
export const speedToWorldUnitsPerSec = (speedKmh: number) =>
  (speedKmh / 3.6) * SPEED_TO_WORLD_MULTIPLIER;

// The simulation runs in km/h internally (all tuning and tests are in km/h);
// the HUD and leaderboard display mph via this conversion.
export const KMH_TO_MPH = 0.621371;
export const kmhToMph = (speedKmh: number) => speedKmh * KMH_TO_MPH;

export interface DrivetrainInput {
  gear: Gear;
  speed: number;       // current speed, km/h
  accelInput: boolean;
  brakeInput: boolean;
}

// Net acceleration in km/h per second, already including aerodynamic drag.
// A lightweight arcade drivetrain: torque fades near the redline, high gear
// bogs below its powerband, and drag is always applied so lift-off coasts down
// naturally. The caller integrates this against dt and clamps to [0, topSpeed].
export function computeDrivetrainAcceleration({
  gear,
  speed,
  accelInput,
  brakeInput,
}: DrivetrainInput): number {
  const maxSpeed = topSpeedForGear(gear);
  const speedRatio = clamp(speed / maxSpeed, 0, 1);
  let acceleration = 0;

  if (accelInput && !brakeInput) {
    const basePower = gear === 'LOW' ? 255 : 190;
    const torqueCurve = clamp(1.0 - 0.62 * speedRatio * speedRatio, 0.22, 1.0);
    // High gear bogs below its powerband, but as a smooth ramp instead of a
    // hard 0.34x cliff at 125 km/h that made an early upshift feel like the
    // engine had stalled. It now pulls cleanly once past ~60 km/h.
    const lugPenalty = gear === 'HIGH' ? clamp(0.55 + speed / 140, 0.55, 1.0) : 1.0;
    acceleration += basePower * torqueCurve * lugPenalty;
  }

  if (brakeInput) {
    acceleration -= 470 + speed * 0.18;
  } else if (!accelInput) {
    acceleration -= 24 + speed * 0.055;
  }

  const aeroDrag = 10 + speed * speed * 0.00034;
  return acceleration - aeroDrag;
}

// ---------------------------------------------------------------------------
// Steering / curves
// ---------------------------------------------------------------------------
export interface LateralInput {
  steerInput: number;    // smoothed steering, -1..+1
  speed: number;         // km/h
  segmentCurve: number;  // signed curvature of the current road segment
  grip: number;          // road + shoulder grip multiplier (1.0 = full grip)
}

// Lateral (sideways) acceleration in road-space units per second^2. Steering
// authority grows with speed; the curve pulls the car toward the outside of a
// bend once past CURVE_PULL_START_SPEED, and a counter-steer assist opposes
// that pull so coasting through a long sweeper doesn't feel like a one-sided
// drift.
export function computeLateralAcceleration({
  steerInput,
  speed,
  segmentCurve,
  grip,
}: LateralInput): number {
  const speed01 = clamp(speed / HIGH_GEAR_TOP_SPEED, 0, 1);
  const steeringAuthority = (1.15 + speed01 * 2.15) * grip;
  const curveForce01 = clamp(
    (speed - CURVE_PULL_START_SPEED) / (CURVE_PULL_FULL_SPEED - CURVE_PULL_START_SPEED),
    0,
    1,
  );
  const curvePull = segmentCurve * (0.05 + speed01 * 0.26) * curveForce01;
  // Opposes the pull (note the sign): a previous version negated this, which
  // amplified the pull instead and made the car slide steadily to one side.
  const counterSteerAssist = clamp(curvePull * 0.5, -0.22, 0.22);
  return (steerInput * steeringAuthority + counterSteerAssist - curvePull) * grip;
}

// ---------------------------------------------------------------------------
// Collision  (rebuilt from scratch)
// ---------------------------------------------------------------------------
//
// REFERENCE FRAME — this is the crux, and where every previous version went
// wrong. `relZ` / `prevRelZ` are measured from the PLAYER CAR, not the camera:
//
//     relZ = carZ - playerCarZ      (playerCarZ = cameraZ + DISTANCE_TO_PLAYER)
//
//   * relZ > 0  -> the traffic car is AHEAD of the player (not yet reached).
//   * relZ ~ 0  -> the traffic car is level with the player car (impact point).
//   * relZ < 0  -> the traffic car is BEHIND the player (already passed).
//
// The old code measured relЗ from the camera, which sits ~DISTANCE_TO_PLAYER
// (150 world units) BEHIND the visible player car. Traffic is also culled from
// rendering once it gets within DISTANCE_TO_PLAYER of the camera. The result:
// a car would visually reach the player, disappear, and only THEN — ~150 units
// later, at the camera — register a hit. That is the "I get hit when the car is
// behind me / when I'm not touching it" bug. The caller must now pass
// player-car-relative coordinates.

// Traffic sits at lateral offsets -LANE_SPACING / 0 / +LANE_SPACING.
export const LANE_SPACING = 0.61;

// How far AHEAD of the player car (world units) a traffic car still counts as
// touching. Deliberately small for a forgiving arcade hitbox; faster
// pass-throughs are caught by the swept check below, not this window.
export const COLLISION_Z_DEPTH = 26;

// Largest plausible one-frame change in relative Z (even on a laggy frame at top
// speed). A swept "pass-through" wider than this is not a real overtake — it is
// the normalized relZ flipping sign as a car crosses the far side of the looping
// track, and must NOT register as a collision.
export const MAX_SWEEP_DISTANCE = 700;

// Lateral half-width of the combined player+traffic hitbox, in road-space units.
// MUST stay below half the lane spacing (0.305) so the player can sit anywhere
// within a lane — and on the line between two lanes — without clipping a
// neighbour. Yields 0.25 (normal car) / 0.30 (truck).
export const carCollisionHalfWidth = (carWidth: number) => 0.10 + carWidth * 0.15;

export interface CollisionInput {
  playerX: number;       // player lateral offset
  carOffset: number;     // traffic car lateral offset
  carWidth: number;
  relZ: number;          // car position relative to the PLAYER CAR this frame (+ = ahead)
  prevRelZ: number;      // ...and last frame
}

// True when the player crashes into a traffic car this frame.
//
// One-sided on purpose, like a classic arcade racer: you only ever crash by
// running INTO a car ahead of you.
//
//   1. Lateral gate: the boxes must overlap across the road.
//   2. A car that was already BEHIND the player last frame (prevRelZ < 0) never
//      crashes you — it has been passed, or it is overtaking from behind.
//   3. Otherwise it was ahead: crash if the player swept clear through it this
//      frame (fast pass-through that didn't span more than one frame's travel —
//      see MAX_SWEEP_DISTANCE, which rejects track-wrap sign flips), or it is
//      still ahead, within the depth window, and the gap is closing (relZ <=
//      prevRelZ — the player is catching it, not being left behind).
export function detectCarCollision(i: CollisionInput): boolean {
  if (Math.abs(i.carOffset - i.playerX) >= carCollisionHalfWidth(i.carWidth)) return false;
  if (i.prevRelZ < 0) return false;
  if (i.relZ <= 0) return i.prevRelZ - i.relZ < MAX_SWEEP_DISTANCE;
  return i.relZ < COLLISION_Z_DEPTH && i.relZ <= i.prevRelZ;
}
