/**
 * OscVoice - Simple oscillator-based voice for fallback and basic synthesis
 * Provides basic waveform synthesis with ADSR envelope and basic filtering
 */

export class OscVoice {
    constructor(ctx, output, adsrParams = null, filterParams = null) {
        this.ctx = ctx;
        this.output = output;
        
        // Store custom ADSR params for later use
        this.customAdsrParams = adsrParams;
        this.customFilterParams = filterParams;
        
        this.voiceId = null;
        this.trackId = 0;
        
        // Audio nodes
        this.oscillator = null;
        this.envelope = null;
        this.filter = null;
        this.gainNode = null;
        this.panNode = null;
        
        // State
        this.isPlaying = false;
        this.isReleased = false;
        this.startTime = 0;
        this.releaseTime = 0;
        
        // Callbacks
        this.onEnded = null;
        
        // Oscillator settings
        this.waveform = 'sine'; // sine, square, sawtooth, triangle
        this.baseFrequency = 440;
        this.detuneAmount = 0;
        
        // ADSR parameters
        this.attackTime = 0.01;
        this.decayTime = 0.1;
        this.sustainLevel = 0.7;
        this.releaseTimeValue = 0.2;
        
        // Filter parameters
        this.filterEnabled = false;
        this.filterType = 'lowpass';
        this.filterFreq = 20000;
        this.filterQ = 1;
        
        // Pan and volume
        this.pan = 0;
        this.volume = 1.0;
        
        // Additional synthesis parameters
        this.modulationIndex = 0;
        this.tremoloDepth = 0;
        this.tremoloRate = 0;
        
        // LFO for pitch modulation
        this.lfoOscillator = null;
        this.lfoGain = null;
        
        console.log(`[DEBUG] OscVoice.constructor: filterParams=`, filterParams);
    }

    /**
     * Start playing an oscillator tone
     * @param {Object} params - Synthesis parameters
     * @param {number} midi - MIDI note number
     * @param {number} velocity - MIDI velocity (0-127)
     * @param {number} duration - Optional duration in seconds
     */
    async start(params = {}, midi, velocity, duration) {
        if (this.isPlaying) {
            this.stop();
        }

        // Apply parameters
        this.applyParameters(params, midi, velocity);
        
        try {
            // Create audio nodes
            this.createAudioNodes();
            
            // Connect nodes
            this.connectNodes();
            
            // Calculate and start envelope
            const targetGain = this.calculateGain(velocity);
            this.startEnvelope(targetGain, duration);
            
            // Start oscillator
            const now = this.ctx.currentTime;
            this.oscillator.frequency.setValueAtTime(this.baseFrequency, now);
            this.oscillator.detune.value = this.detuneAmount;
            this.oscillator.start(now);
            
            // Start LFO if configured
            if (this.tremoloRate > 0 || this.modulationIndex > 0) {
                this.startLFO(now);
            }
            
            // Set up stop time if duration specified
            if (duration) {
                this.oscillator.stop(now + duration + this.releaseTimeValue + 0.1);
                this.releaseTime = now + duration;
            } else {
                // For indefinite notes, we'll stop when release() is called
                this.oscillator.onended = () => {
                    this.isPlaying = false;
                    if (this.onEnded) {
                        this.onEnded();
                    }
                };
            }
            
            this.startTime = now;
            this.isPlaying = true;
            this.isReleased = false;
            
            console.log(`[DEBUG] OscVoice.start: waveform=${this.waveform} freq=${this.baseFrequency.toFixed(2)}Hz`);
        } catch (e) {
            console.error("OscVoice.start: Error during playback:", e);
        }
    }

