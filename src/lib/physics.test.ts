/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  approach,
  normalizeRelativeZ,
  topSpeedForGear,
  speedToWorldUnitsPerSec,
  computeDrivetrainAcceleration,
  computeLateralAcceleration,
  detectCarCollision,
  carCollisionHalfWidth,
  COLLISION_Z_DEPTH,
  LANE_SPACING,
  LOW_GEAR_TOP_SPEED,
  HIGH_GEAR_TOP_SPEED,
  SPEED_TO_WORLD_MULTIPLIER,
  CURVE_PULL_START_SPEED,
  type Gear,
  type DrivetrainInput,
} from './physics.ts';

// Integrate the drivetrain forward in time the same way the game loop does, so
// tests can assert on emergent behavior (top speed, accel time) rather than a
// single frame.
function simulateSpeed(
  opts: {
    gear: Gear;
    accelInput?: boolean;
    brakeInput?: boolean;
    startSpeed?: number;
    seconds: number;
    dt?: number;
  },
): number {
  const dt = opts.dt ?? 1 / 60;
  let speed = opts.startSpeed ?? 0;
  const maxSpeed = topSpeedForGear(opts.gear);
  const steps = Math.round(opts.seconds / dt);
  for (let i = 0; i < steps; i++) {
    const input: DrivetrainInput = {
      gear: opts.gear,
      speed,
      accelInput: opts.accelInput ?? true,
      brakeInput: opts.brakeInput ?? false,
    };
    speed += computeDrivetrainAcceleration(input) * dt;
    speed = clamp(speed, 0, maxSpeed);
  }
  return speed;
}

describe('math helpers', () => {
  test('clamp bounds values', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });

  test('approach moves toward target without overshoot', () => {
    assert.equal(approach(0, 1, 0.3), 0.3);
    assert.equal(approach(0.9, 1, 0.3), 1); // would overshoot -> clamps to target
    assert.equal(approach(1, -1, 0.3), 0.7);
    assert.equal(approach(5, 5, 1), 5);
  });

  test('normalizeRelativeZ returns the shortest signed distance on the loop', () => {
    const total = 1000;
    assert.equal(normalizeRelativeZ(100, total), 100);
    // A car 900 ahead on a 1000-long loop is really 100 behind.
    assert.equal(normalizeRelativeZ(900, total), -100);
    // 900 behind is really 100 ahead.
    assert.equal(normalizeRelativeZ(-900, total), 100);
  });
});

describe('speed / world conversion', () => {
  test('km/h converts to world units per second via the multiplier', () => {
    assert.equal(speedToWorldUnitsPerSec(36), (36 / 3.6) * SPEED_TO_WORLD_MULTIPLIER);
    assert.equal(speedToWorldUnitsPerSec(0), 0);
  });

  test('top speed depends on gear', () => {
    assert.equal(topSpeedForGear('LOW'), LOW_GEAR_TOP_SPEED);
    assert.equal(topSpeedForGear('HIGH'), HIGH_GEAR_TOP_SPEED);
  });
});

describe('drivetrain', () => {
  test('full throttle in LOW gear climbs to (and holds at) the low-gear cap', () => {
    const top = simulateSpeed({ gear: 'LOW', seconds: 12 });
    assert.ok(top > LOW_GEAR_TOP_SPEED - 1, `expected ~${LOW_GEAR_TOP_SPEED}, got ${top}`);
    assert.ok(top <= LOW_GEAR_TOP_SPEED + 1e-6);
  });

  test('full throttle in HIGH gear reaches well past the low-gear cap', () => {
    const top = simulateSpeed({ gear: 'HIGH', seconds: 30 });
    assert.ok(top > 360, `HIGH gear should approach ${HIGH_GEAR_TOP_SPEED}, got ${top}`);
    assert.ok(top <= HIGH_GEAR_TOP_SPEED + 1e-6);
  });

  test('LOW gear out-accelerates HIGH gear from a standstill (gearbox matters)', () => {
    const lowAfter1s = simulateSpeed({ gear: 'LOW', seconds: 1 });
    const highAfter1s = simulateSpeed({ gear: 'HIGH', seconds: 1 });
    assert.ok(
      lowAfter1s > highAfter1s,
      `LOW (${lowAfter1s}) should launch harder than HIGH (${highAfter1s})`,
    );
  });

  test('HIGH gear lug penalty ramps smoothly (no hard cliff)', () => {
    // The old model multiplied power by 0.34 below 125 km/h. With the smooth
    // ramp, accelerating from a near-standstill in HIGH still makes real
    // progress within a second rather than crawling.
    const after1s = simulateSpeed({ gear: 'HIGH', startSpeed: 5, seconds: 1 });
    assert.ok(after1s > 60, `HIGH gear should pull away from low speed, got ${after1s}`);
  });

  test('coasting (no throttle) decelerates', () => {
    const accel = computeDrivetrainAcceleration({
      gear: 'HIGH',
      speed: 200,
      accelInput: false,
      brakeInput: false,
    });
    assert.ok(accel < 0, `coasting should decelerate, got ${accel}`);
  });

  test('braking decelerates much harder than coasting', () => {
    const base = { gear: 'HIGH' as Gear, speed: 200 };
    const coast = computeDrivetrainAcceleration({ ...base, accelInput: false, brakeInput: false });
    const brake = computeDrivetrainAcceleration({ ...base, accelInput: false, brakeInput: true });
    assert.ok(brake < coast, 'brake should be stronger than coast');
    assert.ok(brake < -400, `braking should be a strong negative accel, got ${brake}`);
  });

  test('speed never exceeds the gear cap under sustained throttle', () => {
    const top = simulateSpeed({ gear: 'HIGH', startSpeed: HIGH_GEAR_TOP_SPEED, seconds: 5 });
    assert.ok(top <= HIGH_GEAR_TOP_SPEED + 1e-6);
  });
});

