/**
 * AudioManager - Wrapper for AudioEngine
 * Maintains backward compatibility while delegating to the new audio engine
 * @deprecated Use AudioEngine directly for new code
 */

export class AudioManager {
    constructor() {
        this.engine = null;
        this.mode = 'oscillator';
        this.legacyMode = true; // Use legacy implementation by default
        
        // Track instrument settings (for backward compatibility)
        this.trackInstruments = Array.from({ length: 8 }, () => ({ 
            bank: 0, 
            program: 0, 
            presetIndex: 0
        }));
        
        // Legacy state for SFZ mode
        this.regions = [];
        this.buffers = {};
        
        // Legacy state for SF2 mode
        this.sf2Data = null;
        this.sf2Buffers = {};
    }

    /**
     * Initialize the audio engine
     */
    async init() {
        if (!this.engine) {
            const { AudioEngine } = await import('./audio/AudioEngine.js');
            this.engine = new AudioEngine();
            await this.engine.init();
        }
        return this.engine;
    }

    /**
     * Resume audio context if suspended
     */
    resume() {
        if (this.engine) {
            this.engine.resume();
        }
    }

    /**
     * Set instrument for a specific track
     */
    setTrackInstrument(trackId, bank, program, presetIndex = -1) {
        if (this.engine && !this.legacyMode) {
            this.engine.setTrackInstrument(trackId, bank, program, presetIndex);
        } else {
            if (trackId >= 0 && trackId < 8) {
                this.trackInstruments[trackId] = { bank, program, presetIndex };
            }
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.engine) {
            this.engine.setTrackVolume(trackId, volume);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.engine) {
            this.engine.setTrackPan(trackId, pan);
        }
    }

    /**
     * Load SF2 file
     * @param {File} file - SF2 file to load
     * @param {Object} options - Loading options
     * @param {Function} options.onProgress - Progress callback ({ percent, message }) => void
     */
    async loadSF2(file, options = {}) {
        // Use legacy implementation for now to maintain compatibility
        this.legacyMode = true;
        const { onProgress } = options;
        
        const { SF2Parser } = await import('./sf2parser.js');
        const ctx = (await this.init()).ctx;
        
        try {
            const arrayBuffer = await file.arrayBuffer();
            const parser = new SF2Parser(arrayBuffer);
            this.sf2Data = parser.parse();

            console.log(`Parsed SF2: ${this.sf2Data.presets.length} presets, ${this.sf2Data.samples.length} samples`);

            if (onProgress) {
                onProgress({ percent: 30, message: 'Decoding samples...' });
            }

            // Pre-decode samples to AudioBuffers
            this.sf2Buffers = {};
            const totalSamples = this.sf2Data.samples.length;
            
            for (let i = 0; i < this.sf2Data.samples.length; i++) {
                const sample = this.sf2Data.samples[i];
                if (sample.sampleType === 1 || sample.sampleType === 0) { // Mono samples
                    const buffer = this.createAudioBufferFromSF2Sample(sample, ctx);
                    if (buffer) {
                        this.sf2Buffers[i] = buffer;
                    }
                }
                
                // Report progress
                const percent = 30 + (70 * (i + 1) / totalSamples);
                if (onProgress) {
                    onProgress({ percent, message: `Decoding samples ${i + 1}/${totalSamples}` });
                }
            }

            console.log(`Decoded ${Object.keys(this.sf2Buffers).length} samples`);
            this.mode = 'sf2';
            
            if (onProgress) {
                onProgress({ percent: 100, message: 'Complete' });
            }
            
            // Initialize all tracks to first preset
            for (let i = 0; i < 8; i++) {
                this.trackInstruments[i] = {
                    bank: this.sf2Data.presets[0]?.bank || 0,
                    program: this.sf2Data.presets[0]?.preset || 0,
                    presetIndex: 0
                };
            }
            
            return true;
        } catch (e) {
            console.error("Failed to load SF2:", e);
            return false;
        }
    }

