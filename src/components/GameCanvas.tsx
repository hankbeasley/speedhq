/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { audio } from '../lib/AudioEngine';
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
  kmhToMph,
  LANE_SPACING,
  COLLISION_Z_DEPTH,
  LOW_GEAR_TOP_SPEED,
  HIGH_GEAR_TOP_SPEED,
} from '../lib/physics';
import { PlayerSettings, RoadSegment, GameCar, Particle, ActiveScenery, RoadSprite } from '../types';
import { Sliders, RotateCcw, Volume2, VolumeX, ShieldAlert, Zap, Radio, Phone, Compass, ArrowUp, ArrowDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';

interface GameCanvasProps {
  settings: PlayerSettings;
  updateSettings: (s: Partial<PlayerSettings>) => void;
  onGameOver: (score: number, maxSpeed: number, stage: number) => void;
}

// -------------------------------------------------------------------------
// PERSISTENT CONSTANTS FOR THE PSEUDO-3D RENDER ENGINE
// -------------------------------------------------------------------------
const ROAD_SEGMENT_LENGTH = 200; // world units per segment
const ROAD_WIDTH = 2000;         // road width (world units)
const VIEW_DEPTH = 30;           // number of segments to draw forward
const CAMERA_HEIGHT = 1000;      // camera vertical height above road
const DISTANCE_TO_PLAYER = 150;  // near road cull: segments closer than this are skipped
const CAMERA_DEPTH = 0.8;        // perspective fov multiplier
const LANE_COUNT = 3;

// The player car sprite is drawn at this fraction of the canvas height.
const PLAYER_SPRITE_Y_FRACTION = 0.78;
// ...which means it visually sits at this camera-relative Z on the road. A flat
// road point projects to screenY/H = 0.5 * (1 + CAMERA_HEIGHT*CAMERA_DEPTH/relZ),
// so solving for relZ at the sprite's Y gives where the player car *appears* to
// be. Collisions must be resolved here (not at DISTANCE_TO_PLAYER, which lands
// well below the visible road) so a crash always lines up with a car you can see.
const PLAYER_CAR_ROAD_Z =
  (CAMERA_HEIGHT * CAMERA_DEPTH) / (2 * PLAYER_SPRITE_Y_FRACTION - 1);

// Lateral road-space bounds used when clamping the player's position. The
// drivetrain, steering, and collision math now live in ../lib/physics so they
// can be unit tested without a canvas or animation loop.
const ROAD_EDGE = 0.98;
const HARD_SHOULDER_EDGE = 2.0;


type AliefTrafficCar =
  | 'acura_integra'
  | 'ford_tempo'
  | 'mr2_86'
  | 'pontiac_fiero'
  | 'ford_probe'
  | 'ambulance'
  | 'truck';

const ALIEF_TRAFFIC_MODELS: AliefTrafficCar[] = [
  'acura_integra',
  'ford_tempo',
  'mr2_86',
  'pontiac_fiero',
  'ford_probe'
];

const TRAFFIC_CAR_COLORS: Record<AliefTrafficCar, string> = {
  acura_integra: '#ef4444',
  ford_tempo: '#d6d3d1',
  mr2_86: '#f8fafc',
  pontiac_fiero: '#f97316',
  ford_probe: '#2563eb',
  ambulance: '#ef4444',
  truck: '#334155'
};

// Map out the continuous looping stage segments
const SCENERY_STAGES: ActiveScenery[] = [
  { name: "1. ALIEF NIGHT CRUISE", climate: 'city', bgColor: '#07111f', accentColor: '#38bdf8', length: 360 },
  { name: "2. BELLAIRE BLVD RUN", climate: 'city', bgColor: '#0b1020', accentColor: '#f59e0b', length: 430 },
  { name: "3. ELSIK HIGH SCHOOL", climate: 'city', bgColor: '#081624', accentColor: '#60a5fa', length: 360 },
  { name: "4. HIGH STAR DR SPRINT", climate: 'tunnel', bgColor: '#06131f', accentColor: '#22c55e', length: 330 },
  { name: "5. WESTPARK TOLLWAY DASH", climate: 'city', bgColor: '#030712', accentColor: '#ec4899', length: 420 }
];

const STAGE_BOUNDARIES = SCENERY_STAGES.reduce<Array<{ start: number; end: number }>>((bounds, stage) => {
  const start = bounds.length === 0 ? 0 : bounds[bounds.length - 1].end;
  bounds.push({ start, end: start + stage.length });
  return bounds;
}, []);

const TOTAL_SCENERY_SEGMENTS = STAGE_BOUNDARIES[STAGE_BOUNDARIES.length - 1].end;

const getStageInfo = (segmentIdx: number) => {
  const scenerySegment = segmentIdx % TOTAL_SCENERY_SEGMENTS;
  const stageIdx = STAGE_BOUNDARIES.findIndex(boundary => scenerySegment >= boundary.start && scenerySegment < boundary.end);
  const safeStageIdx = stageIdx >= 0 ? stageIdx : SCENERY_STAGES.length - 1;
  const boundary = STAGE_BOUNDARIES[safeStageIdx];
  return {
    stageIdx: safeStageIdx,
    progress: clamp((scenerySegment - boundary.start) / Math.max(boundary.end - boundary.start, 1), 0, 1)
  };
};

export default function GameCanvas({ settings, updateSettings, onGameOver }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // Game state refs (necessary for 60fps synchronous loop without React lag)
  const stateRef = useRef({
    running: false,
    started: false,
    isCountingDown: true,
    countdownVal: 3,
    
    playerX: 0.0,            // current player offset from road center (-1 to +1)
    playerZ: 0.0,            // physical distance along track Z
    speed: 0.0,              // current speed (km/h)
    gear: 'LOW' as 'LOW' | 'HIGH',
    rpm: 0.0,                // engine revs factor (0.0 to 1.0)
    
    steerInput: 0,           // smoothed steering value (-1 to +1)
    targetSteerInput: 0,     // raw steering target from keyboard/touch/tilt
    lateralVelocity: 0,      // sideways road-space velocity; gives steering inertia
    accelInput: false,
    brakeInput: false,
    keySteerLeft: false,
    keySteerRight: false,
    touchSteerLeft: false,
    touchSteerRight: false,

    timeLimit: 80.0,         // seconds remaining
    score: 0,
    maxSpeedAchieved: 0,
    currentStageIdx: 0,
    stageProgress: 0,        // Z progress relative to stage width
    lapCompleted: 0,

    invincibilityTimer: 0.0,  // blink recovery
    crashAnimationTimer: 0.0, // spin out control
    isCrashActive: false,

    totalSegmentsCount: 0,
    roadSegments: [] as RoadSegment[],
    activeCars: [] as GameCar[],
    particles: [] as Particle[],

    // Calibration
    flatRoll: 0,             // calibrated baseline of the steering-roll axis
    tiltValue: 0,            // live calculated relative tilt value
    steeringMode: settings.steeringMode, // cached steering mode for closures

    // Stats
    nearMissCount: 0,
    totalDistanceDriven: 0,
    uiUpdateTimer: 0,

    // Debug: when showDebug is on, a collision freezes the loop (paused) so the
    // readout can be inspected; the Resume button clears it. Off by default for
    // normal play — the DEBUG button re-enables it.
    paused: false,
    showDebug: false,

    // Collision debug snapshot (nearest traffic car, relative to the player car)
    debug: {
      nearestRelZ: 0,
      nearestCamZ: 0,     // camera-relative Z; visible road is roughly 800..6000
      nearestLateral: 0,
      nearestHalfWidth: 0,
      nearestType: '',
      nearestInLane: false,
      lastHitRelZ: 0
    }
  });

  const [uiState, setUiState] = useState({
    speed: 0,
    gear: 'LOW',
    rpm: 0,
    score: 0,
    time: 80,
    stageName: '1. ALIEF NIGHT CRUISE',
    stageIdx: 0,
    stageProgressPct: 0,
    nearMissScoreAlert: 0, // transient points indicator
    countdownText: '3',
    tiltAvailable: false,
    tiltPermissionStatus: 'unknown' as 'unknown' | 'granted' | 'denied',
    isFirstInteractionRequired: true,
    showControlsHelp: true,
    showDebug: false,
    paused: false,
    isPortrait: false,
    isFullscreen: false,
    musicTrackIndex: 0,
    debug: {
      nearestRelZ: 0,
      nearestCamZ: 0,
      nearestLateral: 0,
      nearestHalfWidth: 0,
      nearestType: '',
      nearestInLane: false,
      lastHitRelZ: 0
    }
  });

  // Track portrait vs landscape so tilt mode can prompt for a wide hold.
  useEffect(() => {
    const checkAspect = () =>
      setUiState(prev => ({ ...prev, isPortrait: window.innerHeight > window.innerWidth }));
    checkAspect();
    window.addEventListener('resize', checkAspect);
    window.addEventListener('orientationchange', checkAspect);
    return () => {
      window.removeEventListener('resize', checkAspect);
      window.removeEventListener('orientationchange', checkAspect);
    };
  }, []);

  // Track fullscreen state so the toggle button shows the right icon (the user
  // can also leave fullscreen via the system back gesture / Esc).
  useEffect(() => {
    const sync = () =>
      setUiState(prev => ({
        ...prev,
        isFullscreen: !!(document.fullscreenElement || (document as any).webkitFullscreenElement),
      }));
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    sync();
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  // Apply audio settings to the engine whenever they change (also wires up the
  // BGM/FX toggles, which previously updated state but never reached the audio).
  useEffect(() => {
    audio.setMusicEnabled(settings.musicEnabled);
    audio.setSoundsEnabled(settings.soundEnabled);
    audio.setMusicVolume(settings.musicVolume);
    audio.setSfxVolume(settings.sfxVolume);
  }, [settings.musicEnabled, settings.soundEnabled, settings.musicVolume, settings.sfxVolume]);

  // Handle device orientation permissions dynamically
  useEffect(() => {
    const checkOrientationAvailability = () => {
      if (window.DeviceOrientationEvent) {
        setUiState(prev => ({ ...prev, tiltAvailable: true }));
        
        // Check standard browser permissions
        if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
          setUiState(prev => ({ ...prev, tiltPermissionStatus: 'unknown' }));
        } else {
          setUiState(prev => ({ ...prev, tiltPermissionStatus: 'granted' }));
        }
      } else {
        setUiState(prev => ({ ...prev, tiltAvailable: false, tiltPermissionStatus: 'denied' }));
      }
    };
    
    checkOrientationAvailability();
  }, []);

  // Request gyroscope/tilt controls
  useEffect(() => {
    // When settings change from parent, update mutable references that might be captured in old closures.
    // Reset held steering so switching modes never leaves the car pulling to one side.
    stateRef.current.steeringMode = settings.steeringMode;
    clearSteeringHolds();
  }, [settings.steeringMode]);

  const requestTiltPermission = async () => {
    audio.resumeContext();
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const permission = await (DeviceOrientationEvent as any).requestPermission();
        if (permission === 'granted') {
          setUiState(prev => ({ ...prev, tiltPermissionStatus: 'granted' }));
          window.addEventListener('deviceorientation', handleOrientationEvent);
          calibrateTilt();
        } else {
          setUiState(prev => ({ ...prev, tiltPermissionStatus: 'denied' }));
        }
      } catch (e) {
        console.error("Gyro permission prompt aborted", e);
        setUiState(prev => ({ ...prev, tiltPermissionStatus: 'denied' }));
      }
    } else {
      setUiState(prev => ({ ...prev, tiltPermissionStatus: 'granted' }));
      window.addEventListener('deviceorientation', handleOrientationEvent);
      calibrateTilt();
    }
  };

  // Process Device Orientation events (tilt control)
  // The "steering roll" axis depends on how the screen is oriented. In portrait
  // it's gamma (left/right tilt); held in landscape — the racing pose — the
  // device's beta axis becomes the left/right roll while gamma now tracks
  // forward/back, which is the "steering hooked to forward/back" bug. Pick the
  // axis (and sign) from the current screen orientation.
  const readRollAngle = (e: DeviceOrientationEvent): number | null => {
    const { beta, gamma } = e;
    if (beta === null || gamma === null) return null;
    const angle =
      (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number')
        ? screen.orientation.angle
        : (typeof (window as any).orientation === 'number' ? (window as any).orientation : 0);
    if (angle === 90) return beta;            // landscape
    if (angle === 270 || angle === -90) return -beta; // landscape, other way up
    return gamma;                             // portrait (fallback)
  };

  const handleOrientationEvent = (e: DeviceOrientationEvent) => {
    if (stateRef.current.steeringMode !== 'tilt') return;

    const roll = readRollAngle(e);
    if (roll === null) return;

    // Steering is the change in the roll axis from the calibrated flat baseline.
    const difference = roll - stateRef.current.flatRoll;
    stateRef.current.tiltValue = difference;

    // Deadzone and sensitivity calculations
    const deadzone = settings.tiltDeadzone;
    const sens = settings.tiltSensitivity; // e.g. 1.0 default

    let normalized = 0;
    if (Math.abs(difference) > deadzone) {
      // Scale from deadzone to maximum active steering angle (approx 28 degrees)
      const maxSteerAngle = 24 / sens;
      const offsetValue = difference > 0 ? difference - deadzone : difference + deadzone;
      normalized = offsetValue / maxSteerAngle;
      normalized = Math.min(Math.max(normalized, -1.0), 1.0);
    }

    // Smooth this in the physics step instead of snapping the car sideways.
    stateRef.current.targetSteerInput = normalized;
  };

  const calibrateTilt = () => {
    // Record the baseline of the current roll axis (matches handleOrientationEvent).
    if (window.DeviceOrientationEvent) {
      const captureFlat = (e: DeviceOrientationEvent) => {
        const roll = readRollAngle(e);
        if (roll !== null) {
          stateRef.current.flatRoll = roll;
          window.removeEventListener('deviceorientation', captureFlat);
          // Re-attach persistent orientation stream
          window.removeEventListener('deviceorientation', handleOrientationEvent);
          window.addEventListener('deviceorientation', handleOrientationEvent);
        }
      };
      window.addEventListener('deviceorientation', captureFlat);
    }
  };

  const updateKeyboardSteerTarget = () => {
    const s = stateRef.current;
    s.targetSteerInput = (s.keySteerRight ? 1 : 0) - (s.keySteerLeft ? 1 : 0);
  };

  const updateTouchSteerTarget = () => {
    const s = stateRef.current;
    s.targetSteerInput = (s.touchSteerRight ? 1 : 0) - (s.touchSteerLeft ? 1 : 0);
  };

  const clearSteeringHolds = () => {
    const s = stateRef.current;
    s.keySteerLeft = false;
    s.keySteerRight = false;
    s.touchSteerLeft = false;
    s.touchSteerRight = false;
    s.targetSteerInput = 0;
    // Keep the smoothed input and sideways velocity from coasting after an
    // alt-tab, browser focus loss, or pointer/touch cancellation.
    s.steerInput = 0;
    s.lateralVelocity = 0;
  };

  const roadGripForSegment = (segment?: RoadSegment) => {
    if (!segment) return 1.0;
    if (segment.climate === 'snow') return 0.72;
    if (segment.climate === 'desert') return 0.92;
    if (segment.climate === 'city') return 1.08;
    if (segment.climate === 'tunnel') return 1.12;
    return 1.0;
  };

  // Keyboard controls listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (uiState.isFirstInteractionRequired) return;
      
      audio.resumeContext();

      const key = e.key.toLowerCase();
      if (key === 'g' || e.code === 'Space') {
        e.preventDefault();
        toggleGear();
      }
      
      if (stateRef.current.steeringMode === 'keyboard') {
        if (key === 'arrowleft' || key === 'a') {
          e.preventDefault();
          stateRef.current.keySteerLeft = true;
          updateKeyboardSteerTarget();
        }
        if (key === 'arrowright' || key === 'd') {
          e.preventDefault();
          stateRef.current.keySteerRight = true;
          updateKeyboardSteerTarget();
        }
      }

      if (key === 'arrowup' || key === 'w') { e.preventDefault(); stateRef.current.accelInput = true; }
      if (key === 'arrowdown' || key === 's') { e.preventDefault(); stateRef.current.brakeInput = true; }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      
      if (stateRef.current.steeringMode === 'keyboard') {
        if (key === 'arrowleft' || key === 'a') {
          stateRef.current.keySteerLeft = false;
          updateKeyboardSteerTarget();
        }
        if (key === 'arrowright' || key === 'd') {
          stateRef.current.keySteerRight = false;
          updateKeyboardSteerTarget();
        }
      }

      if (key === 'arrowup' || key === 'w') stateRef.current.accelInput = false;
      if (key === 'arrowdown' || key === 's') stateRef.current.brakeInput = false;
    };

    const handleBlur = () => clearSteeringHolds();
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearSteeringHolds();
        stateRef.current.accelInput = false;
        stateRef.current.brakeInput = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [uiState.isFirstInteractionRequired]);

  // Generate the recursive track as a stylized Alief, TX night run.
  // It is not a street-accurate map; it uses recognizable local flavor:
  // Alief signs, Bellaire Blvd storefronts, High Star/Highstar Drive, and
  // a big Elsik High School campus landmark.
  const buildTrack = () => {
    const segments: RoadSegment[] = [];
    let currentZ = 0;
    let index = 0;

    SCENERY_STAGES.forEach((stage, stageIdx) => {
      const stageLength = stage.length;

      for (let i = 0; i < stageLength; i++) {
        let segmentCurve = 0;
        let segmentHill = 0;

        // Alief is mostly flat, so hills are intentionally subtle. The fun
        // comes from sweeping boulevard curves, school-zone kinks, and traffic.
        if (stageIdx === 0) {
          // Neighborhood / Alief night cruise.
          segmentCurve = Math.sin(i / 42) * 1.25 + Math.sin(i / 120) * 0.45;
          segmentHill = Math.sin(i / 55) * 2.5;
        } else if (stageIdx === 1) {
          // Bellaire Blvd: wider, faster, storefront rhythm.
          segmentCurve = Math.sin(i / 38) * 1.7;
          if ((i > 110 && i < 145) || (i > 290 && i < 335)) segmentCurve += 1.5;
          segmentHill = Math.sin(i / 45) * 2.0;
        } else if (stageIdx === 2) {
          // Elsik High School campus zone: slower visual density and small bends.
          segmentCurve = Math.sin(i / 48) * 1.15;
          if ((i > 90 && i < 135) || (i > 210 && i < 255)) segmentCurve -= 1.25;
          segmentHill = Math.sin(i / 60) * 1.5;
        } else if (stageIdx === 3) {
          // High Star Dr sprint with green-lit school/parkway feel.
          segmentCurve = Math.sin(i / 36) * 2.2 + Math.cos(i / 90) * 0.5;
          segmentHill = Math.sin(i / 50) * 2.2;
        } else {
          // Westpark-style night dash: faster, sharper, neon-heavy.
          segmentCurve = Math.sin(i / 24) * 2.8;
          segmentHill = Math.sin(i / 42) * 2.4;
        }

        const isAlternating = Math.floor(i / 3) % 2 === 0;
        let segmentColors = {
          road: '#20242b',
          grass: '#10251e',
          rumble: isAlternating ? '#f8fafc' : '#ef4444',
          lane: isAlternating ? '#71717a' : '#20242b'
        };

        if (stageIdx === 0) {
          segmentColors = {
            road: '#1f2937',
            grass: '#123524',
            rumble: isAlternating ? '#38bdf8' : '#f8fafc',
            lane: isAlternating ? '#64748b' : '#1f2937'
          };
        } else if (stageIdx === 1) {
          segmentColors = {
            road: '#262626',
            grass: '#1f2937',
            rumble: isAlternating ? '#f59e0b' : '#f8fafc',
            lane: isAlternating ? '#fef3c7' : '#262626'
          };
        } else if (stageIdx === 2) {
          segmentColors = {
            road: '#1e293b',
            grass: '#0f2f46',
            rumble: isAlternating ? '#60a5fa' : '#f8fafc',
            lane: isAlternating ? '#dbeafe' : '#1e293b'
          };
        } else if (stageIdx === 3) {
          segmentColors = {
            road: '#18212f',
            grass: '#052e16',
            rumble: isAlternating ? '#22c55e' : '#f8fafc',
            lane: isAlternating ? '#86efac' : '#18212f'
          };
        } else {
          segmentColors = {
            road: '#111827',
            grass: '#020617',
            rumble: isAlternating ? '#ec4899' : '#06b6d4',
            lane: isAlternating ? '#c084fc' : '#111827'
          };
        }

        const spritesList: RoadSprite[] = [];
        const addSprite = (spriteType: string, offset: number, scale = 1.0) => {
          spritesList.push({ spriteType, offset, scale });
        };

        // Big fixed landmarks first so they stand out in the route.
        if (stageIdx === 0 && i === 18) addSprite('alief_gateway', -1.65, 1.45);
        if (stageIdx === 1 && i === 36) addSprite('bellaire_sign', 1.65, 1.25);
        if (stageIdx === 2 && (i === 52 || i === 72 || i === 92)) addSprite('elsik_school', i === 72 ? 1.75 : -1.75, 1.65);
        if (stageIdx === 2 && (i === 120 || i === 210)) addSprite('elsik_rams', i === 120 ? 1.65 : -1.65, 1.35);
        if (stageIdx === 3 && i === 32) addSprite('high_star_sign', -1.65, 1.25);
        if (stageIdx === 4 && i === 34) addSprite('westpark_sign', 1.65, 1.25);

        if (i % 6 === 0) {
          const side = (Math.sin(i * 1.7 + stageIdx) > 0) ? 1.5 : -1.5;
          let spriteName = 'streetlight';

          if (stageIdx === 0) {
            spriteName = Math.sin(i * 0.7) > 0.15 ? 'apartment_block' : 'alief_sign';
          } else if (stageIdx === 1) {
            spriteName = Math.cos(i * 0.8) > 0 ? 'food_mart' : 'bellaire_sign';
          } else if (stageIdx === 2) {
            spriteName = Math.sin(i * 0.4) > 0.25 ? 'school_bus' : 'elsik_rams';
          } else if (stageIdx === 3) {
            spriteName = Math.cos(i * 0.7) > 0 ? 'high_star_sign' : 'streetlight';
          } else {
            spriteName = Math.sin(i * 0.9) > 0 ? 'westpark_sign' : 'billboard';
          }

          addSprite(spriteName, side, 1.0);
        }

        segments.push({
          index,
          p1: { world: { x: 0, y: 0, z: currentZ }, screen: { x: 0, y: 0, w: 0 } },
          p2: { world: { x: 0, y: 0, z: currentZ + ROAD_SEGMENT_LENGTH }, screen: { x: 0, y: 0, w: 0 } },
          curve: segmentCurve,
          hill: segmentHill,
          color: segmentColors,
          sprites: spritesList,
          climate: stage.climate
        });

        currentZ += ROAD_SEGMENT_LENGTH;
        index++;
      }
    });

    // Make the last few segments flat to blend back to start loop.
    for (let k = 0; k < 20; k++) {
      segments.push({
        index,
        p1: { world: { x: 0, y: 0, z: currentZ }, screen: { x: 0, y: 0, w: 0 } },
        p2: { world: { x: 0, y: 0, z: currentZ + ROAD_SEGMENT_LENGTH }, screen: { x: 0, y: 0, w: 0 } },
        curve: 0,
        hill: 0,
        color: { road: '#1f2937', grass: '#123524', rumble: '#38bdf8', lane: '#64748b' },
        sprites: [],
        climate: 'city'
      });
      currentZ += ROAD_SEGMENT_LENGTH;
      index++;
    }

    stateRef.current.totalSegmentsCount = segments.length;
    stateRef.current.roadSegments = segments;
    return segments;
  };

  // Populate dynamic traffic along the track
  const spawnCars = () => {
    const carsList: GameCar[] = [];
    const segmentsCount = stateRef.current.totalSegmentsCount;
    if (segmentsCount === 0) return;

    // The Alief build uses a late-80s / early-90s traffic roster: Acura
    // Integra, Ford Tempo, 1986 Toyota MR2, Pontiac Fiero, and Ford Probe.
    // Ambulances/trucks stay rare so traffic still has readable variety.
    for (let i = 0; i < 56; i++) {
      const zPos = 1700 + i * (segmentsCount * ROAD_SEGMENT_LENGTH / 58);
      const laneId = Math.floor(Math.random() * 3) - 1; // -1, 0, 1 -> maps to offset -0.6, 0.0, 0.6
      const baseModel = ALIEF_TRAFFIC_MODELS[i % ALIEF_TRAFFIC_MODELS.length];
      const selectedType: AliefTrafficCar =
        i % 17 === 0 ? 'truck' :
        i % 13 === 0 ? 'ambulance' :
        baseModel;

      let speedKmh = 90 + Math.random() * 115;
      if (selectedType === 'acura_integra' || selectedType === 'ford_probe') speedKmh += 20;
      if (selectedType === 'mr2_86' || selectedType === 'pontiac_fiero') speedKmh += 28;
      if (selectedType === 'ford_tempo') speedKmh -= 10;
      if (selectedType === 'truck') speedKmh -= 25;
      if (selectedType === 'ambulance') speedKmh += 38;

      carsList.push({
        offset: laneId * 0.61,
        z: zPos,
        speed: clamp(speedKmh, 75, 255),
        spriteType: selectedType,
        width: selectedType === 'truck' ? 1.35 : selectedType === 'ford_tempo' ? 1.08 : 1.0,
        length: selectedType === 'truck' ? 150 : selectedType === 'ford_tempo' ? 118 : 104,
        color: TRAFFIC_CAR_COLORS[selectedType],
        laneChangeTimer: 2.4 + Math.random() * 5.0,
        laneTarget: laneId * 0.61,
        isPassing: false
      });
    }

    stateRef.current.activeCars = carsList;
  };

  // Project 3D segment curves and hills coordinates onto 2D viewport
  const project = (
    p: { world: { x: number; y: number; z: number }; screen: { x: number; y: number; w: number } },
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    canvasWidth: number,
    canvasHeight: number,
    currentCurveAddX: number
  ) => {
    const scale = CAMERA_DEPTH / (p.world.z - cameraZ);
    
    // Scale screen width multiplier
    p.screen.w = Math.round(scale * ROAD_WIDTH * (canvasWidth / 2));
    
    // Horizontal alignment incorporating track curvature
    const worldDeltaX = p.world.x - cameraX + currentCurveAddX;
    p.screen.x = Math.round((canvasWidth / 2) + (worldDeltaX * scale * (canvasWidth / 2)));
    
    // Vertical alignment incorporating active hills
    const worldDeltaY = p.world.y - cameraY;
    p.screen.y = Math.round((canvasHeight / 2) - (worldDeltaY * scale * (canvasHeight / 2)));
  };

  // Canvas drawing functions for sprites (avoiding external PNG limits)
  const drawVectorSprite = (
    ctx: CanvasRenderingContext2D,
    type: string,
    width: number,
    height: number,
    screenX: number,
    screenY: number,
    animationFrame: number
  ) => {
    ctx.save();
    ctx.translate(screenX, screenY);

    if (type === 'palm') {
      // Retro 80s styled physical palm tree
      ctx.fillStyle = '#78350f'; // trunk
      ctx.beginPath();
      ctx.moveTo(-width * 0.1, 0);
      ctx.quadraticCurveTo(-width * 0.05, -height * 0.5, -width * 0.02, -height);
      ctx.lineTo(width * 0.02, -height);
      ctx.quadraticCurveTo(width * 0.05, -height * 0.5, width * 0.1, 0);
      ctx.fill();

      // Glowing Neon palm fronds
      ctx.fillStyle = '#10b981'; // neon emerald
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#10b981';
      for (let j = 0; j < 5; j++) {
        const frondAngle = -Math.PI / 2 + (j - 2) * 0.4 + Math.sin(animationFrame / 10 + j) * 0.05;
        ctx.save();
        ctx.translate(0, -height);
        ctx.rotate(frondAngle);
        ctx.beginPath();
        ctx.ellipse(width * 0.3, 0, width * 0.35, height * 0.1, 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (type === 'cactus') {
      ctx.fillStyle = '#065f46';
      // Trunk
      ctx.fillRect(-width * 0.12, -height * 1.0, width * 0.24, height * 1.0);
      // Left arm
      ctx.fillRect(-width * 0.35, -height * 0.65, width * 0.25, height * 0.12);
      ctx.fillRect(-width * 0.35, -height * 0.85, width * 0.12, height * 0.25);
      // Right arm
      ctx.fillRect(width * 0.1, -height * 0.5, width * 0.25, height * 0.12);
      ctx.fillRect(width * 0.23, -height * 0.7, width * 0.12, height * 0.22);
    } else if (type === 'snow_pine') {
      // Snowy pine tree
      ctx.fillStyle = '#0f172a'; // dark base
      ctx.fillRect(-width * 0.08, -height * 1.0, width * 0.16, height * 1.0);

      ctx.fillStyle = '#ffffff'; // white tipped needles
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#cbd5e1';
      
      // Bottom layer
      ctx.beginPath();
      ctx.moveTo(-width * 0.6, -height * 0.2);
      ctx.lineTo(width * 0.6, -height * 0.2);
      ctx.lineTo(0, -height * 0.55);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#334155'; // darker inner foliage
      ctx.beginPath();
      ctx.moveTo(-width * 0.5, -height * 0.45);
      ctx.lineTo(width * 0.4, -height * 0.45);
      ctx.lineTo(0, -height * 0.8);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#f8fafc'; // top peak ice
      ctx.beginPath();
      ctx.moveTo(-width * 0.3, -height * 0.7);
      ctx.lineTo(width * 0.3, -height * 0.7);
      ctx.lineTo(0, -height * 1.0);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'streetlight') {
      // Metal pole
      ctx.fillStyle = '#475569';
      ctx.fillRect(-width * 0.04, -height, width * 0.08, height);
      // Arm reaching over road
      ctx.fillRect(-width * 0.04, -height, width * 0.35, height * 0.05);

      // Neon glowing light orb
      const alphaVal = Math.sin(animationFrame / 4) > 0 ? 0.9 : 0.8;
      ctx.fillStyle = `rgba(236, 72, 153, ${alphaVal})`; // bright magenta
      ctx.shadowBlur = 20;
      ctx.shadowColor = '#ec4899';
      ctx.beginPath();
      ctx.arc(width * 0.26, -height * 0.95, width * 0.12, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'billboard') {
      // Two support legs
      ctx.fillStyle = '#334155';
      ctx.fillRect(-width * 0.35, -height * 0.5, width * 0.06, height * 0.5);
      ctx.fillRect(width * 0.28, -height * 0.5, width * 0.06, height * 0.5);

      // Board frame
      ctx.strokeStyle = '#f43f5e';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#f43f5e';
      ctx.fillStyle = '#020617';
      ctx.fillRect(-width * 0.55, -height * 1.0, width * 1.1, height * 0.55);
      ctx.strokeRect(-width * 0.55, -height * 1.0, width * 1.1, height * 0.55);

      // Ad Text: 'SpeedHQ' or 'TURBO'
      ctx.shadowBlur = 0;
      ctx.font = `bold ${Math.round(height * 0.22)}px monospace`;
      ctx.textAlign = 'center';
      
      const phrases = ['ALIEF TX', 'ELSIK RAMS', 'SHIFT UP', 'WESTPARK'];
      const phrase = phrases[Math.floor(animationFrame / 80) % phrases.length];
      
      ctx.fillStyle = '#06b6d4'; // cyan glow
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#06b6d4';
      ctx.fillText(phrase, 0, -height * 0.65);
    } else if (type === 'alief_gateway') {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-width * 0.7, -height * 0.75, width * 1.4, height * 0.45);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 4;
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#38bdf8';
      ctx.strokeRect(-width * 0.7, -height * 0.75, width * 1.4, height * 0.45);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#38bdf8';
      ctx.font = `bold ${Math.round(height * 0.18)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('ALIEF, TX', 0, -height * 0.55);
      ctx.fillStyle = '#475569';
      ctx.fillRect(-width * 0.48, -height * 0.3, width * 0.08, height * 0.3);
      ctx.fillRect(width * 0.4, -height * 0.3, width * 0.08, height * 0.3);
    } else if (type === 'alief_sign' || type === 'bellaire_sign' || type === 'high_star_sign' || type === 'westpark_sign') {
      const signText =
        type === 'alief_sign' ? 'ALIEF' :
        type === 'bellaire_sign' ? 'BELLAIRE BLVD' :
        type === 'high_star_sign' ? 'HIGH STAR DR' :
        'WESTPARK';

      ctx.fillStyle = '#475569';
      ctx.fillRect(-width * 0.04, -height * 0.85, width * 0.08, height * 0.85);
      ctx.fillStyle = type === 'bellaire_sign' ? '#92400e' : type === 'westpark_sign' ? '#581c87' : '#065f46';
      ctx.shadowBlur = 8;
      ctx.shadowColor = type === 'westpark_sign' ? '#ec4899' : '#22c55e';
      ctx.beginPath();
      ctx.roundRect(-width * 0.55, -height * 1.05, width * 1.1, height * 0.32, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(height * 0.12)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(signText, 0, -height * 0.84);
    } else if (type === 'food_mart') {
      ctx.fillStyle = '#111827';
      ctx.fillRect(-width * 0.65, -height * 0.75, width * 1.3, height * 0.75);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(-width * 0.65, -height * 0.75, width * 1.3, height * 0.16);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-width * 0.55, -height * 0.52, width * 0.35, height * 0.52);
      ctx.fillStyle = '#06b6d4';
      ctx.fillRect(-width * 0.12, -height * 0.48, width * 0.55, height * 0.22);
      ctx.font = `bold ${Math.round(height * 0.13)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#111827';
      ctx.fillText('FOOD MART', 0, -height * 0.62);
    } else if (type === 'apartment_block') {
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(-width * 0.45, -height * 1.0, width * 0.9, height * 1.0);
      ctx.fillStyle = '#334155';
      ctx.fillRect(-width * 0.35, -height * 0.88, width * 0.7, height * 0.12);
      ctx.fillStyle = '#fef3c7';
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) {
          if ((row + col + Math.floor(animationFrame / 80)) % 3 !== 0) {
            ctx.fillRect(-width * 0.28 + col * width * 0.25, -height * 0.66 + row * height * 0.14, width * 0.08, height * 0.07);
          }
        }
      }
    } else if (type === 'elsik_school') {
      // Large stylized campus building with a readable Elsik High School sign.
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-width * 0.9, -height * 0.85, width * 1.8, height * 0.85);
      ctx.fillStyle = '#1d4ed8';
      ctx.fillRect(-width * 0.9, -height * 0.85, width * 1.8, height * 0.16);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(-width * 0.72, -height * 0.58, width * 0.26, height * 0.18);
      ctx.fillRect(-width * 0.28, -height * 0.58, width * 0.26, height * 0.18);
      ctx.fillRect(width * 0.16, -height * 0.58, width * 0.26, height * 0.18);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(-width * 0.12, -height * 0.28, width * 0.24, height * 0.28);
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#60a5fa';
      ctx.strokeRect(-width * 0.9, -height * 0.85, width * 1.8, height * 0.85);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(height * 0.13)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('ELSIK HIGH SCHOOL', 0, -height * 0.72);
    } else if (type === 'elsik_rams') {
      ctx.fillStyle = '#1d4ed8';
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#60a5fa';
      ctx.beginPath();
      ctx.roundRect(-width * 0.55, -height * 0.95, width * 1.1, height * 0.48, 5);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(-width * 0.48, -height * 0.88, width * 0.96, height * 0.34);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(height * 0.13)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('ELSIK', 0, -height * 0.74);
      ctx.fillText('RAMS', 0, -height * 0.59);
      // Simple ram-horn icon.
      ctx.strokeStyle = '#bfdbfe';
      ctx.beginPath();
      ctx.arc(-width * 0.22, -height * 0.38, width * 0.13, Math.PI * 0.2, Math.PI * 1.45);
      ctx.arc(width * 0.22, -height * 0.38, width * 0.13, Math.PI * 1.55, Math.PI * 0.8, true);
      ctx.stroke();
    } else if (type === 'school_bus') {
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.roundRect(-width * 0.68, -height * 0.58, width * 1.36, height * 0.42, 5);
      ctx.fill();
      ctx.fillStyle = '#111827';
      for (let col = 0; col < 4; col++) {
        ctx.fillRect(-width * 0.48 + col * width * 0.25, -height * 0.5, width * 0.16, height * 0.12);
      }
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(-width * 0.42, -height * 0.13, width * 0.11, 0, Math.PI * 2);
      ctx.arc(width * 0.42, -height * 0.13, width * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold ${Math.round(height * 0.09)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#111827';
      ctx.fillText('ALIEF ISD', 0, -height * 0.26);
    } else if (type === 'tunnel_ring') {
      // Arched neon strip spanning overhead. Due to drawing order we can draw a grand archway
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 5;
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#eab308';
      
      ctx.beginPath();
      // Elliptical arch
      ctx.ellipse(0, 0, width * 1.4, height * 2.2, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  };

  // Vector render for other AI cars on the track
  const drawAiCar = (
    ctx: CanvasRenderingContext2D,
    car: GameCar,
    cx: number,
    cy: number,
    size: number
  ) => {
    ctx.save();
    ctx.translate(cx, cy);

    const carType = car.spriteType as AliefTrafficCar | string;

    const drawWheels = (front = 0.42, rear = -0.42) => {
      ctx.fillStyle = '#020617';
      ctx.fillRect(rear * size - size * 0.09, -size * 0.1, size * 0.18, size * 0.14);
      ctx.fillRect(front * size - size * 0.09, -size * 0.1, size * 0.18, size * 0.14);
    };

    const drawLabel = (label: string, y: number) => {
      ctx.save();
      ctx.font = `bold ${Math.max(7, Math.round(size * 0.12))}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(label, 0, y);
      ctx.restore();
    };

    if (carType === 'ambulance') {
      // Red/White emergency speed-runner
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-size * 0.5, -size * 0.61, size, size * 0.61);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(-size * 0.4, -size * 0.55, size * 0.8, size * 0.16);

      const flash = Math.sin(Date.now() / 80) > 0;
      ctx.fillStyle = flash ? '#ef4444' : '#3b82f6';
      ctx.shadowBlur = flash ? 15 : 0;
      ctx.shadowColor = '#ef4444';
      ctx.fillRect(-size * 0.15, -size * 0.72, size * 0.3, size * 0.12);

      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-size * 0.45, -size * 0.22, size * 0.15, size * 0.1);
      ctx.fillRect(size * 0.3, -size * 0.22, size * 0.15, size * 0.1);
      drawWheels();
    } else if (carType === 'truck') {
      // Heavy shipping vehicle (huge grey block)
      ctx.fillStyle = '#334155';
      ctx.fillRect(-size * 0.65, -size * 0.95, size * 1.3, size * 0.95);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(-size * 0.61, -size * 0.18, size * 0.3, size * 0.08);
      ctx.fillRect(size * 0.31, -size * 0.18, size * 0.3, size * 0.08);
      ctx.fillStyle = '#000000';
      ctx.fillRect(-size * 0.65, -size * 0.12, size * 0.22, size * 0.15);
      ctx.fillRect(size * 0.43, -size * 0.12, size * 0.22, size * 0.15);
    } else if (carType === 'acura_integra') {
      // Long, low Acura Integra hatchback.
      ctx.fillStyle = car.color;
      ctx.beginPath();
      ctx.moveTo(-size * 0.62, -size * 0.21);
      ctx.lineTo(-size * 0.42, -size * 0.48);
      ctx.lineTo(size * 0.28, -size * 0.5);
      ctx.lineTo(size * 0.62, -size * 0.22);
      ctx.lineTo(size * 0.54, -size * 0.04);
      ctx.lineTo(-size * 0.56, -size * 0.04);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-size * 0.24, -size * 0.45, size * 0.42, size * 0.16);
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(-size * 0.58, -size * 0.2, size * 0.12, size * 0.05);
      ctx.fillStyle = '#7f1d1d';
      ctx.fillRect(size * 0.43, -size * 0.2, size * 0.13, size * 0.06);
      drawLabel('INTEGRA', -size * 0.11);
      drawWheels(0.42, -0.42);
    } else if (carType === 'ford_tempo') {
      // Boxy Ford Tempo sedan.
      ctx.fillStyle = car.color;
      ctx.fillRect(-size * 0.55, -size * 0.38, size * 1.1, size * 0.34);
      ctx.fillRect(-size * 0.32, -size * 0.58, size * 0.64, size * 0.24);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(-size * 0.25, -size * 0.54, size * 0.22, size * 0.14);
      ctx.fillRect(size * 0.05, -size * 0.54, size * 0.22, size * 0.14);
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(-size * 0.55, -size * 0.22, size * 0.1, size * 0.05);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(size * 0.45, -size * 0.22, size * 0.1, size * 0.05);
      drawLabel('TEMPO', -size * 0.11);
      drawWheels(0.37, -0.37);
    } else if (carType === 'mr2_86') {
      // 1986 MR2: small mid-engine wedge with pop-up headlight vibe.
      ctx.fillStyle = car.color;
      ctx.beginPath();
      ctx.moveTo(-size * 0.58, -size * 0.16);
      ctx.lineTo(-size * 0.32, -size * 0.45);
      ctx.lineTo(size * 0.25, -size * 0.5);
      ctx.lineTo(size * 0.58, -size * 0.2);
      ctx.lineTo(size * 0.5, -size * 0.04);
      ctx.lineTo(-size * 0.52, -size * 0.04);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-size * 0.05, -size * 0.46, size * 0.28, size * 0.16);
      ctx.fillStyle = '#facc15';
      ctx.fillRect(-size * 0.45, -size * 0.28, size * 0.13, size * 0.06);
      ctx.fillRect(-size * 0.23, -size * 0.31, size * 0.13, size * 0.06);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(size * 0.42, -size * 0.2, size * 0.12, size * 0.06);
      drawLabel('86 MR2', -size * 0.1);
      drawWheels(0.36, -0.38);
    } else if (carType === 'pontiac_fiero') {
      // Pontiac Fiero: angular red/orange wedge.
      ctx.fillStyle = car.color;
      ctx.beginPath();
      ctx.moveTo(-size * 0.62, -size * 0.12);
      ctx.lineTo(-size * 0.35, -size * 0.44);
      ctx.lineTo(size * 0.22, -size * 0.48);
      ctx.lineTo(size * 0.62, -size * 0.18);
      ctx.lineTo(size * 0.52, -size * 0.04);
      ctx.lineTo(-size * 0.56, -size * 0.04);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#111827';
      ctx.fillRect(-size * 0.04, -size * 0.43, size * 0.3, size * 0.14);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(-size * 0.55, -size * 0.2, size * 0.12, size * 0.05);
      ctx.fillStyle = '#7f1d1d';
      ctx.fillRect(size * 0.43, -size * 0.2, size * 0.13, size * 0.05);
      drawLabel('FIERO', -size * 0.1);
      drawWheels(0.38, -0.4);
    } else if (carType === 'ford_probe') {
      // Ford Probe: smooth aero hatch.
      ctx.fillStyle = car.color;
      ctx.beginPath();
      ctx.ellipse(0, -size * 0.22, size * 0.62, size * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(-size * 0.04, -size * 0.36, size * 0.28, size * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bfdbfe';
      ctx.fillRect(-size * 0.55, -size * 0.23, size * 0.12, size * 0.05);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(size * 0.43, -size * 0.23, size * 0.12, size * 0.05);
      drawLabel('PROBE', -size * 0.1);
      drawWheels(0.39, -0.39);
    } else {
      // Fallback if older saved traffic data is still in memory.
      ctx.fillStyle = car.color || '#3b82f6';
      ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.31);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-size * 0.35, -size * 0.52, size * 0.7, size * 0.18);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-size * 0.45, -size * 0.26, size * 0.15, size * 0.06);
      ctx.fillRect(size * 0.3, -size * 0.26, size * 0.15, size * 0.06);
      drawWheels();
    }

    ctx.restore();
  };

  // Draw the spinning player car center screen
  const drawPlayerCar = (ctx: CanvasRenderingContext2D, step: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    ctx.save();

    // Position of player near the bottom of segment viewport
    const px = canvas.width / 2;
    const py = canvas.height * PLAYER_SPRITE_Y_FRACTION;
    const pSize = 75; // dynamic relative display size

    ctx.translate(px, py);

    // If crashed, add dramatic retro arcade spin out rotation!
    if (stateRef.current.isCrashActive) {
      const angle = stateRef.current.crashAnimationTimer * Math.PI * 4.0;
      ctx.rotate(angle);
    } else {
      // Dynamic sway based on steer input (tilting left/right tilts chassis slightly)
      const swayAngle = stateRef.current.steerInput * 0.09;
      ctx.rotate(swayAngle);
    }

    // Blink effect if invincibility is active
    if (stateRef.current.invincibilityTimer > 0) {
      if (Math.floor(stateRef.current.invincibilityTimer * 15) % 2 === 0) {
        ctx.restore();
        return;
      }
    }

    // 1. Sleek Cherry Red Racing Chassis (Retro sports design)
    ctx.shadowBlur = stateRef.current.speed > 250 ? 12 : 3;
    ctx.shadowColor = '#ef4444';
    
    // Main base
    ctx.fillStyle = '#dc2626'; // primary body
    ctx.beginPath();
    ctx.roundRect(-pSize * 0.6, -pSize * 0.25, pSize * 1.2, pSize * 0.35, 6);
    ctx.fill();

    // Yellow neon dashboard striping
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-pSize * 0.55, -pSize * 0.18, pSize * 1.1, pSize * 0.06);

    // 2. Cockpit / Windshield
    ctx.fillStyle = '#0f172a'; // dark tinted screen
    ctx.beginPath();
    ctx.roundRect(-pSize * 0.4, -pSize * 0.45, pSize * 0.8, pSize * 0.22, 4);
    ctx.fill();

    // High fidelity glass glare lines
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-pSize * 0.1, -pSize * 0.4);
    ctx.lineTo(-pSize * 0.3, -pSize * 0.28);
    ctx.stroke();

    // 3. Spoilers (classic retro wing)
    ctx.fillStyle = '#b91c1c'; // darker red
    ctx.fillRect(-pSize * 0.65, -pSize * 0.52, pSize * 1.3, pSize * 0.08);
    // Left & Right wing stabilizer flaps
    ctx.fillStyle = '#000000';
    ctx.fillRect(-pSize * 0.65, -pSize * 0.58, pSize * 0.08, pSize * 0.15);
    ctx.fillRect(pSize * 0.57, -pSize * 0.58, pSize * 0.08, pSize * 0.15);

    // Spoiler struts
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(-pSize * 0.4, -pSize * 0.44, pSize * 0.06, pSize * 0.09);
    ctx.fillRect(pSize * 0.34, -pSize * 0.44, pSize * 0.06, pSize * 0.09);

    // 4. Slick racing tires (large rear tires!)
    ctx.fillStyle = '#020617';
    ctx.fillRect(-pSize * 0.68, -pSize * 0.1, pSize * 0.18, pSize * 0.3);
    ctx.fillRect(pSize * 0.5, -pSize * 0.1, pSize * 0.18, pSize * 0.3);

    // Yellow custom hubcaps
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(-pSize * 0.59, pSize * 0.05, pSize * 0.05, 0, Math.PI * 2);
    ctx.arc(pSize * 0.59, pSize * 0.05, pSize * 0.05, 0, Math.PI * 2);
    ctx.fill();

    // 5. Working arcade LED glowing break lights (glows red on brakeInput)
    ctx.shadowBlur = stateRef.current.brakeInput ? 18 : 4;
    ctx.shadowColor = '#ef4444';
    ctx.fillStyle = stateRef.current.brakeInput ? '#ff0000' : '#ea580c';
    ctx.fillRect(-pSize * 0.5, -pSize * 0.15, pSize * 0.18, pSize * 0.07);
    ctx.fillRect(pSize * 0.32, -pSize * 0.15, pSize * 0.18, pSize * 0.07);

    // Dynamic tailpipes exhaust fire particle spray! (if extreme speeds)
    if (stateRef.current.accelInput && stateRef.current.speed > 5) {
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#f97316';
      ctx.fillStyle = Math.sin(step) > 0 ? '#ff7200' : '#ffea00';
      const fireLength = (stateRef.current.speed / 300) * 16 + Math.random() * 5;
      
      // Exhaust pipes left and right
      ctx.fillRect(-pSize * 0.3, pSize * 0.1, pSize * 0.08, fireLength * 0.6);
      ctx.fillRect(pSize * 0.22, pSize * 0.1, pSize * 0.08, fireLength * 0.6);
    }

    ctx.restore();
  };

  // Main high speed animation frame loop
  useEffect(() => {
    // Generate static elements
    const trackSegments = buildTrack();
    spawnCars();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let totalLength = trackSegments.length * ROAD_SEGMENT_LENGTH;
    stateRef.current.started = true;
    stateRef.current.running = true;

    let lastTime = performance.now();
    let animationStep = 0;
    let lastCountdownText = '3';

    const gameTick = (highResTime: number) => {
      if (!stateRef.current.running) return;

      const delta = Math.min((highResTime - lastTime) / 1000.0, 0.1); // cap latency jump
      lastTime = highResTime;

      // Debug pause: freeze the world (last frame stays on screen) but keep the
      // RAF loop alive so the Resume button can pick it straight back up. lastTime
      // is refreshed above, so resuming does not produce a giant delta jump.
      if (stateRef.current.paused) {
        requestAnimationFrame(gameTick);
        return;
      }

      // Handle start sequence countdown
      if (stateRef.current.isCountingDown) {
        stateRef.current.countdownVal -= delta;
        const countdownInt = Math.ceil(stateRef.current.countdownVal);
        if (countdownInt <= 0) {
          stateRef.current.isCountingDown = false;
          audio.playChime();
        } else {
          const displayStr = countdownInt.toString();
          if (lastCountdownText !== displayStr) {
            lastCountdownText = displayStr;
            setUiState(prev => ({ ...prev, countdownText: displayStr }));
          }
        }
      }

      updatePhysics(delta, totalLength);
      drawFrame(ctx, canvas, animationStep);

      animationStep++;
      requestAnimationFrame(gameTick);
    };

    requestAnimationFrame(gameTick);

    return () => {
      stateRef.current.running = false;
    };
  }, []); // Run only once

  // Handle speed computations, collisions, and AI lane choices
  const updatePhysics = (dt: number, totalLength: number) => {
    const s = stateRef.current;

    // Tick invincibility and recovery timers
    if (s.invincibilityTimer > 0) s.invincibilityTimer = Math.max(s.invincibilityTimer - dt, 0);
    if (s.crashAnimationTimer > 0) {
      s.crashAnimationTimer -= dt;
      if (s.crashAnimationTimer <= 0) {
        s.isCrashActive = false;
        s.invincibilityTimer = 1.6; // protective shield upon recovery
      }
    }

    if (s.isCountingDown) return; // Freeze players until countdown clears

    const previousPlayerZ = s.playerZ;
    const maxSpeed = topSpeedForGear(s.gear);

    // Handle Time Tock
    s.timeLimit -= dt;
    if (s.timeLimit <= 0) {
      s.timeLimit = 0;
      s.running = false;
      onGameOver(s.score, s.maxSpeedAchieved, s.currentStageIdx + 1);
      return;
    }

    // Integrate the arcade drivetrain (see ../lib/physics for the model).
    if (s.isCrashActive) {
      s.speed -= 260 * dt;
      s.targetSteerInput = 0;
    } else {
      s.speed += computeDrivetrainAcceleration({
        gear: s.gear,
        speed: s.speed,
        accelInput: s.accelInput,
        brakeInput: s.brakeInput,
      }) * dt;
    }

    // Map current active segment to find track curves and hills
    const activeSegmentIdxBeforeMove = Math.floor(s.playerZ / ROAD_SEGMENT_LENGTH) % s.roadSegments.length;
    const currentSegmentBeforeMove = s.roadSegments[activeSegmentIdxBeforeMove];

    // Lane boundaries drift deceleration. Rumbles are recoverable; deep shoulder
    // driving rapidly bleeds speed and lateral grip without random teleport jitter.
    const offRoadDepth = Math.max(Math.abs(s.playerX) - ROAD_EDGE, 0);
    const onShoulder = offRoadDepth > 0;
    if (onShoulder && !s.isCrashActive) {
      const shoulderSeverity = clamp(offRoadDepth / 0.9, 0, 1);
      s.speed -= (120 + 240 * shoulderSeverity) * dt;
      s.lateralVelocity *= Math.exp(-dt * (2.4 + shoulderSeverity * 4.5));

      if (Math.random() < 0.18 + shoulderSeverity * 0.22) {
        audio.playScreech(0.25 + shoulderSeverity * 0.25);
        spawnSpinDebris(s.playerX > 0 ? 0.95 : -0.95, currentSegmentBeforeMove?.climate === 'snow' ? '#e2e8f0' : '#15803d');
      }
    }

    // Clamp absolute bounds
    s.speed = clamp(s.speed, 0, maxSpeed);
    if (s.speed > s.maxSpeedAchieved) s.maxSpeedAchieved = Math.round(s.speed);

    // Compute synthetic engine RPM (for pitch modulation)
    if (s.gear === 'LOW') {
      s.rpm = clamp(s.speed / LOW_GEAR_TOP_SPEED, 0, 1);
    } else {
      s.rpm = clamp((s.speed - 95) / (HIGH_GEAR_TOP_SPEED - 95), 0, 1);
    }
    audio.setEngineSound(s.speed, s.gear, s.rpm);

    // Player position Z physics
    const speedMs = speedToWorldUnitsPerSec(s.speed);
    s.playerZ += speedMs * dt;
    s.totalDistanceDriven += speedMs * dt * 0.01;

    // Check Track bounds and loop stage transitions
    if (s.playerZ >= totalLength) {
      s.playerZ -= totalLength;
      s.lapCompleted++;
    }

    const activeSegmentIdx = Math.floor(s.playerZ / ROAD_SEGMENT_LENGTH) % s.roadSegments.length;
    const currentSegment = s.roadSegments[activeSegmentIdx];

    // Handling model: raw controls are smoothed, converted into lateral
    // acceleration, then filtered through grip. This gives the car weight.
    if (!s.isCrashActive) {
      const steerResponse = s.steeringMode === 'tilt' ? 7.5 : 11.5;
      s.steerInput = approach(s.steerInput, s.targetSteerInput, steerResponse * dt);

      const speed01 = clamp(s.speed / HIGH_GEAR_TOP_SPEED, 0, 1);
      const baseGrip = roadGripForSegment(currentSegment);
      const shoulderGrip = onShoulder ? clamp(1.0 - offRoadDepth * 0.35, 0.48, 1.0) : 1.0;
      const grip = baseGrip * shoulderGrip;

      const lateralAcceleration = computeLateralAcceleration({
        steerInput: s.steerInput,
        speed: s.speed,
        segmentCurve: currentSegment.curve,
        grip,
      });

      s.lateralVelocity += lateralAcceleration * dt;

      // Lower speed should settle quickly; high speed should keep some momentum.
      const lateralDamping = (3.9 - speed01 * 1.55) * grip;
      s.lateralVelocity *= Math.exp(-dt * lateralDamping);
      s.playerX += s.lateralVelocity * dt;

      if (Math.abs(s.playerX) > HARD_SHOULDER_EDGE) {
        s.playerX = clamp(s.playerX, -HARD_SHOULDER_EDGE, HARD_SHOULDER_EDGE);
        s.lateralVelocity *= -0.22;
        s.speed *= 0.88;
        audio.playScreech(0.55);
      }
    } else {
      // Let the crash spin slide a little instead of instantly freezing the lane.
      s.steerInput = approach(s.steerInput, 0, 8 * dt);
      s.lateralVelocity *= Math.exp(-dt * 2.8);
      s.playerX = clamp(s.playerX + s.lateralVelocity * dt, -HARD_SHOULDER_EDGE, HARD_SHOULDER_EDGE);
    }

    // Stage progression tracker. The original used a fixed 400-segment stage
    // width even though the stages have different lengths, which made the HUD
    // and time bonuses fire at the wrong places.
    const stageInfo = getStageInfo(activeSegmentIdx);
    if (s.currentStageIdx !== stageInfo.stageIdx) {
      s.currentStageIdx = stageInfo.stageIdx;
      s.timeLimit = Math.min(s.timeLimit + 28.0, 99.0);
      audio.playChime();
      setUiState(prev => ({ ...prev, nearMissScoreAlert: 5000 }));
      s.score += 5000;
      setTimeout(() => setUiState(prev => ({ ...prev, nearMissScoreAlert: 0 })), 2500);
    }
    s.stageProgress = stageInfo.progress;

    // Update Score incrementally as you drive. High gear gives a modest risk bonus.
    if (s.speed > 10) {
      s.score += Math.round((s.speed / 55) * (s.gear === 'HIGH' ? 1.65 : 1.0) * dt * 10);
    }

    // Update dynamic particles
    updateParticles(dt);

    // AI Car Physics & Logic
    updateAiCars(dt, activeSegmentIdx, totalLength, previousPlayerZ);

    // Synchronize to UI state at a stable rate instead of using position modulo,
    // which could skip updates at high speed or flood updates at low speed.
    s.uiUpdateTimer += dt;
    if (s.uiUpdateTimer >= 1 / 12) {
      s.uiUpdateTimer = 0;
      setUiState(prev => ({
        ...prev,
        speed: Math.round(s.speed),
        gear: s.gear,
        rpm: Math.round(s.rpm * 100),
        score: s.score,
        time: Math.ceil(s.timeLimit),
        stageName: SCENERY_STAGES[s.currentStageIdx].name,
        stageIdx: s.currentStageIdx,
        stageProgressPct: Math.round(s.stageProgress * 100),
        debug: {
          nearestRelZ: s.debug.nearestRelZ,
          nearestCamZ: s.debug.nearestCamZ,
          nearestLateral: Math.round(s.debug.nearestLateral * 100) / 100,
          nearestHalfWidth: Math.round(s.debug.nearestHalfWidth * 100) / 100,
          nearestType: s.debug.nearestType,
          nearestInLane: s.debug.nearestInLane,
          lastHitRelZ: s.debug.lastHitRelZ
        }
      }));
    }
  };

  const updateParticles = (dt: number) => {
    const s = stateRef.current;
    
    // Iterate and filter dead particles
    s.particles = s.particles.filter(p => {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.alpha = Math.max(p.life / 0.8, 0);
      return p.life > 0;
    });
  };

  const updateAiCars = (dt: number, _activeSegmentIdx: number, totalLength: number, previousPlayerZ: number) => {
    const s = stateRef.current;
    // Collisions and passes are resolved against the PLAYER CAR's on-screen
    // position (PLAYER_CAR_ROAD_Z ahead of the camera — where the sprite is
    // actually drawn), NOT the camera, so a crash lines up with a visible car.
    const playerCarZ = s.playerZ + PLAYER_CAR_ROAD_Z;
    const prevPlayerCarZ = previousPlayerZ + PLAYER_CAR_ROAD_Z;

    let nearest: { relZ: number; lateral: number; halfWidth: number; type: string } | null = null;
    let collidedThisFrame = false;

    s.activeCars.forEach(car => {
      const carPrevZ = car.z;
      const speedMs = speedToWorldUnitsPerSec(car.speed);
      car.z += speedMs * dt;

      // Handle wrapping at end of track
      if (car.z >= totalLength) {
        car.z -= totalLength;
      }

      // Position relative to the player car: + = ahead, - = behind/passed.
      const relZ = normalizeRelativeZ(car.z - playerCarZ, totalLength);
      const prevRelZ = normalizeRelativeZ(carPrevZ - prevPlayerCarZ, totalLength);

      // Lane changes are measured in seconds, not world units. Keep them
      // occasional and avoid surprise swerves right on top of the player.
      car.laneChangeTimer -= dt;
      if (car.laneChangeTimer <= 0) {
        car.laneChangeTimer = 2.2 + Math.random() * 5.5;
        const playerNearby = relZ > -160 && relZ < 320;
        if (!playerNearby) {
          const newLane = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
          car.laneTarget = newLane * LANE_SPACING;
        }
      }

      // Smooth lane interpolations with overshoot protection.
      if (car.offset !== car.laneTarget) {
        const offsetDelta = car.laneTarget - car.offset;
        const laneStep = 0.55 * dt;
        if (Math.abs(offsetDelta) <= laneStep) {
          car.offset = car.laneTarget;
        } else {
          car.offset += Math.sign(offsetDelta) * laneStep;
        }
      }

      const xCollisionLimit = carCollisionHalfWidth(car.width);
      const lateralDistance = Math.abs(car.offset - s.playerX);

      const collided = detectCarCollision({
        playerX: s.playerX,
        carOffset: car.offset,
        carWidth: car.width,
        relZ,
        prevRelZ,
      });

      if (collided && !s.isCrashActive && s.invincibilityTimer <= 0) {
        collidedThisFrame = true;
        s.debug.lastHitRelZ = Math.round(relZ); // the car that actually hit, not the nearest
        s.isCrashActive = true;
        s.crashAnimationTimer = 1.05;
        s.speed = Math.max(18, s.speed * 0.18);
        s.lateralVelocity += (s.playerX < car.offset ? -1 : 1) * 1.6;
        audio.playCrash();
        spawnSpinDebris(s.playerX, '#f43f5e');
      }

      // Near miss bonuses should trigger on the actual pass moment, not for
      // multiple frames in the overlap window. Trucks need more clearance.
      const passedCar = prevRelZ > 0 && relZ <= 0;
      const pathPassingSpeed = s.speed > car.speed + 8;
      const nearMissMin = xCollisionLimit + 0.04;
      const nearMissMax = xCollisionLimit + 0.30;
      if (passedCar && pathPassingSpeed && !car.isPassing && !s.isCrashActive) {
        if (lateralDistance >= nearMissMin && lateralDistance <= nearMissMax) {
          car.isPassing = true;
          s.nearMissCount++;

          const passBonus = car.spriteType === 'ambulance' ? 3000 : car.spriteType === 'truck' ? 1500 : 1000;
          s.score += passBonus;
          audio.playScreech(0.45);

          setUiState(prev => ({ ...prev, nearMissScoreAlert: passBonus }));
          setTimeout(() => setUiState(prev => ({ ...prev, nearMissScoreAlert: 0 })), 1500);
        }
      }

      // Reset pass tracker once distant
      if (Math.abs(relZ) > 380) {
        car.isPassing = false;
      }

      // Track the closest car (to the player car) for the on-screen debug panel.
      if (!nearest || Math.abs(relZ) < Math.abs(nearest.relZ)) {
        nearest = { relZ, lateral: lateralDistance, halfWidth: xCollisionLimit, type: car.spriteType };
      }
    });

    // Publish a debug snapshot for the overlay (read on the throttled UI tick).
    if (nearest) {
      const n = nearest as { relZ: number; lateral: number; halfWidth: number; type: string };
      s.debug.nearestRelZ = Math.round(n.relZ);
      s.debug.nearestCamZ = Math.round(n.relZ + PLAYER_CAR_ROAD_Z);
      s.debug.nearestLateral = n.lateral;
      s.debug.nearestHalfWidth = n.halfWidth;
      s.debug.nearestType = n.type;
      s.debug.nearestInLane = n.lateral < n.halfWidth;
    }

    // With debug on, freeze on impact so the readout can be inspected. Push the
    // exact collision-frame snapshot to the UI (the throttled tick won't run
    // while paused).
    if (collidedThisFrame && s.showDebug) {
      s.paused = true;
      setUiState(prev => ({
        ...prev,
        paused: true,
        debug: {
          nearestRelZ: s.debug.nearestRelZ,
          nearestCamZ: s.debug.nearestCamZ,
          nearestLateral: Math.round(s.debug.nearestLateral * 100) / 100,
          nearestHalfWidth: Math.round(s.debug.nearestHalfWidth * 100) / 100,
          nearestType: s.debug.nearestType,
          nearestInLane: s.debug.nearestInLane,
          lastHitRelZ: s.debug.lastHitRelZ
        }
      }));
    }

    // Handle background particles flow (speed dust particles flying backwards).
    // Scale by dt so high-refresh displays do not spawn twice as much dust.
    if (s.speed > 60 && Math.random() < dt * 9.0) {
      const pColor = s.currentStageIdx === 4 ? '#cbd5e1' : 'rgba(255,255,255,0.7)';
      const dustX = Math.random() * 2 - 1;
      s.particles.push({
        x: dustX,
        y: -1 + Math.random() * 1.5,
        vx: -s.steerInput * 4.0,
        vy: (s.speed / 80) * 4.0,
        color: pColor,
        alpha: 0.8,
        life: 0.8,
        size: 1 + Math.random() * 2
      });
    }
  };

  const spawnSpinDebris = (targetX: number, color: string) => {
    const s = stateRef.current;
    for (let i = 0; i < 22; i++) {
      s.particles.push({
        x: targetX,
        y: 0.5 + Math.random() * 0.3,
        vx: (Math.random() * 10 - 5),
        vy: -(5 + Math.random() * 8),
        color,
        alpha: 1.0,
        life: 0.7 + Math.random() * 0.3,
        size: 3 + Math.random() * 5
      });
    }
  };

  // Main 3D segment road drawing logic back-to-front
  const drawFrame = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, stepNum: number) => {
    const s = stateRef.current;
    const startZ = s.playerZ;
    const totalLength = s.roadSegments.length * ROAD_SEGMENT_LENGTH;

    // Refresh backdrop using climate-specific colors
    const climateStage = SCENERY_STAGES[s.currentStageIdx];
    ctx.fillStyle = climateStage.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw scrolling sky horizons (Sunset mountains/Urban skylines/Tunnels)
    drawBackgroundScenery(ctx, canvas, scaleSteerAngleOffset(stepNum));

    // Painter's algorithm setup
    // Find segment holding index relative to Z
    const startSegmentIdx = Math.floor(startZ / ROAD_SEGMENT_LENGTH);
    const percentZ = (startZ % ROAD_SEGMENT_LENGTH) / ROAD_SEGMENT_LENGTH;

    let totalSegmentDeltaCurve = 0;
    let cameraZ = startZ;
    let cameraY = CAMERA_HEIGHT; // camera elevation
    
    // Elevate camera proportional to player speed over hills
    const playerSegment = s.roadSegments[startSegmentIdx % s.roadSegments.length];
    if (playerSegment) {
      cameraY += playerSegment.hill * 18.0;
    }

    // Capture running variables
    let accumulatedCurveAddX = 0;
    let previousSegmentScaleCurve = 0;

    // Assemble temporary segment coordinate projection buffer
    const renderPointsList = [];

    for (let i = 0; i < VIEW_DEPTH; i++) {
      const idx = (startSegmentIdx + i) % s.roadSegments.length;
      const seg = s.roadSegments[idx];

      // Looping modulo math
      const loopDeltaZ = (startSegmentIdx + i) >= s.roadSegments.length ? s.roadSegments.length * ROAD_SEGMENT_LENGTH : 0;

      // Project world points
      const p1 = {
        world: {
          x: seg.p1.world.x,
          y: seg.p1.world.y + seg.hill * 10.0,
          z: seg.p1.world.z + loopDeltaZ
        },
        screen: { x: 0, y: 0, w: 0 }
      };

      const p2 = {
        world: {
          x: seg.p2.world.x,
          y: seg.p2.world.y + seg.hill * 10.0,
          z: seg.p2.world.z + loopDeltaZ
        },
        screen: { x: 0, y: 0, w: 0 }
      };

      // Accumulate road curve modifiers
      accumulatedCurveAddX += segmentCurveAt(idx);

      // playerX is in road-half-width units (±1 == road edge). The tarmac is
      // drawn ±screen.w/2 wide, which corresponds to a world X of ROAD_WIDTH/2,
      // so the camera must shift by playerX * ROAD_WIDTH/2 for the edge to line
      // up at playerX == 1. (Using the full ROAD_WIDTH doubled the offset and
      // pushed the side lanes off the road.)
      const cameraX = s.playerX * (ROAD_WIDTH / 2);
      project(p1, cameraX, cameraY, cameraZ, canvas.width, canvas.height, accumulatedCurveAddX - (percentZ * seg.curve));
      project(p2, cameraX, cameraY, cameraZ, canvas.width, canvas.height, accumulatedCurveAddX + segmentCurveAt(idx) - (percentZ * seg.curve));

      renderPointsList.push({
        segment: seg,
        p1,
        p2,
        clipY: canvas.height // default capping
      });
    }

    // Now, draw back-to-front (Painter's algorithm)
    let maxClipY = canvas.height;

    for (let i = VIEW_DEPTH - 1; i > 0; i--) {
      const render = renderPointsList[i];
      const p1 = render.p1;
      const p2 = render.p2;
      const seg = render.segment;

      // Skip segments situated behind camera
      if (p1.world.z <= cameraZ + DISTANCE_TO_PLAYER) continue;

      // Draw road slice polygons (quadrilaterals)
      drawRoadSegmentPolygons(ctx, canvas, p1.screen, p2.screen, seg);
    }

    // Draw side decorations and AI cars back-to-front
    for (let i = VIEW_DEPTH - 1; i > 0; i--) {
      const render = renderPointsList[i];
      const p1 = render.p1;
      const p2 = render.p2;
      const seg = render.segment;

      // Render roadside trees, poles, tunnels, billboards
      seg.sprites.forEach(sprite => {
        // Horizontal offset
        const sprOffset = sprite.offset;
        const xPos = p1.screen.x + Math.round(sprOffset * p1.screen.w * 0.52);
        const yPos = p1.screen.y;
        
        // Size scales based on screen projection factor and per-landmark scale.
        const spriteScale = sprite.scale ?? 1.0;
        const sprWidth = Math.round(p1.screen.w * 0.18 * spriteScale);
        const sprHeight = Math.round(p1.screen.w * 0.22 * spriteScale);

        drawVectorSprite(ctx, sprite.spriteType, sprWidth, sprHeight, xPos, yPos, stepNum);
      });

      // Render AI cars sitting on this segment. We reuse the segment's own
      // projected road slice (p1) so each car tracks the road's curve, hills,
      // and width exactly. The previous code re-projected every car with an
      // independent curve sum and a doubled offset, which drifted side-lane
      // cars off into the grass and made collisions look wrong.
      s.activeCars.forEach(car => {
        const carSegmentIdx = Math.floor(car.z / ROAD_SEGMENT_LENGTH) % s.roadSegments.length;
        if (carSegmentIdx !== seg.index) return;

        // Skip cars that are essentially on top of / behind the camera.
        const relZ = normalizeRelativeZ(car.z - startZ, totalLength);
        if (relZ <= DISTANCE_TO_PLAYER) return;

        // Interpolate the car's position across its segment (near edge p1 -> far
        // edge p2) by how far along the segment it actually sits. Snapping the
        // car to p1 made it jump a whole segment at a time, which reads as a
        // flicker/judder at high speed. car.offset is in road-half-width units
        // (±1 == road edge).
        const frac = (car.z % ROAD_SEGMENT_LENGTH) / ROAD_SEGMENT_LENGTH;
        const centerX = p1.screen.x + (p2.screen.x - p1.screen.x) * frac;
        const centerY = p1.screen.y + (p2.screen.y - p1.screen.y) * frac;
        const roadWidth = p1.screen.w + (p2.screen.w - p1.screen.w) * frac;

        const carScreenX = Math.round(centerX + car.offset * (roadWidth / 2));
        const carScreenY = Math.round(centerY);
        const size = Math.max(1, Math.round(roadWidth * 0.14));

        drawAiCar(ctx, car, carScreenX, carScreenY, size);
      });
    }

    // Render particles overlay
    s.particles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;

      // Convert coordinate offsets
      const sx = canvas.width / 2 + p.x * (canvas.width / 2);
      const sy = canvas.height * p.y;
      
      ctx.beginPath();
      ctx.arc(sx, sy, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    // Draw active Player Car
    drawPlayerCar(ctx, stepNum);
  };

  // Scale steering animations
  const scaleSteerAngleOffset = (step: number) => {
    return Math.sin(step / 30) * 10;
  };

  const segmentCurveAt = (idx: number) => {
    const s = stateRef.current;
    if (idx >= 0 && idx < s.roadSegments.length) {
      return s.roadSegments[idx].curve;
    }
    return 0;
  };

  // Draw background horizons matching Alief route stages.
  const drawBackgroundScenery = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, steerOffset: number) => {
    const stageIdx = stateRef.current.currentStageIdx;
    ctx.save();

    const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.5);
    const drawStreetLights = (color: string, count = 7) => {
      for (let j = 0; j < count; j++) {
        const x = (j * (canvas.width / (count - 1))) - steerOffset * (1.5 + j * 0.08);
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, canvas.height * 0.5);
        ctx.lineTo(x, canvas.height * 0.22 + (j % 2) * 12);
        ctx.lineTo(x + 24, canvas.height * 0.22 + (j % 2) * 12);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.shadowBlur = 18;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(x + 24, canvas.height * 0.23 + (j % 2) * 12, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    };

    if (stageIdx === 0) {
      // 1. Alief neighborhood night cruise.
      skyGrad.addColorStop(0, '#07111f');
      skyGrad.addColorStop(0.7, '#123524');
      skyGrad.addColorStop(1, '#0f766e');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);
      drawStreetLights('#38bdf8', 6);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      for (let j = 0; j < 6; j++) {
        const x = (j * canvas.width / 5) - steerOffset * 2.0;
        ctx.fillRect(x, canvas.height * 0.34 + (j % 2) * 14, 95, canvas.height * 0.16);
      }

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('WELCOME TO ALIEF', canvas.width * 0.5 - steerOffset * 1.8, canvas.height * 0.28);
    } else if (stageIdx === 1) {
      // 2. Bellaire Blvd storefronts.
      skyGrad.addColorStop(0, '#0b1020');
      skyGrad.addColorStop(1, '#3f1f08');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);
      drawStreetLights('#f59e0b', 8);

      const signs = ['PHO', 'TACOS', 'MART', 'WASH', 'VIDEO', 'BBQ'];
      for (let j = 0; j < signs.length; j++) {
        const x = (j * (canvas.width / signs.length)) - steerOffset * 2.7;
        ctx.fillStyle = '#111827';
        ctx.fillRect(x, canvas.height * 0.33 + (j % 2) * 12, 95, canvas.height * 0.17);
        ctx.strokeStyle = j % 2 ? '#f59e0b' : '#06b6d4';
        ctx.strokeRect(x, canvas.height * 0.33 + (j % 2) * 12, 95, canvas.height * 0.17);
        ctx.fillStyle = j % 2 ? '#fde68a' : '#67e8f9';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(signs[j], x + 47, canvas.height * 0.39 + (j % 2) * 12);
      }
    } else if (stageIdx === 2) {
      // 3. Elsik High School campus pass.
      skyGrad.addColorStop(0, '#081624');
      skyGrad.addColorStop(1, '#1d4ed8');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);

      // Stadium lights and school silhouette.
      drawStreetLights('#bfdbfe', 5);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(canvas.width * 0.18 - steerOffset * 1.8, canvas.height * 0.28, canvas.width * 0.64, canvas.height * 0.22);
      ctx.fillStyle = '#1d4ed8';
      ctx.fillRect(canvas.width * 0.18 - steerOffset * 1.8, canvas.height * 0.28, canvas.width * 0.64, 16);
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.strokeRect(canvas.width * 0.18 - steerOffset * 1.8, canvas.height * 0.28, canvas.width * 0.64, canvas.height * 0.22);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('ELSIK HIGH SCHOOL  •  RAMS', canvas.width * 0.5 - steerOffset * 1.8, canvas.height * 0.35);
    } else if (stageIdx === 3) {
      // 4. High Star / Highstar night sprint.
      skyGrad.addColorStop(0, '#06131f');
      skyGrad.addColorStop(1, '#052e16');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);
      drawStreetLights('#22c55e', 7);

      ctx.fillStyle = '#065f46';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height * 0.5);
      ctx.lineTo(canvas.width * 0.28 - steerOffset * 1.4, canvas.height * 0.36);
      ctx.lineTo(canvas.width * 0.55, canvas.height * 0.5);
      ctx.moveTo(canvas.width * 0.5, canvas.height * 0.5);
      ctx.lineTo(canvas.width * 0.82 - steerOffset * 1.4, canvas.height * 0.34);
      ctx.lineTo(canvas.width, canvas.height * 0.5);
      ctx.fill();

      ctx.fillStyle = '#bbf7d0';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('HIGH STAR DR', canvas.width * 0.5 - steerOffset * 1.6, canvas.height * 0.28);
    } else if (stageIdx === 4) {
      // 5. Westpark tollway-style neon dash.
      skyGrad.addColorStop(0, '#030712');
      skyGrad.addColorStop(1, '#581c87');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);
      drawStreetLights('#ec4899', 9);

      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 1;
      for (let j = 0; j < 8; j++) {
        const y = canvas.height * 0.5 - j * 18;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y - Math.sin(j) * 10);
        ctx.stroke();
      }
      ctx.fillStyle = '#f0abfc';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('WESTPARK DASH', canvas.width * 0.5 - steerOffset * 2.0, canvas.height * 0.28);
    }

    ctx.restore();
  };

  // Draw the 3D polygon wedges representing lanes, grates, and tarmac
  const drawRoadSegmentPolygons = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    p1: { x: number; y: number; w: number },
    p2: { x: number; y: number; w: number },
    seg: RoadSegment
  ) => {
    // Left and right curbs (rumble strips)
    const rumbleW1 = p1.w * 0.08;
    const rumbleW2 = p2.w * 0.08;

    // Grass shoulders
    ctx.fillStyle = seg.color.grass;
    ctx.beginPath();
    ctx.moveTo(0, p1.y);
    ctx.lineTo(p1.x - p1.w / 2 - rumbleW1, p1.y);
    ctx.lineTo(p2.x - p2.w / 2 - rumbleW2, p2.y);
    ctx.lineTo(0, p2.y);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(canvas.width, p1.y);
    ctx.lineTo(p1.x + p1.w / 2 + rumbleW1, p1.y);
    ctx.lineTo(p2.x + p2.w / 2 + rumbleW2, p2.y);
    ctx.lineTo(canvas.width, p2.y);
    ctx.fill();

    // Red/White curbs (Rumbles)
    ctx.fillStyle = seg.color.rumble;
    ctx.beginPath();
    ctx.moveTo(p1.x - p1.w / 2 - rumbleW1, p1.y);
    ctx.lineTo(p1.x - p1.w / 2, p1.y);
    ctx.lineTo(p2.x - p2.w / 2, p2.y);
    ctx.lineTo(p2.x - p2.w / 2 - rumbleW2, p2.y);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(p1.x + p1.w / 2 + rumbleW1, p1.y);
    ctx.lineTo(p1.x + p1.w / 2, p1.y);
    ctx.lineTo(p2.x + p2.w / 2, p2.y);
    ctx.lineTo(p2.x + p2.w / 2 + rumbleW2, p2.y);
    ctx.fill();

    // Main Asphalt Tarmac
    ctx.fillStyle = seg.color.road;
    ctx.beginPath();
    ctx.moveTo(p1.x - p1.w / 2, p1.y);
    ctx.lineTo(p1.x + p1.w / 2, p1.y);
    ctx.lineTo(p2.x + p2.w / 2, p2.y);
    ctx.lineTo(p2.x - p2.w / 2, p2.y);
    ctx.fill();

    // White dashed lane markers
    if (seg.color.lane !== seg.color.road) {
      ctx.fillStyle = '#ffffff';
      
      const laneWidth1 = p1.w / LANE_COUNT;
      const laneWidth2 = p2.w / LANE_COUNT;
      
      for (let l = 1; l < LANE_COUNT; l++) {
        const lx1 = p1.x - p1.w / 2 + laneWidth1 * l;
        const lx2 = p2.x - p2.w / 2 + laneWidth2 * l;
        
        ctx.beginPath();
        ctx.moveTo(lx1 - p1.w * 0.012, p1.y);
        ctx.lineTo(lx1 + p1.w * 0.012, p1.y);
        ctx.lineTo(lx2 + p2.w * 0.012, p2.y);
        ctx.lineTo(lx2 - p2.w * 0.012, p2.y);
        ctx.fill();
      }
    }
  };

  const toggleGear = () => {
    const s = stateRef.current;
    if (s.isCountingDown || s.paused) return;

    s.gear = s.gear === 'LOW' ? 'HIGH' : 'LOW';
    audio.playGearChange();
    setUiState(prev => ({ ...prev, gear: s.gear }));
  };

  const resumeGame = () => {
    stateRef.current.paused = false;
    setUiState(prev => ({ ...prev, paused: false }));
  };

  // Fullscreen (great on mobile). iOS Safari doesn't support element fullscreen,
  // so the button is hidden there; everywhere else it toggles the whole app.
  const fullscreenSupported =
    typeof document !== 'undefined' &&
    (document.fullscreenEnabled || !!(document.documentElement as any).webkitRequestFullscreen);

  const toggleFullscreen = () => {
    const doc = document as any;
    const el = document.documentElement as any;
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      (document.exitFullscreen || doc.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  };

  const trackNames = audio.getTrackNames();
  const cycleRadioTrack = () => {
    audio.resumeContext();
    const index = audio.nextTrack();
    setUiState(prev => ({ ...prev, musicTrackIndex: index }));
  };

  const toggleDebug = () => {
    setUiState(prev => {
      const next = !prev.showDebug;
      stateRef.current.showDebug = next;
      // Turning debug off lifts any active debug pause so play can continue.
      if (!next) stateRef.current.paused = false;
      return { ...prev, showDebug: next, paused: next ? prev.paused : false };
    });
  };

  const handleTouchLeft = (activate: boolean) => {
    stateRef.current.touchSteerLeft = activate;
    updateTouchSteerTarget();
  };

  const handleTouchRight = (activate: boolean) => {
    stateRef.current.touchSteerRight = activate;
    updateTouchSteerTarget();
  };

  // Press-and-hold props for the on-screen control buttons. Pointer Events
  // (not touch+mouse) so every finger is an independent pointer — you can hold
  // gas and press SHIFT at the same time. touch-action:none keeps a press from
  // being hijacked by scroll/zoom, and release fires on up/cancel/leave so a
  // button never gets stuck held.
  const holdHandlers = (press: () => void, release: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); press(); },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
    style: { touchAction: 'none' as const },
  });

  // Tap handler that also works mid-multitouch (e.g. tapping SHIFT while holding
  // gas): fire on pointer-down rather than a synthesized click.
  const tapHandler = (action: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); action(); },
    style: { touchAction: 'none' as const },
  });

  const setAccel = (on: boolean) => { stateRef.current.accelInput = on; };
  const setBrake = (on: boolean) => { stateRef.current.brakeInput = on; };

  const handleStartButton = () => {
    setUiState(prev => ({ ...prev, isFirstInteractionRequired: false }));
    audio.init();
  };

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 relative w-full items-center justify-center bg-slate-950 font-mono outline-none ${uiState.isFullscreen ? 'p-0 gap-0' : 'p-2 sm:p-4'}`}
      tabIndex={0}
      ref={(el) => {
        if (el && !uiState.isFirstInteractionRequired) {
          el.focus();
        }
      }}
    >
      
      {/* Starting calibration overlay/introduction splash */}
      {uiState.isFirstInteractionRequired ? (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center p-6 bg-slate-950/95 text-center transition-all">
          <div className="border border-red-500/30 rounded-2xl bg-slate-900 p-6 md:p-8 max-w-lg shadow-2xl relative">
            <Radio className="w-12 h-12 mx-auto text-red-500 animate-pulse mb-3" />
            <div className="text-xs font-mono font-bold uppercase tracking-[0.3em] text-red-500">ALIEF OUTRUN</div>
            <h2 className="text-4xl font-extrabold text-white uppercase italic mt-1 mb-4 select-none bg-gradient-to-r from-yellow-400 via-orange-500 to-red-500 bg-clip-text text-transparent">
              ALIEF ARCADE
            </h2>
            
            <p className="text-sm text-slate-300 font-sans leading-relaxed mb-6">
              Cruise a fictionalized Alief, TX route past Bellaire Blvd, High Star Dr, Westpark lights, and Elsik High School. Dodge retro traffic and keep your shift timing clean!
            </p>

            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 text-left font-sans mb-6">
              <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-900 pb-2 mb-2">
                <Compass className="w-4 h-4 text-cyan-500" />
                ALIEF CRUISE CONTROL SETTINGS:
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Phone className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
                  <div>
                    <strong className="text-sm text-slate-200">Phone Accelerometer (Tilt):</strong>
                    <div className="text-xs text-slate-400">Perfect for gaming on mobile! Hold your device in landscape mode, tilt left/right to steer.</div>
                    {uiState.tiltAvailable ? (
                      <button
                        id="activate-tilt-btn"
                        onClick={requestTiltPermission}
                        className="mt-2 text-xs font-mono font-bold px-3 py-1 bg-cyan-950/60 hover:bg-cyan-900 border border-cyan-500/30 text-cyan-400 rounded cursor-pointer transition-colors"
                      >
                        ENABLE ACCELEROMETER SENSORS (iOS/Android)
                      </button>
                    ) : (
                      <div className="text-xs text-orange-400/80 mt-1 italic">Sensor streams aren't running in this desktop browser context. Use Keyboards fallback.</div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3 border-t border-slate-900/50 pt-2">
                  <Sliders className="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" />
                  <div>
                    <strong className="text-sm text-slate-200">Keyboards & Pedals Fallback:</strong>
                    <div className="text-xs text-slate-400">Steer using <kbd className="bg-slate-800 px-1 rounded text-[10px]">A</kbd>/<kbd className="bg-slate-800 px-1 rounded text-[10px]">D</kbd> or <kbd className="bg-slate-800 px-1 rounded text-[10px]">←</kbd>/<kbd className="bg-slate-800 px-1 rounded text-[10px]">→</kbd>. Gas using <kbd className="bg-slate-800 px-1 rounded text-[10px]">W</kbd> / Brake using <kbd className="bg-slate-800 px-1 rounded text-[10px]">S</kbd>. Gear Shift is <kbd className="bg-slate-800 px-1 rounded text-[10px]">SPACEBAR</kbd>.</div>
                  </div>
                </div>
              </div>
            </div>

            <button
              id="start-arcade-btn"
              onClick={handleStartButton}
              className="w-full py-4 font-mono font-bold text-lg bg-gradient-to-r from-red-600 to-orange-500 hover:from-red-500 hover:to-orange-400 text-white rounded-xl shadow-lg transition-all transform hover:scale-[1.02] active:scale-95 cursor-pointer shadow-red-900/30"
            >
              INSERT COIN & START GAME
            </button>
          </div>
        </div>
      ) : null}

      {/* Main HUD overlay panels (hidden in fullscreen — see the canvas overlay) */}
      <div className={`w-full max-w-3xl items-center justify-between gap-2 px-4 py-2.5 bg-slate-950 border border-red-500/30 rounded-t-xl text-slate-400 text-sm font-display tracking-widest select-none neon-glow-red ${uiState.isFullscreen ? 'hidden' : 'flex'}`}>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
          <span className="text-xs font-black text-red-500 neon-text-red">ALIEF LOBBY</span>
        </div>
        
        <div className="text-center font-black text-yellow-500 flex items-center gap-1 animate-pulse neon-text-yellow">
          <Zap className="w-4 h-4 text-yellow-400 fill-yellow-400" />
          {uiState.stageName}
        </div>

        <div className="flex items-center gap-3">
          {fullscreenSupported && (
            <button
              id="toggle-fullscreen-btn"
              onClick={toggleFullscreen}
              className="p-1 text-slate-500 hover:text-slate-100 transition-colors cursor-pointer"
              title={uiState.isFullscreen ? 'Exit fullscreen' : 'Go fullscreen'}
            >
              {uiState.isFullscreen ? <Minimize2 className="w-4 h-4 text-cyan-400" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          )}
          <button
            id="toggle-sound-hud-btn"
            onClick={() => updateSettings({ soundEnabled: !settings.soundEnabled })}
            className="p-1 text-slate-500 hover:text-slate-100 transition-colors cursor-pointer"
            title="Toggle Sound"
          >
            {settings.soundEnabled ? <Volume2 className="w-4 h-4 text-cyan-400" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Substantial Canvas Window. In fullscreen it fills the whole viewport
          (flex-1, no max width / aspect lock) to maximise the play area. */}
      <div className={`relative bg-slate-950 overflow-hidden shadow-2xl neon-glow-cyan ${uiState.isFullscreen ? 'w-full flex-1 min-h-0' : 'w-full max-w-3xl aspect-[16/10] border-x border-cyan-500/30'}`}>
        <canvas
          id="retro-racing-canvas"
          ref={canvasRef}
          width={640}
          height={400}
          className={`w-full h-full select-none cursor-default ${uiState.isFullscreen ? 'object-contain' : 'object-cover'}`}
        />

        {/* Collision debug readout (toggle with the DEBUG button below). relZ is
            measured from the PLAYER CAR: positive = car ahead, negative = passed. */}
        {uiState.showDebug && !uiState.isFirstInteractionRequired && (
          <div className="absolute top-2 left-2 z-20 bg-slate-950/85 border border-cyan-500/40 rounded-md px-2.5 py-1.5 font-mono text-[10px] leading-snug text-cyan-300 pointer-events-none select-none">
            <div className="text-cyan-400 font-bold tracking-[0.2em] mb-1">COLLISION DEBUG</div>
            <div>playerX {stateRef.current.playerX.toFixed(2)} · hitbox ±{uiState.debug.nearestHalfWidth.toFixed(2)} · depth {COLLISION_Z_DEPTH}</div>
            <div>
              nearest {uiState.debug.nearestType || '—'} · relZ {uiState.debug.nearestRelZ}{' '}
              <span className={uiState.debug.nearestRelZ >= 0 ? 'text-emerald-400' : 'text-slate-500'}>
                ({uiState.debug.nearestRelZ >= 0 ? 'AHEAD' : 'BEHIND'})
              </span>
            </div>
            <div className="text-slate-500">camZ {uiState.debug.nearestCamZ} (visible ~800+)</div>
            <div>
              lateral {uiState.debug.nearestLateral.toFixed(2)}{' '}
              <span className={uiState.debug.nearestInLane ? 'text-red-400 font-bold' : 'text-emerald-400'}>
                {uiState.debug.nearestInLane ? 'IN-LANE' : 'clear'}
              </span>
            </div>
            <div className="text-slate-500">last hit relZ {uiState.debug.lastHitRelZ}</div>
          </div>
        )}

        {/* Tilt on a phone: prompt for landscape + a big fullscreen button so the
            player taps once to get a full, scroll-free play area. Held back until
            after the start/enable splash so it never covers the START button. */}
        {settings.steeringMode === 'tilt' && !uiState.isFullscreen && !uiState.isFirstInteractionRequired && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center text-center px-6 bg-slate-950/92 backdrop-blur-sm pointer-events-auto select-none">
            {uiState.isPortrait && (
              <>
                <RotateCcw className="w-10 h-10 text-cyan-400 animate-pulse mb-2" />
                <div className="text-cyan-300 font-black tracking-[0.25em] text-base font-mono">ROTATE YOUR PHONE</div>
                <div className="text-slate-400 text-xs font-sans mt-1 mb-5 max-w-xs">
                  Tilt steering works best held <span className="text-yellow-300 font-bold">sideways</span>.
                </div>
              </>
            )}
            {fullscreenSupported && (
              <button
                id="enter-fullscreen-cta"
                onClick={toggleFullscreen}
                className="flex flex-col items-center gap-2 px-8 py-6 rounded-2xl border-2 border-cyan-400/60 bg-cyan-950/30 text-cyan-200 font-black tracking-widest cursor-pointer active:scale-95 transition-transform shadow-[0_0_30px_rgba(34,211,238,0.25)] animate-pulse"
              >
                <Maximize2 className="w-12 h-12" />
                <span className="text-lg">TAP FOR FULLSCREEN</span>
                <span className="text-[10px] font-normal text-slate-400 tracking-normal">maximizes the play area</span>
              </button>
            )}
          </div>
        )}

        {/* Fullscreen cockpit controls — overlaid on the canvas since the bottom
            control bar, dashboard and HUD header are all hidden in fullscreen. */}
        {uiState.isFullscreen && !stateRef.current.isCountingDown && !uiState.isFirstInteractionRequired && (
          <>
            {/* Compact stats + exit-fullscreen (top-right; debug panel is top-left) */}
            <div className="absolute top-2 right-2 z-30 flex items-center gap-2 pointer-events-auto font-mono">
              <div className="px-2.5 py-1 rounded-lg bg-slate-950/70 border border-slate-700/50 text-cyan-300 flex items-baseline gap-2">
                <span className="text-lg font-black leading-none">{Math.round(kmhToMph(uiState.speed))}</span>
                <span className="text-[8px] text-slate-500">MPH</span>
                <span className="text-yellow-400 font-bold text-xs">{uiState.gear}</span>
                <span className="text-slate-400 text-xs">{uiState.time}s</span>
              </div>
              <button onClick={toggleFullscreen} title="Exit fullscreen"
                className="p-2 rounded-lg bg-slate-950/70 border border-slate-700/50 text-cyan-300 cursor-pointer active:scale-95">
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>

            {/* Tilt indicator + calibrate (top-centre). Hold the phone in your
                driving pose and tap CALIBRATE to zero the steering. */}
            {settings.steeringMode === 'tilt' && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-1 bg-slate-950/75 border border-cyan-500/40 rounded-xl px-3 py-1.5 pointer-events-auto font-mono select-none">
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <Compass className="w-3.5 h-3.5 text-cyan-400" />
                  TILT {Math.round(stateRef.current.tiltValue)}°
                </div>
                <div className="w-40 h-2.5 bg-slate-950 border border-slate-800 rounded relative overflow-hidden">
                  {/* centre marker */}
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-600" />
                  <div
                    className="absolute top-0 bottom-0 w-2.5 bg-cyan-400 rounded-full transition-all"
                    style={{ left: `calc(50% - 5px + ${Math.min(Math.max(stateRef.current.steerInput * 100, -100), 100) * 0.5}%)` }}
                  />
                </div>
                <button
                  id="calibrate-fullscreen-btn"
                  onClick={calibrateTilt}
                  className="mt-0.5 px-3 py-1 border border-cyan-500/40 bg-cyan-950/30 text-[10px] font-bold text-cyan-300 rounded cursor-pointer hover:bg-cyan-900/40 active:scale-95 transition-all"
                >
                  CALIBRATE CENTER
                </button>
              </div>
            )}

            {/* Steering overlay for d-pad / touch (tilt uses the gyro) */}
            {settings.steeringMode === 'dpad' && (
              <div className="absolute bottom-3 left-3 z-30 grid grid-cols-3 grid-rows-2 gap-1.5 pointer-events-auto">
                <span />
                <button {...holdHandlers(() => setAccel(true), () => setAccel(false))} aria-label="Accelerate" className="w-14 h-14 rounded-lg border-2 border-emerald-500/40 bg-slate-900/70 active:bg-emerald-500 text-emerald-200 flex items-center justify-center"><ArrowUp className="w-6 h-6" /></button>
                <span />
                <button {...holdHandlers(() => handleTouchLeft(true), () => handleTouchLeft(false))} aria-label="Steer left" className="w-14 h-14 rounded-lg border border-slate-700 bg-slate-900/70 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-xl">◀</button>
                <button {...holdHandlers(() => setBrake(true), () => setBrake(false))} aria-label="Brake" className="w-14 h-14 rounded-lg border-2 border-orange-500/40 bg-slate-900/70 active:bg-orange-500 text-orange-200 flex items-center justify-center"><ArrowDown className="w-6 h-6" /></button>
                <button {...holdHandlers(() => handleTouchRight(true), () => handleTouchRight(false))} aria-label="Steer right" className="w-14 h-14 rounded-lg border border-slate-700 bg-slate-900/70 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-xl">▶</button>
              </div>
            )}
            {settings.steeringMode === 'touch' && (
              <div className="absolute bottom-3 left-3 z-30 flex gap-3 pointer-events-auto">
                <button {...holdHandlers(() => handleTouchLeft(true), () => handleTouchLeft(false))} aria-label="Steer left" className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900/70 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl">◀</button>
                <button {...holdHandlers(() => handleTouchRight(true), () => handleTouchRight(false))} aria-label="Steer right" className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900/70 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl">▶</button>
              </div>
            )}

            {/* SHIFT — bottom centre, always available */}
            <button {...tapHandler(toggleGear)}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-xl border-2 border-yellow-500/50 bg-yellow-950/40 active:bg-yellow-500 active:text-slate-950 text-yellow-300 font-black text-sm flex items-center gap-1.5 pointer-events-auto cursor-pointer">
              <Zap className="w-4 h-4" /> SHIFT <span className="ml-1 px-1.5 rounded bg-slate-950/60 text-cyan-300">{uiState.gear}</span>
            </button>

            {/* Gas / brake pedals (tilt / touch / keyboard; the d-pad has its own) */}
            {settings.steeringMode !== 'dpad' && (
              <div className="absolute bottom-3 right-3 z-30 flex gap-3 pointer-events-auto">
                <button {...holdHandlers(() => setBrake(true), () => setBrake(false))} aria-label="Brake" className="w-16 h-16 rounded-xl bg-orange-600/90 border-2 border-orange-500/30 text-white flex flex-col items-center justify-center font-black text-[10px] active:bg-orange-500"><ArrowDown className="w-5 h-5" />BRAKE</button>
                <button {...holdHandlers(() => setAccel(true), () => setAccel(false))} aria-label="Accelerate" className="w-16 h-16 rounded-xl bg-emerald-600/90 border-2 border-emerald-500/30 text-white flex flex-col items-center justify-center font-black text-[10px] active:bg-emerald-500"><ArrowUp className="w-5 h-5" />GAS</button>
              </div>
            )}
          </>
        )}

        {/* 3.. 2.. 1.. GO Countdown */}
        {stateRef.current.isCountingDown && !uiState.isFirstInteractionRequired && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/40 backdrop-blur-[2px]">
            <div className="animate-ping text-8xl font-black font-mono text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-500 select-none">
              {uiState.countdownText}
            </div>
            <div className="text-xs text-yellow-500 tracking-[0.4em] font-mono font-bold mt-4 uppercase animate-pulse">
              GET READY FOR ALIEF!
            </div>
          </div>
        )}

        {/* Transient Near-Miss Bonus score notification animation */}
        {uiState.nearMissScoreAlert > 0 && (
          <div className="absolute top-[40%] left-[50%] -translate-x-[50%] -translate-y-[50%] text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 font-mono font-extrabold text-4xl tracking-widest animate-bounce z-10 drop-shadow-[0_2px_10px_rgba(234,179,8,0.5)]">
            +{uiState.nearMissScoreAlert.toLocaleString()}
            <div className="text-[10px] text-center text-slate-100 uppercase tracking-[0.2em] mt-1 font-sans">
              CLEAN ALIEF PASS!
            </div>
          </div>
        )}

        {/* Emergency low fuel alarm flash overlay */}
        {uiState.time <= 10 && uiState.time > 0 && (
          <div className="absolute inset-0 border-[6px] border-red-600/60 pointer-events-none animate-flash-border z-10 flex items-start justify-center pt-10">
            <div className="bg-red-950/90 border border-red-500 px-4 py-2 rounded-lg text-red-500 flex items-center gap-2 font-black text-xs uppercase tracking-widest animate-pulse shadow-lg">
              <ShieldAlert className="w-5 h-5 text-red-500" />
              CRITICAL TIME RUNNING OUT!
            </div>
          </div>
        )}

        {/* Debug pause card — kept bottom-center so the top-left debug readout
            stays fully visible for inspection. */}
        {uiState.paused && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 bg-slate-950/90 border-2 border-cyan-500/50 rounded-xl px-5 py-3 font-mono pointer-events-auto">
            <div className="text-cyan-400 font-black tracking-[0.25em] text-xs">PAUSED ON COLLISION</div>
            <div className="text-[10px] text-slate-400">
              impact relZ <span className="text-yellow-300">{uiState.debug.lastHitRelZ}</span> · full readout top-left ↖
            </div>
            <button
              id="resume-btn"
              onClick={resumeGame}
              className="px-6 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 font-black tracking-wider cursor-pointer active:scale-95 transition-transform outline-none"
            >
              ▶ RESUME
            </button>
          </div>
        )}

        {/* On-screen driving controls live BELOW the canvas (see the control bar
            after this container) so they never cover the play area. */}
      </div>

      {/* On-screen driving controls — BELOW the canvas so they never cover the
          play area. Steering varies by mode; SHIFT + DEBUG are always present.
          In fullscreen these move onto the canvas as overlays (above). */}
      {!stateRef.current.isCountingDown && !uiState.isFirstInteractionRequired && !uiState.isFullscreen && (
        <div className="w-full max-w-3xl flex items-center justify-between gap-3 px-4 py-3 bg-slate-950 border-x border-cyan-500/20 select-none">
          {/* Steering (mode-dependent) */}
          <div className="flex items-center min-h-[3.5rem]">
            {settings.steeringMode === 'dpad' && (
              <div className="grid grid-cols-3 grid-rows-2 gap-1.5">
                <span />
                <button id="dpad-up-btn" {...holdHandlers(() => setAccel(true), () => setAccel(false))} aria-label="Accelerate"
                  className="w-14 h-14 rounded-lg border-2 border-emerald-500/40 bg-slate-900 active:bg-emerald-500 text-emerald-200 flex items-center justify-center cursor-pointer outline-none">
                  <ArrowUp className="w-6 h-6" />
                </button>
                <span />
                <button id="dpad-left-btn" {...holdHandlers(() => handleTouchLeft(true), () => handleTouchLeft(false))} aria-label="Steer left"
                  className="w-14 h-14 rounded-lg border border-slate-700 bg-slate-900 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-xl cursor-pointer outline-none">◀</button>
                <button id="dpad-down-btn" {...holdHandlers(() => setBrake(true), () => setBrake(false))} aria-label="Brake"
                  className="w-14 h-14 rounded-lg border-2 border-orange-500/40 bg-slate-900 active:bg-orange-500 text-orange-200 flex items-center justify-center cursor-pointer outline-none">
                  <ArrowDown className="w-6 h-6" />
                </button>
                <button id="dpad-right-btn" {...holdHandlers(() => handleTouchRight(true), () => handleTouchRight(false))} aria-label="Steer right"
                  className="w-14 h-14 rounded-lg border border-slate-700 bg-slate-900 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-xl cursor-pointer outline-none">▶</button>
              </div>
            )}
            {settings.steeringMode === 'touch' && (
              <div className="flex gap-3">
                <button id="virtual-steer-left-btn" {...holdHandlers(() => handleTouchLeft(true), () => handleTouchLeft(false))} aria-label="Steer left"
                  className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl cursor-pointer outline-none">◀</button>
                <button id="virtual-steer-right-btn" {...holdHandlers(() => handleTouchRight(true), () => handleTouchRight(false))} aria-label="Steer right"
                  className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl cursor-pointer outline-none">▶</button>
              </div>
            )}
            {settings.steeringMode === 'tilt' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 flex flex-col text-[10px] text-slate-400 font-mono gap-1">
                <div className="flex items-center gap-1"><Compass className="w-3.5 h-3.5 text-cyan-400" />SENSORS: {Math.round(stateRef.current.tiltValue)}°</div>
                <div className="w-24 h-2.5 bg-slate-950 border border-slate-800 rounded relative overflow-hidden">
                  <div className="absolute top-0 bottom-0 w-2.5 bg-cyan-400 rounded-full transition-all" style={{ left: `calc(50% - 5px + ${Math.min(Math.max(stateRef.current.steerInput * 100, -100), 100) * 0.5}%)` }} />
                </div>
                <button id="calibrate-sensor-btn" onClick={calibrateTilt} className="mt-1 px-1.5 py-0.5 border border-slate-700 bg-slate-950 text-[9px] font-bold hover:bg-slate-800 text-slate-300 rounded cursor-pointer">CALIBRATE CENTER</button>
              </div>
            )}
            {settings.steeringMode === 'keyboard' && (
              <div className="text-[10px] text-slate-500 font-mono leading-relaxed">
                ◀ ▶ / A D — STEER<br />▲ ▼ / W S — GAS · BRAKE
              </div>
            )}
          </div>

          {/* Shift + Radio + Debug toggle (always available) */}
          <div className="flex flex-col items-center justify-center gap-2">
            <button id="shift-gear-btn" {...tapHandler(toggleGear)}
              className="px-4 py-2 rounded-xl border-2 border-yellow-500/50 bg-yellow-950/30 active:bg-yellow-500 active:text-slate-950 text-yellow-300 font-black text-sm flex items-center gap-1.5 cursor-pointer outline-none transition-colors">
              <Zap className="w-4 h-4" />
              SHIFT
              <span className="ml-1 px-1.5 rounded bg-slate-950/60 text-cyan-300">{uiState.gear}</span>
            </button>
            <button id="radio-btn" onClick={cycleRadioTrack} title="Change radio station"
              className="px-2.5 py-1 rounded-lg border border-fuchsia-500/40 bg-fuchsia-950/20 text-fuchsia-300 text-[10px] font-bold flex items-center gap-1.5 cursor-pointer outline-none transition-colors hover:bg-fuchsia-900/30 active:scale-95">
              <Radio className="w-3.5 h-3.5" />
              <span className="tracking-wider">{trackNames[uiState.musicTrackIndex]}</span>
              <ChevronRight className="w-3 h-3 opacity-70" />
            </button>
            <div className="flex items-center gap-1.5" title="Music volume">
              {settings.musicVolume > 0 ? <Volume2 className="w-3.5 h-3.5 text-fuchsia-300" /> : <VolumeX className="w-3.5 h-3.5 text-slate-500" />}
              <input
                type="range"
                aria-label="Music volume"
                min="0"
                max="1"
                step="0.05"
                value={settings.musicVolume}
                onChange={(e) => updateSettings({ musicVolume: parseFloat(e.target.value) })}
                className="w-24 accent-fuchsia-500 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer"
              />
            </div>
            <button onClick={toggleDebug}
              className={`px-2 py-0.5 rounded border text-[9px] font-bold cursor-pointer transition-colors ${uiState.showDebug ? 'border-cyan-500/50 text-cyan-300 bg-cyan-950/30' : 'border-slate-700 text-slate-500 bg-slate-950'}`}>
              DEBUG {uiState.showDebug ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* Pedals (touch/tilt only — the d-pad already includes gas/brake) */}
          {(settings.steeringMode === 'touch' || settings.steeringMode === 'tilt') ? (
            <div className="flex gap-3 items-center">
              <button id="virtual-brake-btn" {...holdHandlers(() => setBrake(true), () => setBrake(false))} aria-label="Brake"
                className="w-16 h-16 rounded-xl bg-orange-600 border-2 border-orange-500/30 text-white flex flex-col items-center justify-center font-black text-[10px] active:bg-orange-500 cursor-pointer">
                <ArrowDown className="w-5 h-5" />BRAKE
              </button>
              <button id="virtual-accel-btn" {...holdHandlers(() => setAccel(true), () => setAccel(false))} aria-label="Accelerate"
                className="w-16 h-16 rounded-xl bg-emerald-600 border-2 border-emerald-500/30 text-white flex flex-col items-center justify-center font-black text-[10px] active:bg-emerald-500 cursor-pointer">
                <ArrowUp className="w-5 h-5" />GAS
              </button>
            </div>
          ) : (
            <div className="w-10" />
          )}
        </div>
      )}

      {/* Retro dashboard below the canvas (hidden in fullscreen; a compact
          speed/gear/time readout overlays the canvas instead). */}
      <div className={`w-full max-w-3xl grid-cols-12 gap-2 sm:gap-4 p-4 bg-slate-950 border border-red-500/30 rounded-b-xl select-none text-slate-200 font-mono neon-glow-red ${uiState.isFullscreen ? 'hidden' : 'grid'}`}>
        
        {/* Left Dial: Speedometer */}
        <div className="col-span-4 flex flex-col items-center justify-center p-2 bg-slate-950 rounded-xl border border-slate-850 relative overflow-hidden group">
          <div className="text-[10px] text-slate-500 tracking-wider">SPEEDOMETER</div>
          <div className="flex items-baseline mt-1">
            <span className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500 group-hover:animate-pulse">
              {Math.round(kmhToMph(uiState.speed))}
            </span>
            <span className="text-xs text-slate-500 ml-1">MPH</span>
          </div>
          {/* Simulated speed progress bar */}
          <div className="w-full h-1 bg-slate-900 rounded-full mt-2 overflow-hidden">
            <div 
              className="h-full bg-cyan-400 transition-all duration-75"
              style={{ width: `${Math.min((uiState.speed / HIGH_GEAR_TOP_SPEED) * 100, 100)}%` }}
            />
          </div>
        </div>

        {/* Center: Interactive Gear shifter & Tacho dial */}
        <div className="col-span-4 flex items-center justify-between p-2 bg-slate-950 rounded-xl border border-slate-800/80">
          
          <div className="flex flex-col items-center flex-1 pr-2 border-r border-slate-800">
            <div className="text-[10px] text-slate-500 tracking-wider">RPM REVS</div>
            <div className="text-lg font-bold text-slate-300 mt-1">{uiState.rpm}</div>
            <div className="w-full h-1 bg-slate-900 rounded-full mt-2 overflow-hidden">
              <div 
                className={`h-full transition-all duration-75 ${uiState.rpm > 85 ? 'bg-red-500' : uiState.rpm > 65 ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(uiState.rpm, 100)}%` }}
              />
            </div>
          </div>

          {/* Low/High Gear knob button */}
          <button
            id="gear-shifter-hud-btn"
            {...tapHandler(toggleGear)}
            className="flex flex-col items-center justify-center flex-1 pl-2 h-full cursor-pointer hover:bg-slate-900 rounded transition-colors group select-none"
            title="Click or Tap to Shift Gear"
          >
            <div className="text-[10px] text-slate-500 mb-1">GEARBOX</div>
            <div className={`px-2.5 py-1 text-center font-black text-sm rounded ${
              uiState.gear === 'HIGH' 
                ? 'bg-red-950 border border-red-500 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.2)]' 
                : 'bg-cyan-950 border border-cyan-500 text-cyan-400'
            }`}>
              {uiState.gear}
            </div>
            <div className="text-[8px] text-slate-500 mt-1 flex items-center justify-center gap-0.5 group-hover:text-slate-300">
              SHIFT <ChevronRight className="w-2 h-2 shrink-0 animate-pulse" />
            </div>
          </button>
        </div>

        {/* Right Dashboard panel: Scores and check timer */}
        <div className="col-span-4 grid grid-rows-2 gap-2">
          
          {/* LCD Score */}
          <div className="bg-slate-950 rounded-lg p-1.5 flex items-center justify-between border border-slate-800/80 px-3">
            <span className="text-[9px] text-slate-500 font-bold uppercase">SCORE</span>
            <span className="text-sm font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-yellow-200">
              {uiState.score.toLocaleString()}
            </span>
          </div>

          {/* Countdown Clock */}
          <div className="bg-slate-950 rounded-lg p-1.5 flex items-center justify-between border border-slate-800/80 px-3">
            <span className="text-[9px] text-slate-500 font-bold uppercase">LIMIT SURVIVAL</span>
            <span className={`text-sm font-black tracking-tight ${uiState.time <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
              {uiState.time}s
            </span>
          </div>

        </div>
      </div>

    </div>
  );
}
