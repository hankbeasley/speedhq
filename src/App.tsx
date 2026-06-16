/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import GameCanvas from './components/GameCanvas';
import Leaderboard from './components/Leaderboard';
import { PlayerSettings } from './types';
import { Sliders, Volume2, VolumeX, Phone, Keyboard, Sparkles, Navigation, Award, RotateCcw, Zap } from 'lucide-react';

export default function App() {
  const [gameState, setGameState] = useState<'lobby' | 'playing' | 'scores'>('lobby');
  
  // Player settings management
  const [settings, setSettings] = useState<PlayerSettings>({
    steeringMode: 'keyboard', // default keyboard
    tiltSensitivity: 1.0,
    tiltDeadzone: 4.5, // degrees
    lowPrecisionTilt: false,
    soundEnabled: true,
    musicEnabled: true,
  });

  // Score statistics passing to Leaderboard
  const [gameStats, setGameStats] = useState({
    score: 0,
    maxSpeed: 0,
    stageReached: 1,
    difficulty: 'Amateur' as 'Novice' | 'Amateur' | 'Champion'
  });

  const handleUpdateSettings = (updated: Partial<PlayerSettings>) => {
    setSettings(prev => ({ ...prev, ...updated }));
  };

  const handleGameOver = (finalScore: number, maxSpeed: number, stageReached: number) => {
    // Standard arcade difficulty based on stage cleared
    let diff: 'Novice' | 'Amateur' | 'Champion' = 'Amateur';
    if (stageReached <= 2) diff = 'Novice';
    else if (stageReached >= 4) diff = 'Champion';

    setGameStats({
      score: finalScore,
      maxSpeed,
      stageReached,
      difficulty: diff
    });
    setGameState('scores');
  };

  const handleStartGame = () => {
    setGameState('playing');
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between relative overflow-hidden font-mono selection:bg-red-500 selection:text-white">
      
      {/* Decorative Arcade Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none bg-scanlines z-30 opacity-[0.03]" />

      {/* Decorative Grid backdrop in Lobby */}
      {gameState === 'lobby' && (
        <div className="absolute inset-0 bg-cyber-grid opacity-10 pointer-events-none" />
      )}

      {/* Corporate SpeedHQ branding Header */}
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md px-6 py-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-orange-500 flex items-center justify-center font-black text-2xl italic tracking-tighter text-white shadow-lg shadow-red-900/20">
            S
          </div>
          <div>
            <div className="text-xl font-extrabold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-white to-slate-400 select-none">
              SPEED<span className="text-red-500">HQ</span>
            </div>
            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.25em] -mt-1 leading-none">
              Premium Arcade Systems
            </div>
          </div>
        </div>

        {gameState === 'playing' && (
          <button
            id="abort-race-btn"
            onClick={() => setGameState('lobby')}
            className="px-3.5 py-1.5 text-xs border border-slate-800 hover:border-red-900 bg-slate-900 hover:bg-red-950/20 text-slate-400 hover:text-red-400 rounded-lg cursor-pointer transition-colors"
          >
            ABORT RACE
          </button>
        )}

        {gameState === 'lobby' && (
          <button
            id="show-records-btn"
            onClick={() => setGameState('scores')}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold border border-yellow-500/30 hover:border-yellow-400/50 bg-yellow-950/20 text-yellow-400 rounded-lg cursor-pointer transition-all active:scale-95"
          >
            <Award className="w-4 h-4 fill-current text-yellow-500" />
            HALL OF FAME
          </button>
        )}
      </header>

      {/* Lobby panel */}
      {gameState === 'lobby' ? (
        <section className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 max-w-4xl mx-auto w-full z-10 my-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center w-full">
            
            {/* Left: Beautiful Neon Arcade Mockup Hero */}
            <div className="md:col-span-6 flex flex-col justify-center text-center md:text-left select-none">
              <div className="flex items-center gap-2 justify-center md:justify-start">
                <span className="text-xs bg-red-950 border border-red-500 text-red-500 font-bold px-2.5 py-0.5 rounded-full tracking-widest uppercase animate-pulse">
                  TURBO SEPARATION
                </span>
                <span className="text-xs font-mono text-slate-500">V1.4</span>
              </div>

              <h1 className="text-4xl md:text-6xl font-black italic uppercase tracking-tight text-white mt-4 leading-tight drop-shadow-lg font-display neon-text-red">
                80s retro <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500">
                  turbo racer
                </span>
              </h1>
              
              <p className="text-sm font-sans text-slate-400 mt-4 leading-relaxed max-w-md mx-auto md:mx-0">
                Put your hands on the steering wheel! SpeedHQ invites you to experiences inspired by legendary retro pseudo-3D raster engines. Leverage your phone's tilt sensors for full tactile steering feedback.
              </p>

              <div className="mt-8 flex justify-center md:justify-start">
                <button
                  id="lobby-start-race-btn"
                  onClick={handleStartGame}
                  className="px-8 py-4 font-display font-extrabold tracking-widest text-lg bg-gradient-to-r from-red-600 via-orange-500 to-yellow-500 hover:from-red-500 hover:to-yellow-400 text-white rounded-xl cursor-pointer shadow-red-950/50 transition-all hover:scale-105 active:scale-95 neon-glow-red hover:shadow-[0_0_25px_rgba(239,68,68,0.6)] animate-pulse"
                >
                  START RACE NOW
                </button>
              </div>
            </div>

            {/* Right: Rich Settings customizer */}
            <div className="md:col-span-6 border border-slate-800/80 hover:border-red-500/50 rounded-2xl bg-slate-950/60 backdrop-blur-md p-6 relative transition-all duration-300 hover:shadow-[0_0_20px_rgba(239,68,68,0.15)] glow-panel-r">
              <div className="absolute top-0 right-6 -translate-y-1/2 px-3 py-1 bg-slate-950 border border-slate-800 text-slate-500 text-[9px] uppercase tracking-widest font-black rounded-full">
                Dashboard setup
              </div>
              
              <div className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-6 border-b border-slate-800 pb-3 font-display">
                <Sliders className="w-4 h-4 text-red-500" />
                CONTROLLER PREFERENCES
              </div>

              <div className="space-y-6 font-sans">
                {/* Steering select */}
                <div>
                  <label className="block text-sm font-bold text-slate-200 mb-2 font-mono uppercase tracking-widest text-xs">
                    STEERING MODE
                  </label>
                  <div className="grid grid-cols-2 gap-3 font-mono">
                    <button
                      id="mode-tilt-btn"
                      onClick={() => handleUpdateSettings({ steeringMode: 'tilt' })}
                      className={`px-4 py-3 border text-xs rounded-xl flex flex-col items-center gap-1.5 cursor-pointer transition-all ${
                        settings.steeringMode === 'tilt'
                          ? 'border-red-500 bg-red-950/20 text-red-400 font-bold shadow-lg shadow-red-950/20'
                          : 'border-slate-800 bg-slate-950 hover:bg-slate-900 text-slate-400'
                      }`}
                    >
                      <Phone className="w-5 h-5 shrink-0" />
                      PHONE GYRO / TILT
                    </button>

                    <button
                      id="mode-keyboard-btn"
                      onClick={() => handleUpdateSettings({ steeringMode: 'keyboard' })}
                      className={`px-4 py-3 border text-xs rounded-xl flex flex-col items-center gap-1.5 cursor-pointer transition-all ${
                        settings.steeringMode === 'keyboard'
                          ? 'border-red-500 bg-red-950/20 text-red-400 font-bold shadow-lg shadow-red-950/20'
                          : 'border-slate-800 bg-slate-950 hover:bg-slate-900 text-slate-400'
                      }`}
                    >
                      <Keyboard className="w-5 h-5 shrink-0" />
                      KEYBOARD / PADS
                    </button>
                  </div>
                </div>

                {/* Tilt sliders */}
                {settings.steeringMode === 'tilt' && (
                  <div className="space-y-4 pt-1 font-mono">
                    <div>
                      <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5 font-bold uppercase tracking-widest">
                        <span>GYRO SENSITIVITY:</span>
                        <span className="text-red-400">{settings.tiltSensitivity.toFixed(1)}x</span>
                      </div>
                      <input
                        id="tilt-sensitivity-slider"
                        type="range"
                        min="0.5"
                        max="2.5"
                        step="0.1"
                        value={settings.tiltSensitivity}
                        onChange={(e) => handleUpdateSettings({ tiltSensitivity: parseFloat(e.target.value) })}
                        className="w-full accent-red-500 h-1 bg-slate-950 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5 font-bold uppercase tracking-widest">
                        <span>SENSOR DEADZONE:</span>
                        <span className="text-red-400">{settings.tiltDeadzone.toFixed(1)}°</span>
                      </div>
                      <input
                        id="tilt-deadzone-slider"
                        type="range"
                        min="2.0"
                        max="8.0"
                        step="0.5"
                        value={settings.tiltDeadzone}
                        onChange={(e) => handleUpdateSettings({ tiltDeadzone: parseFloat(e.target.value) })}
                        className="w-full accent-red-500 h-1 bg-slate-950 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  </div>
                )}

                {/* Sound settings */}
                <div className="border-t border-slate-850 pt-4 flex items-center justify-between font-mono text-xs">
                  <span className="text-slate-400 font-bold uppercase tracking-wider">SYNTHESIZED AUDIO:</span>
                  <div className="flex items-center gap-3">
                    <button
                      id="toggle-music-setting-btn"
                      onClick={() => handleUpdateSettings({ musicEnabled: !settings.musicEnabled })}
                      className={`px-3 py-1.5 border text-[10px] uppercase font-bold rounded-lg cursor-pointer transition-colors ${
                        settings.musicEnabled ? 'border-emerald-500/30 text-emerald-400 bg-emerald-950/20' : 'border-slate-800 text-slate-500 bg-slate-950'
                      }`}
                    >
                      BGM BEAT {settings.musicEnabled ? 'ON' : 'OFF'}
                    </button>

                    <button
                      id="toggle-sound-setting-btn"
                      onClick={() => handleUpdateSettings({ soundEnabled: !settings.soundEnabled })}
                      className={`px-3 py-1.5 border text-[10px] uppercase font-bold rounded-lg cursor-pointer transition-colors ${
                        settings.soundEnabled ? 'border-emerald-500/30 text-emerald-400 bg-emerald-950/20' : 'border-slate-800 text-slate-500 bg-slate-950'
                      }`}
                    >
                      FX SOUNDS {settings.soundEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>

              </div>
            </div>

          </div>
        </section>
      ) : null}

      {/* Game canvas renderer views */}
      {gameState === 'playing' ? (
        <div className="flex-1 flex flex-col justify-center items-center py-4 w-full h-full relative z-10 bg-slate-950">
          <GameCanvas
            settings={settings}
            updateSettings={handleUpdateSettings}
            onGameOver={handleGameOver}
          />
        </div>
      ) : null}

      {/* Leaderboard screen */}
      {gameState === 'scores' ? (
        <Leaderboard
          currentScore={gameStats.score}
          speedAchieved={gameStats.maxSpeed}
          stageReached={gameStats.stageReached}
          difficulty={gameStats.difficulty}
          onRestart={() => setGameState('playing')}
          onClose={() => setGameState('lobby')}
        />
      ) : null}

      {/* Footer / Arcade branding credit stamp */}
      <footer className="border-t border-slate-900 bg-slate-950/60 p-4 text-center text-[10px] text-slate-600 select-none font-mono tracking-widest uppercase flex flex-col sm:flex-row items-center justify-between px-8 gap-4">
        <div>
          © 2026 SPEEDHQ RACING SOLUTIONS INC. ORIGINAL CABINET HARDWARE.
        </div>
        <div className="flex items-center gap-2">
          <span>HOST: SPEEDHQ.COM</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
        </div>
      </footer>

    </main>
  );
}
