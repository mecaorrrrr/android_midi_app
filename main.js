import { UIManager } from './ui.js';
import { InputManager } from './input.js';
import { AudioManager, toneControllerMessages } from './audio.js';
import { TransportManager } from './transport.js';
import { Scheduler } from './scheduler.js';
import { SongView } from './song_view.js';
import { loadTheme } from './theme.js';
import { ToneEditor } from './tone_editor.js';
import {
    createSong, normalizeSong, SONG_VERSION, getPattern, patternsOfTrack, createPattern, addClip,
    clipAt, forEachSongNote, flattenTrack, songEnd, isTrackAudible
} from './song.js';

const DEFAULT_PATTERN_BARS = 4;
const INPUT_POLL_MS = 4;

console.log("Initializing Android MIDI App...");

class App {
    constructor() {
        loadTheme();
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
        this.toneEditor = new ToneEditor(this);

        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Init audio on first interaction
        document.body.addEventListener('click', () => {
            if (!this.audio.ctx) this.audio.init();
            this.audio.resume();
            setTimeout(() => this.showAudioLatency(), 1000);
        }, { once: true });

        // Poll the gamepad faster than the display refresh to cut input latency
        setInterval(() => this.input.update(), INPUT_POLL_MS);

        this.setupMenus();
        this.setupTransportButtons();
        this.setupDialog();
        this.setupMappingModal();
        this.setupTrackListModal();

        // SFZ Input
        document.getElementById('sfz-file-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                this.audio.init();
                this.showToast('Loading SFZ...');
                const success = await this.audio.loadSFZ(e.target.files);
                this.showToast(success ? 'SFZ loaded' : 'Could not load the SFZ folder');
                // Clear SF2 preset selector when loading SFZ
                const presetSel = document.getElementById('preset-selector');
                presetSel.innerHTML = '<option value="">-- SFZ Mode --</option>';
                presetSel.disabled = true;
            }
            e.target.value = ''; // Allow loading the same folder again
        });

        // SF2 File Loading
        document.getElementById('sf2-file-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                this.showToast('Loading SoundFont...');
                const success = await this.audio.loadSF2(e.target.files[0]);
                if (success) {
                    this.showToast('SoundFont loaded');
                    this.populatePresetSelector();
                    this.validateTracksAgainstSF2();
                } else {
                    this.showToast('Could not load the SoundFont');
                }
            }
            e.target.value = '';
        });

        document.getElementById('preset-selector').addEventListener('change', (e) => {
            const idx = parseInt(e.target.value);
            if (!isNaN(idx) && idx >= 0) {
                this.saveState();
                this.setTrackPreset(this.currentTrackId, idx);
            }
        });

        document.getElementById('file-input-project').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.loadProject(e.target.files[0]);
            }
            e.target.value = '';
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

    // Push volume / pan / tone of every track to the audio engine
    applyAllTrackSettings() {
        for (const track of this.songData.tracks) {
            if (this.audio.hasSoundBank()) {
                this.audio.setTrackInstrument(track.id, track.bank || 0, track.program || 0, track.presetIndex ?? -1);
            }
            this.audio.setTrackVolume(track.id, track.volume);
            this.audio.setTrackPan(track.id, track.pan);
            this.audio.setTrackTone(track.id, track.tone);
        }
    }

    // Called after undo/redo replaced songData with a copy
    afterSongDataReplaced() {
        this.applyAllTrackSettings();
        if (this.toneEditor.isOpen) this.toneEditor.render();
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
        // Pattern view: the edited pattern, plus the other tracks at the clip the pattern was
        // opened from (the same place the ghost notes show). Mute / solo apply as in the song view.
        const pattern = this.currentPattern;
        if (!pattern) return;
        const song = this.songData;
        if (isTrackAudible(song, song.tracks[pattern.trackId])) {
            for (const note of pattern.notes) {
                if (note.time >= fromBeat && note.time < toBeat && note.time < pattern.length) {
                    fn(pattern.trackId, note.time, note);
                }
            }
        }
        if (!this.isPatternInContext()) return;
        const offset = this.patternContextStart;
        forEachSongNote(song, offset + fromBeat, offset + toBeat, (trackId, time, note) => {
            if (trackId !== pattern.trackId) fn(trackId, time - offset, note);
        });
    }

    // True when the edited pattern is placed at patternContextStart (so it has a place in the song)
    isPatternInContext() {
        const pattern = this.currentPattern;
        return !!pattern && this.songData.clips.some(c => c.patternId === pattern.id && Math.abs(c.start - this.patternContextStart) < 1e-6);
    }

    // Song beat at which the current view's timeline starts (tempo changes are looked up there)
    getPlaybackBeatOffset() {
        return this.view === 'pattern' && this.isPatternInContext() ? this.patternContextStart : 0;
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
        document.getElementById('tab-song').classList.toggle('on', this.view === 'song');
        document.getElementById('tab-pattern').classList.toggle('on', this.view === 'pattern');
        // Instrument can be picked from the screen in the song view only
        document.querySelector('.oled-title').classList.toggle('pick', this.view === 'song');
        document.getElementById('preset-selector').style.pointerEvents = this.view === 'song' ? '' : 'none';

        const hints = this.view === 'song'
            ? [['A', 'Place or open'], ['B', 'Copy, hold to delete'], ['X', 'Play'], ['Y', 'Select'],
                ['Start', 'Next track'], ['Start + Y', 'Tone'], ['Select', 'Hold for pattern']]
            : [['A', 'Add note, hold to edit'], ['B', 'Copy, hold to delete'], ['X', 'Play'], ['Y', 'Select'],
                ['L2', 'Grid'], ['Start + Y', 'Tone'], ['Select', 'Hold for song']];
        document.getElementById('legend').innerHTML =
            hints.map(([key, text]) => `<span><b>${key}</b>${text}</span>`).join('');
        this.oledCache = null;
    }

    // Parameter screen at the top: what the cursor points at in the current view
    updateOled() {
        let name;
        let sub;
        let params;
        const pan = (p) => Math.abs(p) < 0.05 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.round(Math.abs(p) * 100)}`;

        if (this.view === 'song') {
            const track = this.songData.tracks[this.currentTrackId];
            const beat = this.transport.barToBeat(this.songState.cursorBar);
            const clip = clipAt(this.songData, this.currentTrackId, beat);
            const pattern = clip ? getPattern(this.songData, clip.patternId) : null;
            const bar = this.isPlaying
                ? Math.floor(this.transport.beatToBar(this.cardinalTime)) + 1
                : this.songState.cursorBar + 1;
            name = `<b>${escapeHtml(track.name)}</b>`;
            sub = `T${track.id + 1}, ${escapeHtml(this.getInstrumentName(track))}`;
            params = [
                ['Bar', bar],
                ['Volume', Math.round(track.volume * 100)],
                ['Pan', pan(track.pan)],
                ['Pattern', pattern ? escapeHtml(pattern.name) : '-'],
                ['Tempo', this.transport.getBpmAt(beat), 'minor']
            ];
            if (this.songState.clipboard) params.push(['Clipboard', this.songState.clipboard.length, 'minor']);
        } else {
            const pattern = this.currentPattern;
            if (!pattern) return;
            const track = this.songData.tracks[pattern.trackId];
            const input = this.input;
            const note = input.getNoteAtCursor();
            const bars = +(pattern.length / this.getPatternBarLength()).toFixed(2);
            const duration = note ? note.duration : (input.lastNoteDuration || 4 / this.ui.gridDivisions);
            name = `<b>${escapeHtml(track.name)}</b><i class="pipe"></i><b class="pat">${escapeHtml(pattern.name)}</b>`;
            sub = `${bars} bar${bars === 1 ? '' : 's'}`;
            params = [
                ['Note', input.midiToNoteName(input.state.cursor.pitch)],
                ['Velocity', Math.round(note ? (note.velocity || 100) : input.lastNoteVelocity)],
                ['Length', beatsToNoteValue(duration)],
                ['Grid', `1/${this.ui.gridDivisions}`],
                ['Position', input.formatCursorPosition(), 'minor']
            ];
        }

        const html = params.map(([label, value, cls]) =>
            `<div class="param ${cls || ''}"><span>${label}</span><b>${value}</b></div>`).join('');
        const key = name + sub + html;
        if (key === this.oledCache) return;
        this.oledCache = key;
        document.getElementById('oled-name').innerHTML = name;
        document.getElementById('oled-sub').innerHTML = sub;
        document.getElementById('oled-params').innerHTML = html;
    }

    // Shows the browser/OS output delay; large values usually mean Bluetooth audio or power saving
    showAudioLatency() {
        const ms = this.audio.getOutputLatencyMs();
        if (ms === null) return;
        this.showToast(`Audio output latency: ${ms} ms`);
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
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
    }

    // ---------------------------------------------------------------- Dialog

    setupDialog() {
        this.dialogResolve = null;
        const input = document.getElementById('dialog-input');
        document.getElementById('dialog-ok').addEventListener('click', () => this.closeDialog(true));
        document.getElementById('dialog-cancel').addEventListener('click', () => this.closeDialog(false));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.closeDialog(true);
            if (e.key === 'Escape') this.closeDialog(false);
        });
    }

    get isDialogOpen() {
        return this.dialogResolve !== null;
    }

    /**
     * Themed replacement for alert / confirm / prompt.
     * options: { title, message, input (default text, omit for no input), cancel (show Cancel) }
     * Resolves to the entered text (prompt), true (confirm/alert OK) or null (cancelled).
     */
    showDialog({ title, message = '', input = null, cancel = true }) {
        if (this.isDialogOpen) this.closeDialog(false);
        document.getElementById('dialog-title').textContent = title;
        const messageEl = document.getElementById('dialog-message');
        messageEl.textContent = message;
        messageEl.hidden = !message;
        const inputEl = document.getElementById('dialog-input');
        inputEl.hidden = input === null;
        inputEl.value = input === null ? '' : String(input);
        document.getElementById('dialog-cancel').hidden = !cancel;
        document.getElementById('dialog').classList.add('open');
        if (input !== null) {
            inputEl.focus();
            inputEl.select();
        }
        return new Promise(resolve => {
            this.dialogResolve = (ok) => resolve(ok ? (input === null ? true : inputEl.value) : null);
        });
    }

    closeDialog(ok) {
        if (!this.isDialogOpen) return;
        const resolve = this.dialogResolve;
        this.dialogResolve = null;
        document.getElementById('dialog').classList.remove('open');
        resolve(ok);
    }

    showAlert(title, message) {
        return this.showDialog({ title, message, cancel: false });
    }

    resize() {
        this.ui.resize();
    }

    // FILE / ADD dropdowns: .menu elements with [data-menu-toggle] and [data-action] items
    setupMenus() {
        const menus = document.querySelectorAll('.menu');
        const closeAll = () => menus.forEach(m => m.classList.remove('open'));

        menus.forEach(menu => {
            menu.querySelector('[data-menu-toggle]').addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = menu.classList.contains('open');
                closeAll();
                menu.classList.toggle('open', !wasOpen);
            });
        });
        document.addEventListener('click', closeAll);

        const actions = {
            'save': () => this.saveProject(),
            'load': () => document.getElementById('file-input-project').click(),
            'export-midi': () => this.exportMIDI(),
            'load-sf2': () => document.getElementById('sf2-file-input').click(),
            'load-sfz': () => document.getElementById('sfz-file-input').click(),
            'controller-map': () => this.openMappingModal(),
            'marker-prev': () => this.navigateToPrevMarker(),
            'marker-next': () => this.navigateToNextMarker(),
            'add-marker': () => this.addMarker(),
            'add-bpm': () => this.addBpm(),
            'add-timesig': () => this.addTimeSig()
        };
        document.querySelectorAll('.menu-item[data-action]').forEach(item => {
            item.addEventListener('click', () => {
                closeAll();
                actions[item.dataset.action]();
            });
        });
    }

    setupTransportButtons() {
        document.getElementById('btn-tone').addEventListener('click', () => this.toneEditor.open());
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

    async addBpm() {
        const cursorTime = this.getSongCursorBeat();
        const currentBpm = this.transport.getBpmAt(cursorTime);
        const targetTime = Math.round(cursorTime * 100) / 100;

        const val = await this.showDialog({ title: 'Tempo Change', message: `BPM at beat ${targetTime}`, input: currentBpm });
        if (val === null) return;
        const bpm = parseFloat(val);
        if (!isNaN(bpm) && bpm > 0) {
            this.transport.addTempoChange(targetTime, bpm);
            this.showToast(`BPM ${bpm} at beat ${targetTime}`);
        }
    }

    async addTimeSig() {
        const cursorTime = this.getSongCursorBeat();
        const currentTs = this.transport.getMeasureAt(cursorTime).timeSig;
        const targetTime = Math.round(cursorTime * 100) / 100;

        const val = await this.showDialog({
            title: 'Time Signature', message: `num/den at beat ${targetTime}`, input: `${currentTs.num}/${currentTs.den}`
        });
        if (val === null) return;
        const [num, den] = val.split('/').map(v => parseInt(v));
        if (!isNaN(num) && !isNaN(den)) {
            this.transport.addTimeSigChange(targetTime, num, den);
            this.showToast(`Time Sig ${num}/${den} at beat ${targetTime}`);
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
        document.getElementById('btn-close-mapping').addEventListener('click', () => {
            modal.classList.remove('open');
            this.input.isMapping = false; // Cancel mapping if open
        });
        document.getElementById('btn-reset-mapping').addEventListener('click', async () => {
            if (await this.showDialog({ title: 'Reset Mapping', message: 'Reset all button mappings to default?' })) {
                this.input.resetMapping();
                this.updateMappingUI();
            }
        });
    }

    openMappingModal() {
        document.getElementById('mapping-modal').classList.add('open');
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
            btn.className = 'btn small';
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
        if (show) this.updateTrackListUI();
        document.getElementById('track-list-modal').classList.toggle('open', show);
        this.isTrackListOpen = show;
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
                <td>T${track.id + 1}</td>
                <td>${track.name}</td>
                <td>${instrumentName}</td>
                <td>${Math.round(track.volume * 100)}%</td>
                <td>${track.pan.toFixed(1)}</td>
                <td><button class="btn small success ${track.solo ? 'active' : ''}" data-action="solo">Solo</button></td>
                <td><button class="btn small danger ${track.muted ? 'active' : ''}" data-action="mute">Mute</button></td>
                <td><button class="btn small" data-action="tone">Edit</button></td>
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

            tr.querySelector('[data-action="tone"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTrackListModal(false);
                this.toneEditor.open(track.id);
            });

            tbody.appendChild(tr);
        });
    }

    // Change a track's instrument (index into audio.getPresets()) and play a short preview
    setTrackPreset(trackId, presetIndex, preview = true) {
        const preset = this.audio.getPresets()[presetIndex];
        if (!preset) return;
        const track = this.songData.tracks[trackId];
        track.bank = preset.bank;
        track.program = preset.preset;
        track.presetIndex = presetIndex;
        this.audio.selectPreset(trackId, presetIndex);
        if (trackId === this.currentTrackId) this.updateTrackUI();
        if (preview) this.audio.playNote(60, 0.5, trackId);
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
        if (this.isPlaying) {
            this.scheduler.update();
            this.cardinalTime = this.scheduler.currentBeat();
            // Stop at the end of the song (plus one beat for release tails)
            if (this.view === 'song' && !this.getPlaybackLoop()
                && this.cardinalTime > songEnd(this.songData) + 1) {
                this.stopPlayback();
            }
        }

        this.updateOled();
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
                    this.showAlert('Load Project', 'This project file uses an old format and cannot be loaded.');
                    return;
                }

                // Restore data
                if (this.isPlaying) this.stopPlayback();
                this.undoStack = [];
                this.redoStack = [];
                this.songData = normalizeSong(project.songData);
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

                this.applyAllTrackSettings();

                // Reset State
                this.cardinalTime = 0;
                this.input.state.cursor.time = 0;
                this.showSong();
                this.updateTrackUI();

                console.log("Project loaded");
                this.showToast('Project loaded');

            } catch (err) {
                console.error("Failed to load project", err);
                this.showAlert('Load Project', 'Failed to load project: ' + err.message);
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

            // Tone edits (same messages the live synth receives)
            for (const [cc, value] of toneControllerMessages(trackData.tone)) {
                encoder.addEvent(track, 0, [0xB0 | ch, cc, value]);
            }

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

// Note length in beats as a note value, e.g. 1.5 -> "3/8", 4 -> "1"
function beatsToNoteValue(beats) {
    let num = Math.round(beats / 4 * 64);
    let den = 64;
    while (num % 2 === 0 && den > 1) {
        num /= 2;
        den /= 2;
    }
    return den === 1 ? String(num) : `${num}/${den}`;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