describe('steering / curves', () => {
  const fullGrip = 1.0;

  test('on a straight road, steering input is the only lateral force', () => {
    const straight = computeLateralAcceleration({
      steerInput: 1,
      speed: 200,
      segmentCurve: 0,
      grip: fullGrip,
    });
    assert.ok(straight > 0, 'steering right should push right on a straight');

    const noInput = computeLateralAcceleration({
      steerInput: 0,
      speed: 200,
      segmentCurve: 0,
      grip: fullGrip,
    });
    assert.equal(noInput, 0, 'no steering on a straight road => no drift');
  });

  test('below the curve-pull threshold the car does not drift while coasting', () => {
    const accel = computeLateralAcceleration({
      steerInput: 0,
      speed: CURVE_PULL_START_SPEED - 10,
      segmentCurve: 2.0,
      grip: fullGrip,
    });
    assert.equal(accel, 0, 'no curve pull below CURVE_PULL_START_SPEED');
  });

  test('the counter-steer assist REDUCES curve pull (regression: it used to amplify it)', () => {
    // With the bug, the "assist" was negated and added to the pull. We assert
    // the assist now strictly shrinks the magnitude of the coasting drift.
    const speed = 250;
    const curve = 2.0;
    const grip = fullGrip;

    const withAssist = computeLateralAcceleration({ steerInput: 0, speed, segmentCurve: curve, grip });

    // Reconstruct the raw pull (no assist term) to compare magnitudes.
    const speed01 = clamp(speed / HIGH_GEAR_TOP_SPEED, 0, 1);
    const curveForce01 = clamp((speed - CURVE_PULL_START_SPEED) / (285 - CURVE_PULL_START_SPEED), 0, 1);
    const rawPull = curve * (0.05 + speed01 * 0.26) * curveForce01;
    const rawAccel = -rawPull * grip;

    assert.ok(withAssist < 0, 'a positive curve still pulls the car toward the outside (negative)');
    assert.ok(
      Math.abs(withAssist) < Math.abs(rawAccel),
      `assist should reduce drift: |${withAssist}| should be < |${rawAccel}|`,
    );
  });

  test('curve drift is symmetric: opposite curves produce opposite, equal pulls', () => {
    const right = computeLateralAcceleration({ steerInput: 0, speed: 250, segmentCurve: 2.0, grip: 1 });
    const left = computeLateralAcceleration({ steerInput: 0, speed: 250, segmentCurve: -2.0, grip: 1 });
    assert.ok(Math.abs(right + left) < 1e-9, 'mirrored curves should cancel');
  });

  test('steering authority grows with speed', () => {
    const slow = computeLateralAcceleration({ steerInput: 1, speed: 40, segmentCurve: 0, grip: 1 });
    const fast = computeLateralAcceleration({ steerInput: 1, speed: 360, segmentCurve: 0, grip: 1 });
    assert.ok(fast > slow, 'more steering authority at speed');
  });
});

