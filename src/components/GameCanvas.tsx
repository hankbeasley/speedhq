/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { audio } from '../lib/AudioEngine';
import { PlayerSettings, RoadSegment, GameCar, Particle, ActiveScenery } from '../types';
import { Sliders, RotateCcw, Volume2, VolumeX, ShieldAlert, Zap, Radio, Phone, Compass, ArrowUp, ArrowDown, ChevronRight } from 'lucide-react';

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
const DISTANCE_TO_PLAYER = 150;  // player distance from camera along Z
const CAMERA_DEPTH = 0.8;        // perspective fov multiplier
const LANE_COUNT = 3;

// Tuned handling model constants. The original game moved the car directly
// sideways from input, which made the controls feel twitchy at low speeds and
// imprecise at high speeds. These constants give the car inertia, grip, drag,
// and a readable arcade top speed while preserving the pseudo-3D render style.
const LOW_GEAR_TOP_SPEED = 195.0;
const HIGH_GEAR_TOP_SPEED = 385.0;
const SPEED_TO_WORLD_MULTIPLIER = 5.0;
const ROAD_EDGE = 0.98;
const HARD_SHOULDER_EDGE = 2.0;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const approach = (value: number, target: number, maxDelta: number) => {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return value;
};

const normalizeRelativeZ = (relativeZ: number, totalLength: number) => {
  if (relativeZ < -totalLength / 2) return relativeZ + totalLength;
  if (relativeZ > totalLength / 2) return relativeZ - totalLength;
  return relativeZ;
};

