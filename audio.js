export class AudioManager {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.trackChannels = []; // Array of { gain: GainNode, panner: StereoPannerNode }

        this.regions = []; // SFZ Regions
        this.buffers = {}; // Filename -> AudioBuffer

        // SF2 specific
        this.sf2Data = null;
        this.sf2Buffers = {}; // Sample index -> AudioBuffer
        // Track instruments: each track can have different preset
        this.trackInstruments = Array.from({ length: 8 }, () => ({ 
            bank: 0, 
            program: 0, 
            presetIndex: 0  // Direct preset index for SF2
        }));
        this.mode = 'oscillator'; // 'oscillator', 'sfz', 'sf2'
    }

    setTrackInstrument(trackId, bank, program, presetIndex = -1) {
        if (trackId >= 0 && trackId < 8) {
            this.trackInstruments[trackId] = { bank, program, presetIndex };
            console.log(`AudioManager: Track ${trackId} instrument set to Bank:${bank} Prog:${program} PresetIndex:${presetIndex}`);
        } else {
            console.warn("AudioManager: Invalid trackId for instrument set:", trackId);
        }
    }

    init() {
        if (this.ctx) return;

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.5;
        this.masterGain.connect(this.ctx.destination);

        // Create 8 Track Channels
        for (let i = 0; i < 8; i++) {
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();

            // Chain: Gain -> Panner -> Master
            gain.connect(panner);
            panner.connect(this.masterGain);

            this.trackChannels.push({ gain, panner });
        }

        console.log("AudioManager initialized");
    }

    setTrackVolume(trackId, volume) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        }
    }

    setTrackPan(trackId, pan) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].panner.pan.setValueAtTime(pan, this.ctx.currentTime);
        }
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    async loadSFZ(fileList) {
        this.init();
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
                    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
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
        // Handle sample= specially (can have spaces in path)
        const sampleMatch = line.match(/sample=([^\r\n]+?)(?=\s+[a-zA-Z_]+=|\s*$)/);
        if (sampleMatch) {
            targetObj.sample = sampleMatch[1].trim();
        }

        // Match other opcode=value pairs
        const regex = /([a-zA-Z0-9_]+)=([^=\s]+)/g;
        let match;
        while ((match = regex.exec(line)) !== null) {
            const key = match[1];
            if (key === 'sample') continue; // Already handled

            let val = match[2];

            // Convert note names to MIDI numbers for key-related opcodes
            if (['key', 'lokey', 'hikey', 'pitch_keycenter'].includes(key)) {
                val = this.noteNameToMidi(val);
            } else if (!isNaN(val)) {
                val = parseFloat(val);
            }

            targetObj[key] = val;
        }
    }

    noteNameToMidi(str) {
        // Handle both numbers and note names like C4, D#5, Eb3
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

    // SF2 Methods
    async loadSF2(file) {
        this.init();
        this.resume();

        try {
            const { SF2Parser } = await import('./sf2parser.js');
            const arrayBuffer = await file.arrayBuffer();
            const parser = new SF2Parser(arrayBuffer);
            this.sf2Data = parser.parse();

            console.log(`Parsed SF2: ${this.sf2Data.presets.length} presets, ${this.sf2Data.samples.length} samples`);

            // Pre-decode samples to AudioBuffers
            this.sf2Buffers = {};
            for (let i = 0; i < this.sf2Data.samples.length; i++) {
                const sample = this.sf2Data.samples[i];
                if (sample.sampleType === 1 || sample.sampleType === 0) { // Mono samples
                    const buffer = this.createAudioBufferFromSF2Sample(sample);
                    if (buffer) {
                        this.sf2Buffers[i] = buffer;
                    }
                }
            }

            console.log(`Decoded ${Object.keys(this.sf2Buffers).length} samples`);
            this.mode = 'sf2';
            
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

    createAudioBufferFromSF2Sample(sample) {
        if (!this.sf2Data.sampleData) return null;

        const start = sample.start;
        const end = sample.end;
        const length = end - start;

        if (length <= 0) return null;

        const buffer = this.ctx.createBuffer(1, length, sample.sampleRate);
        const channelData = buffer.getChannelData(0);

        // Convert Int16 to Float32
        for (let i = 0; i < length; i++) {
            channelData[i] = this.sf2Data.sampleData[start + i] / 32768.0;
        }

        return buffer;
    }

    getPresets() {
        if (!this.sf2Data) return [];
        return this.sf2Data.presets.map((p, index) => ({
            index: index,
            name: p.name,
            bank: p.bank,
            preset: p.preset,
            fullName: `${p.bank}:${p.preset} ${p.name}`
        }));
    }

    // Set preset by index for a specific track
    selectPreset(trackId, presetIndex) {
        if (!this.sf2Data || presetIndex < 0 || presetIndex >= this.sf2Data.presets.length) {
            console.warn("Invalid preset index:", presetIndex);
            return;
        }
        
        const preset = this.sf2Data.presets[presetIndex];
        this.setTrackInstrument(trackId, preset.bank, preset.preset, presetIndex);
        console.log(`Track ${trackId} preset changed to: ${preset.name} (Index: ${presetIndex})`);
    }

    playNote(midi, duration = 1.0, trackId = 0) {
        if (!this.ctx) return;

        if (this.mode === 'sf2' && this.sf2Data) {
            this.playSF2Note(midi, duration, trackId);
        } else if (this.mode === 'sfz' && this.regions.length > 0) {
            this.playSFZNote(midi, duration, trackId);
        } else {
            this.playOscillator(midi, duration, trackId);
        }
    }

    playOscillator(midi, duration = 0.2, trackId = 0) {
        if (!this.ctx) this.init();
        this.resume();

        const channel = this.trackChannels[trackId];
        const dest = channel ? channel.gain : this.masterGain;

        const osc = this.ctx.createOscillator();
        const envelope = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.midiToFreq(midi), this.ctx.currentTime);

        envelope.gain.setValueAtTime(0, this.ctx.currentTime);
        envelope.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        osc.connect(envelope);
        envelope.connect(dest);

        osc.start();
        osc.stop(this.ctx.currentTime + duration + 0.1);
    }

    playSFZNote(midi, duration, trackId = 0) {
        const velocity = 100;

        const region = this.regions.find(r => {
            const key = r.key !== undefined ? r.key : -1;
            const lokey = r.lokey !== undefined ? r.lokey : (key !== -1 ? key : 0);
            const hikey = r.hikey !== undefined ? r.hikey : (key !== -1 ? key : 127);

            const lovel = r.lovel !== undefined ? r.lovel : 0;
            const hivel = r.hivel !== undefined ? r.hivel : 127;

            return (midi >= lokey && midi <= hikey) && (velocity >= lovel && velocity <= hivel);
        });

        if (region && region.sample && this.buffers[region.sample]) {
            this.triggerSample(this.buffers[region.sample], midi, region, duration, trackId);
        } else {
            console.warn("No SFZ region found for note", midi);
        }
    }

    playSF2Note(midi, duration, trackId = 0) {
        try {
            if (!this.sf2Data || !this.sf2Data.presets) return;

            // Get track instrument settings
            const instrument = this.trackInstruments[trackId];
            if (!instrument) {
                console.warn(`No instrument set for track ${trackId}`);
                return;
            }

            // Get preset - prioritize presetIndex if set
            let preset;
            if (instrument.presetIndex >= 0 && instrument.presetIndex < this.sf2Data.presets.length) {
                preset = this.sf2Data.presets[instrument.presetIndex];
                console.log(`Track ${trackId} using preset index ${instrument.presetIndex}: ${preset.name}`);
            } else {
                // Fallback: search by bank/program
                preset = this.sf2Data.presets.find(p => 
                    p.preset === instrument.program && 
                    p.bank === instrument.bank
                );
                
                if (!preset) {
                    console.warn(`Preset not found for Bank:${instrument.bank} Program:${instrument.program}. Using first preset.`);
                    preset = this.sf2Data.presets[0];
                }
            }

            if (!preset || !preset.zones) {
                console.warn("No valid preset found");
                return;
            }

            const velocity = 100;

            // Find instrument from preset zones
            for (const pzone of preset.zones) {
                if (pzone.isGlobal) continue;
                if (pzone.instrumentIndex === undefined) continue;

                const inst = this.sf2Data.instruments[pzone.instrumentIndex];
                if (!inst || !inst.zones) continue;

                // Find sample zones matching the note
                for (const izone of inst.zones) {
                    if (izone.isGlobal) continue;
                    
                    const keyLo = izone.keyLo !== undefined ? izone.keyLo : 0;
                    const keyHi = izone.keyHi !== undefined ? izone.keyHi : 127;
                    const velLo = izone.velLo !== undefined ? izone.velLo : 0;
                    const velHi = izone.velHi !== undefined ? izone.velHi : 127;

                    if (midi >= keyLo && midi <= keyHi && velocity >= velLo && velocity <= velHi) {
                        if (izone.sampleIndex !== undefined && this.sf2Buffers[izone.sampleIndex]) {
                            const sample = this.sf2Data.samples[izone.sampleIndex];
                            this.triggerSF2Sample(
                                this.sf2Buffers[izone.sampleIndex], 
                                midi, 
                                sample, 
                                izone, 
                                pzone, 
                                duration, 
                                trackId
                            );
                            return; // Play first matching zone
                        }
                    }
                }
            }

            console.warn(`No matching zone found for note ${midi} in preset ${preset.name}`);
        } catch (e) {
            console.error("Error in playSF2Note:", e);
        }
    }

    triggerSF2Sample(buffer, midi, sample, izone, pzone, duration = 1.0, trackId = 0) {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;

        // Pitch adjustment logic considering SF2 generators
        // Generator 58: overridingRootKey
        let rootKey = sample.originalPitch;
        if (izone.generators && izone.generators[58] !== undefined) {
            rootKey = izone.generators[58];
        }

        // Generator 51: coarseTune (semitones)
        // Generator 52: fineTune (cents)
        const instCoarse = (izone.generators && izone.generators[51]) || 0;
        const instFine = (izone.generators && izone.generators[52]) || 0;
        const presetCoarse = (pzone.generators && pzone.generators[51]) || 0;
        const presetFine = (pzone.generators && pzone.generators[52]) || 0;

        // Total detune calculation
        // Base pitch difference
        let currentDetune = (midi - rootKey) * 100;

        // Add sample correction (cents)
        currentDetune += (sample.pitchCorrection || 0);

        // Add instrument tuning
        currentDetune += (instCoarse * 100) + instFine;

        // Add preset tuning
        currentDetune += (presetCoarse * 100) + presetFine;

        source.detune.value = currentDetune;

        // Envelope with duration and release
        const gain = this.ctx.createGain();
        const now = this.ctx.currentTime;
        const releaseTime = 0.1;

        gain.gain.setValueAtTime(0.8, now);
        gain.gain.setValueAtTime(0.8, now + duration - releaseTime);
        gain.gain.linearRampToValueAtTime(0, now + duration);

        source.connect(gain);
        const dest = this.trackChannels[trackId] ? this.trackChannels[trackId].gain : this.masterGain;
        gain.connect(dest);
        source.start(0);
        source.stop(now + duration + 0.05);
    }

    triggerSample(buffer, midi, region, duration = 1.0, trackId = 0) {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;

        const rootKey = region.pitch_keycenter !== undefined ? region.pitch_keycenter : (region.key !== undefined ? region.key : 60);
        const detune = (midi - rootKey) * 100;

        source.detune.value = detune;

        const gain = this.ctx.createGain();
        const now = this.ctx.currentTime;
        const releaseTime = 0.1;

        gain.gain.setValueAtTime(1, now);
        gain.gain.setValueAtTime(1, now + duration - releaseTime);
        gain.gain.linearRampToValueAtTime(0, now + duration);

        source.connect(gain);
        const dest = this.trackChannels[trackId] ? this.trackChannels[trackId].gain : this.masterGain;
        gain.connect(dest);
        source.start(0);
        source.stop(now + duration + 0.05);
    }

    midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }
}