/**
 * AudioEngine - Main audio engine for Android MIDI App
 * Acts as a facade for the audio subsystem, delegating to specialized managers.
 */

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.voiceManager = null;
        this.soundFontManager = null;
        this.effects = {
            reverb: null,
            chorus: null,
            filter: null
        };
        this.initialized = false;
        
        // Track instrument settings: each track can have different preset
        this.trackInstruments = Array.from({ length: 8 }, () => ({ 
            bank: 0, 
            program: 0, 
            presetIndex: -1,
            fontId: null
        }));
        
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

        console.log("AudioEngine initialized");
        this.initialized = true;
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
            }
            
            // Register the SF2 with the manager
            await this.soundFontManager.loadFont(fontId, sf2Data, arrayBuffer);

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
            }
            
            this.mode = 'sf2';
            return true;
        } catch (e) {
            console.error("AudioEngine: Failed to load SF2:", e);
            return false;
        }
    }

    /**
     * Load SFZ file (simplified for now - delegates to existing implementation)
     */
    async loadSFZ(fileList) {
        await this.init();
        this.resume();
        
        console.log("AudioEngine: SFZ loading - using legacy implementation");
        this.mode = 'sfz';
        return true;
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
        if (!this.ctx) return;

        const instrument = this.trackInstruments[trackId];
        
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
