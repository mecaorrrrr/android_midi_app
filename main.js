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
        this.undoStack = [];
        this.redoStack = [];

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
        this.setupFileMenu();
        this.setupMappingModal();

        // SFZ Input
        document.getElementById('sfz-file-input').addEventListener('change', async (e) => {
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
        document.getElementById('sf2-file-input').addEventListener('change', async (e) => {
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

        document.getElementById('preset-selector').addEventListener('change', (e) => {
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

        document.getElementById('file-input-project').addEventListener('change', (e) => {
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

        // Transport
        this.cardinalTime = 0;
        this.playbackStartTime = 0;
        this.isPlaying = false;
        this.bpm = 120;
        this.loopRegion = null; // { start: 0, end: 4 }
        this.isLooping = false;

        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    saveState() {
        // Deep copy songData for history
        try {
            const state = JSON.stringify(this.songData);
            this.undoStack.push(state);
            // Limit stack size
            if (this.undoStack.length > 50) this.undoStack.shift();
            this.redoStack = []; // Clear redo on new action
        } catch (e) {
            console.error("Failed to save state", e);
        }
    }

    undo() {
        if (this.undoStack.length === 0) {
            this.showToast("Nothing to Undo");
            return;
        }

        // Save current state to redo
        this.redoStack.push(JSON.stringify(this.songData));

        const prevState = this.undoStack.pop();
        this.songData = JSON.parse(prevState);
        this.input.clearSelection(); // Clear selection to avoid invalid references

        this.showToast("Undo");
    }

    redo() {
        if (this.redoStack.length === 0) {
            this.showToast("Nothing to Redo");
            return;
        }

        this.undoStack.push(JSON.stringify(this.songData));

        const nextState = this.redoStack.pop();
        this.songData = JSON.parse(nextState);
        this.input.clearSelection();

        this.showToast("Redo");
    }

    showToast(message) {
        let toast = document.getElementById('toast-notification');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast-notification';
            Object.assign(toast.style, {
                position: 'fixed',
                bottom: '100px',
                left: '50%',
                transform: 'translateX(-50%)',
                backgroundColor: 'rgba(45, 52, 54, 0.9)',
                color: '#fff',
                padding: '10px 20px',
                borderRadius: '20px',
                zIndex: '2000',
                transition: 'opacity 0.3s',
                pointerEvents: 'none',
                opacity: '0'
            });
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            toast.style.opacity = '0';
        }, 1500);
    }

    resize() {
        this.ui.resize();
    }

    setupFileMenu() {
        // Hide legacy buttons
        const ids = ['btn-play', 'btn-stop', 'btn-save', 'btn-load', 'btn-export', 'btn-load-sfz', 'btn-load-sf2'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // Create Container for Menu if not exists
        let menuContainer = document.getElementById('menu-container');
        if (!menuContainer) {
            const status = document.getElementById('status-display');
            if (status && status.parentElement) {
                menuContainer = document.createElement('div');
                menuContainer.id = 'menu-container';
                menuContainer.style.display = 'inline-block';
                menuContainer.style.marginRight = '10px';
                status.parentElement.insertBefore(menuContainer, status);
            } else {
                menuContainer = document.body;
            }
        }

        // FILE Button
        const fileBtn = document.createElement('button');
        fileBtn.textContent = 'FILE';
        fileBtn.className = 'control-btn'; // Use existing class if available
        fileBtn.style.fontWeight = 'bold';
        
        // Ribbon (Dropdown)
        const ribbon = document.createElement('div');
        ribbon.style.display = 'none';
        ribbon.style.position = 'absolute';
        ribbon.style.backgroundColor = '#2d3436';
        ribbon.style.border = '1px solid #555';
        ribbon.style.padding = '5px';
        ribbon.style.zIndex = '1000';
        ribbon.style.flexDirection = 'column';
        ribbon.style.gap = '5px';
        ribbon.style.minWidth = '120px';
        ribbon.style.borderRadius = '4px';

        fileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = ribbon.style.display === 'flex';
            ribbon.style.display = isVisible ? 'none' : 'flex';
            
            const rect = fileBtn.getBoundingClientRect();
            ribbon.style.top = `${rect.bottom + window.scrollY + 5}px`;
            ribbon.style.left = `${rect.left + window.scrollX}px`;
        });

        document.addEventListener('click', () => {
            ribbon.style.display = 'none';
        });

        const addMenuItem = (text, onClick) => {
            const item = document.createElement('button');
            item.textContent = text;
            item.className = 'control-btn';
            item.style.width = '100%';
            item.style.textAlign = 'left';
            item.style.marginBottom = '2px';
            item.addEventListener('click', onClick);
            ribbon.appendChild(item);
        };

        addMenuItem('Save', () => this.saveProject());
        addMenuItem('Load', () => document.getElementById('file-input-project').click());
        addMenuItem('Export MIDI', () => this.exportMIDI());
        addMenuItem('SFZ', () => document.getElementById('sfz-file-input').click());
        addMenuItem('SF2', () => document.getElementById('sf2-file-input').click());
        addMenuItem('Controller Map', () => this.openMappingModal());

        menuContainer.appendChild(fileBtn);
        document.body.appendChild(ribbon);
    }

    setupMappingModal() {
        const modal = document.getElementById('mapping-modal');
        const closeBtn = document.getElementById('btn-close-mapping');
        const resetBtn = document.getElementById('btn-reset-mapping');

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            this.input.isMapping = false; // Cancel mapping if open
        });

        resetBtn.addEventListener('click', () => {
            if (confirm('Reset all button mappings to default?')) {
                this.input.resetMapping();
                this.updateMappingUI();
            }
        });
    }

    openMappingModal() {
        const modal = document.getElementById('mapping-modal');
        modal.style.display = 'flex';
        this.updateMappingUI();
    }

    updateMappingUI() {
        const container = document.getElementById('mapping-list');
        container.innerHTML = '';

        const map = this.input.buttonMap;
        // Order keys for display
        const keys = ['A', 'B', 'X', 'Y', 'L1', 'R1', 'L2', 'R2', 'SELECT', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT'];

        keys.forEach(key => {
            const val = map[key];
            const div = document.createElement('div');
            div.className = 'mapping-item';
            
            const label = document.createElement('span');
            label.textContent = key;
            
            const btn = document.createElement('button');
            btn.className = 'mapping-btn';
            btn.textContent = `Btn ${val}`;
            btn.onclick = () => {
                btn.textContent = 'Press...';
                btn.classList.add('waiting');
                this.input.startMapping(key, (target, newIndex) => {
                    btn.textContent = `Btn ${newIndex}`;
                    btn.classList.remove('waiting');
                });
            };

            div.appendChild(label);
            div.appendChild(btn);
            container.appendChild(div);
        });
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
            
            let nextTime = this.cardinalTime + advance;

            if (this.isLooping && this.loopRegion) {
                if (nextTime >= this.loopRegion.end) {
                    // Play until end of loop
                    this.checkAndPlayNotes(this.cardinalTime, this.loopRegion.end);
                    
                    // Loop back
                    const remainder = nextTime - this.loopRegion.end;
                    this.cardinalTime = this.loopRegion.start + remainder;
                    
                    // Play from start of loop
                    this.checkAndPlayNotes(this.loopRegion.start, this.cardinalTime);
                } else {
                    this.checkAndPlayNotes(this.cardinalTime, nextTime);
                    this.cardinalTime = nextTime;
                }
            } else {
                this.checkAndPlayNotes(this.cardinalTime, nextTime);
                this.cardinalTime = nextTime;
            }
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
        const anySolo = this.songData.tracks.some(t => t.solo);

        for (const track of this.songData.tracks) {
            if (anySolo) {
                if (!track.solo) continue;
            }
            if (track.muted) continue;

            for (const note of track.notes) {
                if (note.time >= start && note.time < end) {
                    const currentBpm = this.transport.getBpmAt(note.time);
                    const velocity = note.velocity !== undefined ? note.velocity : 100;
                    this.audio.playNote(note.pitch, note.duration * (60 / currentBpm), track.id, velocity);
                }
            }
        }
    }

    populatePresetSelector() {
        const selector = document.getElementById('preset-selector');
        const presets = this.audio.getPresets();
        
        // Sort presets by Bank then Program
        const sortedPresets = [...presets].sort((a, b) => {
            if (a.bank !== b.bank) return a.bank - b.bank;
            return a.preset - b.preset;
        });

        selector.innerHTML = '';
        sortedPresets.forEach((preset) => {
            const opt = document.createElement('option');
            opt.value = preset.index;
            opt.textContent = `${preset.bank}:${preset.preset} ${preset.name}`;
            selector.appendChild(opt);
        });

        selector.disabled = false;

        // Select first preset (sorted) for current track
        if (sortedPresets.length > 0) {
            const first = sortedPresets[0];
            this.audio.selectPreset(this.currentTrackId, first.index);
            selector.value = first.index;
            
            // Update current track data
            const track = this.songData.tracks[this.currentTrackId];
            track.bank = first.bank;
            track.program = first.preset;
            track.presetIndex = first.index;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});