/**
 * VoiceManager - Manages voice allocation and playback
 * Handles polyphony, voice pooling, and track routing
 * Phase 3: Added SFZ and OscVoice support
 */

export class VoiceManager {
    constructor(ctx, maxVoices = 64, audioEngine = null) {
        this.ctx = ctx;
        this.maxVoices = maxVoices;
        this.audioEngine = audioEngine; // Reference to AudioEngine for filter propagation
        this.activeVoices = new Map(); // voiceId -> voice object
        this.voicePool = {
            sf2: [],
            sfz: []
        };
        this.nextVoiceId = 0;
        
        // Track SoundFontManager initialization
        this.soundFontManager = null;
        
        // SFZ data reference
        this.sfzParser = null;
        this.sfzRegions = null;
        
        // Track outputs for routing
        this.trackChannels = []; // Array of { gain: GainNode, panner: StereoPannerNode }
        this.masterOutput = null;
        this.effectsOutput = null;
        
        // ADSR parameters (can be overridden per voice)
        this.adsrParams = {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.7,
            release: 0.1
        };
        
        // Filter parameters
        this.filterParams = {
            type: 'lowpass',
            cutoff: 20000,
            resonance: 1
        };
        
        // Initialize track channels
        this.initTrackChannels();
    }

    /**
     * Initialize track channel outputs
     */
    initTrackChannels() {
        for (let i = 0; i < 8; i++) {
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            
            gain.connect(panner);
            panner.connect(this.ctx.destination); // Temporary - will be re-routed
            
            this.trackChannels.push({ gain, panner });
        }
    }

