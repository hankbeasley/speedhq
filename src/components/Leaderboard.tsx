/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Trophy, Star, Play, RotateCcw, Flame } from 'lucide-react';
import { HighScore } from '../types';
import { kmhToMph } from '../lib/physics';

interface LeaderboardProps {
  currentScore?: number;
  speedAchieved?: number;
  stageReached?: number;
  difficulty?: 'Novice' | 'Amateur' | 'Champion';
  onRestart: () => void;
  onClose: () => void;
}

const STORAGE_KEY = 'speedhq_turbo_leaderboard';

const PRE_SEEDED_SCORES: HighScore[] = [
  { name: 'NEO', score: 984500, date: '2026-06-15', speedAchieved: 312, stageReached: 8, difficulty: 'Champion' },
  { name: 'HQ1', score: 825000, date: '2026-06-14', speedAchieved: 304, stageReached: 7, difficulty: 'Champion' },
  { name: 'DRV', score: 641200, date: '2026-06-12', speedAchieved: 295, stageReached: 5, difficulty: 'Amateur' },
  { name: 'BLZ', score: 489000, date: '2026-06-10', speedAchieved: 247, stageReached: 4, difficulty: 'Amateur' },
  { name: 'BOB', score: 250000, date: '2026-06-01', speedAchieved: 185, stageReached: 2, difficulty: 'Novice' },
];

