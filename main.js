import { UIManager } from './ui.js';
import { InputManager } from './input.js';
import { AudioManager } from './audio.js';
import { TransportManager } from './transport.js';

console.log("Initializing Android MIDI App...");

class App {
    constructor() {
        this.songData = {
            tracks: Array.from({ length: 8 }, (_, i) => ({
                id: i,
                name: `Track ${i + 1}`,
                notes: [],
                volume: 0.8,
                pan: 0.0,
                muted: false,
                solo: false,
                program: 0,
                bank: 0,
                presetIndex: 0
            }))
        };
        this.currentTrackId = 0;

        this.transport = new TransportManager(this);
        this.ui = new UIManager(this);
        this.audio = new AudioManager();
        this.input = new InputManager(this);

        this.lastTime = 0;
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Init audio on first interaction
        document.body.addEventListener('click', () => {
            if (!this.audio.ctx) this.audio.init();
            this.audio.resume();
        }, { once: true });

        // File Loading
        const btnLoad = document.getElementById('btn-load-sfz');
        const fileInput = document.getElementById('sfz-file-input');

        btnLoad.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                document.getElementById('status-display').textContent = "Loading SFZ...";
                const success = await this.audio.loadSFZ(e.target.files);
                document.getElementById('status-display').textContent = success ? "SFZ Loaded" : "Load Failed";
                // Clear SF2 preset selector when loading SFZ
                const presetSel = document.getElementById('preset-selector');
                presetSel.innerHTML = '<option value="">-- SFZ Mode --</option>';
                presetSel.disabled = true;
            }
        });

        // SF2 File Loading
        const btnLoadSF2 = document.getElementById('btn-load-sf2');
        const sf2Input = document.getElementById('sf2-file-input');
        const presetSelector = document.getElementById('preset-selector');

        btnLoadSF2.addEventListener('click', () => {
            sf2Input.click();
        });

        sf2Input.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                document.getElementById('status-display').textContent = "Loading SF2...";
                const success = await this.audio.loadSF2(e.target.files[0]);
                if (success) {
                    document.getElementById('status-display').textContent = "SF2 Loaded";
                    this.populatePresetSelector();
                    this.validateTracksAgainstSF2();
                } else {
                    document.getElementById('status-display').textContent = "SF2 Load Failed";
                }
            }
        });

        presetSelector.addEventListener('change', (e) => {
            const idx = parseInt(e.target.value);
            if (!isNaN(idx) && idx >= 0) {
                const presets = this.audio.getPresets();
                if (presets && presets[idx]) {
                    const preset = presets[idx];
                    
                    console.log(`[UI] Selected Preset Index: ${idx}, Name: ${preset.name}`);
                    console.log(`[UI] Bank: ${preset.bank}, Program: ${preset.preset}`);

                    // Update Track
                    const track = this.songData.tracks[this.currentTrackId];
                    track.bank = preset.bank;
                    track.program = preset.preset;
                    track.presetIndex = idx;

                    this.audio.selectPreset(this.currentTrackId, idx);
                    console.log(`[UI] Track ${this.currentTrackId + 1} updated to Bank:${track.bank} Program:${track.program} Index:${idx}`);

                    // Preview Note
                    this.audio.playNote(60, 0.5, this.currentTrackId);
                }
            }
        });

        document.getElementById('btn-save').addEventListener('click', () => {
            this.saveProject();
        });

        const loadBtn = document.getElementById('btn-load');
        const fileInputProject = document.getElementById('file-input-project');
        loadBtn.addEventListener('click', () => fileInputProject.click());
        fileInputProject.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.loadProject(e.target.files[0]);
            }
        });

        // Transport/Structure Controls
        document.getElementById('btn-add-bpm').addEventListener('click', () => {
            const cursorTime = this.input.state.cursor.time;
            const currentBpm = this.transport.getBpmAt(cursorTime);
            const targetTime = Math.round(cursorTime * 100) / 100;

            const val = prompt(`Enter BPM at ${targetTime}:`, currentBpm);
            if (val) {
                const bpm = parseFloat(val);
                if (!isNaN(bpm) && bpm > 0) {
                    this.transport.addTempoChange(targetTime, bpm);
                    alert(`Added BPM change to ${bpm} at beat ${targetTime}`);
                }
            }
        });

        document.getElementById('btn-add-ts').addEventListener('click', () => {
            const cursorTime = this.input.state.cursor.time;
            const context = this.transport.getMeasureAt(cursorTime);
            const currentTs = context.timeSig;
            const targetTime = Math.round(cursorTime * 100) / 100;

            const val = prompt(`Enter Time Signature (num/den) at ${targetTime}:`, `${currentTs.num}/${currentTs.den}`);
            if (val) {
                const parts = val.split('/');
                if (parts.length === 2) {
                    const num = parseInt(parts[0]);
                    const den = parseInt(parts[1]);
                    if (!isNaN(num) && !isNaN(den)) {
                        this.transport.addTimeSigChange(targetTime, num, den);
                        alert(`Added Time Sig change to ${num}/${den} at beat ${targetTime}`);
                    }
                }
            }
        });

        document.getElementById('btn-export').addEventListener('click', () => {
            this.exportMIDI();
        });

        // Transport
        this.cardinalTime = 0;
        this.playbackStartTime = 0;
        this.isPlaying = false;
        this.bpm = 120;

        document.getElementById('btn-play').addEventListener('click', () => {
            if (!this.isPlaying) {
                this.playbackStartTime = this.cardinalTime;
            }
            this.isPlaying = true;
            this.audio.resume();
        });

        document.getElementById('btn-stop').addEventListener('click', () => {
            this.isPlaying = false;
            this.cardinalTime = this.playbackStartTime;
        });

        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    resize() {
        this.ui.resize();
    }

    validateTracksAgainstSF2() {
        const presets = this.audio.getPresets();
        if (!presets || presets.length === 0) return;

        const defaultPreset = presets[0];
        let updatedCount = 0;

        this.songData.tracks.forEach(t => {
            // Check if current bank/program exists
            const matchingPreset = presets.find(p => 
                p.bank === t.bank && p.preset === t.program
            );

            if (!matchingPreset) {
                // Not found - Auto assign Default
                t.bank = defaultPreset.bank;
                t.program = defaultPreset.preset;
                t.presetIndex = 0;
                this.audio.selectPreset(t.id, 0);
                console.log(`Track ${t.id} auto-corrected to ${t.bank}:${t.program} (${defaultPreset.name})`);
                updatedCount++;
            } else {
                // Found - Ensure index is consistent
                const idx = presets.indexOf(matchingPreset);
                t.presetIndex = idx;
                this.audio.selectPreset(t.id, idx);
            }
        });

        if (updatedCount > 0) {
            console.log(`Validated SF2: ${updatedCount} tracks updated to default.`);
            this.updateTrackUI();
        }
    }

    updateTrackUI() {
        const track = this.songData.tracks[this.currentTrackId];

        // Update Preset Selector if SF2 loaded
        if (this.audio.mode === 'sf2' && this.audio.sf2Data) {
            const presetSel = document.getElementById('preset-selector');
            const presets = this.audio.getPresets();
            
            // Find index matching track bank/program
            const matchingPreset = presets.find(p => 
                p.bank === track.bank && p.preset === track.program
            );
            
            if (matchingPreset) {
                const idx = presets.indexOf(matchingPreset);
                presetSel.value = idx;
                presetSel.disabled = false;
            } else {
                // Use stored presetIndex or fallback to 0
                presetSel.value = track.presetIndex || 0;
                presetSel.disabled = false;
            }
        }
    }

    loop(timestamp) {
        const deltaTime = (timestamp - this.lastTime) / 1000;
        this.lastTime = timestamp;

        this.input.update();

        if (this.isPlaying) {
            const currentBpm = this.transport.getBpmAt(this.cardinalTime);
            const beatsPerSecond = currentBpm / 60;
            const advance = beatsPerSecond * deltaTime;
            const previousTime = this.cardinalTime;
            this.cardinalTime += advance;

            this.checkAndPlayNotes(previousTime, this.cardinalTime);
        }

        this.ui.draw(this.input.state, this.cardinalTime);

        requestAnimationFrame(this.loop);
    }

    saveProject() {
        const project = {
            version: 1,
            date: new Date().toISOString(),
            songData: this.songData,
            transport: {
                bpm: this.bpm,
                tempoMap: this.transport.tempoMap,
                timeSigMap: this.transport.timeSigMap
            }
        };

        const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    loadProject(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const project = JSON.parse(e.target.result);
                if (project.version !== 1) {
                    console.warn("Unknown project version");
                }

                // Restore data
                this.songData = project.songData;
                this.currentTrackId = 0;

                // Restore Transport
                if (project.transport) {
                    this.transport.tempoMap = project.transport.tempoMap || [{ beat: 0, bpm: 120 }];
                    this.transport.timeSigMap = project.transport.timeSigMap || [{ beat: 0, num: 4, den: 4 }];
                }

                // Sync Instruments to Audio Engine
                if (this.audio.sf2Data) {
                    this.validateTracksAgainstSF2();
                } else {
                    // Restore values even if no SF2 (will validate when SF2 is loaded)
                    this.songData.tracks.forEach(t => {
                        const idx = t.presetIndex !== undefined ? t.presetIndex : -1;
                        this.audio.setTrackInstrument(t.id, t.bank || 0, t.program || 0, idx);
                    });
                }

                // Reset State
                this.cardinalTime = 0;
                this.isPlaying = false;
                this.input.state.cursor.time = 0;

                // Force UI Update
                this.updateTrackUI();
                this.ui.draw(this.input.state, this.cardinalTime);

                console.log("Project loaded");
                alert("Project loaded successfully.");

            } catch (err) {
                console.error("Failed to load project", err);
                alert("Failed to load project: " + err.message);
            }
        };
        reader.readAsText(file);
    }

    async exportMIDI() {
        const { MidiEncoder } = await import('./midi_encoder.js');
        const encoder = new MidiEncoder();
        const PPQ = 480;

        const tracks = [];

        // 1. Conductor Track (Tempo, TimeSig)
        const conductor = encoder.createTrack();

        this.transport.tempoMap.forEach(t => {
            const tick = Math.round(t.beat * PPQ);
            const micros = Math.round(60000000 / t.bpm);
            encoder.addEvent(conductor, tick, [0xFF, 0x51, 0x03, (micros >> 16) & 0xFF, (micros >> 8) & 0xFF, micros & 0xFF]);
        });

        this.transport.timeSigMap.forEach(ts => {
            const tick = Math.round(ts.beat * PPQ);
            const denPower = Math.log2(ts.den);
            encoder.addEvent(conductor, tick, [0xFF, 0x58, 0x04, ts.num, denPower, 24, 8]);
        });

        // Set Track Name
        encoder.addEvent(conductor, 0, [0xFF, 0x03, 9, ...Array.from("Conductor").map(c => c.charCodeAt(0))]);

        tracks.push(conductor);

        // 2. Instrument Tracks
        for (const trackData of this.songData.tracks) {
            const track = encoder.createTrack();

            // Track Name
            const nameBytes = Array.from(trackData.name).map(c => c.charCodeAt(0));
            encoder.addEvent(track, 0, [0xFF, 0x03, nameBytes.length, ...nameBytes]);

            // Channel (0-15)
            const ch = trackData.id % 16;

            // Volume (CC 7)
            const vol = Math.round(trackData.volume * 127);
            encoder.addEvent(track, 0, [0xB0 | ch, 7, vol]);

            // Pan (CC 10)
            const pan = Math.round((trackData.pan + 1) * 63.5);
            encoder.addEvent(track, 0, [0xB0 | ch, 10, pan]);

            // Bank Select (CC 0 for MSB, CC 32 for LSB if needed)
            if (trackData.bank !== undefined && trackData.bank !== 0) {
                encoder.addEvent(track, 0, [0xB0 | ch, 0, trackData.bank]);
            }

            // Program Change
            const prog = trackData.program || 0;
            encoder.addEvent(track, 0, [0xC0 | ch, prog]);

            // Notes
            for (const note of trackData.notes) {
                const onTick = Math.round(note.time * PPQ);
                const offTick = Math.round((note.time + note.duration) * PPQ);

                // Note On
                encoder.addEvent(track, onTick, [0x90 | ch, note.pitch, 100]);
                // Note Off
                encoder.addEvent(track, offTick, [0x80 | ch, note.pitch, 0]);
            }

            tracks.push(track);
        }

        // Build file
        const fileData = encoder.buildFile(tracks, PPQ);

        // Download
        const blob = new Blob([fileData], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `song_${Date.now()}.mid`;
        a.click();
        URL.revokeObjectURL(url);
    }

    checkAndPlayNotes(start, end) {
        for (const track of this.songData.tracks) {
            if (track.muted) continue;

            for (const note of track.notes) {
                if (note.time >= start && note.time < end) {
                    const currentBpm = this.transport.getBpmAt(note.time);
                    this.audio.playNote(note.pitch, note.duration * (60 / currentBpm), track.id);
                }
            }
        }
    }

    populatePresetSelector() {
        const selector = document.getElementById('preset-selector');
        const presets = this.audio.getPresets();

        selector.innerHTML = '';
        presets.forEach((preset, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = `${preset.bank}:${preset.preset} ${preset.name}`;
            selector.appendChild(opt);
        });

        selector.disabled = false;

        // Select first preset for current track
        if (presets.length > 0) {
            this.audio.selectPreset(this.currentTrackId, 0);
            selector.value = 0;
            
            // Update current track data
            const track = this.songData.tracks[this.currentTrackId];
            track.bank = presets[0].bank;
            track.program = presets[0].preset;
            track.presetIndex = 0;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});