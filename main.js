import { UIManager } from './ui.js';
import { InputManager } from './input.js';
import { AudioManager } from './audio.js';
import { TransportManager } from './transport.js';
import { Scheduler } from './scheduler.js';
import { SongView } from './song_view.js';
import {
    createSong, SONG_VERSION, getPattern, patternsOfTrack, createPattern, addClip,
    clipAt, forEachSongNote, flattenTrack, songEnd
} from './song.js';

const DEFAULT_PATTERN_BARS = 4;

console.log("Initializing Android MIDI App...");

class App {
    constructor() {
        this.songData = createSong();

        // Views: 'song' (arrangement) or 'pattern' (piano roll of one pattern)
        this.view = 'pattern';
        this.currentPatternId = null;
        this.patternContextStart = 0; // Song beat the edited pattern is viewed at (for ghost notes)
        this.lastPatternByTrack = {};
        this.songState = { cursorBar: 0, selection: null, selectionStart: null, clipboard: null };
        this.loops = {
            song: { region: null, enabled: false },
            pattern: { region: null, enabled: false } // pattern-local; the whole pattern loops when disabled
        };
        this.undoStack = [];
        this.redoStack = [];

        this.currentTrackId = 0;

        this.transport = new TransportManager(this);
        this.scheduler = new Scheduler(this);
        this.ui = new UIManager(this);
        this.songView = new SongView(this);
        this.audio = new AudioManager();
        this.input = new InputManager(this);

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
        this.setupTrackListModal();

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

        // Transport
        this.cardinalTime = 0;
        this.playbackStartTime = 0;
        this.isPlaying = false;
        this.bpm = 120;

        this.setupViewTabs();
        this.startNewSong();

        this.loop = this.loop.bind(this);
        requestAnimationFrame(this.loop);
    }

    // ------------------------------------------------------------ Song / views

    get currentPattern() {
        return getPattern(this.songData, this.currentPatternId);
    }

    // Loop settings of the current view (the piano roll ruler and SELECT button use these)
    get loopRegion() { return this.loops[this.view].region; }
    set loopRegion(region) { this.loops[this.view].region = region; }
    get isLooping() { return this.loops[this.view].enabled; }
    set isLooping(enabled) { this.loops[this.view].enabled = enabled; }

    getPatternBarLength() {
        return this.transport.getBaseBarLength();
    }

    createEmptyPattern(trackId) {
        return createPattern(this.songData, trackId, DEFAULT_PATTERN_BARS * this.getPatternBarLength());
    }

    startNewSong() {
        this.songData = createSong();
        const pattern = this.createEmptyPattern(0);
        addClip(this.songData, 0, pattern.id, 0);
        this.openPattern(pattern.id, 0);
    }

    // Called after undo/redo replaced songData with a copy
    afterSongDataReplaced() {
        this.input.clearSelection();
        this.input.song.clearSelection();
        if (this.view === 'pattern' && !this.currentPattern) {
            this.showSong();
        }
        this.updateViewUI();
    }

    // Loop range used by the scheduler, in the current view's timeline
    getPlaybackLoop() {
        const loop = this.loops[this.view];
        if (this.view === 'pattern') {
            const pattern = this.currentPattern;
            if (!pattern) return null;
            if (loop.enabled && loop.region) return loop.region;
            return { start: 0, end: pattern.length };
        }
        return loop.enabled && loop.region ? loop.region : null;
    }

    forEachPlaybackNote(fromBeat, toBeat, fn) {
        if (this.view === 'song') {
            forEachSongNote(this.songData, fromBeat, toBeat, fn);
            return;
        }
        // Pattern view plays the edited pattern even if its track is muted
        const pattern = this.currentPattern;
        if (!pattern) return;
        for (const note of pattern.notes) {
            if (note.time >= fromBeat && note.time < toBeat && note.time < pattern.length) {
                fn(pattern.trackId, note.time, note);
            }
        }
    }

    // Notes of other tracks that sound while the edited pattern plays in the song (pattern-local times)
    getGhostNotes() {
        const pattern = this.currentPattern;
        if (!pattern) return [];
        const offset = this.patternContextStart;
        const ghosts = [];
        forEachSongNote(this.songData, offset, offset + pattern.length, (trackId, time, note) => {
            if (trackId !== pattern.trackId) {
                ghosts.push({ time: time - offset, pitch: note.pitch, duration: note.duration });
            }
        });
        return ghosts;
    }

    // Song-timeline beat under the cursor of the current view
    getSongCursorBeat() {
        if (this.view === 'song') return this.transport.barToBeat(this.songState.cursorBar);
        return this.patternContextStart + this.input.state.cursor.time;
    }