export default function Leaderboard({
  currentScore = 0,
  speedAchieved = 0,
  stageReached = 1,
  difficulty = 'Amateur',
  onRestart,
  onClose,
}: LeaderboardProps) {
  const [highScores, setHighScores] = useState<HighScore[]>([]);
  const [initials, setInitials] = useState('');
  const [scoreRegistered, setScoreRegistered] = useState(false);
  const [isNewHighScore, setIsNewHighScore] = useState(false);

  useEffect(() => {
    // Load high scores
    const stored = localStorage.getItem(STORAGE_KEY);
    let scores: HighScore[] = [];
    if (stored) {
      try {
        scores = JSON.parse(stored);
      } catch (e) {
        scores = [...PRE_SEEDED_SCORES];
      }
    } else {
      scores = [...PRE_SEEDED_SCORES];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
    }
    
    // Sort descending
    scores.sort((a, b) => b.score - a.score);
    setHighScores(scores);

    // Check if player qualified for high scores (higher than the lowest, or list has space)
    if (currentScore > 0) {
      const isQualifying = scores.length < 5 || currentScore > scores[scores.length - 1].score;
      setIsNewHighScore(isQualifying);
    }
  }, [currentScore]);

  const handleSubmitScore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!initials || initials.trim().length === 0) return;

    const formattedInitials = initials.slice(0, 3).toUpperCase();
    const newEntry: HighScore = {
      name: formattedInitials,
      score: currentScore,
      date: new Date().toISOString().split('T')[0],
      speedAchieved,
      stageReached,
      difficulty,
    };

    const updated = [...highScores, newEntry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 7); // keep top 7

    setHighScores(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setScoreRegistered(true);
    setIsNewHighScore(false);
  };

  const handleResetScores = () => {
    if (confirm('Are you sure you want to reset all persistent high scores?')) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(PRE_SEEDED_SCORES));
      setHighScores(PRE_SEEDED_SCORES);
      setScoreRegistered(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center p-4 bg-slate-950/95 overflow-y-auto">
      <div className="w-full max-w-2xl border border-red-500/40 rounded-2xl bg-slate-950/80 p-6 md:p-8 relative shadow-2xl neon-glow-red backdrop-blur-md">
        
        {/* Glowing SpeedHQ Label */}
        <div className="flex flex-col items-center mb-6 text-center select-none font-display">
          <div className="text-xs font-mono font-bold uppercase tracking-[0.3em] text-red-500 animate-pulse">
            SpeedHQ.com Dashboard
          </div>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-500 to-red-500 mt-1 uppercase italic drop-shadow-[0_2px_10px_rgba(239,68,68,0.4)] neon-text-yellow">
            TURBO CHALLENGE
          </h1>
          <p className="text-xs font-mono text-slate-400 mt-2">
            ARCADE CABINET RECORD
          </p>
        </div>

        {/* If user scored a qualified record, prompt initials entry */}
        {isNewHighScore && !scoreRegistered ? (
          <div className="mb-8 p-6 border-2 border-dashed border-yellow-500/50 bg-yellow-950/20 rounded-xl text-center neon-glow-yellow">
            <Flame className="w-10 h-10 mx-auto text-yellow-500 animate-bounce mb-2" />
            <div className="text-lg font-bold font-display text-yellow-400 tracking-wider">NEW HIGH SCORE DETECTED!</div>
            <div className="text-3xl font-mono font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-yellow-300 my-2 neon-text-yellow">
              {currentScore.toLocaleString()} PTS
            </div>
            <p className="text-xs text-slate-300 font-sans max-w-md mx-auto mb-4">
              Qualifying with Rank #{highScores.findIndex(s => currentScore > s.score) + 1 || highScores.length + 1}! Enter your 3-character racer initials for the SpeedHQ halls of fame:
            </p>

            <form onSubmit={handleSubmitScore} className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <input
                id="racer-initials"
                type="text"
                maxLength={3}
                placeholder="NEO"
                value={initials}
                onChange={(e) => setInitials(e.target.value.slice(0, 3).toUpperCase())}
                className="w-28 px-4 py-3 text-center text-2xl font-mono rounded bg-slate-950 text-yellow-400 border border-yellow-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 tracking-[0.2em] font-extrabold uppercase placeholder-slate-700 neon-glow-yellow"
                autoFocus
              />
              <button
                id="submit-record-btn"
                type="submit"
                className="px-6 py-3 w-full sm:w-auto font-display text-sm font-bold bg-gradient-to-r from-yellow-500 to-orange-600 hover:from-yellow-400 hover:to-orange-500 text-slate-950 rounded cursor-pointer transition-all active:scale-95 shadow-[0_0_15px_rgba(234,179,8,0.3)]"
              >
                SAVE IN HALL OF FAME
              </button>
            </form>
          </div>
        ) : null}

        {/* High score list */}
        <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40 font-mono mb-6">
          <div className="grid grid-cols-12 gap-2 bg-slate-900 border-b border-slate-800 p-3 text-xs font-bold text-slate-400 uppercase tracking-wider">
            <div className="col-span-2 text-center">RANK</div>
            <div className="col-span-3">DRIVER</div>
            <div className="col-span-3 text-right">SCORE</div>
            <div className="col-span-2 text-center">STAGE</div>
            <div className="col-span-2 text-right">MAX MPH</div>
          </div>

          <div className="divide-y divide-slate-900">
            {highScores.map((entry, index) => {
              const isPlayerEntry = scoreRegistered && entry.score === currentScore && entry.name === initials.toUpperCase();
              return (
                <div 
                  key={index} 
                  className={`grid grid-cols-12 gap-2 p-3 items-center text-sm ${
                    isPlayerEntry 
                      ? 'bg-yellow-500/10 text-yellow-400 font-black border-l-4 border-yellow-500' 
                      : index === 0 
                      ? 'text-red-400 font-bold' 
                      : 'text-slate-200'
                  }`}
                >
                  <div className="col-span-2 text-center flex items-center justify-center">
                    {index === 0 ? (
                      <Trophy className="w-4 h-4 text-yellow-400" />
                    ) : index === 1 ? (
                      <Star className="w-4 h-4 text-slate-300" />
                    ) : (
                      <span className="text-xs text-slate-500 font-bold">{index + 1}</span>
                    )}
                  </div>
                  <div className="col-span-3 font-extrabold uppercase tracking-widest flex items-center gap-1">
                    {entry.name}
                    {isPlayerEntry && <span className="text-[10px] bg-yellow-500 text-slate-950 px-1 rounded scale-90">YOU</span>}
                  </div>
                  <div className="col-span-3 text-right font-bold text-yellow-500">
                    {entry.score.toLocaleString()}
                  </div>
                  <div className="col-span-2 text-center font-bold text-slate-300">
                    STAGE {entry.stageReached}
                  </div>
                  <div className="col-span-2 text-right text-xs text-slate-400 font-bold">
                    {Math.round(kmhToMph(entry.speedAchieved))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Buttons */}
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
          <button
            id="reset-leaderboard-btn"
            onClick={handleResetScores}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-500 hover:text-red-400 font-mono transition-colors border border-slate-800 hover:border-red-900 rounded cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            RESET CABINET RECORDS
          </button>

          <div className="flex gap-3 w-full sm:w-auto">
            {onClose && (
              <button
                id="close-leaderboard-btn"
                onClick={onClose}
                className="px-5 py-2.5 flex-1 sm:flex-initial font-mono text-sm border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded cursor-pointer transition-colors"
              >
                BACK TO HUB
              </button>
            )}
            <button
              id="restart-game-btn"
              onClick={onRestart}
              className="px-6 py-2.5 flex-1 sm:flex-initial font-mono text-sm font-bold bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer flex items-center justify-center gap-2 hover:shadow-[0_0_15px_rgba(239,68,68,0.4)] transition-all"
            >
              <Play className="w-4 h-4 fill-current" />
              RACE AGAIN
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