    /**
     * Apply synthesis parameters
     */
    applyParameters(params, midi, velocity) {
        // Waveform
        this.waveform = params.waveform || 'sine';
        
        // Frequency from MIDI note
        if (params.frequency) {
            this.baseFrequency = params.frequency;
        } else {
            this.baseFrequency = this.midiToFreq(midi);
        }
        
        // Detune
        this.detuneAmount = params.detune || 0;
        
        // ADSR envelope - use custom params first, then params, then defaults
        this.attackTime = this.customAdsrParams?.attack ?? params.attack ?? 0.01;
        this.decayTime = this.customAdsrParams?.decay ?? params.decay ?? 0.1;
        this.sustainLevel = this.customAdsrParams?.sustain ?? (params.sustain !== undefined ? params.sustain / 100 : 0.7);
        this.releaseTimeValue = this.customAdsrParams?.release ?? params.release ?? 0.2;
        
        // Filter - use custom filter params as fallback
        if (this.customFilterParams) {
            this.filterEnabled = true;
            this.filterType = this.customFilterParams.type || 'lowpass';
            this.filterFreq = this.customFilterParams.frequency || 20000;
            this.filterQ = this.customFilterParams.resonance || 1;
            console.log(`[DEBUG] OscVoice: Using global filter - type=${this.filterType}, freq=${this.filterFreq}, Q=${this.filterQ}`);
        }
        
        // Override with params if provided
        if (params.filterEnabled !== undefined) {
            this.filterEnabled = params.filterEnabled;
        }
        if (params.filterType) {
            this.filterType = params.filterType;
        }
        if (params.filterFreq !== undefined) {
            this.filterFreq = params.filterFreq;
        }
        if (params.filterQ !== undefined) {
            this.filterQ = params.filterQ;
        }
        
        // Pan
        if (params.pan !== undefined) {
            this.pan = params.pan;
            if (this.panNode) {
                this.panNode.pan.value = this.pan / 100;
            }
        }
        
        // Volume
        if (params.volume !== undefined) {
            this.volume = params.volume;
        }
        
        // Modulation
        this.modulationIndex = params.modulationIndex || 0;
        this.tremoloDepth = params.tremoloDepth || 0;
        this.tremoloRate = params.tremoloRate || 0;
        
        // LFO frequency for pitch modulation
        this.lfoFrequency = params.lfoFrequency || 5;
        this.lfoDepth = params.lfoDepth || 0;
    }

    /**
     * Create audio nodes
     */
    createAudioNodes() {
        // Main oscillator
        this.oscillator = this.ctx.createOscillator();
        this.oscillator.type = this.waveform;
        
        // Gain node for envelope and volume
        this.gainNode = this.ctx.createGain();
        
        // Pan node for stereo
        this.panNode = this.ctx.createStereoPanner();
        this.panNode.pan.value = this.pan / 100;
        
        // Filter (optional)
        if (this.filterEnabled) {
            this.filter = this.ctx.createBiquadFilter();
            this.filter.type = this.filterType;
            this.filter.frequency.value = this.filterFreq;
            this.filter.Q.value = this.filterQ;
            console.log(`[DEBUG] OscVoice.createAudioNodes: filter created - type=${this.filterType}, freq=${this.filterFreq}, Q=${this.filterQ}`);
        }
    }

    /**
     * Connect audio nodes
     */
    connectNodes() {
        // Main chain: Osc -> Filter (optional) -> Gain -> Pan -> Output
        console.log(`[DEBUG] OscVoice.connectNodes: output node type=${this.output?.constructor?.name || 'null'}`);
        
        if (this.filterEnabled) {
            this.oscillator.connect(this.filter);
            this.filter.connect(this.gainNode);
        } else {
            this.oscillator.connect(this.gainNode);
        }
        
        this.gainNode.connect(this.panNode);
        this.panNode.connect(this.output);
        
        console.log(`[DEBUG] OscVoice: audio graph connected successfully`);
    }

    /**
     * Start LFO for modulation
     */
    startLFO(now) {
        // Create LFO oscillator
        this.lfoOscillator = this.ctx.createOscillator();
        this.lfoOscillator.type = 'sine';
        this.lfoOscillator.frequency.value = this.tremoloRate || this.lfoFrequency || 5;
        
        // LFO gain for depth control
        this.lfoGain = this.ctx.createGain();
        this.lfoGain.gain.value = this.tremoloDepth || this.lfoDepth || 10;
        
        // Connect LFO to gain (tremolo)
        if (this.tremoloDepth > 0) {
            this.lfoOscillator.connect(this.lfoGain);
            this.lfoGain.connect(this.gainNode.gain);
        }
        
        // Connect LFO to pitch (vibrato)
        if (this.lfoDepth > 0) {
            const vibratoGain = this.ctx.createGain();
            vibratoGain.gain.value = this.lfoDepth;
            this.lfoOscillator.connect(vibratoGain);
            vibratoGain.connect(this.oscillator.detune);
        }
        
        this.lfoOscillator.start(now);
    }

