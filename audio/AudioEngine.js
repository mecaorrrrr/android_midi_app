/**
 * AudioEngine - Main audio engine for Android MIDI App
 * Acts as a facade for the audio subsystem, delegating to specialized managers.
 * Phase 3: Added SFZ support, effects chain, and OscVoice fallback.
 */

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.voiceManager = null;
        this.soundFontManager = null;
        
        // Effect instances
        this.effects = {
            reverb: null,
            chorus: null,
            filter: null
        };
        
        // Effect chain
        this.effectChain = null;
        this.effectsEnabled = false;
        
        this.initialized = false;
        
        // Track instrument settings: each track can have different preset
        this.trackInstruments = Array.from({ length: 8 }, () => ({ 
            bank: 0, 
            program: 0, 
            presetIndex: -1,
            fontId: null,
            type: 'sf2' // 'sf2', 'sfz', 'osc'
        }));
        
        // SFZ data storage
        this.sfzData = null;
        this.sfzParser = null;
        
        // Oscillator presets
        this.oscPreset = 'Sine';
        
        this.mode = 'oscillator'; // 'oscillator', 'sfz', 'sf2'
    }

    /**
     * Initialize the audio engine
     */
    async init() {
        if (this.initialized) return;

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        
        // Create master gain
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.5;
        this.masterGain.connect(this.ctx.destination);

        // Initialize effect chain
        await this.initEffects();

        console.log("AudioEngine initialized");
        this.initialized = true;
    }

    /**
     * Initialize effects chain
     */
    async initEffects() {
        try {
            // Import effects
            const { EffectChain, EffectBase } = await import('./effects/EffectBase.js');
            const { Reverb } = await import('./effects/Reverb.js');
            const { Chorus } = await import('./effects/Chorus.js');
            const { Filter } = await import('./effects/Filter.js');
            
            // Create effect chain
            this.effectChain = new EffectChain(this.ctx);
            
            // Create individual effects
            this.effects.filter = new Filter(this.ctx, this.effectChain.getInput());
            this.effects.chorus = new Chorus(this.ctx, this.effects.filter.getInput());
            this.effects.reverb = new Reverb(this.ctx, this.effects.chorus.getInput());
            
            // Add to chain
            this.effectChain.addEffect(this.effects.reverb);
            this.effectChain.addEffect(this.effects.chorus);
            this.effectChain.addEffect(this.effects.filter);
            
            // Connect chain output to master
            this.effectChain.getOutput().connect(this.masterGain);
            
            console.log("AudioEngine: Effects chain initialized");
        } catch (e) {
            console.warn("AudioEngine: Failed to initialize effects:", e);
        }
    }

    /**
     * Enable or disable effects
     */
    setEffectsEnabled(enabled) {
        this.effectsEnabled = enabled;
        if (this.effectChain) {
            if (enabled) {
                this.effectChain.unbypassAll();
            } else {
                this.effectChain.bypassAll();
            }
        }
    }

    /**
     * Set master volume
     */
    setMasterVolume(volume) {
        if (this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    /**
     * Set reverb parameters
     */
    setReverb(params) {
        if (this.effects.reverb) {
            if (params.decayTime !== undefined) this.effects.reverb.setParameter('decayTime', params.decayTime);
            if (params.wetLevel !== undefined) this.effects.reverb.setParameter('wetLevel', params.wetLevel);
            if (params.preDelay !== undefined) this.effects.reverb.setParameter('preDelay', params.preDelay);
        }
    }

    /**
     * Set chorus parameters
     */
    setChorus(params) {
        if (this.effects.chorus) {
            if (params.rate !== undefined) this.effects.chorus.setParameter('rate', params.rate);
            if (params.depth !== undefined) this.effects.chorus.setParameter('depth', params.depth);
            if (params.wetLevel !== undefined) this.effects.chorus.setParameter('wetLevel', params.wetLevel);
        }
    }

    /**
     * Set filter parameters
     */
    setFilter(params) {
        if (this.effects.filter) {
            if (params.frequency !== undefined) this.effects.filter.setParameter('frequency', params.frequency);
            if (params.resonance !== undefined) this.effects.filter.setParameter('resonance', params.resonance);
            if (params.filterType !== undefined) this.effects.filter.setFilterType(params.filterType);
        }
    }

    /**
     * Get effects state
     */
    getEffectsState() {
        return {
            enabled: this.effectsEnabled,
            reverb: this.effects.reverb?.getState(),
            chorus: this.effects.chorus?.getState(),
            filter: this.effects.filter?.getState()
        };
    }

    /**
     * Resume audio context if suspended
     */
    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    /**
     * Set instrument for a specific track
     */
    setTrackInstrument(trackId, bank, program, presetIndex = -1, fontId = null) {
        if (trackId >= 0 && trackId < 8) {
            this.trackInstruments[trackId] = { bank, program, presetIndex, fontId };
            console.log(`AudioEngine: Track ${trackId} instrument set to Bank:${bank} Prog:${program} PresetIndex:${presetIndex}`);
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.voiceManager) {
            this.voiceManager.setTrackVolume(trackId, volume);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.voiceManager) {
            this.voiceManager.setTrackPan(trackId, pan);
        }
    }

    /**
     * Load SF2 file
     */
    async loadSF2(file) {
        await this.init();
        this.resume();

        try {
            const { SF2Parser } = await import('../sf2parser.js');
            const arrayBuffer = await file.arrayBuffer();
            const parser = new SF2Parser(arrayBuffer);
            const sf2Data = parser.parse();

            console.log(`AudioEngine: Parsed SF2: ${sf2Data.presets.length} presets, ${sf2Data.samples.length} samples`);

            // Create a font ID
            const fontId = `sf2_${Date.now()}`;
            
            // Initialize SoundFontManager if needed
            if (!this.soundFontManager) {
                const { SoundFontManager } = await import('./SoundFontManager.js');
                this.soundFontManager = new SoundFontManager(this.ctx);
                console.log("[DEBUG] AudioEngine: SoundFontManager created");
            } else {
                console.log("[DEBUG] AudioEngine: SoundFontManager already exists");
            }
            
            // Set progress callback if available (for streaming decode)
            if (this.progressCallback) {
                this.soundFontManager.setProgressCallback(this.progressCallback);
            }
            
            // Register the SF2 with the manager
            await this.soundFontManager.loadFont(fontId, sf2Data, arrayBuffer);
            
            console.log(`AudioEngine: SF2 loaded successfully, presets count: ${sf2Data.presets.length}`);

            // Initialize all tracks to first preset
            for (let i = 0; i < 8; i++) {
                this.trackInstruments[i] = {
                    bank: sf2Data.presets[0]?.bank || 0,
                    program: sf2Data.presets[0]?.preset || 0,
                    presetIndex: 0,
                    fontId: fontId
                };
            }

            // Initialize VoiceManager
            if (!this.voiceManager) {
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64);
                this.voiceManager.setMasterOutput(this.masterGain);
                // FIX: Inject SoundFontManager into VoiceManager
                this.voiceManager.soundFontManager = this.soundFontManager;
                console.log("[DEBUG] AudioEngine: VoiceManager created and SoundFontManager injected");
            }
            
            this.mode = 'sf2';
            return true;
        } catch (e) {
            console.error("AudioEngine: Failed to load SF2:", e);
            return false;
        }
    }

    /**
     * Set progress callback for loading operations
     */
    setProgressCallback(callback) {
        this.progressCallback = callback;
        if (this.soundFontManager) {
            this.soundFontManager.setProgressCallback(callback);
        }
    }

    /**
     * Load SFZ file (simplified - parses SFZ text format)
     */
    async loadSFZ(fileList) {
        await this.init();
        this.resume();
        
        try {
            // Import SFZVoice and SFZParser
            const { SFZVoice, SFZParser } = await import('./voices/SFZVoice.js');
            
            const sfzFile = fileList[0];
            const text = await sfzFile.text();
            
            // Parse SFZ file
            const parser = new SFZParser();
            parser.parse(text, sfzFile.name.replace(/[^\/]*$/, ''));
            
            this.sfzParser = parser;
            this.sfzData = parser.getRegions();
            
            console.log(`AudioEngine: SFZ loaded - ${this.sfzData.length} regions`);
            
            // Initialize VoiceManager for SFZ
            if (!this.voiceManager) {
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64);
                this.voiceManager.setMasterOutput(this.masterGain);
                
                // Inject effects chain output
                if (this.effectChain) {
                    this.voiceManager.setEffectsOutput(this.effectChain.getInput());
                }
            }
            
            // Initialize all tracks for SFZ mode
            for (let i = 0; i < 8; i++) {
                this.trackInstruments[i] = {
                    bank: 0,
                    program: 0,
                    presetIndex: -1,
                    fontId: 'sfz',
                    type: 'sfz',
                    regionIndex: 0
                };
            }
            
            this.mode = 'sfz';
            return true;
        } catch (e) {
            console.error("AudioEngine: Failed to load SFZ:", e);
            return false;
        }
    }

    /**
     * Get SFZ regions for display
     */
    getSFZRegions() {
        if (!this.sfzData) return [];
        
        return this.sfzData.map((region, index) => ({
            index: index,
            name: region.sample || `Region ${index + 1}`,
            keyLo: region.keyLo || 0,
            keyHi: region.keyHi || 127,
            velLo: region.velLo || 0,
            velHi: region.velHi || 127,
            lokey: region.lokey,
            hikey: region.hikey
        }));
    }

    /**
     * Set oscillator preset
     */
    setOscPreset(presetName) {
        this.oscPreset = presetName;
    }

    /**
     * Get available oscillator presets
     */
    getOscPresets() {
        return ['Sine', 'Square', 'Sawtooth', 'Triangle', 'Synth Lead', 'Synth Bass', 'Pad', 'Pluck', 'Bell', 'Electric Piano', 'Vibraphone'];
    }

    /**
     * Play oscillator note (fallback voice)
     */
    async playOscillator(midi, duration = 0.5, trackId = 0, velocity = 100) {
        await this.init();
        this.resume();
        
        try {
            const { OscVoice, getOscillatorPreset } = await import('./voices/OscVoice.js');
            
            // Get preset parameters
            const preset = getOscillatorPreset(this.oscPreset);
            
            // Initialize VoiceManager for oscillator
            if (!this.voiceManager) {
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64);
                this.voiceManager.setMasterOutput(this.masterGain);
                
                // Inject effects chain output
                if (this.effectChain) {
                    this.voiceManager.setEffectsOutput(this.effectChain.getInput());
                }
            }
            
            // Play using VoiceManager
            await this.voiceManager.playOscNote(
                preset,
                midi,
                velocity,
                duration,
                trackId
            );
            
        } catch (e) {
            console.error("AudioEngine: Failed to play oscillator:", e);
            
            // Fallback to direct oscillator
            this.playOscillatorDirect(midi, duration, trackId, velocity);
        }
    }

    /**
     * Direct oscillator playback (no VoiceManager)
     */
    playOscillatorDirect(midi, duration = 0.2, trackId = 0, velocity = 100) {
        if (!this.ctx) this.init();
        this.resume();

        const osc = this.ctx.createOscillator();
        const envelope = this.ctx.createGain();
        const pan = this.ctx.createStereoPanner();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.midiToFreq(midi), this.ctx.currentTime);

        const gainVal = (velocity / 127) * 0.3;
        envelope.gain.setValueAtTime(0, this.ctx.currentTime);
        envelope.gain.linearRampToValueAtTime(gainVal, this.ctx.currentTime + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        // Pan based on track
        pan.pan.value = (trackId - 3.5) / 4;

        osc.connect(envelope);
        envelope.connect(pan);
        
        // Connect to effects or direct to master
        if (this.effectsEnabled && this.effectChain) {
            pan.connect(this.effectChain.getInput());
        } else {
            pan.connect(this.masterGain);
        }

        osc.start();
        osc.stop(this.ctx.currentTime + duration + 0.1);
    }

    /**
     * Get list of presets from loaded soundfonts
     */
    getPresets() {
        if (this.soundFontManager) {
            return this.soundFontManager.getAllPresets();
        }
        return [];
    }

    /**
     * Select preset for a specific track
     */
    selectPreset(trackId, presetIndex) {
        if (!this.soundFontManager) return;
        
        const presets = this.soundFontManager.getAllPresets();
        if (presetIndex < 0 || presetIndex >= presets.length) {
            console.warn("AudioEngine: Invalid preset index:", presetIndex);
            return;
        }
        
        const preset = presets[presetIndex];
        this.setTrackInstrument(trackId, preset.bank, preset.preset, presetIndex, preset.fontId);
        console.log(`AudioEngine: Track ${trackId} preset changed to: ${preset.name} (Index: ${presetIndex})`);
    }

    /**
     * Play a note
     */
    playNote(midi, duration = 1.0, trackId = 0, velocity = 100) {
        if (!this.ctx) {
            console.log("[DEBUG] AudioEngine.playNote: ctx is null, returning");
            return;
        }

        const instrument = this.trackInstruments[trackId];
        console.log(`[DEBUG] AudioEngine.playNote: mode=${this.mode}, soundFontManager=${!!this.soundFontManager}, fontId=${instrument?.fontId}`);
        
        if (this.mode === 'sf2' && this.soundFontManager && instrument.fontId) {
            // Play using VoiceManager with SF2
            if (this.voiceManager) {
                this.voiceManager.playSF2Note(
                    instrument.fontId,
                    instrument.presetIndex,
                    midi,
                    velocity,
                    duration,
                    trackId
                );
            } else {
                console.log("[DEBUG] AudioEngine.playNote: voiceManager is null");
            }
        } else if (this.mode === 'sfz') {
            // Use legacy SFZ implementation - would need to be migrated
            console.warn("AudioEngine: SFZ playback via legacy engine not implemented yet");
        } else {
            // Use oscillator fallback
            this.playOscillator(midi, duration, trackId, velocity);
        }
    }

    /**
     * Play a simple oscillator tone (fallback)
     */
    playOscillator(midi, duration = 0.2, trackId = 0, velocity = 100) {
        if (!this.ctx) this.init();
        this.resume();

        const osc = this.ctx.createOscillator();
        const envelope = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.midiToFreq(midi), this.ctx.currentTime);

        const gainVal = (velocity / 127) * 0.5;
        envelope.gain.setValueAtTime(0, this.ctx.currentTime);
        envelope.gain.linearRampToValueAtTime(gainVal, this.ctx.currentTime + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        osc.connect(envelope);
        envelope.connect(this.masterGain);

        osc.start();
        osc.stop(this.ctx.currentTime + duration + 0.1);
    }

    /**
     * Convert MIDI note to frequency
     */
    midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }

    /**
     * Get ADSR parameters for the current track's preset
     * @returns {Object} ADSR parameters { attack, decay, sustain, release }
     */
    getCurrentPresetAdsrParams() {
        if (!this.soundFontManager) {
            console.warn('AudioEngine: SoundFontManager not available');
            return null;
        }
        
        const trackId = 0; // Use first track as default
        const instrument = this.trackInstruments[trackId];
        
        if (!instrument || !instrument.fontId || instrument.presetIndex < 0) {
            console.warn('AudioEngine: No valid preset selected');
            return null;
        }
        
        return this.soundFontManager.getPresetAdsrParams(instrument.fontId, instrument.presetIndex);
    }

    /**
     * Panic - stop all playing voices immediately
     */
    panic() {
        if (this.voiceManager) {
            this.voiceManager.panic();
        }
    }

    /**
     * Clean up resources
     */
    dispose() {
        this.panic();
        if (this.ctx) {
            this.ctx.close();
            this.ctx = null;
        }
        this.initialized = false;
    }
}