// Map out the continuous looping stage segments
const SCENERY_STAGES: ActiveScenery[] = [
  { name: "1. COCONUT COAST", climate: 'cost', bgColor: '#021526', accentColor: '#0ea5e9', length: 400 },
  { name: "2. NEON METROPOLIS", climate: 'city', bgColor: '#090514', accentColor: '#ec4899', length: 500 },
  { name: "3. CRYPTIC TUNNEL", climate: 'tunnel', bgColor: '#060a0f', accentColor: '#eab308', length: 300 },
  { name: "4. DESERT DUNES", climate: 'desert', bgColor: '#1c0f05', accentColor: '#f97316', length: 450 },
  { name: "5. BLIZZARD PASS", climate: 'snow', bgColor: '#071624', accentColor: '#a5f3fc', length: 450 }
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
    flatGamma: 0,            // calibrated horizontal balance
    tiltValue: 0,            // live calculated relative tilt value
    steeringMode: settings.steeringMode, // cached steering mode for closures

    // Stats
    nearMissCount: 0,
    totalDistanceDriven: 0,
    uiUpdateTimer: 0
  });

  const [uiState, setUiState] = useState({
    speed: 0,
    gear: 'LOW',
    rpm: 0,
    score: 0,
    time: 80,
    stageName: '1. COCONUT COAST',
    stageIdx: 0,
    stageProgressPct: 0,
    nearMissScoreAlert: 0, // transient points indicator
    countdownText: '3',
    tiltAvailable: false,
    tiltPermissionStatus: 'unknown' as 'unknown' | 'granted' | 'denied',
    isFirstInteractionRequired: true,
    showControlsHelp: true
  });

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
    const s = stateRef.current;
    s.steeringMode = settings.steeringMode;
    s.keySteerLeft = false;
    s.keySteerRight = false;
    s.touchSteerLeft = false;
    s.touchSteerRight = false;
    s.targetSteerInput = 0;
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
  const handleOrientationEvent = (e: DeviceOrientationEvent) => {
    if (stateRef.current.steeringMode !== 'tilt') return;
    if (!e.gamma && e.gamma !== 0) return;

    // Convert roll (gamma) to steering factor based on landscape orientation (horizontal holding)
    const baseGamma = e.gamma; // Range: -90 to +90
    
    // Compute steering steer factor
    // If phone is tilted left or right, we scale roll to -1.0 -> +1.0
    const difference = baseGamma - stateRef.current.flatGamma;
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
    // Record baseline horizontal gamma
    if (window.DeviceOrientationEvent) {
      const captureFlat = (e: DeviceOrientationEvent) => {
        if (e.gamma !== null) {
          stateRef.current.flatGamma = e.gamma;
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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [uiState.isFirstInteractionRequired]);

  // Generate the recursive track with variable scenery climates
  const buildTrack = () => {
    const segments: RoadSegment[] = [];
    let currentZ = 0;
    let index = 0;

    SCENERY_STAGES.forEach((stage) => {
      // Generate components for this scenery block
      const stageLength = stage.length;

      for (let i = 0; i < stageLength; i++) {
        // Curve frequency & amplitude variations matching climatic theme
        let segmentCurve = 0;
        let segmentHill = 0;

        // Generate undulating road structures
        if (stage.climate === 'cost') {
          // Coast has long gentle winding curves and light coastal slopes
          segmentCurve = Math.sin(i / 35) * 2.2;
          segmentHill = Math.cos(i / 20) * 8.0;
        } else if (stage.climate === 'city') {
          // City has sharp turns at grid intervals
          if ((i > 50 && i < 110) || (i > 200 && i < 270) || (i > 380 && i < 440)) {
            segmentCurve = 4.5; // sharp right curve
          } else {
            segmentCurve = 0;
          }
          segmentHill = Math.sin(i / 15) * 4.0;
        } else if (stage.climate === 'tunnel') {
          // Tunnels are straight or slightly sweeping, flat roads
          segmentCurve = Math.sin(i / 60) * 1.5;
          segmentHill = -2.0; // gradual downhill entry
        } else if (stage.climate === 'desert') {
          // Desert has severe sand dunes (rollercoaster hills) but sparse curves
          segmentCurve = Math.cos(i / 50) * 1.2;
          segmentHill = Math.sin(i / 12) * 28.0; // Extreme hills!
        } else if (stage.climate === 'snow') {
          // Blizzard mountain pass has extremely erratic hairpins
          segmentCurve = Math.sin(i / 18) * 5.2; // sharp hairpins
          segmentHill = Math.sin(i / 25) * 15.0; // moderate hills
        }

        // Color definitions for alternating segment tracks
        const isAlternating = Math.floor(i / 3) % 2 === 0;
        let segmentColors = {
          road: '#212529',
          grass: stage.climate === 'desert' ? '#92400e' : stage.climate === 'snow' ? '#ffffff' : '#14532d',
          rumble: isAlternating ? '#ef4444' : '#f8fafc',
          lane: isAlternating ? '#6b7280' : '#212529'
        };

        // Custom climate adjustments
        if (stage.climate === 'tunnel') {
          segmentColors.road = '#111827';
          segmentColors.grass = '#030712'; // dark surroundings
          segmentColors.rumble = isAlternating ? '#eab308' : '#374151'; // warning stripes
        } else if (stage.climate === 'city') {
          segmentColors.road = '#1f2937';
          segmentColors.grass = '#0f172a'; // urban midnight grid
          segmentColors.rumble = isAlternating ? '#a855f7' : '#06b6d4'; // bright cyber neon curbs
        }

        // Populate side-road decorations
        const spritesList = [];
        if (i % 6 === 0) {
          // Alternate side left (-1.5) or right (+1.5)
          const side = (Math.sin(i) > 0) ? 1.5 : -1.5;
          let spriteName = 'palm';

          if (stage.climate === 'cost') {
            spriteName = Math.sin(i * 2) > 0.3 ? 'palm' : 'billboard';
          } else if (stage.climate === 'city') {
            spriteName = Math.cos(i * 3) > 0 ? 'streetlight' : 'billboard';
          } else if (stage.climate === 'tunnel') {
            spriteName = 'tunnel_ring'; // arched overhead light
          } else if (stage.climate === 'desert') {
            spriteName = Math.sin(i * 2) > 0 ? 'cactus' : 'billboard';
          } else if (stage.climate === 'snow') {
            spriteName = 'snow_pine';
          }

          spritesList.push({
            spriteType: spriteName,
            offset: side,
            scale: 1.0
          });
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

    // Make the last few segments flat to blend back to start loop
    for (let k = 0; k < 20; k++) {
      segments.push({
        index,
        p1: { world: { x: 0, y: 0, z: currentZ }, screen: { x: 0, y: 0, w: 0 } },
        p2: { world: { x: 0, y: 0, z: currentZ + ROAD_SEGMENT_LENGTH }, screen: { x: 0, y: 0, w: 0 } },
        curve: 0,
        hill: 0,
        color: { road: '#212529', grass: '#14532d', rumble: '#ef4444', lane: '#212529' },
        sprites: [],
        climate: 'cost'
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

    // Spawn 48 AI cars distributed across the track. The spacing keeps the first
    // seconds playable while still giving enough overtaking opportunities.
    for (let i = 0; i < 48; i++) {
      const zPos = 1800 + i * (segmentsCount * ROAD_SEGMENT_LENGTH / 50);
      const laneId = Math.floor(Math.random() * 3) - 1; // -1, 0, 1 -> maps to offset -0.6, 0.0, 0.6
      const speedKmh = 95 + Math.random() * 135; // 95 to 230 km/h

      const types: Array<'blue' | 'yellow' | 'green' | 'ambulance' | 'truck'> = ['blue', 'yellow', 'green', 'truck'];
      // Flashing ambulance speed runner
      const selectedType = (i % 8 === 0) ? 'ambulance' : types[Math.floor(Math.random() * types.length)];

      carsList.push({
        offset: laneId * 0.61,
        z: zPos,
        speed: speedKmh,
        spriteType: selectedType,
        width: selectedType === 'truck' ? 1.4 : 1.0,
        length: selectedType === 'truck' ? 150 : 100,
        color: selectedType === 'ambulance' ? '#ef4444' : selectedType === 'blue' ? '#3b82f6' : '#eab308',
        laneChangeTimer: 2.5 + Math.random() * 4.5,
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
      
      const phrases = ['SPEED HQ', 'TURBO', 'SHIFT UP', 'PLAY NOW'];
      const phrase = phrases[Math.floor(animationFrame / 80) % phrases.length];
      
      ctx.fillStyle = '#06b6d4'; // cyan glow
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#06b6d4';
      ctx.fillText(phrase, 0, -height * 0.65);
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

    const isAmbulance = car.spriteType === 'ambulance';
    const isTruck = car.spriteType === 'truck';

    if (isAmbulance) {
      // Red/White emergency speed-runner
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-size * 0.5, -size * 0.61, size, size * 0.61);
      
      // Windshield
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(-size * 0.4, -size * 0.55, size * 0.8, size * 0.16);

      // Flashing top siren
      const flash = Math.sin(Date.now() / 80) > 0;
      ctx.fillStyle = flash ? '#ef4444' : '#3b82f6';
      ctx.shadowBlur = flash ? 15 : 0;
      ctx.shadowColor = '#ef4444';
      ctx.fillRect(-size * 0.15, -size * 0.72, size * 0.3, size * 0.12);

      // Rear break lamps
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-size * 0.45, -size * 0.22, size * 0.15, size * 0.1);
      ctx.fillRect(size * 0.3, -size * 0.22, size * 0.15, size * 0.1);
    } else if (isTruck) {
      // Heavy shipping vehicle (huge grey block)
      ctx.fillStyle = '#334155';
      ctx.fillRect(-size * 0.65, -size * 0.95, size * 1.3, size * 0.95);

      // Left & right warning hazard stripes
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(-size * 0.61, -size * 0.18, size * 0.3, size * 0.08);
      ctx.fillRect(size * 0.31, -size * 0.18, size * 0.3, size * 0.08);

      // Rear massive tires
      ctx.fillStyle = '#000000';
      ctx.fillRect(-size * 0.65, -size * 0.12, size * 0.22, size * 0.15);
      ctx.fillRect(size * 0.43, -size * 0.12, size * 0.22, size * 0.15);
    } else {
      // Standard sporty race car (blue or yellow)
      ctx.fillStyle = car.color;
      // Body chassis
      ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.31);
      // Cockpit hood cabin
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-size * 0.35, -size * 0.52, size * 0.7, size * 0.18);

      // Spoilers wing
      ctx.fillStyle = car.color;
      ctx.fillRect(-size * 0.55, -size * 0.56, size * 1.1, size * 0.08);
      // Spoiler supports
      ctx.fillStyle = '#000000';
      ctx.fillRect(-size * 0.45, -size * 0.48, size * 0.06, size * 0.1);
      ctx.fillRect(size * 0.39, -size * 0.48, size * 0.06, size * 0.1);

      // Tail lights
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-size * 0.45, -size * 0.26, size * 0.15, size * 0.06);
      ctx.fillRect(size * 0.3, -size * 0.26, size * 0.15, size * 0.06);

      // Wheels
      ctx.fillStyle = '#000';
      ctx.fillRect(-size * 0.52, -size * 0.12, size * 0.18, size * 0.12);
      ctx.fillRect(size * 0.34, -size * 0.12, size * 0.18, size * 0.12);
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
    const py = canvas.height * 0.78;
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
    const maxSpeed = s.gear === 'LOW' ? LOW_GEAR_TOP_SPEED : HIGH_GEAR_TOP_SPEED;

    // Handle Time Tock
    s.timeLimit -= dt;
    if (s.timeLimit <= 0) {
      s.timeLimit = 0;
      s.running = false;
      onGameOver(s.score, s.maxSpeedAchieved, s.currentStageIdx + 1);
      return;
    }

    // A lightweight arcade drivetrain: torque fades near redline, high gear lugs
    // under ~125 km/h, and drag is always applied so lift-off feels natural.
    if (s.isCrashActive) {
      s.speed -= 260 * dt;
      s.targetSteerInput = 0;
    } else {
      const speedRatio = clamp(s.speed / maxSpeed, 0, 1);
      let acceleration = 0;

      if (s.accelInput && !s.brakeInput) {
        const basePower = s.gear === 'LOW' ? 255 : 190;
        const torqueCurve = clamp(1.0 - 0.62 * speedRatio * speedRatio, 0.22, 1.0);
        const lugPenalty = s.gear === 'HIGH' && s.speed < 125 ? 0.34 : 1.0;
        acceleration += basePower * torqueCurve * lugPenalty;
      }

      if (s.brakeInput) {
        acceleration -= 470 + s.speed * 0.18;
      } else if (!s.accelInput) {
        acceleration -= 24 + s.speed * 0.055;
      }

      const aeroDrag = 10 + s.speed * s.speed * 0.00034;
      s.speed += (acceleration - aeroDrag) * dt;
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
    const speedMs = (s.speed / 3.6) * SPEED_TO_WORLD_MULTIPLIER;
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

      const steeringAuthority = (1.15 + speed01 * 2.15) * grip;
      const curvePull = currentSegment.curve * (0.18 + speed01 * 0.72);
      const counterSteerAssist = clamp(-curvePull * 0.18, -0.35, 0.35);
      const lateralAcceleration = (s.steerInput * steeringAuthority + counterSteerAssist - curvePull) * grip;

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
        stageProgressPct: Math.round(s.stageProgress * 100)
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
    const playerZ = s.playerZ;

    s.activeCars.forEach(car => {
      const carPrevZ = car.z;
      const speedMs = (car.speed / 3.6) * SPEED_TO_WORLD_MULTIPLIER;
      car.z += speedMs * dt;

      // Handle wrapping at end of track
      if (car.z >= totalLength) {
        car.z -= totalLength;
      }

      // Lane changes are measured in seconds, not world units. Keep them
      // occasional and avoid surprise swerves right on top of the player.
      let relZ = normalizeRelativeZ(car.z - playerZ, totalLength);
      car.laneChangeTimer -= dt;
      if (car.laneChangeTimer <= 0) {
        car.laneChangeTimer = 2.2 + Math.random() * 5.5;
        const playerNearby = relZ > -160 && relZ < 260;
        if (!playerNearby) {
          const newLane = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
          car.laneTarget = newLane * 0.61;
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

      relZ = normalizeRelativeZ(car.z - playerZ, totalLength);
      const prevRelZ = normalizeRelativeZ(carPrevZ - previousPlayerZ, totalLength);

      // Swept collision: at 300+ km/h a single frame can skip a small overlap
      // window, so detect sign-crossing as well as immediate overlap.
      const sweptAcrossPlayer = (prevRelZ > 0 && relZ <= 0) || (prevRelZ < 0 && relZ >= 0 && car.speed > s.speed);
      const zOverlap = Math.min(Math.abs(relZ), Math.abs(prevRelZ)) < 45 || sweptAcrossPlayer;
      const xCollisionLimit = 0.25 + car.width * 0.15;
      const lateralDistance = Math.abs(car.offset - s.playerX);
      const xOverlap = lateralDistance < xCollisionLimit;

      if (zOverlap && xOverlap && !s.isCrashActive && s.invincibilityTimer <= 0) {
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
    });

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

      project(p1, s.playerX * ROAD_WIDTH, cameraY, cameraZ, canvas.width, canvas.height, accumulatedCurveAddX - (percentZ * seg.curve));
      project(p2, s.playerX * ROAD_WIDTH, cameraY, cameraZ, canvas.width, canvas.height, accumulatedCurveAddX + segmentCurveAt(idx) - (percentZ * seg.curve));

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
      const seg = render.segment;

      // Render roadside trees, poles, tunnels, billboards
      seg.sprites.forEach(sprite => {
        // Horizontal offset
        const sprOffset = sprite.offset;
        const xPos = p1.screen.x + Math.round(sprOffset * p1.screen.w * 0.52);
        const yPos = p1.screen.y;
        
        // Size scales based on screen projection factor
        const sprWidth = Math.round(p1.screen.w * 0.18);
        const sprHeight = Math.round(p1.screen.w * 0.22);

        drawVectorSprite(ctx, sprite.spriteType, sprWidth, sprHeight, xPos, yPos, stepNum);
      });

      // Render AI cars that fit on this segment section
      s.activeCars.forEach(car => {
        // Match segment
        const carSegmentIdx = Math.floor(car.z / ROAD_SEGMENT_LENGTH) % s.roadSegments.length;
        if (carSegmentIdx === seg.index) {
          // Calculate project position
          const relZ = normalizeRelativeZ(car.z - startZ, totalLength);
          if (relZ <= DISTANCE_TO_PLAYER || relZ >= VIEW_DEPTH * ROAD_SEGMENT_LENGTH) return;

          const scale = CAMERA_DEPTH / relZ;
          
          let carAccumCurve = 0;
          for (let k = 0; k <= VIEW_DEPTH; k++) {
            const lookIdx = (startSegmentIdx + k) % s.roadSegments.length;
            if (lookIdx === carSegmentIdx) {
              break;
            }
            carAccumCurve += segmentCurveAt(lookIdx);
          }

          const carWorldX = car.offset * ROAD_WIDTH;
          const carScreenW = Math.round(scale * ROAD_WIDTH * (canvas.width / 2));
          const carScreenX = Math.round((canvas.width / 2) + ((carWorldX - s.playerX * ROAD_WIDTH + carAccumCurve) * scale * (canvas.width / 2)));
          const carScreenY = Math.round((canvas.height / 2) - ((seg.hill * 10.0 - cameraY) * scale * (canvas.height / 2)));
          
          const size = Math.round(carScreenW * 0.14);

          drawAiCar(ctx, car, carScreenX, carScreenY, size);
        }
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

  // Draw background horizons matching stages (sunsets/wireframes/tunnels)
  const drawBackgroundScenery = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, steerOffset: number) => {
    const stageIdx = stateRef.current.currentStageIdx;
    
    ctx.save();

    const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height * 0.5);

    if (stageIdx === 0) {
      // 1. Palms and blue shore
      skyGrad.addColorStop(0, '#021526');
      skyGrad.addColorStop(0.7, '#0ea5e9');
      skyGrad.addColorStop(1, '#38bdf8');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);

      // Simple yellow sun dropping
      ctx.fillStyle = '#f59e0b';
      ctx.shadowBlur = 40;
      ctx.shadowColor = '#f59e0b';
      ctx.beginPath();
      ctx.arc(canvas.width * 0.5 + steerOffset * 3, canvas.height * 0.34, 45, 0, Math.PI * 2);
      ctx.fill();
    } else if (stageIdx === 1) {
      // 2. Neon Metropolis Skyline
      skyGrad.addColorStop(0, '#090514');
      skyGrad.addColorStop(1, '#4a044e');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);

      // Draw cybercity skyscrapers blocks
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.4)'; // distant skyline shadow
      for (let j = 0; j < 8; j++) {
        const offset = (j * (canvas.width / 6)) - steerOffset * 2.5;
        ctx.fillRect(offset, canvas.height * 0.25 + (j % 3) * 20, 80, canvas.height * 0.25);
      }
      ctx.fillStyle = '#0f172a'; // close skyline blocks
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ec4899'; // violet wireframe
      for (let j = 0; j < 6; j++) {
        const offset = (j * (canvas.width / 5)) - steerOffset * 4.0;
        ctx.fillRect(offset, canvas.height * 0.3 + (j % 2) * 15, 110, canvas.height * 0.2);
        ctx.strokeRect(offset, canvas.height * 0.3 + (j % 2) * 15, 110, canvas.height * 0.2);
      }
    } else if (stageIdx === 2) {
      // 3. Cryptic Tunnel interior
      // Tunnels have black background so we don't draw any distant features, making the neon tunnel rings pop!
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);
    } else if (stageIdx === 3) {
      // 4. Desert sunset
      skyGrad.addColorStop(0, '#1c0f05');
      skyGrad.addColorStop(0.6, '#ea580c');
      skyGrad.addColorStop(1, '#f97316');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);

      // Distant orange pyramid dunes
      ctx.fillStyle = '#7c2d12';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height * 0.5);
      ctx.lineTo(canvas.width * 0.3 - steerOffset * 2, canvas.height * 0.35);
      ctx.lineTo(canvas.width * 0.6, canvas.height * 0.5);
      ctx.moveTo(canvas.width * 0.4, canvas.height * 0.5);
      ctx.lineTo(canvas.width * 0.85 - steerOffset * 2, canvas.height * 0.3);
      ctx.lineTo(canvas.width, canvas.height * 0.5);
      ctx.fill();
    } else if (stageIdx === 4) {
      // 5. Snow mountain
      skyGrad.addColorStop(0, '#071624');
      skyGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, canvas.width, canvas.height * 0.5);

      // Big snow peaks
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height * 0.5);
      ctx.lineTo(canvas.width * 0.4 - steerOffset * 1.5, canvas.height * 0.18);
      ctx.lineTo(canvas.width * 0.7, canvas.height * 0.5);
      ctx.fill();

      ctx.fillStyle = '#94a3b8'; // snowy ice caps
      ctx.beginPath();
      ctx.moveTo(canvas.width * 0.35 - steerOffset * 1.5, canvas.height * 0.24);
      ctx.lineTo(canvas.width * 0.4 - steerOffset * 1.5, canvas.height * 0.18);
      ctx.lineTo(canvas.width * 0.45 - steerOffset * 1.5, canvas.height * 0.24);
      ctx.closePath();
      ctx.fill();
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
    if (s.isCountingDown) return;

    s.gear = s.gear === 'LOW' ? 'HIGH' : 'LOW';
    audio.playGearChange();
    setUiState(prev => ({ ...prev, gear: s.gear }));
  };

  const handleTouchLeft = (activate: boolean) => {
    stateRef.current.touchSteerLeft = activate;
    updateTouchSteerTarget();
  };

  const handleTouchRight = (activate: boolean) => {
    stateRef.current.touchSteerRight = activate;
    updateTouchSteerTarget();
  };

  const handleStartButton = () => {
    setUiState(prev => ({ ...prev, isFirstInteractionRequired: false }));
    audio.init();
  };

  return (
    <div 
      className="flex flex-col flex-1 relative w-full items-center justify-center p-2 sm:p-4 bg-slate-950 font-mono outline-none"
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
            <div className="text-xs font-mono font-bold uppercase tracking-[0.3em] text-red-500">SPEEDHQ OUTLET</div>
            <h2 className="text-4xl font-extrabold text-white uppercase italic mt-1 mb-4 select-none bg-gradient-to-r from-yellow-400 via-orange-500 to-red-500 bg-clip-text text-transparent">
              TURBO ARCADE
            </h2>
            
            <p className="text-sm text-slate-300 font-sans leading-relaxed mb-6">
              Welcome to the Ultimate SpeedHQ Retro Arcade Challenge. Shift gears, dodge high-speed traffic, and beat the clock around winding coasts and neon tunnels!
            </p>

            <div className="bg-slate-950/80 p-4 rounded-xl border border-slate-800 text-left font-sans mb-6">
              <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-900 pb-2 mb-2">
                <Compass className="w-4 h-4 text-cyan-500" />
                DIVERSE STEERING CONTROL SETTINGS:
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

      {/* Main HUD overlay panels */}
      <div className="w-full max-w-3xl flex items-center justify-between gap-2 px-4 py-2.5 bg-slate-950 border border-red-500/30 rounded-t-xl text-slate-400 text-sm font-display tracking-widest select-none neon-glow-red">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
          <span className="text-xs font-black text-red-500 neon-text-red">SPEEDHQ LOBBY</span>
        </div>
        
        <div className="text-center font-black text-yellow-500 flex items-center gap-1 animate-pulse neon-text-yellow">
          <Zap className="w-4 h-4 text-yellow-400 fill-yellow-400" />
          {uiState.stageName}
        </div>

        <div className="flex items-center gap-3">
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

      {/* Substantial Canvas Window */}
      <div className="relative w-full max-w-3xl aspect-[16/10] bg-slate-950 border-x border-cyan-500/30 overflow-hidden shadow-2xl neon-glow-cyan">
        <canvas
          id="retro-racing-canvas"
          ref={canvasRef}
          width={640}
          height={400}
          className="w-full h-full object-cover select-none cursor-default"
        />

        {/* 3.. 2.. 1.. GO Countdown */}
        {stateRef.current.isCountingDown && !uiState.isFirstInteractionRequired && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/40 backdrop-blur-[2px]">
            <div className="animate-ping text-8xl font-black font-mono text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-500 select-none">
              {uiState.countdownText}
            </div>
            <div className="text-xs text-yellow-500 tracking-[0.4em] font-mono font-bold mt-4 uppercase animate-pulse">
              GET READY TO STEER!
            </div>
          </div>
        )}

        {/* Transient Near-Miss Bonus score notification animation */}
        {uiState.nearMissScoreAlert > 0 && (
          <div className="absolute top-[40%] left-[50%] -translate-x-[50%] -translate-y-[50%] text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 font-mono font-extrabold text-4xl tracking-widest animate-bounce z-10 drop-shadow-[0_2px_10px_rgba(234,179,8,0.5)]">
            +{uiState.nearMissScoreAlert.toLocaleString()}
            <div className="text-[10px] text-center text-slate-100 uppercase tracking-[0.2em] mt-1 font-sans">
              NEAR MISS OVERTAKE!
            </div>
          </div>
        )}

        {/* Emergency low fuel alarm flash overlay */}
        {uiState.time <= 10 && uiState.time > 0 && (
          <div className="absolute inset-0 border-[6px] border-red-600/60 pointer-events-none animate-flash-border z-10 flex items-start justify-center pt-10">
            <div className="bg-red-950/90 border border-red-500 px-4 py-2 rounded-lg text-red-500 flex items-center gap-2 font-black text-xs uppercase tracking-widest animate-pulse shadow-lg">
              <ShieldAlert className="w-5 h-5 text-red-500" />
              CRITICAL TIME RUNNING LIMIT OUT!
            </div>
          </div>
        )}

        {/* On-screen Mobile fallback buttons (Touch & Accelerometer modes) */}
        {!stateRef.current.isCountingDown && !uiState.isFirstInteractionRequired && settings.steeringMode !== 'keyboard' && (
          <div className="absolute bottom-4 inset-x-4 flex justify-between items-end gap-12 pointer-events-none select-none z-10">
            {/* Left/Right turn touches (hidden if tilt mode, shown as fallback steering anchors) */}
            {settings.steeringMode === 'touch' ? (
              <div className="flex gap-3 pointer-events-auto">
                <button
                  id="virtual-steer-left-btn"
                  onTouchStart={() => handleTouchLeft(true)}
                  onTouchEnd={() => handleTouchLeft(false)}
                  onTouchCancel={() => handleTouchLeft(false)}
                  onMouseDown={() => handleTouchLeft(true)}
                  onMouseUp={() => handleTouchLeft(false)}
                  onMouseLeave={() => handleTouchLeft(false)}
                  className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900/80 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl transition-colors cursor-pointer outline-none select-none"
                >
                  ◀
                </button>
                <button
                  id="virtual-steer-right-btn"
                  onTouchStart={() => handleTouchRight(true)}
                  onTouchEnd={() => handleTouchRight(false)}
                  onTouchCancel={() => handleTouchRight(false)}
                  onMouseDown={() => handleTouchRight(true)}
                  onMouseUp={() => handleTouchRight(false)}
                  onMouseLeave={() => handleTouchRight(false)}
                  className="w-16 h-16 rounded-xl border border-slate-700 bg-slate-900/80 active:bg-cyan-600 text-white flex items-center justify-center font-bold text-2xl transition-colors cursor-pointer outline-none select-none"
                >
                  ▶
                </button>
              </div>
            ) : (
              /* Accelerometer Calibration diagnostic hub */
              <div className="pointer-events-auto bg-slate-900/80 border border-slate-800 rounded-xl px-3 py-1.5 flex flex-col text-[10px] text-slate-400 font-mono gap-1 select-none">
                <div className="flex items-center gap-1">
                  <Compass className="w-3.5 h-3.5 text-cyan-400" />
                  SENSORS: {Math.round(stateRef.current.tiltValue)}°
                </div>
                <div className="w-24 h-2.5 bg-slate-950 border border-slate-800 rounded relative overflow-hidden">
                  <div 
                    className="absolute top-0 bottom-0 w-2.5 bg-cyan-400 rounded-full transition-all"
                    style={{ left: `calc(50% - 5px + ${Math.min(Math.max(stateRef.current.steerInput * 100, -100), 100) * 0.5}%)` }}
                  />
                </div>
                <button
                  id="calibrate-sensor-btn"
                  onClick={calibrateTilt}
                  className="mt-1 px-1.5 py-0.5 border border-slate-700 bg-slate-950 text-[9px] font-bold text-center hover:bg-slate-800 text-slate-300 rounded cursor-pointer transition-all"
                >
                  CALIBRATE CENTER
                </button>
              </div>
            )}

            {/* Accelerator & Brake Pedals (Always shown in touch/tilt mode for mobile interactions) */}
            <div className="flex gap-4 pointer-events-auto select-none">
              <button
                id="virtual-brake-btn"
                onTouchStart={() => { stateRef.current.brakeInput = true; }}
                onTouchEnd={() => { stateRef.current.brakeInput = false; }}
                onTouchCancel={() => { stateRef.current.brakeInput = false; }}
                onMouseDown={() => { stateRef.current.brakeInput = true; }}
                onMouseUp={() => { stateRef.current.brakeInput = false; }}
                onMouseLeave={() => { stateRef.current.brakeInput = false; }}
                className="w-16 h-20 rounded-t-lg bg-orange-600 border-2 border-orange-500/30 text-white flex flex-col items-center justify-center transition-colors font-black text-xs shadow-lg active:bg-orange-500 cursor-pointer select-none"
              >
                <ArrowDown className="w-5 h-5 mb-1" />
                BRAKE
              </button>
              <button
                id="virtual-accel-btn"
                onTouchStart={() => { stateRef.current.accelInput = true; }}
                onTouchEnd={() => { stateRef.current.accelInput = false; }}
                onTouchCancel={() => { stateRef.current.accelInput = false; }}
                onMouseDown={() => { stateRef.current.accelInput = true; }}
                onMouseUp={() => { stateRef.current.accelInput = false; }}
                onMouseLeave={() => { stateRef.current.accelInput = false; }}
                className="w-16 h-24 rounded-t-lg bg-emerald-600 border-2 border-emerald-500/30 text-white flex flex-col items-center justify-center transition-colors font-black text-xs shadow-xl active:bg-emerald-500 cursor-pointer select-none"
              >
                <ArrowUp className="w-6 h-6 mb-1 text-emerald-200" />
                GAS
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Highly immersive Retro dashboard below the canvas */}
      <div className="w-full max-w-3xl grid grid-cols-12 gap-2 sm:gap-4 p-4 bg-slate-950 border border-red-500/30 rounded-b-xl select-none text-slate-200 font-mono neon-glow-red">
        
        {/* Left Dial: Speedometer */}
        <div className="col-span-4 flex flex-col items-center justify-center p-2 bg-slate-950 rounded-xl border border-slate-850 relative overflow-hidden group">
          <div className="text-[10px] text-slate-500 tracking-wider">SPEEDOMETER</div>
          <div className="flex items-baseline mt-1">
            <span className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500 group-hover:animate-pulse">
              {uiState.speed}
            </span>
            <span className="text-xs text-slate-500 ml-1">KM/H</span>
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
            onClick={toggleGear}
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