describe('collision detection', () => {
  // A baseline same-lane encounter with a car just ahead of the player.
  const baseline = {
    playerX: 0,
    carOffset: 0,
    carWidth: 1,
    relZ: 10,
    prevRelZ: 20,
  };

  test('half-width grows with car width', () => {
    assert.ok(carCollisionHalfWidth(1.35) > carCollisionHalfWidth(1.0));
  });

  test('running into a car just ahead in the same lane => collision', () => {
    assert.equal(detectCarCollision(baseline), true);
  });

  test('adjacent lane => no collision even when overlapping in Z', () => {
    assert.equal(detectCarCollision({ ...baseline, carOffset: 0.61 }), false);
  });

  test('far ahead in same lane => no collision', () => {
    assert.equal(detectCarCollision({ ...baseline, relZ: 200, prevRelZ: 210 }), false);
  });

  test('a car ahead pulling away faster than the player => no collision', () => {
    // relZ grew (20 -> 30): the gap is opening, so the player is not running
    // into it even though it is briefly within the hitbox.
    assert.equal(detectCarCollision({ ...baseline, prevRelZ: 20, relZ: 30 }), false);
  });

  test('player overtaking a slower car ahead (swept ahead->behind) => collision', () => {
    // High closing speed jumps the car from in-front to behind in one frame.
    assert.equal(detectCarCollision({ ...baseline, prevRelZ: 40, relZ: -40 }), true);
  });

  test('REGRESSION: a slower car the player has passed (now behind) never crashes', () => {
    assert.equal(
      detectCarCollision({ ...baseline, relZ: -20, prevRelZ: -25 }),
      false,
    );
  });

  test('REGRESSION: a faster car overtaking from behind never crashes the player', () => {
    // The reported bug: "I get hit if the AI car goes behind me." A car that was
    // behind last frame is never the player's fault — neither while it is still
    // behind and catching up...
    assert.equal(detectCarCollision({ ...baseline, relZ: -20, prevRelZ: -30 }), false);
    // ...nor on the frame it crosses ahead of the player as it passes.
    assert.equal(detectCarCollision({ ...baseline, relZ: 25, prevRelZ: -10 }), false);
  });

  test('high speed: a one-frame jump straight through a same-lane car still collides', () => {
    // At a 20x world multiplier a laggy frame can advance the player ~200 world
    // units, throwing a slower car from well ahead (+80) to well behind (-78) in
    // a single step — past the proximity window entirely. The swept (sign
    // crossing) path must still register the hit.
    assert.ok(Math.abs(80) > COLLISION_Z_DEPTH && Math.abs(78) > COLLISION_Z_DEPTH);
    assert.equal(detectCarCollision({ ...baseline, prevRelZ: 80, relZ: -78 }), true);
  });

  test('REGRESSION: a relZ sign flip across the track wrap is NOT a collision', () => {
    // A car on the far side of the looping track has its normalized relZ flip
    // from a large positive to a large negative as it crosses the wrap point.
    // That is not a pass-through and must never register a (phantom) crash.
    assert.equal(detectCarCollision({ ...baseline, prevRelZ: 6000, relZ: -6000 }), false);
    // ...but a genuine one-frame pass-through (small span) still collides.
    assert.equal(detectCarCollision({ ...baseline, prevRelZ: 150, relZ: -120 }), true);
  });

  test('high speed: that same jump in an adjacent lane does NOT collide', () => {
    // Lane gating must still hold so blowing past traffic in another lane at top
    // speed never phantom-crashes.
    assert.equal(
      detectCarCollision({ ...baseline, carOffset: 0.61, prevRelZ: 80, relZ: -78 }),
      false,
    );
  });
});

describe('collision detection — real lane geometry', () => {
  // Traffic spawns in three lanes at these lateral offsets (see spawnCars).
  const LANE = LANE_SPACING;
  const overlappingZ = { relZ: 5, prevRelZ: 15 };

  function hit(playerX: number, carOffset: number, carWidth = 1) {
    return detectCarCollision({
      playerX,
      carOffset,
      carWidth,
      ...overlappingZ,
    });
  }

  test('same-lane car is hit in every lane', () => {
    assert.equal(hit(-LANE, -LANE), true);
    assert.equal(hit(0, 0), true);
    assert.equal(hit(LANE, LANE), true);
  });

  test('the hitbox stays inside half a lane so each lane has a safe zone', () => {
    // If the half-width ever grew past half the lane spacing, you could clip a
    // neighbouring car while sitting legitimately inside your own lane — the
    // "hit when I wasn't touching it" bug.
    assert.ok(carCollisionHalfWidth(1.0) < LANE / 2, 'normal car hitbox must fit within half a lane');
    assert.ok(carCollisionHalfWidth(1.35) <= LANE / 2, 'even a truck must fit within half a lane');
  });

  test('a car one full lane away is always safe — even a truck', () => {
    assert.equal(hit(0, LANE), false); // player center, car right lane
    assert.equal(hit(0, -LANE), false); // player center, car left lane
    assert.equal(hit(0, LANE, 1.35), false); // ...and the same for a truck
  });

  test('drifting toward your own lane edge does NOT clip the adjacent car', () => {
    // Player at 0.20 is still well within the center lane; the right-lane car
    // (0.61) must not register a hit. Under the old 0.40 hitbox it would have.
    assert.equal(hit(0.20, LANE), false);
    assert.equal(hit(0.20, 0), true); // ...but the car in your own lane still hits
  });

  test('a wider truck hitbox catches a glancing offset a normal car would slip past', () => {
    const grazingOffset = 0.27; // between the normal (0.25) and truck (0.30) half-widths
    assert.equal(hit(0, grazingOffset, 1.0), false);
    assert.equal(hit(0, grazingOffset, 1.35), true);
  });

  test('sitting on the line between two lanes is safe (no phantom double hit)', () => {
    const midpoint = LANE / 2; // 0.305, exactly between center and right lane
    assert.equal(hit(midpoint, 0), false);
    assert.equal(hit(midpoint, LANE), false);
  });
});
