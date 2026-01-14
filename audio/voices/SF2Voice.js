/**
 * SF2Voice - Individual voice for SF2 sample playback
 * Handles ADSR envelope, pitch adjustment, and filtering
 */

export class SF2Voice {
    constructor(ctx, output, soundFontManager = null, adsrParams = null, filterParams = null) {
        this.ctx = ctx;
        this.output = output;
        this.soundFontManager = soundFontManager;
        
        // Use provided ADSR params or use class defaults
        this.customAdsrParams = adsrParams;
        this.customFilterParams = filterParams;
        
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
        this.sustainAttenuationDb = 0;  // Generator 36 / 10 (デシベル単位の減衰量)
        this.sustainLevel = 0.7;  // 後方互換性のため維持（使用推奨せず）
        this.releaseTimeValue = 0.1;
        
        // Filter parameters
        this.filterEnabled = false;
        this.filterType = 'lowpass';
        this.filterFreq = 20000;
        this.filterQ = 1;
        
        console.log(`[DEBUG] SF2Voice.constructor: filterParams=`, filterParams);
    }

    /**
     * Start playing a sample
     */
    async start(sampleInfo, midi, velocity, duration) {
        console.log(`[DEBUG] SF2Voice.start: called with sampleInfo keys=${Object.keys(sampleInfo).join(', ')}`);
        if (this.isPlaying) {
            this.stop();
        }

        const { sample, zone, presetZone, fontData } = sampleInfo;
        console.log(`[DEBUG] SF2Voice.start: sample=${sample?.name}, fontData=${!!fontData}`);
        
        if (!sample) {
            console.error("SF2Voice.start: sample is missing!");
            return;
        }
        
        // Get or create buffer from SoundFontManager
        let buffer = null;
        if (this.soundFontManager && fontData) {
            try {
                // Get sample index - either from samples_idx or by searching
                let sampleIndex = sample.samples_idx;
                if (sampleIndex === undefined && fontData.samples) {
                    sampleIndex = fontData.samples.indexOf(sample);
                }
                
                if (sampleIndex !== undefined && sampleIndex >= 0) {
                    const bufferInfo = await this.soundFontManager.getOrCreateBuffer(
                        fontData.id, 
                        sampleIndex, 
                        sample
                    );
                    buffer = bufferInfo;
                    console.log(`[DEBUG] SF2Voice.start: buffer created/retrieved successfully for sample index ${sampleIndex}`);
                } else {
                    console.warn("SF2Voice.start: Could not determine sample index");
                }
            } catch (e) {
                console.error("SF2Voice.start: Failed to get buffer:", e);
            }
        } else if (sample.buffer) {
            // Fallback for pre-loaded buffers
            buffer = sample.buffer;
        }
        
        if (!buffer) {
            console.error("SF2Voice.start: buffer is still missing! sample:", sample.name);
            return;
        }
        
        try {
            // Create nodes
            this.source = this.ctx.createBufferSource();
            this.source.buffer = buffer;
            console.log("[DEBUG] SF2Voice.start: source created successfully");
            
            this.gainNode = this.ctx.createGain();
            this.filter = this.ctx.createBiquadFilter();
            console.log("[DEBUG] SF2Voice.start: nodes created successfully");
            
            // Calculate ADSR from generators
            this.calculateEnvelope(zone, presetZone, this.customAdsrParams);
            
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
            
            // Debug: Verify output connection
            console.log(`[DEBUG] SF2Voice: audio graph connected`);
            console.log(`[DEBUG] SF2Voice: source=${this.source ? 'connected' : 'null'}, filter=${this.filter ? 'connected' : 'null'}, gainNode=${this.gainNode ? 'connected' : 'null'}`);
            console.log(`[DEBUG] SF2Voice: output node type=${this.output?.constructor?.name || 'null'}, output destination nodes=${this.output?. destinations?.length || 0}`);
            
            // Calculate peak gain from velocity (no sustainLevel multiplication)
            const peakGain = Math.max(0, velocity / 127);
            this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
            
            // Start envelope
            this.startEnvelope(peakGain, duration);
            
            // Debug: Check envelope scheduling
            console.log(`[DEBUG] SF2Voice: peakGain=${peakGain.toFixed(4)}, sustainAttenuationDb=${this.sustainAttenuationDb.toFixed(4)}`);
            console.log(`[DEBUG] SF2Voice: attack=${this.attackTime.toFixed(4)}s, decay=${this.decayTime.toFixed(4)}s, release=${this.releaseTimeValue.toFixed(4)}s`);
            
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
            
            console.log("[DEBUG] SF2Voice.start: playback started successfully");
        } catch (e) {
            console.error("SF2Voice.start: Error during playback:", e);
        }
    }