    setSongCursorBeat(beat) {
        if (this.view === 'song') {
            this.songState.cursorBar = Math.floor(this.transport.beatToBar(beat) + 1e-6);
        } else {
            const pattern = this.currentPattern;
            const local = beat - this.patternContextStart;
            if (pattern && local >= 0 && local < pattern.length) this.input.state.cursor.time = local;
        }
    }

    // Beat where playback starts in the current view
    getPlayStartBeat() {
        if (this.view === 'song') return this.transport.barToBeat(this.songState.cursorBar);
        return this.input.state.cursor.time;
    }

    openPattern(patternId, contextStart = null) {
        const pattern = getPattern(this.songData, patternId);
        if (!pattern) return;
        if (this.isPlaying) this.stopPlayback();

        if (this.currentPatternId !== patternId) {
            this.loops.pattern = { region: null, enabled: false };
        }
        if (contextStart === null) {
            // View the pattern at its placement closest to the current context
            const clips = this.songData.clips.filter(c => c.patternId === patternId);
            if (clips.length > 0) {
                const distance = (c) => Math.abs(c.start - this.patternContextStart);
                clips.sort((a, b) => distance(a) - distance(b));
                contextStart = clips[0].start;
            } else {
                contextStart = this.patternContextStart;
            }
        }

        this.currentPatternId = pattern.id;
        this.patternContextStart = contextStart;
        this.lastPatternByTrack[pattern.trackId] = pattern.id;
        this.currentTrackId = pattern.trackId;
        this.view = 'pattern';
        this.input.onViewChanged();
        this.updateTrackUI();
        this.updateViewUI();
    }

    showSong() {
        if (this.isPlaying) this.stopPlayback();
        this.view = 'song';
        this.input.onViewChanged();
        this.updateViewUI();
    }

    // SELECT long press / header tabs
    toggleView() {
        if (this.view === 'pattern') {
            this.showSong();
            return;
        }
        const beat = this.transport.barToBeat(this.songState.cursorBar);
        const clip = clipAt(this.songData, this.currentTrackId, beat);
        if (clip) {
            this.openPattern(clip.patternId, clip.start);
        } else {
            this.openPattern(this.getOrCreateTrackPattern(this.currentTrackId).id, beat);
        }
    }

    // Pattern last edited on the track, or its newest pattern, or a new empty one
    getOrCreateTrackPattern(trackId) {
        const last = getPattern(this.songData, this.lastPatternByTrack[trackId]);
        if (last) return last;
        const patterns = patternsOfTrack(this.songData, trackId);
        if (patterns.length > 0) return patterns[patterns.length - 1];
        this.saveState();
        return this.createEmptyPattern(trackId);
    }

    selectTrack(trackId) {
        this.currentTrackId = trackId;
        this.input.updateStatus(`Track: ${trackId + 1}`);
        if (this.view === 'pattern') {
            this.openPattern(this.getOrCreateTrackPattern(trackId).id);
        } else {
            this.updateTrackUI();
        }
    }

    setupViewTabs() {
        document.getElementById('tab-song').addEventListener('click', () => {
            if (this.view !== 'song') this.toggleView();
        });
        document.getElementById('tab-pattern').addEventListener('click', () => {
            if (this.view !== 'pattern') this.toggleView();
        });
    }

    updateViewUI() {
        document.getElementById('tab-song').classList.toggle('active', this.view === 'song');
        document.getElementById('tab-pattern').classList.toggle('active', this.view === 'pattern');
        const label = document.getElementById('tab-pattern-label');
        const pattern = this.currentPattern;
        if (pattern) {
            const bars = +(pattern.length / this.getPatternBarLength()).toFixed(2);
            const trackName = this.songData.tracks[pattern.trackId].name;
            label.textContent = `${trackName} · ${pattern.name} · ${bars} bar${bars === 1 ? '' : 's'}`;
        } else {
            label.textContent = '';
        }
    }

    setCursorInfo(text) {
        const el = document.getElementById('cursor-info');
        if (el && el.textContent !== text) el.textContent = text;
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
        this.afterSongDataReplaced();

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
        this.afterSongDataReplaced();

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
        const ids = ['btn-play', 'btn-stop', 'btn-save', 'btn-load', 'btn-export', 'btn-load-sfz', 'btn-load-sf2', 'btn-add-marker', 'btn-add-bpm', 'btn-add-ts'];
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

        // ADD Menu (similar to FILE menu)
        this.setupAddMenu();
    }

