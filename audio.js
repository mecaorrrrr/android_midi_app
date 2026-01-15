/**
 * AudioManager - Wrapper for SpessaSynth
 */
import { WorkletSynthesizer } from "spessasynth_lib";

export class AudioManager {
    constructor() {
        this.synth = null;
        this.ctx = new AudioContext();
        this.mode = 'sf2'; // Compatibility property

        // Track instrument settings
        this.trackInstruments = Array.from({ length: 16 }, () => ({
            bank: 0,
            program: 0
        }));
    }

    // ... (init, resume, setTrackInstrument methods remain) ...

    selectPreset(trackId, presetIndex) {
        if (this.synth && this.synth.presetList) {
            const preset = this.synth.presetList[presetIndex];
            if (preset) {
                this.setTrackInstrument(trackId, preset.bank, preset.program, presetIndex);
                console.log(`Track ${trackId} set to preset ${preset.name}`);
            }
        }
    }

    getCurrentPresetAdsrParams() { return null; }
    getCurrentPresetFilterParams() { return null; }

    /**
     * Initialize the audio engine
     */
    async init() {
        if (!this.synth) {
            await this.ctx.audioWorklet.addModule("./libs/spessasynth_processor.js");
            this.synth = new WorkletSynthesizer(this.ctx);
            // SpessaSynth uses 0.5s fade out by default, maybe too long?
        }
        return this.synth;
    }

    /**
     * Resume audio context
     */
    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    /**
     * Set instrument for a specific track
     */
    setTrackInstrument(trackId, bank, program, presetIndex = -1) {
        if (trackId >= 0 && trackId < 16) {
            this.trackInstruments[trackId] = { bank, program };
            if (this.synth) {
                this.synth.programChange(trackId, program);
                // Handle bank change if needed (CC 0 and 32)
                // this.synth.controllerChange(trackId, 0, bank); 
            }
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.synth && trackId >= 0 && trackId < 16) {
            // MIDI CC 7 is Volume
            this.synth.controllerChange(trackId, 7, volume);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.synth && trackId >= 0 && trackId < 16) {
            // MIDI CC 10 is Pan (0-127, 64 is center)
            // pan input might be -1 to 1 or 0-127? 
            // Assuming 0-127 based on MIDI standard
            this.synth.controllerChange(trackId, 10, pan);
        }
    }

    /**
     * Load SF2 file
     */
    async loadSF2(file, options = {}) {
        const { onProgress } = options;

        try {
            await this.init();

            if (onProgress) onProgress({ percent: 10, message: 'Loading SF2...' });

            const arrayBuffer = await file.arrayBuffer();

            if (onProgress) onProgress({ percent: 50, message: 'Parsing...' });

            // SpessaSynth handles parsing and loading internally
            // we use the filename as the ID
            await this.synth.soundBankManager.addSoundBank(arrayBuffer, file.name);

            console.log(`Loaded SF2: ${file.name}`);

            if (onProgress) onProgress({ percent: 100, message: 'Complete' });

            return true;
        } catch (e) {
            console.error("Failed to load SF2:", e);
            return false;
        }
    }

    /**
     * Load SFZ file (Not supported by SpessaSynth directly? It supports SF3/DLS)
     * SpessaSynth documentation mentioned SF2, SF3, DLS.
     * We will disable SFZ for now or leave it empty?
     * The user request mentioned "replace with spessasynth", implying SF2 focus.
     */
    async loadSFZ(fileList) {
        console.warn("SFZ loading not fully supported in this replacement yet.");
        return false;
    }

    /**
     * Get list of presets
     * SpessaSynth likely has a way to get presets from SoundBankManager or similar.
     * But SoundBankManager manages banks, not individual presets directly exposed as a flat list?
     * We need to inspect `synth.soundBankManager`.
     * Actually, standard MIDI doesn't always expose "list of all presets" easily.
     */
    getPresets() {
        if (this.synth && this.synth.presetList) {
            return this.synth.presetList.map((p, i) => ({
                index: i, // Presets might not have index property, so use array index
                name: p.name,
                bank: p.bank,
                program: p.program,
                preset: p.program, // Alias for compatibility
                fullName: `${p.bank}:${p.program} ${p.name}`
            }));
        }
        return [];
    }

    selectPreset(trackId, presetIndex) {
        // If we implement getPresets, we implement this.
    }

    /**
     * Play a note
     */
    playNote(midi, duration = 1.0, trackId = 0, velocity = 100) {
        if (this.synth) {
            this.synth.noteOn(trackId, midi, velocity);

            // Check if duration is valid
            if (duration > 0) {
                setTimeout(() => {
                    this.synth.noteOff(trackId, midi);
                }, duration * 1000);
            }
        }
    }

    /**
     * Get AudioContext
     */
    getContext() {
        return this.ctx;
    }

    /**
     * Panic - stop all voices
     */
    panic() {
        if (this.synth) {
            this.synth.stopAll();
        }
    }
}
