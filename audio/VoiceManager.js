/**
 * VoiceManager - Manages voice allocation and playback
 * Handles polyphony, voice pooling, and track routing
 * Phase 3: Added SFZ and OscVoice support
 */

export class VoiceManager {
    constructor(ctx, maxVoices = 64) {
        this.ctx = ctx;
        this.maxVoices = maxVoices;
        this.activeVoices = new Map(); // voiceId -> voice object
        this.voicePool = {
            sf2: [],
            sfz: [],
            osc: []
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
        this.filterParams = { ...this.filterParams, ...params };
        console.log(`VoiceManager: Filter params updated - Type:${this.filterParams.type} Cutoff:${this.filterParams.cutoff}Hz Res:${this.filterParams.resonance}`);
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
        // Re-route all track channels
        for (const channel of this.trackChannels) {
            channel.panner.disconnect();
            if (this.effectsOutput) {
                channel.panner.connect(this.effectsOutput);
            } else if (this.masterOutput) {
                channel.panner.connect(this.masterOutput);
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
     * Play an oscillator note
     */
    async playOscNote(presetParams, midi, velocity, duration, trackId) {
        // Allocate oscillator voice
        const voice = await this.allocateVoice('osc', trackId);
        if (!voice) {
            console.warn("VoiceManager: Failed to allocate oscillator voice");
            return;
        }
        
        // Start playback
        await voice.start(presetParams, midi, velocity, duration);
        
        console.log(`[DEBUG] VoiceManager.playOscNote: Played ${presetParams.waveform || 'sine'} at MIDI ${midi}`);
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
        
        switch (type) {
            case 'sf2': {
                const { SF2Voice } = await import('./voices/SF2Voice.js');
                return new SF2Voice(this.ctx, output, this.soundFontManager, this.adsrParams, this.filterParams);
            }
            case 'sfz': {
                const { SFZVoice } = await import('./voices/SFZVoice.js');
                return new SFZVoice(this.ctx, output);
            }
            case 'osc': {
                const { OscVoice } = await import('./voices/OscVoice.js');
                return new OscVoice(this.ctx, output, this.adsrParams, this.filterParams);
            }
            default:
                console.warn(`VoiceManager: Unknown voice type: ${type}`);
                return null;
        }
    }

    /**
     * Stop all active voices immediately
     */
    panic() {
        for (const [voiceId, voice] of this.activeVoices) {
            voice.stop();
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
}