    /**
     * Calculate gain based on velocity and volume
     */
    calculateGain(velocity) {
        const velGain = velocity / 127;
        return velGain * this.volume;
    }

    /**
     * Start ADSR envelope
     */
    startEnvelope(targetGain, duration) {
        const now = this.ctx.currentTime;
        
        // Attack: fade in from 0 to target
        this.gainNode.gain.setValueAtTime(0, now);
        this.gainNode.gain.linearRampToValueAtTime(targetGain, now + this.attackTime);
        
        // Decay: fade to sustain level
        const decayEnd = now + this.attackTime + this.decayTime;
        this.gainNode.gain.linearRampToValueAtTime(
            targetGain * this.sustainLevel,
            decayEnd
        );
        
        // Sustain: hold at sustain level
        this.gainNode.gain.setValueAtTime(
            targetGain * this.sustainLevel,
            decayEnd
        );
        
        // Calculate release start
        if (duration) {
            const releaseStart = now + duration - this.releaseTimeValue;
            this.gainNode.gain.setValueAtTime(
                targetGain * this.sustainLevel,
                releaseStart
            );
            this.gainNode.gain.linearRampToValueAtTime(0, releaseStart + this.releaseTimeValue);
            this.releaseTime = releaseStart + this.releaseTimeValue;
        } else {
            this.releaseTime = decayEnd + 0.1;
        }
    }

    /**
     * Release the voice (note off)
     */
    release() {
        if (!this.isPlaying || this.isReleased) return;
        
        const now = this.ctx.currentTime;
        
        if (now < this.releaseTime) {
            const currentGain = this.gainNode.gain.value;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(currentGain, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + this.releaseTimeValue);
            
            // Schedule oscillator stop
            if (this.oscillator) {
                this.oscillator.stop(now + this.releaseTimeValue + 0.05);
            }
        }
        
        this.isReleased = true;
    }

    /**
     * Stop the voice immediately
     */
    stop() {
        if (this.oscillator) {
            try {
                this.oscillator.stop(0);
            } catch (e) {
                // Already stopped
            }
            this.oscillator.disconnect();
            this.oscillator = null;
        }
        
        if (this.lfoOscillator) {
            try {
                this.lfoOscillator.stop(0);
            } catch (e) {
                // Already stopped
            }
            this.lfoOscillator.disconnect();
            this.lfoOscillator = null;
        }
        
        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        
        if (this.filter) {
            this.filter.disconnect();
            this.filter = null;
        }
        
        if (this.panNode) {
            this.panNode.disconnect();
            this.panNode = null;
        }
        
        this.isPlaying = false;
        this.isReleased = true;
    }

    /**
     * Update parameters at runtime
     */
    setFrequency(freq) {
        this.baseFrequency = freq;
        if (this.oscillator && this.ctx.state === 'running') {
            this.oscillator.frequency.setValueAtTime(freq, this.ctx.currentTime);
        }
    }

    /**
     * Update filter frequency at runtime
     */
    setFilterFrequency(freq) {
        this.filterFreq = freq;
        if (this.filter && this.filterEnabled) {
            this.filter.frequency.setValueAtTime(freq, this.ctx.currentTime);
        }
    }

    /**
     * Update filter Q at runtime
     */
    setFilterQ(q) {
        this.filterQ = q;
        if (this.filter && this.filterEnabled) {
            this.filter.Q.setValueAtTime(q, this.ctx.currentTime);
        }
    }

    /**
     * Update waveform at runtime
     */
    setWaveform(type) {
        this.waveform = type;
        if (this.oscillator) {
            this.oscillator.type = type;
        }
    }