    /**
     * Load SFZ file
     */
    async loadSFZ(fileList) {
        // Use legacy implementation for now
        this.legacyMode = true;
        
        const ctx = (await this.init()).ctx;
        this.resume();

        this.regions = [];
        this.buffers = {};

        // 1. Find .sfz file
        let sfzFile = null;
        const assetFiles = {}; // name -> File

        for (const f of fileList) {
            if (f.name.toLowerCase().endsWith('.sfz')) {
                sfzFile = f;
            } else {
                assetFiles[f.name.toLowerCase()] = f;
            }
        }

        if (!sfzFile) {
            console.error("No .sfz file found in selection");
            return false;
        }

        console.log("Parsing SFZ:", sfzFile.name);
        const text = await sfzFile.text();
        this.parseSFZ(text);

        console.log(`Parsed ${this.regions.length} regions. Loading samples...`);

        // 2. Load samples referenced in regions
        const padName = (path) => path.split(/[\\/]/).pop().toLowerCase();

        for (const region of this.regions) {
            if (!region.sample) continue;
            const simpleName = padName(region.sample);

            if (!this.buffers[region.sample] && assetFiles[simpleName]) {
                try {
                    const arrayBuffer = await assetFiles[simpleName].arrayBuffer();
                    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                    this.buffers[region.sample] = audioBuffer;
                } catch (e) {
                    console.error("Failed to load sample:", simpleName, e);
                }
            }
        }

        console.log("Loaded samples:", Object.keys(this.buffers).length);
        this.mode = 'sfz';
        return true;
    }

    /**
     * Create AudioBuffer from SF2 sample data
     */
    createAudioBufferFromSF2Sample(sample, ctx) {
        if (!this.sf2Data.sampleData) return null;

        const start = sample.start;
        const end = sample.end;
        const length = end - start;

        if (length <= 0) return null;

        const buffer = ctx.createBuffer(1, length, sample.sampleRate);
        const channelData = buffer.getChannelData(0);

        // Convert Int16 to Float32
        for (let i = 0; i < length; i++) {
            channelData[i] = this.sf2Data.sampleData[start + i] / 32768.0;
        }

        return buffer;
    }

    /**
     * Get list of presets
     */
    getPresets() {
        if (this.sf2Data) {
            return this.sf2Data.presets.map((p, index) => ({
                index: index,
                name: p.name,
                bank: p.bank,
                preset: p.preset,
                fullName: `${p.bank}:${p.preset} ${p.name}`
            }));
        }
        return [];
    }

    /**
     * Select preset for a specific track
     */
    selectPreset(trackId, presetIndex) {
        if (this.sf2Data && presetIndex >= 0 && presetIndex < this.sf2Data.presets.length) {
            const preset = this.sf2Data.presets[presetIndex];
            this.setTrackInstrument(trackId, preset.bank, preset.preset, presetIndex);
            console.log(`Track ${trackId} preset changed to: ${preset.name} (Index: ${presetIndex})`);
        }
    }

    /**
     * Play a note
     */
    playNote(midi, duration = 1.0, trackId = 0, velocity = 100) {
        if (this.mode === 'sf2' && this.sf2Data) {
            this.playSF2Note(midi, duration, trackId, velocity);
        } else if (this.mode === 'sfz' && this.regions.length > 0) {
            this.playSFZNote(midi, duration, trackId, velocity);
        } else {
            this.playOscillator(midi, duration, trackId, velocity);
        }
    }

    /**
     * Play oscillator (fallback)
     */
    async playOscillator(midi, duration = 0.2, trackId = 0, velocity = 100) {
        const engine = await this.init();
        engine.playOscillator(midi, duration, trackId, velocity);
    }