    setupAddMenu() {
        // Create marker navigation container (left of ADD button)
        const navContainer = document.createElement('div');
        navContainer.style.display = 'inline-flex';
        navContainer.style.gap = '2px';
        navContainer.style.marginRight = '5px';
        navContainer.style.alignItems = 'center';

        const markerLabel = document.createElement('span');
        markerLabel.textContent = 'Marker ';
        markerLabel.style.color = '#b2bec3';
        markerLabel.style.fontSize = '14px';
        markerLabel.style.marginRight = '4px';
        navContainer.appendChild(markerLabel);
        
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '◀';
        prevBtn.className = 'control-btn';
        prevBtn.title = 'Previous Marker';
        prevBtn.addEventListener('click', () => this.navigateToPrevMarker());
        
        const nextBtn = document.createElement('button');
        nextBtn.textContent = '▶';
        nextBtn.className = 'control-btn';
        nextBtn.title = 'Next Marker';
        nextBtn.addEventListener('click', () => this.navigateToNextMarker());
        
        navContainer.appendChild(prevBtn);
        navContainer.appendChild(nextBtn);
        
        // Create ADD Button
        const addBtn = document.createElement('button');
        addBtn.textContent = 'ADD';
        addBtn.className = 'control-btn';
        addBtn.style.fontWeight = 'bold';
        
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

        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = ribbon.style.display === 'flex';
            ribbon.style.display = isVisible ? 'none' : 'flex';
            
            const rect = addBtn.getBoundingClientRect();
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

        addMenuItem('Marker', () => this.addMarker());
        addMenuItem('BPM', () => this.addBpm());
        addMenuItem('Time Sig', () => this.addTimeSig());

        // Insert before preset selector
        const presetSel = document.getElementById('preset-selector');
        if (presetSel && presetSel.parentElement) {
            // Insert navigation first, then ADD button
            presetSel.parentElement.insertBefore(navContainer, presetSel);
            presetSel.parentElement.insertBefore(addBtn, presetSel);
        }
        document.body.appendChild(ribbon);
    }

    addMarker() {
        const cursorTime = this.getSongCursorBeat();
        const result = this.transport.addMarker(cursorTime);
        if (result.removed) {
            this.showToast(`Marker ${result.label} removed`);
        } else {
            this.showToast(`Marker ${result.label} added at beat ${cursorTime.toFixed(2)}`);
        }
    }

    addBpm() {
        const cursorTime = this.getSongCursorBeat();
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
    }

    addTimeSig() {
        const cursorTime = this.getSongCursorBeat();
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
    }

    navigateToPrevMarker() {
        const cursorTime = this.getSongCursorBeat();
        const prevMarker = this.transport.getPrevMarker(cursorTime);
        if (prevMarker) {
            this.setSongCursorBeat(prevMarker.beat);
            this.showToast(`Jump to marker ${prevMarker.label}`);
        } else {
            this.showToast('No marker on the left');
        }
    }

