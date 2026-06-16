/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PlayerSettings {
  steeringMode: 'tilt' | 'touch' | 'keyboard';
  tiltSensitivity: number;
  tiltDeadzone: number;
  lowPrecisionTilt: boolean;
  soundEnabled: boolean;
  musicEnabled: boolean;
}

export interface HighScore {
  name: string;
  score: number;
  date: string;
  speedAchieved: number;
  stageReached: number;
  difficulty: 'Novice' | 'Amateur' | 'Champion';
}

export interface RoadSegment {
  index: number;
  p1: { world: { x: number; y: number; z: number }; screen: { x: number; y: number; w: number } };
  p2: { world: { x: number; y: number; z: number }; screen: { x: number; y: number; w: number } };
  curve: number; // horizontal offset curve modifier
  hill: number;  // vertical offset slope modifier
  color: {
    road: string;
    grass: string;
    rumble: string;
    lane: string;
  };
  sprites: RoadSprite[];
  climate: 'cost' | 'tunnel' | 'city' | 'desert' | 'snow';
}

export interface SpriteType {
  id: string;
  width: number; // physical width
  height: number; // physical height
  sourceY: number; // reference height if drawn from canvas or drawn via custom path
  renderFn: (ctx: CanvasRenderingContext2D, width: number, height: number, frame: number) => void;
}

export interface RoadSprite {
  spriteType: string;
  offset: number; // -1 to 1 (left/right side of the road, or middle)
  scale: number;
}

export interface GameCar {
  offset: number;      // -1 to 1 across the road width
  z: number;           // world z position
  speed: number;       // speed of car (m/s equivalent)
  spriteType: 'blue' | 'yellow' | 'green' | 'ambulance' | 'truck';
  width: number;
  length: number;
  color: string;
  laneChangeTimer: number; // delay before shifting lane
  laneTarget: number;
  isPassing: boolean;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  alpha: number;
  life: number;
  size: number;
}

export interface ActiveScenery {
  name: string;
  climate: 'cost' | 'tunnel' | 'city' | 'desert' | 'snow';
  bgColor: string;
  accentColor: string;
  length: number; // length in road segments
}