    /**
     * Play SFZ note (legacy implementation)
     */
    async playSFZNote(midi, duration, trackId = 0, velocity = 100) {
        const engine = await this.init();
        const ctx = engine.ctx;

        const region = this.regions.find(r => {
            const key = r.key !== undefined ? r.key : -1;
            const lokey = r.lokey !== undefined ? r.lokey : (key !== -1 ? key : 0);
            const hikey = r.hikey !== undefined ? r.hikey : (key !== -1 ? key : 127);

            const lovel = r.lovel !== undefined ? r.lovel : 0;
            const hivel = r.hivel !== undefined ? r.hivel : 127;

            return (midi >= lokey && midi <= hikey) && (velocity >= lovel && velocity <= hivel);
        });

        if (region && region.sample && this.buffers[region.sample]) {
            this.triggerSample(ctx, this.buffers[region.sample], midi, region, duration, trackId, velocity);
        } else {
            console.warn("No SFZ region found for note", midi);
        }
    }

    /**
     * Play SF2 note (legacy implementation)
     */
    async playSF2Note(midi, duration, trackId = 0, velocity = 100) {
        const engine = await this.init();
        const ctx = engine.ctx;

        try {
            if (!this.sf2Data || !this.sf2Data.presets) return;

            const instrument = this.trackInstruments[trackId];
            if (!instrument) {
                console.warn(`No instrument set for track ${trackId}`);
                return;
            }

            let preset;
            if (instrument.presetIndex >= 0 && instrument.presetIndex < this.sf2Data.presets.length) {
                preset = this.sf2Data.presets[instrument.presetIndex];
            } else {
                preset = this.sf2Data.presets.find(p => 
                    p.preset === instrument.program && 
                    p.bank === instrument.bank
                );
                if (!preset) preset = this.sf2Data.presets[0];
            }

            if (!preset || !preset.zones) return;

            let fallbackZone = null;

            for (const pzone of preset.zones) {
                if (pzone.isGlobal) continue;
                if (pzone.instrumentIndex === undefined) continue;

                const inst = this.sf2Data.instruments[pzone.instrumentIndex];
                if (!inst || !inst.zones) continue;

                for (const izone of inst.zones) {
                    if (izone.isGlobal) continue;
                    
                    const keyLo = izone.keyLo !== undefined ? izone.keyLo : 0;
                    const keyHi = izone.keyHi !== undefined ? izone.keyHi : 127;
                    const velLo = izone.velLo !== undefined ? izone.velLo : 0;
                    const velHi = izone.velHi !== undefined ? izone.velHi : 127;

                    if (midi >= keyLo && midi <= keyHi && izone.sampleIndex !== undefined && this.sf2Buffers[izone.sampleIndex]) {
                        if (!fallbackZone) fallbackZone = { izone, pzone };
                    }

                    if (midi >= keyLo && midi <= keyHi && velocity >= velLo && velocity <= velHi) {
                        if (izone.sampleIndex !== undefined && this.sf2Buffers[izone.sampleIndex]) {
                            const sample = this.sf2Data.samples[izone.sampleIndex];
                            this.triggerSF2Sample(ctx, this.sf2Buffers[izone.sampleIndex], midi, sample, izone, pzone, duration, trackId, velocity);
                            return;
                        }
                    }
                }
            }

            if (fallbackZone) {
                const { izone, pzone } = fallbackZone;
                const sample = this.sf2Data.samples[izone.sampleIndex];
                this.triggerSF2Sample(ctx, this.sf2Buffers[izone.sampleIndex], midi, sample, izone, pzone, duration, trackId, velocity);
                return;
            }

            console.warn(`No matching zone found for note ${midi} in preset ${preset.name}`);
        } catch (e) {
            console.error("Error in playSF2Note:", e);
        }
    }

    /**
     * Trigger SF2 sample playback
     */
    triggerSF2Sample(ctx, buffer, midi, sample, izone, pzone, duration = 1.0, trackId = 0, velocity = 100) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        // Loop handling
        let loopMode = 0;
        if (izone.generators && izone.generators[54] !== undefined) {
            loopMode = izone.generators[54];
        }

        if (loopMode === 1 || loopMode === 3) {
            const loopStart = sample.loopStart - sample.start;
            const loopEnd = sample.loopEnd - sample.start;
            
            if (loopEnd > loopStart && loopStart >= 0) {
                source.loop = true;
                source.loopStart = loopStart / sample.sampleRate;
                source.loopEnd = loopEnd / sample.sampleRate;
            }
        }