    /**
     * Update pan at runtime
     */
    setPan(pan) {
        this.pan = pan;
        if (this.panNode) {
            this.panNode.pan.setValueAtTime(pan / 100, this.ctx.currentTime);
        }
    }

    /**
     * Update volume at runtime
     */
    setVolume(volume) {
        this.volume = volume;
    }

    /**
     * Update detune at runtime
     */
    setDetune(detune) {
        this.detuneAmount = detune;
        if (this.oscillator) {
            this.oscillator.detune.setValueAtTime(detune, this.ctx.currentTime);
        }
    }

    /**
     * Convert MIDI note to frequency
     */
    midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }

    /**
     * Get current state
     */
    getState() {
        return {
            isPlaying: this.isPlaying,
            isReleased: this.isReleased,
            waveform: this.waveform,
            frequency: this.baseFrequency,
            detune: this.detuneAmount,
            filterFreq: this.filterFreq,
            filterQ: this.filterQ,
            pan: this.pan,
            volume: this.volume,
            attack: this.attackTime,
            decay: this.decayTime,
            sustain: this.sustainLevel * 100,
            release: this.releaseTimeValue
        };
    }
}

/**
 * Built-in preset definitions for OscVoice
 * Simple synthesis patches for fallback use
 */
export const OscillatorPresets = {
    // Basic waveforms
    'Sine': { waveform: 'sine', attack: 0.01, decay: 0.1, sustain: 70, release: 0.2 },
    'Square': { waveform: 'square', attack: 0.01, decay: 0.1, sustain: 60, release: 0.2 },
    'Sawtooth': { waveform: 'sawtooth', attack: 0.01, decay: 0.1, sustain: 70, release: 0.2 },
    'Triangle': { waveform: 'triangle', attack: 0.01, decay: 0.1, sustain: 70, release: 0.2 },
    
    // Classic synth sounds
    'Synth Lead': { 
        waveform: 'sawtooth', 
        attack: 0.05, 
        decay: 0.2, 
        sustain: 80, 
        release: 0.3,
        filterEnabled: true,
        filterType: 'lowpass',
        filterFreq: 5000,
        filterQ: 2
    },
    'Synth Bass': { 
        waveform: 'square', 
        attack: 0.01, 
        decay: 0.1, 
        sustain: 70, 
        release: 0.1,
        filterEnabled: true,
        filterType: 'lowpass',
        filterFreq: 2000,
        filterQ: 1
    },
    'Pad': { 
        waveform: 'sine', 
        attack: 0.5, 
        decay: 0.3, 
        sustain: 80, 
        release: 0.8,
        filterEnabled: true,
        filterType: 'lowpass',
        filterFreq: 8000,
        filterQ: 0.5
    },
    'Pluck': { 
        waveform: 'triangle', 
        attack: 0.001, 
        decay: 0.3, 
        sustain: 0, 
        release: 0.1,
        filterEnabled: true,
        filterType: 'lowpass',
        filterFreq: 4000,
        filterQ: 1
    },
    'Bell': { 
        waveform: 'sine', 
        attack: 0.001, 
        decay: 1.5, 
        sustain: 0, 
        release: 0.5,
        filterEnabled: true,
        filterType: 'bandpass',
        filterFreq: 3000,
        filterQ: 5
    },
    
    // FM synthesis presets
    'Electric Piano': { 
        waveform: 'sine', 
        attack: 0.005, 
        decay: 0.5, 
        sustain: 40, 
        release: 0.3,
        modulationIndex: 0.3,
        tremoloRate: 6,
        tremoloDepth: 0.1
    },
    'Vibraphone': { 
        waveform: 'sine', 
        attack: 0.01, 
        decay: 0.8, 
        sustain: 0, 
        release: 0.5,
        tremoloRate: 5,
        tremoloDepth: 0.15
    }
};

/**
 * Get preset by name
 */
export function getOscillatorPreset(name) {
    return OscillatorPresets[name] || OscillatorPresets['Sine'];
}