    /**
     * Calculate ADSR parameters from SF2 generators or custom params
     */
    calculateEnvelope(zone, presetZone, customParams = null) {
        // If custom ADSR params are provided, use them
        if (customParams) {
            this.attackTime = customParams.attack || 0.001;
            this.decayTime = Math.min(4, customParams.decay || 0.1);
            this.sustainLevel = customParams.sustain !== undefined ? customParams.sustain : 0.7;
            this.releaseTimeValue = customParams.release || 0.1;
            return;
        }
        
        // Otherwise, calculate from SF2 generators
        // Generator 33: attackVolEnv (timecents, -12000 to 0)
        const attackGen = this.getGeneratorValue(zone, presetZone, 33);
        this.attackTime = attackGen !== null ? this.timecentsToSeconds(attackGen) : 0.001;
        
        // Generator 34: decayVolEnv (timecents, -12000 to 0)
        const decayGen = this.getGeneratorValue(zone, presetZone, 34);
        this.decayTime = Math.min(4, decayGen !== null ? this.timecentsToSeconds(decayGen) : 0.1);
        
        // Generator 36: sustainVolEnv (centibels, 0 to -1440, positive = quieter)
        const sustainGen = this.getGeneratorValue(zone, presetZone, 36);
        if (sustainGen !== null) {
            // センチベルを10で割ってデシベルに変換（減衰量）
            this.sustainAttenuationDb = Math.abs(sustainGen / 10);
        } else {
            this.sustainAttenuationDb = 0;
        }
        // 後方互換性のため維持（使用しないことを推奨）
        this.sustainLevel = 0.7;
        
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
        console.log(`[DEBUG] SF2Voice.configureFilter: customFilterParams=`, this.customFilterParams);
        
        // Generator 8: initialFilterFreq (Hz, 0 to 20000)
        const freqGen = this.getGeneratorValue(zone, presetZone, 8);
        
        if (freqGen !== null && freqGen < 20000) {
            // Use SF2 filter settings
            this.filterEnabled = true;
            this.filterFreq = Math.min(20000, Math.max(0, freqGen));
            
            // Generator 9: initialFilterQ (centibels, 0 to 960)
            const qGen = this.getGeneratorValue(zone, presetZone, 9);
            this.filterQ = qGen !== null ? qGen / 10 : 1;
            
            // Filter type (usually lowpass for standard SF2)
            this.filterType = 'lowpass';
            
            console.log(`[DEBUG] SF2Voice: Using SF2 filter - freq=${this.filterFreq}, Q=${this.filterQ}`);
        } else if (this.customFilterParams) {
            // Use global filter params from VoiceManager
            this.filterEnabled = true;
            this.filterType = this.customFilterParams.type || 'lowpass';
            this.filterFreq = this.customFilterParams.frequency || 20000;
            this.filterQ = this.customFilterParams.resonance || 1;
            
            console.log(`[DEBUG] SF2Voice: Using global filter - type=${this.filterType}, freq=${this.filterFreq}, Q=${this.filterQ}`);
        } else {
            // No filter
            this.filterEnabled = false;
            console.log(`[DEBUG] SF2Voice: No filter enabled (no SF2 filter and no global filter)`);
        }
        
        // Apply filter settings to filter node
        if (this.filter) {
            this.filter.type = this.filterType;
            this.filter.frequency.value = this.filterFreq;
            this.filter.Q.value = this.filterQ;
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
        
        // Calculate release start - ensure it's after decay phase
        // This prevents release from starting before attack/decay completes
        let releaseStart = now + duration - this.releaseTimeValue;
        if (releaseStart < decayEnd) {
            // If duration is too short, cap at decay end
            releaseStart = decayEnd;
        }
        
        // Attack
        this.gainNode.gain.setValueAtTime(0, now);
        this.gainNode.gain.linearRampToValueAtTime(targetGain, attackEnd);
        
        // Decay to sustain: peakGainからsustainAttenuationDbだけ減衰
        const sustainGain = Math.max(0, targetGain - this.sustainAttenuationDb);
        this.gainNode.gain.linearRampToValueAtTime(sustainGain, decayEnd);
        
        // Hold at sustain until release
        this.gainNode.gain.setValueAtTime(sustainGain, decayEnd);
        
        // Schedule release (only if releaseStart is after decayEnd)
        if (releaseStart >= decayEnd) {
            this.gainNode.gain.setValueAtTime(
                sustainGain, 
                releaseStart
            );
            this.gainNode.gain.linearRampToValueAtTime(0, releaseStart + this.releaseTimeValue);
            this.releaseTime = releaseStart + this.releaseTimeValue;
        } else {
            // If duration is too short, release immediately after decay
            this.releaseTime = decayEnd + 0.01;
        }
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