    navigateToNextMarker() {
        const cursorTime = this.getSongCursorBeat();
        const nextMarker = this.transport.getNextMarker(cursorTime);
        if (nextMarker) {
            this.setSongCursorBeat(nextMarker.beat);
            this.showToast(`Jump to marker ${nextMarker.label}`);
        } else {
            this.showToast('No marker on the right');
        }
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

    setupTrackListModal() {
        this.isTrackListOpen = false;
        document.getElementById('btn-close-tracklist').addEventListener('click', () => {
            this.toggleTrackListModal(false);
        });
    }

    toggleTrackListModal(show) {
        const modal = document.getElementById('track-list-modal');
        if (show) {
            this.updateTrackListUI();
            modal.style.display = 'flex';
            this.isTrackListOpen = true;
        } else {
            modal.style.display = 'none';
            this.isTrackListOpen = false;
        }
    }

    updateTrackListUI() {
        const tbody = document.getElementById('track-list-body');
        tbody.innerHTML = '';

        this.songData.tracks.forEach(track => {
            const tr = document.createElement('tr');
            tr.className = 'track-row';
            if (track.id === this.currentTrackId) {
                tr.classList.add('active');
            }

            const instrumentName = this.getInstrumentName(track);

            tr.innerHTML = `
                <td>${track.id + 1}</td>
                <td>${track.name}</td>
                <td>${instrumentName}</td>
                <td>${Math.round(track.volume * 100)}%</td>
                <td>${track.pan.toFixed(1)}</td>
                <td><button class="track-btn ${track.solo ? 'active' : ''}" data-action="solo">Solo</button></td>
                <td><button class="track-btn ${track.muted ? 'active-mute' : ''}" data-action="mute">Mute</button></td>
            `;

            tr.addEventListener('click', () => {
                this.selectTrack(track.id);
                this.updateTrackListUI();
            });

            tr.querySelector('[data-action="solo"]').addEventListener('click', (e) => {
                e.stopPropagation();
                track.solo = !track.solo;
                this.updateTrackListUI();
            });

            tr.querySelector('[data-action="mute"]').addEventListener('click', (e) => {
                e.stopPropagation();
                track.muted = !track.muted;
                this.updateTrackListUI();
            });

            tbody.appendChild(tr);
        });
    }

    getInstrumentName(track) {
        if (this.audio.hasSoundBank()) {
            const presets = this.audio.getPresets();
            // Try to find by index first, then bank/prog
            let p = presets[track.presetIndex];
            if (!p || p.bank !== track.bank || p.preset !== track.program) {
                p = presets.find(pr => pr.bank === track.bank && pr.preset === track.program) || p;
            }
            if (p) return p.name;
        } else if (this.audio.mode === 'sfz') {
            return "SFZ Sample";
        }
        return "Sine Wave";
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
        if (this.audio.hasSoundBank()) {
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

    togglePlayback(fromBeat) {
        if (this.isPlaying) {
            this.stopPlayback();
            this.cardinalTime = this.playbackStartTime;
        } else {
            this.startPlayback(fromBeat);
        }
    }

    startPlayback(fromBeat) {
        this.audio.init();
        this.audio.resume();
        const loop = this.getPlaybackLoop();
        if (loop && (fromBeat < loop.start || fromBeat >= loop.end)) {
            fromBeat = loop.start;
        }
        this.cardinalTime = fromBeat;
        this.playbackStartTime = fromBeat;
        this.isPlaying = true;
        this.scheduler.start(fromBeat);
    }

    stopPlayback() {
        this.isPlaying = false;
        this.scheduler.stop();
        this.audio.stopAll();
    }

    loop(timestamp) {
        this.input.update();

        if (this.isPlaying) {
            this.scheduler.update();
            this.cardinalTime = this.scheduler.currentBeat();
            // Stop at the end of the song (plus one beat for release tails)
            if (this.view === 'song' && !this.getPlaybackLoop()
                && this.cardinalTime > songEnd(this.songData) + 1) {
                this.stopPlayback();
            }
        }

        if (this.view === 'song') {
            this.songView.draw(this.cardinalTime);
        } else {
            this.ui.draw(this.input.state, this.cardinalTime);
        }

        requestAnimationFrame(this.loop);
    }

    saveProject() {
        const project = {
            version: SONG_VERSION,
            date: new Date().toISOString(),
            songData: this.songData,
            transport: {
                bpm: this.bpm,
                tempoMap: this.transport.tempoMap,
                timeSigMap: this.transport.timeSigMap,
                markerMap: this.transport.markerMap
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
                if (project.version !== SONG_VERSION || !project.songData || !project.songData.patterns) {
                    alert('This project file uses an old format and cannot be loaded.');
                    return;
                }

                // Restore data
                if (this.isPlaying) this.stopPlayback();
                this.undoStack = [];
                this.redoStack = [];
                this.songData = project.songData;
                this.currentTrackId = 0;
                this.currentPatternId = null;
                this.lastPatternByTrack = {};
                this.loops.song = { region: null, enabled: false };
                this.loops.pattern = { region: null, enabled: false };
                this.songState.cursorBar = 0;

                // Restore Transport
                if (project.transport) {
                    this.transport.tempoMap = project.transport.tempoMap || [{ beat: 0, bpm: 120 }];
                    this.transport.timeSigMap = project.transport.timeSigMap || [{ beat: 0, num: 4, den: 4 }];
                    this.transport.markerMap = project.transport.markerMap || [];
                }

                // Sync Instruments to Audio Engine
                if (this.audio.hasSoundBank()) {
                    this.validateTracksAgainstSF2();
                } else {
                    // Restore values even if no SF2 (will validate when SF2 is loaded)
                    this.songData.tracks.forEach(t => {
                        const idx = t.presetIndex !== undefined ? t.presetIndex : -1;
                        this.audio.setTrackInstrument(t.id, t.bank || 0, t.program || 0, idx);
                    });
                }

                // Apply mixer settings
                this.songData.tracks.forEach(t => {
                    this.audio.setTrackVolume(t.id, t.volume);
                    this.audio.setTrackPan(t.id, t.pan);
                });

                // Reset State
                this.cardinalTime = 0;
                this.input.state.cursor.time = 0;
                this.showSong();
                this.updateTrackUI();

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

            // Bank Select (CC 0 for MSB). Bank 128 (drum kits) is not a valid MSB value.
            if (trackData.bank !== undefined && trackData.bank !== 0 && trackData.bank < 128) {
                encoder.addEvent(track, 0, [0xB0 | ch, 0, trackData.bank]);
            }

            // Program Change
            const prog = trackData.program || 0;
            encoder.addEvent(track, 0, [0xC0 | ch, prog]);

            // Notes
            for (const note of flattenTrack(this.songData, trackData.id)) {
                const onTick = Math.round(note.time * PPQ);
                const offTick = Math.round((note.time + note.duration) * PPQ);
                const velocity = note.velocity !== undefined ? note.velocity : 100;

                // Note On
                encoder.addEvent(track, onTick, [0x90 | ch, note.pitch, velocity]);
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