        // Pitch calculation
        let rootKey = sample.originalPitch;
        if (izone.generators && izone.generators[58] !== undefined) {
            rootKey = izone.generators[58];
        }

        const instCoarse = (izone.generators && izone.generators[51]) || 0;
        const instFine = (izone.generators && izone.generators[52]) || 0;
        const presetCoarse = (pzone.generators && pzone.generators[51]) || 0;
        const presetFine = (pzone.generators && pzone.generators[52]) || 0;

        let currentDetune = (midi - rootKey) * 100;
        currentDetune += (sample.pitchCorrection || 0);
        currentDetune += (instCoarse * 100) + instFine;
        currentDetune += (presetCoarse * 100) + presetFine;

        source.detune.value = currentDetune;

        // Envelope
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        const releaseTime = 0.1;

        const gainVal = (velocity / 127) * 0.8;
        gain.gain.setValueAtTime(gainVal, now);
        gain.gain.setValueAtTime(gainVal, now + duration - releaseTime);
        gain.gain.linearRampToValueAtTime(0, now + duration);

        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        source.stop(now + duration + 0.05);
    }

    /**
     * Trigger SFZ sample playback
     */
    triggerSample(ctx, buffer, midi, region, duration = 1.0, trackId = 0, velocity = 100) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const rootKey = region.pitch_keycenter !== undefined ? region.pitch_keycenter : (region.key !== undefined ? region.key : 60);
        const detune = (midi - rootKey) * 100;

        source.detune.value = detune;

        const gain = ctx.createGain();
        const now = ctx.currentTime;
        const releaseTime = 0.1;

        const gainVal = velocity / 127;
        gain.gain.setValueAtTime(gainVal, now);
        gain.gain.setValueAtTime(gainVal, now + duration - releaseTime);
        gain.gain.linearRampToValueAtTime(0, now + duration);

        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        source.stop(now + duration + 0.05);
    }

    /**
     * SFZ parser
     */
    parseSFZ(text) {
        const lines = text.split(/\r?\n/);
        let currentRegion = {};
        let groupParams = {};

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('//')) continue;

            if (line.includes('<group>')) {
                groupParams = {};
                this.parseOpCodes(line, groupParams);
                continue;
            }

            if (line.includes('<region>')) {
                currentRegion = { ...groupParams };
                this.parseOpCodes(line, currentRegion);
                this.regions.push(currentRegion);
                continue;
            }

            if (this.regions.length > 0) {
                this.parseOpCodes(line, this.regions[this.regions.length - 1]);
            }
        }
    }

    parseOpCodes(line, targetObj) {
        const sampleMatch = line.match(/sample=([^\r\n]+?)(?=\s+[a-zA-Z_]+=|\s*$)/);
        if (sampleMatch) {
            targetObj.sample = sampleMatch[1].trim();
        }

        const regex = /([a-zA-Z0-9_]+)=([^=\s]+)/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
            const key = match[1];
            if (key === 'sample') continue;

            let val = match[2];

            if (['key', 'lokey', 'hikey', 'pitch_keycenter'].includes(key)) {
                val = this.noteNameToMidi(val);
            } else if (!isNaN(val)) {
                val = parseFloat(val);
            }

            targetObj[key] = val;
        }
    }

    noteNameToMidi(str) {
        if (!isNaN(str)) return parseInt(str);

        const match = str.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
        if (!match) return parseInt(str) || 60;

        const noteMap = { 'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11 };
        const note = match[1].toUpperCase();
        const accidental = match[2];
        const octave = parseInt(match[3]);

        let midi = noteMap[note] + (octave + 1) * 12;
        if (accidental === '#') midi += 1;
        if (accidental === 'b') midi -= 1;

        return midi;
    }

    /**
     * Convert MIDI to frequency
     */
    midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }

    /**
     * Get AudioContext (for internal/legacy use)
     */
    getContext() {
        return this.engine?.ctx;
    }

    /**
     * Panic - stop all voices
     */
    panic() {
        if (this.engine) {
            this.engine.panic();
        }
    }
}
