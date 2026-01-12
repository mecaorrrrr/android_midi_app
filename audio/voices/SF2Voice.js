/**
 * SF2Voice - Individual voice for SF2 sample playback
 * Handles ADSR envelope, pitch adjustment, and filtering
 */

export class SF2Voice {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        
        this.voiceId = null;
        this.trackId = 0;
        
        // Audio nodes
        this.source = null;
        this.envelope = null;
        this.filter = null;
        this.gainNode = null;
        
        // State
        this.isPlaying = false;
        this.isReleased = false;
        this.startTime = 0;
        this.releaseTime = 0;
        
        // Callbacks
        this.onEnded = null;
        
        // ADSR parameters
        this.attackTime = 0.001;
        this.decayTime = 0.1;
        this.sustainLevel = 0.7;
        this.releaseTimeValue = 0.1;
        
        // Filter parameters
        this.filterEnabled = false;
        this.filterType = 'lowpass';
        this.filterFreq = 20000;
        this.filterQ = 1;
    }

    /**
     * Start playing a sample
     */
    async start(sampleInfo, midi, velocity, duration) {
        if (this.isPlaying) {
            this.stop();
        }

        const { buffer, sample, zone, presetZone } = sampleInfo;
        
        // Create nodes
        this.source = this.ctx.createBufferSource();
        this.source.buffer = buffer;
        
        this.gainNode = this.ctx.createGain();
        this.filter = this.ctx.createBiquadFilter();
        
        // Calculate ADSR from generators
        this.calculateEnvelope(zone, presetZone);
        
        // Configure filter if available
        this.configureFilter(zone, presetZone);
        
        // Calculate pitch
        const detune = this.calculateDetune(midi, sample, zone, presetZone);
        this.source.detune.value = detune;
        
        // Handle looping
        this.configureLoop(sample, zone);
        
        // Connect: Source -> Filter -> Envelope -> Output
        if (this.filterEnabled) {
            this.source.connect(this.filter);
            this.filter.connect(this.gainNode);
        } else {
            this.source.connect(this.gainNode);
        }
        this.gainNode.connect(this.output);
        
        // Set initial gain
        const initialGain = (velocity / 127) * this.sustainLevel;
        this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
        
        // Start envelope
        this.startEnvelope(initialGain, duration);
        
        // Start source
        this.source.start(0);
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;
        this.isReleased = false;
        
        // Set up end callback
        this.source.onended = () => {
            this.isPlaying = false;
            if (this.onEnded) {
                this.onEnded();
            }
        };
    }

    /**
     * Calculate ADSR parameters from SF2 generators
     */
    calculateEnvelope(zone, presetZone) {
        // Generator 33: attackVolEnv (timecents, -12000 to 0)
        const attackGen = this.getGeneratorValue(zone, presetZone, 33);
        this.attackTime = attackGen !== null ? this.timecentsToSeconds(attackGen) : 0.001;
        
        // Generator 34: decayVolEnv (timecents, -12000 to 0)
        const decayGen = this.getGeneratorValue(zone, presetZone, 34);
        this.decayTime = decayGen !== null ? this.timecentsToSeconds(decayGen) : 0.1;
        
        // Generator 36: sustainVolEnv (centibels, 0 to -1440, positive = quieter)
        const sustainGen = this.getGeneratorValue(zone, presetZone, 36);
        if (sustainGen !== null) {
            this.sustainLevel = 1 - (Math.abs(sustainGen) / 1440);
        } else {
            this.sustainLevel = 0.7;
        }
        
        // Generator 35: releaseVolEnv (timecents, -12000 to 0)
        const releaseGen = this.getGeneratorValue(zone, presetZone, 35);
        this.releaseTimeValue = releaseGen !== null ? this.timecentsToSeconds(releaseGen) : 0.1;
    }

    /**
     * Get generator value from zone or preset zone
     */
    getGeneratorValue(zone, presetZone, genIndex) {
        // Zone generators override preset generators
        if (zone && zone.generators && zone.generators[genIndex] !== undefined) {
            return zone.generators[genIndex];
        }
        if (presetZone && presetZone.generators && presetZone.generators[genIndex] !== undefined) {
            return presetZone.generators[genIndex];
        }
        return null;
    }

    /**
     * Configure filter from SF2 generators
     */
    configureFilter(zone, presetZone) {
        // Generator 8: initialFilterFreq (Hz, 0 to 20000)
        const freqGen = this.getGeneratorValue(zone, presetZone, 8);
        
        if (freqGen !== null && freqGen < 20000) {
            this.filterEnabled = true;
            this.filterFreq = Math.min(20000, Math.max(0, freqGen));
            
            // Generator 9: initialFilterQ (centibels, 0 to 960)
            const qGen = this.getGeneratorValue(zone, presetZone, 9);
            this.filterQ = qGen !== null ? qGen / 10 : 1;
            
            // Filter type (usually lowpass for standard SF2)
            this.filterType = 'lowpass';
            
            this.filter.type = this.filterType;
            this.filter.frequency.value = this.filterFreq;
            this.filter.Q.value = this.filterQ;
        } else {
            this.filterEnabled = false;
        }
    }

    /**
     * Calculate detune value for pitch adjustment
     */
    calculateDetune(midi, sample, zone, presetZone) {
        // Generator 58: overridingRootKey
        let rootKey = sample.originalPitch;
        const rootGen = this.getGeneratorValue(zone, presetZone, 58);
        if (rootGen !== null) {
            rootKey = rootGen;
        }

        // Generator 51: coarseTune (semitones)
        const coarseGen = this.getGeneratorValue(zone, presetZone, 51);
        const coarse = coarseGen || 0;
        
        // Generator 52: fineTune (cents)
        const fineGen = this.getGeneratorValue(zone, presetZone, 52);
        const fine = fineGen || 0;
        
        // Total detune calculation
        let detune = (midi - rootKey) * 100;
        detune += (sample.pitchCorrection || 0);
        detune += (coarse * 100) + fine;
        
        return detune;
    }

    /**
     * Configure sample looping
     */
    configureLoop(sample, zone) {
        // Generator 54: sampleModes (0: no loop, 1: loop continuously, 3: loop during keypress)
        let loopMode = 0;
        if (zone && zone.generators && zone.generators[54] !== undefined) {
            loopMode = zone.generators[54];
        }

        if (loopMode === 1 || loopMode === 3) {
            const loopStart = sample.loopStart - sample.start;
            const loopEnd = sample.loopEnd - sample.start;
            
            if (loopEnd > loopStart && loopStart >= 0) {
                this.source.loop = true;
                this.source.loopStart = loopStart / sample.sampleRate;
                this.source.loopEnd = loopEnd / sample.sampleRate;
            }
        }
    }

    /**
     * Start the ADSR envelope
     */
    startEnvelope(targetGain, duration) {
        const now = this.ctx.currentTime;
        const attackEnd = now + this.attackTime;
        const decayEnd = attackEnd + this.decayTime;
        const releaseStart = now + duration - this.releaseTimeValue;
        
        // Attack
        this.gainNode.gain.setValueAtTime(0, now);
        this.gainNode.gain.linearRampToValueAtTime(targetGain, attackEnd);
        
        // Decay to sustain
        this.gainNode.gain.linearRampToValueAtTime(
            targetGain * this.sustainLevel, 
            decayEnd
        );
        
        // Hold at sustain until release
        this.gainNode.gain.setValueAtTime(
            targetGain * this.sustainLevel, 
            decayEnd
        );
        
        // Schedule release
        this.gainNode.gain.setValueAtTime(
            targetGain * this.sustainLevel, 
            releaseStart
        );
        this.gainNode.gain.linearRampToValueAtTime(0, releaseStart + this.releaseTimeValue);
        
        this.releaseTime = releaseStart + this.releaseTimeValue;
    }

    /**
     * Release the voice (called when note ends)
     */
    release() {
        if (!this.isPlaying || this.isReleased) return;
        
        const now = this.ctx.currentTime;
        
        // If we're before the scheduled release, cancel and release now
        if (now < this.releaseTime) {
            const currentGain = this.gainNode.gain.value;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(currentGain, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + this.releaseTimeValue);
        }
        
        this.isReleased = true;
    }

    /**
     * Stop the voice immediately
     */
    stop() {
        if (this.source) {
            try {
                this.source.stop(0);
            } catch (e) {
                // Already stopped
            }
            this.source.disconnect();
            this.source = null;
        }
        
        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        
        if (this.filter) {
            this.filter.disconnect();
            this.filter = null;
        }
        
        this.isPlaying = false;
        this.isReleased = true;
    }

    /**
     * Convert timecents to seconds
     */
    timecentsToSeconds(timecents) {
        if (timecents === null || timecents === undefined) return 0.001;
        if (timecents <= -32768) return 0;
        return Math.pow(2, timecents / 1200);
    }
}
