/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterVolume: GainNode | null = null;
  private musicVolume: GainNode | null = null;
  private fxVolume: GainNode | null = null;

  // Engine Synthesizer Components
  private engineOscillator1: OscillatorNode | null = null;
  private engineOscillator2: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  
  // Sequence variables for procedural synth music
  private musicIntervalId: number | null = null;
  private sequencerStep = 0;

  // State
  private soundEnabled = true;
  private musicEnabled = true;
  private isInitialized = false;

  constructor() {
    // Lazy-init web audio to bypass browser autoplay policies
  }

  public init() {
    if (this.isInitialized) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      
      this.masterVolume = this.ctx.createGain();
      this.masterVolume.gain.setValueAtTime(0.5, this.ctx.currentTime);
      this.masterVolume.connect(this.ctx.destination);

      this.musicVolume = this.ctx.createGain();
      this.musicVolume.gain.setValueAtTime(0.25, this.ctx.currentTime);
      this.musicVolume.connect(this.masterVolume);

      this.fxVolume = this.ctx.createGain();
      this.fxVolume.gain.setValueAtTime(0.6, this.ctx.currentTime);
      this.fxVolume.connect(this.masterVolume);

      this.startEngineSynth();
      this.startAmbientMusic();
      
      this.isInitialized = true;
      this.setSoundsEnabled(this.soundEnabled);
      this.setMusicEnabled(this.musicEnabled);
    } catch (e) {
      console.warn("Web Audio is not supported in this frame", e);
    }
  }

  public setSoundsEnabled(enabled: boolean) {
    this.soundEnabled = enabled;
    if (this.masterVolume && this.ctx) {
      this.masterVolume.gain.setValueAtTime(enabled ? 0.4 : 0, this.ctx.currentTime);
    }
  }

  public setMusicEnabled(enabled: boolean) {
    this.musicEnabled = enabled;
    if (this.musicVolume && this.ctx) {
      this.musicVolume.gain.setValueAtTime(enabled ? 0.25 : 0, this.ctx.currentTime);
    }
  }

  private startEngineSynth() {
    if (!this.ctx || !this.fxVolume) return;

    try {
      // We will model the engine by combining two sawtooth/triangle oscillators passing through a resonant lowpass filter
      this.engineOscillator1 = this.ctx.createOscillator();
      this.engineOscillator2 = this.ctx.createOscillator();
      this.engineGain = this.ctx.createGain();
      this.engineFilter = this.ctx.createBiquadFilter();

      this.engineOscillator1.type = 'sawtooth';
      this.engineOscillator2.type = 'triangle';

      // Deep rumble values
      this.engineOscillator1.frequency.setValueAtTime(45, this.ctx.currentTime);
      this.engineOscillator2.frequency.setValueAtTime(45.5, this.ctx.currentTime); // slightly detuned for detune fatness

      this.engineGain.gain.setValueAtTime(0.08, this.ctx.currentTime);

      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.setValueAtTime(140, this.ctx.currentTime);
      this.engineFilter.Q.setValueAtTime(5, this.ctx.currentTime);

      // Connect nodes
      this.engineOscillator1.connect(this.engineFilter);
      this.engineOscillator2.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.fxVolume);

      this.engineOscillator1.start();
      this.engineOscillator2.start();
    } catch (err) {
      console.warn("Unable to start engine synthesizer", err);
    }
  }

  /**
   * Modulate engine sound pitch based on speed, gear, and rev RPMs
   * @param speed km/h (0 to 320)
   * @param gear 'LOW' | 'HIGH'
   * @param rpm 0 to 1 value representing engine revs (simulated)
   */
  public setEngineSound(speed: number, gear: 'LOW' | 'HIGH', rpm: number) {
    if (!this.isInitialized || !this.ctx || !this.engineOscillator1 || !this.engineOscillator2 || !this.engineFilter) {
      return;
    }

    try {
      // In LOW gear: speed 0-120 maps to engine frequency 45Hz to 160Hz
      // In HIGH gear: speed 80-320 maps to engine frequency 60Hz to 190Hz
      let baseFreq = 40;
      if (gear === 'LOW') {
        const speedRatio = Math.min(speed / 130, 1.0);
        baseFreq = 42 + speedRatio * 110 + rpm * 15;
      } else {
        const speedRatio = Math.min(Math.max((speed - 80) / 240, 0), 1.0);
        baseFreq = 50 + speedRatio * 125 + rpm * 10;
      }

      const t = this.ctx.currentTime;
      this.engineOscillator1.frequency.setTargetAtTime(baseFreq, t, 0.05);
      this.engineOscillator2.frequency.setTargetAtTime(baseFreq * 1.015, t, 0.05);

      // Dynamically raise filter cutoff as engine gains RPMs to make it sound brighter and louder
      const filterCutoff = Math.min(130 + baseFreq * 2.2, 1000);
      this.engineFilter.frequency.setTargetAtTime(filterCutoff, t, 0.05);

      // When decelerating or idling, soften the engine noise
      const volumeLevel = 0.04 + (Math.min(speed / 320, 1.0) * 0.05) + (rpm * 0.02);
      if (this.engineGain) {
        this.engineGain.gain.setTargetAtTime(this.soundEnabled ? volumeLevel : 0, t, 0.08);
      }
    } catch (err) {
      // Suppress errors during high-frequency updates
    }
  }

  public playCrash() {
    if (!this.isInitialized || !this.ctx || !this.fxVolume || !this.soundEnabled) return;

    try {
      const now = this.ctx.currentTime;

      // 1. Create White Noise Buffer for crunch
      const bufferSize = this.ctx.sampleRate * 0.8; // 0.8 seconds
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noiseNode = this.ctx.createBufferSource();
      noiseNode.buffer = buffer;

      const noiseFilter = this.ctx.createBiquadFilter();
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(350, now);
      noiseFilter.frequency.exponentialRampToValueAtTime(30, now + 0.7);

      const noiseGain = this.ctx.createGain();
      noiseGain.gain.setValueAtTime(0.4, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

      noiseNode.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.fxVolume);
      noiseNode.start(now);

      // 2. Heavy boom layer using low square wave
      const boomNode = this.ctx.createOscillator();
      boomNode.type = 'triangle';
      boomNode.frequency.setValueAtTime(100, now);
      boomNode.frequency.exponentialRampToValueAtTime(20, now + 0.5);

      const boomGain = this.ctx.createGain();
      boomGain.gain.setValueAtTime(0.5, now);
      boomGain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);

      boomNode.connect(boomGain);
      boomGain.connect(this.fxVolume);
      boomNode.start(now);
      boomNode.stop(now + 0.61);
    } catch (e) {
      console.warn("Crash audio play failed", e);
    }
  }

  public playScreech(intensity = 1.0) {
    if (!this.isInitialized || !this.ctx || !this.fxVolume || !this.soundEnabled) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();

      osc.type = 'triangle';
      // Retro tire sound is high pitch, modulated slightly
      const baseFreq = 850 + Math.random() * 80;
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.setTargetAtTime(baseFreq - 150, now, 0.1);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1200, now);

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.12 * intensity, now + 0.05);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(this.fxVolume);

      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {}
  }

  public playGearChange() {
    if (!this.isInitialized || !this.ctx || !this.fxVolume || !this.soundEnabled) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.08);

      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.09);

      osc.connect(gainNode);
      gainNode.connect(this.fxVolume);

      osc.start(now);
      osc.stop(now + 0.1);
    } catch (e) {}
  }

  public playScoreBeep() {
    if (!this.isInitialized || !this.ctx || !this.fxVolume || !this.soundEnabled) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1100, now);

      gainNode.gain.setValueAtTime(0.08, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

      osc.connect(gainNode);
      gainNode.connect(this.fxVolume);

      osc.start(now);
      osc.stop(now + 0.06);
    } catch (e) {}
  }

  public playChime() {
    if (!this.isInitialized || !this.ctx || !this.fxVolume || !this.soundEnabled) return;

    try {
      const now = this.ctx.currentTime;
      
      // Retro chime: minor/major triad or arpeggio
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = this.ctx!.createOscillator();
        const gainNode = this.ctx!.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.08);

        gainNode.gain.setValueAtTime(0, now + idx * 0.08);
        gainNode.gain.linearRampToValueAtTime(0.15, now + idx * 0.08 + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.3);

        osc.connect(gainNode);
        gainNode.connect(this.fxVolume!);
        
        osc.start(now + idx * 0.08);
        osc.stop(now + idx * 0.08 + 0.35);
      });
    } catch (e) {}
  }

  /**
   * Starts a dynamic synthesized neon synthwave background loop
   */
  private startAmbientMusic() {
    if (!this.ctx || !this.musicVolume) return;

    // Tempo: 125 BPM
    const stepDuration = 60 / 125 / 2; // eighth notes = ~0.24 seconds

    // Simulating simple synthwave tracks: progressive bassline + hi-hat + melodic stab
    // Steps (16-step grid)
    const bassline = [
      110, 110, 110, 110, 
      130, 130, 130, 130, 
      146.8, 146.8, 146.8, 146.8, 
      98, 98, 98, 98
    ]; // A2, C3, D3, G2
    
    const leadNotes = [
      440, 0, 493.88, 523.25,
      0, 587.33, 0, 659.25,
      0, 659.25, 587.33, 523.25,
      493.88, 0, 440, 0
    ]; // A Melody

    this.musicIntervalId = window.setInterval(() => {
      if (!this.musicEnabled || !this.ctx || this.ctx.state === 'suspended') {
        return;
      }

      try {
        const now = this.ctx.currentTime;
        const step = this.sequencerStep % 16;
        const octaveGroup = Math.floor(this.sequencerStep / 16) % 4; // change melody progression

        // Play rolling bass synth (classic 80s arcade pulse)
        const bassOsc = this.ctx.createOscillator();
        const bassGain = this.ctx.createGain();
        bassOsc.type = 'sawtooth';
        
        // Dynamic octave jumping for authentic synth tick-tock
        const octaveMultiplier = (step % 2 === 0) ? 0.5 : 1.0;
        const rootFreq = bassline[step];
        bassOsc.frequency.setValueAtTime(rootFreq * octaveMultiplier, now);

        bassGain.gain.setValueAtTime(0.12, now);
        bassGain.gain.exponentialRampToValueAtTime(0.01, now + stepDuration * 0.9);

        // Filter out harsh highs for smooth bass
        const bassFilter = this.ctx.createBiquadFilter();
        bassFilter.type = 'lowpass';
        bassFilter.frequency.setValueAtTime(350, now);

        bassOsc.connect(bassFilter);
        bassFilter.connect(bassGain);
        bassGain.connect(this.musicVolume!);

        bassOsc.start(now);
        bassOsc.stop(now + stepDuration);

        // Melodic stabs on certain bars!
        const melodyNote = leadNotes[(step + octaveGroup * 4) % 16];
        if (melodyNote > 0 && Math.random() < 0.7) {
          const leadOsc = this.ctx.createOscillator();
          const leadGain = this.ctx.createGain();
          const leadFilter = this.ctx.createBiquadFilter();

          leadOsc.type = 'triangle';
          leadOsc.frequency.setValueAtTime(melodyNote, now);

          leadFilter.type = 'bandpass';
          leadFilter.frequency.setValueAtTime(800 + Math.sin(now)*200, now);

          leadGain.gain.setValueAtTime(0, now);
          leadGain.gain.linearRampToValueAtTime(0.08, now + 0.02);
          leadGain.gain.exponentialRampToValueAtTime(0.001, now + stepDuration * 1.5);

          leadOsc.connect(leadFilter);
          leadFilter.connect(leadGain);
          leadGain.connect(this.musicVolume!);

          leadOsc.start(now);
          leadOsc.stop(now + stepDuration * 1.8);
        }

        // Simulating electronic woodblock/snare rimshot on steps 4, 8, 12
        if (step % 4 === 2) {
          const snareOsc = this.ctx.createOscillator();
          const snareGain = this.ctx.createGain();
          snareOsc.type = 'triangle';
          snareOsc.frequency.setValueAtTime(320, now);
          snareOsc.frequency.exponentialRampToValueAtTime(100, now + 0.08);

          snareGain.gain.setValueAtTime(0.05, now);
          snareGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

          snareOsc.connect(snareGain);
          snareGain.connect(this.musicVolume!);

          snareOsc.start(now);
          snareOsc.stop(now + 0.1);
        }

        this.sequencerStep++;
      } catch (err) {}
    }, stepDuration * 1000);
  }

  public stopAmbientMusic() {
    if (this.musicIntervalId) {
      clearInterval(this.musicIntervalId);
      this.musicIntervalId = null;
    }
  }

  /**
   * Resumes Web Audio context if suspended by browser auto-play block.
   */
  public resumeContext() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
}

// Export singleton instance
export const audio = new AudioEngine();