    /**
     * Set master output for all track channels
     */
    setMasterOutput(masterGain) {
        this.masterOutput = masterGain;
        // Re-route all track channels to master
        for (const channel of this.trackChannels) {
            channel.panner.disconnect();
            channel.panner.connect(masterGain);
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].panner.pan.setValueAtTime(pan, this.ctx.currentTime);
        }
    }

    /**
     * Set ADSR envelope parameters
     */
    setAdsrParams(params) {
        this.adsrParams = { ...this.adsrParams, ...params };
        console.log(`VoiceManager: ADSR params updated - A:${this.adsrParams.attack} D:${this.adsrParams.decay} S:${this.adsrParams.sustain} R:${this.adsrParams.release}`);
    }

    /**
     * Get current ADSR parameters
     */
    getAdsrParams() {
        return this.adsrParams;
    }

    /**
     * Set Filter parameters
     */
    setFilterParams(params) {
        // Map UI parameter names to internal names
        const mappedParams = { ...params };
        
        // UI sends 'frequency' but we use 'frequency' internally
        // Also support 'cutoff' as alias for frequency
        if (params.frequency !== undefined) {
            mappedParams.frequency = params.frequency;
        }
        if (params.cutoff !== undefined) {
            mappedParams.frequency = params.cutoff;
        }
        
        this.filterParams = { ...this.filterParams, ...mappedParams };
        console.log(`VoiceManager: Filter params updated - Type:${this.filterParams.type} Freq:${this.filterParams.frequency}Hz Res:${this.filterParams.resonance}`);
        
        // Propagate to AudioEngine's global filter
        if (this.audioEngine && this.audioEngine.setFilter) {
            this.audioEngine.setFilter(this.filterParams);
            console.log('VoiceManager: Filter params propagated to AudioEngine');
        }
    }

    /**
     * Get current Filter parameters
     */
    getFilterParams() {
        return this.filterParams;
    }

    /**
     * Play an SF2 note
     */
    async playSF2Note(fontId, presetIndex, midi, velocity, duration, trackId) {
        console.log(`[DEBUG] VoiceManager.playSF2Note called - fontId: ${fontId}, presetIndex: ${presetIndex}, midi: ${midi}`);
        console.log(`[DEBUG] AudioContext state: ${this.ctx.state}`);
        if (!this.soundFontManager) {
            console.warn("VoiceManager: SoundFontManager not initialized");
            return;
        }

        // Resolve the sample for this note
        const sampleInfo = this.soundFontManager.resolveSample(fontId, presetIndex, midi, velocity);
        console.log(`[DEBUG] VoiceManager.playSF2Note: sampleInfo=${sampleInfo ? 'found' : 'null'}`);
        if (!sampleInfo) {
            console.warn(`VoiceManager: No sample found for note ${midi} in preset ${presetIndex}`);
            return;
        }

        // Allocate a voice
        const voice = await this.allocateVoice('sf2', trackId);
        console.log(`[DEBUG] VoiceManager.playSF2Note: voice=${voice ? voice.constructor.name : 'null'}`);
        if (!voice) {
            console.warn("VoiceManager: Failed to allocate voice");
            return;
        }

        // Start playback
        console.log(`[DEBUG] VoiceManager.playSF2Note: calling voice.start()`);
        console.log(`[DEBUG] voice.start: gainNode=${voice.gainNode ? 'exists' : 'null'}, gainValue=${voice.gainNode?.gain?.value}`);
        await voice.start(sampleInfo, midi, velocity, duration);
        console.log(`[DEBUG] VoiceManager.playSF2Note: voice.start() completed`);
    }

    /**
     * Set effects output for routing
     */
    setEffectsOutput(effectsInput) {
        this.effectsOutput = effectsInput;
        console.log("[DEBUG] VoiceManager.setEffectsOutput called:", {
            effectsInput: effectsInput ? 'provided' : 'null',
            effectsInputType: effectsInput?.constructor?.name,
            previousEffectsOutput: this.effectsOutput ? 'was set' : 'was null',
            masterOutput: this.masterOutput ? 'exists' : 'null',
            trackChannelsCount: this.trackChannels?.length || 0
        });
        
        // Re-route all track channels
        for (const channel of this.trackChannels) {
            if (!channel.panner) {
                console.warn("[DEBUG] VoiceManager: channel.panner is null for track");
                continue;
            }
            
            // Disconnect from current connections
            try {
                channel.panner.disconnect();
            } catch (e) {
                console.warn("[DEBUG] VoiceManager: panner.disconnect() failed:", e);
            }
            
            // Determine where to connect
            let target = null;
            if (this.effectsOutput) {
                target = this.effectsOutput;
                console.log("[DEBUG] Connecting channel.panner to effectsOutput");
            } else if (this.masterOutput) {
                target = this.masterOutput;
                console.log("[DEBUG] Connecting channel.panner to masterOutput (effectsOutput is null)");
            } else {
                console.warn("[DEBUG] VoiceManager: No valid output target for panner!");
            }
            
            if (target) {
                try {
                    channel.panner.connect(target);
                    console.log("[DEBUG] VoiceManager: panner connected successfully");
                } catch (e) {
                    console.error("[DEBUG] VoiceManager: panner.connect() failed:", e);
                }
            }
        }
        
        // Verify connections after routing
        console.log("[DEBUG] VoiceManager: Post-routing connection verification:");
        for (let i = 0; i < this.trackChannels.length; i++) {
            const ch = this.trackChannels[i];
            if (ch?.panner) {
                // Check if panner has any active connections
                const connections = ch.panner._connections || ch.panner._activeInputs || [];
                console.log(`[DEBUG] Track ${i} panner connections: ${connections.length}`);
            }
        }
    }

    /**
     * Set SFZ data for playback
     */
    setSFZData(sfzParser, regions) {
        this.sfzParser = sfzParser;
        this.sfzRegions = regions;
    }

    /**
     * Play an SFZ note
     */
    async playSFZNote(region, midi, velocity, duration, trackId) {
        if (!this.sfzParser || !this.sfzRegions) {
            console.warn("VoiceManager: SFZ data not loaded");
            return;
        }
        
        // Allocate SFZ voice
        const voice = await this.allocateVoice('sfz', trackId);
        if (!voice) {
            console.warn("VoiceManager: Failed to allocate SFZ voice");
            return;
        }
        
        // For SFZ, we don't need a buffer (oscillator-based)
        await voice.start(region, null, midi, velocity, duration);
        
        console.log(`[DEBUG] VoiceManager.playSFZNote: Played region for MIDI ${midi}`);
    }

    /**
     * Allocate a voice for a track
     * Returns a voice instance or null if max voices reached
     */
    async allocateVoice(type, trackId) {
        // Check if we've reached max voices
        if (this.activeVoices.size >= this.maxVoices) {
            // Steal the oldest voice
            const oldestVoiceId = this.activeVoices.keys().next().value;
            if (oldestVoiceId) {
                const oldVoice = this.activeVoices.get(oldestVoiceId);
                if (oldVoice) {
                    oldVoice.stop();
                }
                this.activeVoices.delete(oldestVoiceId);
            }
        }

        // Get voice from pool or create new
        let voice;
        
        // Check pool first
        if (this.voicePool[type] && this.voicePool[type].length > 0) {
            voice = this.voicePool[type].pop();
        } else {
            // Create new voice
            voice = await this.createVoice(type, trackId);
        }

        if (!voice) {
            return null;
        }

        const voiceId = ++this.nextVoiceId;
        voice.voiceId = voiceId;
        voice.trackId = trackId;
        voice.voiceType = type; // Store type for pool identification
        
        this.activeVoices.set(voiceId, voice);
        
        // Set up cleanup callback
        voice.onEnded = () => {
            this.activeVoices.delete(voiceId);
            // Return to appropriate pool
            const poolType = voice.voiceType || 'sf2';
            if (!this.voicePool[poolType]) {
                this.voicePool[poolType] = [];
            }
            this.voicePool[poolType].push(voice);
        };

        return voice;
    }

    /**
     * Create a new voice of specified type
     */
    async createVoice(type, trackId) {
        const trackChannel = this.trackChannels[trackId] || this.trackChannels[0];
        const output = this.effectsOutput || trackChannel.gain;
        
        console.log(`[DEBUG] VoiceManager.createVoice: type=${type}, trackId=${trackId}`);
        console.log(`[DEBUG] VoiceManager.createVoice: effectsOutput=${this.effectsOutput ? 'set' : 'null'}, trackChannel.gain=${trackChannel.gain ? 'exists' : 'null'}`);
        console.log(`[DEBUG] VoiceManager.createVoice: output node type=${output?.constructor?.name || 'null'}`);
        
        switch (type) {
            case 'sf2': {
                const { SF2Voice } = await import('./voices/SF2Voice.js');
                console.log(`[DEBUG] VoiceManager.createVoice: filterParams=`, this.filterParams);
                return new SF2Voice(this.ctx, output, this.soundFontManager, this.adsrParams, this.filterParams);
            }
            case 'sfz': {
                const { SFZVoice } = await import('./voices/SFZVoice.js');
                return new SFZVoice(this.ctx, output);
            }
            default:
                console.warn(`VoiceManager: Unknown voice type: ${type}`);
                return null;
        }
    }

    /**
     * Stop all active voices immediately (for panic/emergency situations)
     */
    panic() {
        for (const [voiceId, voice] of this.activeVoices) {
            voice.stop();
            if (voice.stopImmediate) {
                voice.stopImmediate();
            } else {
                voice.stop();
            }
        }
        this.activeVoices.clear();
    }

    /**
     * Get count of active voices
     */
    getActiveVoiceCount() {
        return this.activeVoices.size;
    }

    /**
     * Get polyphony usage
     */
    getPolyphonyInfo() {
        return {
            active: this.activeVoices.size,
            max: this.maxVoices,
            available: this.maxVoices - this.activeVoices.size
        };
    }

    /**
     * Dispose of all resources and stop all voices
     */
    dispose() {
        console.log("[DEBUG] VoiceManager.dispose() called");
        
        // Stop all active voices
        if (this.activeVoices && this.activeVoices.size > 0) {
            for (const [voiceId, voice] of this.activeVoices) {
                try {
                    voice.stop();
                    voice.disconnect();
                } catch (e) {
                    console.warn("[DEBUG] Error disposing voice:", e);
                }
            }
            this.activeVoices.clear();
        }
        
        // Dispose all voices in the pools
        if (this.voicePool) {
            for (const type in this.voicePool) {
                const pool = this.voicePool[type];
                if (pool && pool.length > 0) {
                    for (const voice of pool) {
                        try {
                            if (voice.dispose) {
                                voice.dispose();
                            }
                        } catch (e) {
                            console.warn("[DEBUG] Error disposing pooled voice:", e);
                        }
                    }
                    pool.length = 0;
                }
            }
        }
        
        // Clear voice pool
        this.voicePool = {
            sf2: [],
            sfz: []
        };
        
        // Dispose track channels
        if (this.trackChannels && this.trackChannels.length > 0) {
            for (const channel of this.trackChannels) {
                try {
                    if (channel.gain) {
                        channel.gain.disconnect();
                    }
                    if (channel.panner) {
                        channel.panner.disconnect();
                    }
                } catch (e) {
                    // Ignore
                }
            }
            this.trackChannels = [];
        }
        
        // Dispose effects output if exists
        if (this.effectsOutput) {
            try {
                this.effectsOutput.disconnect();
            } catch (e) {
                // Ignore
            }
            this.effectsOutput = null;
        }
        
        console.log("[DEBUG] VoiceManager dispose complete");
    }
}
