export class InputManager {
    constructor(app) {
        this.app = app;
        this.gamepads = {};
        this.activeGamepadIndex = null;

        this.lastNoteDuration = null;

        // State
        this.state = {
            // ... (existing state)
        };

        // Button Mapping (Standard Gamepad Layout)
        // DirectInput controllers may require different indices.
        this.buttonMap = {
            A: 0, B: 1, X: 2, Y: 3,
            L1: 4, R1: 5, L2: 6, R2: 7,
            SELECT: 8, START: 9,
            UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
        };

        this.state = {
            cursor: {
                time: 0,
                pitch: 60
            },
            buttons: {}, // Previous frame button state for edge detection
            // Selection state
            selectedNotes: [], // Array of selected note references
            selectionStart: null, // {time, pitch} - anchor point for range selection
            hasSelection: false,
            clipboard: null
        };

        this.lastButtonState = [];
        this.wasYButtonHeld = false; // Track Y button state for release detection
        this.wasStartButtonHeld = false;
        this.startComboUsed = false;


        // Timing for repeat
        this.repeatTimers = {};
        this.REPEAT_DELAY = 200; // ms
        this.REPEAT_RATE = 50;  // ms

        window.addEventListener("gamepadconnected", (e) => this.onGamepadConnected(e));
        window.addEventListener("gamepaddisconnected", (e) => this.onGamepadDisconnected(e));
    }

    onGamepadConnected(e) {
        console.log("Gamepad connected at index %d: %s. %d buttons, %d axes. Mapping: %s",
            e.gamepad.index, e.gamepad.id,
            e.gamepad.buttons.length, e.gamepad.axes.length, e.gamepad.mapping);
        this.gamepads[e.gamepad.index] = e.gamepad;
        this.activeGamepadIndex = e.gamepad.index; // Auto switch to latest

        this.updateStatus(`Connected: ${e.gamepad.id}`);
    }

    onGamepadDisconnected(e) {
        console.log("Gamepad disconnected from index %d: %s",
            e.gamepad.index, e.gamepad.id);
        delete this.gamepads[e.gamepad.index];

        if (this.activeGamepadIndex === e.gamepad.index) {
            this.activeGamepadIndex = null;
            // Find another one
            const indices = Object.keys(this.gamepads);
            if (indices.length > 0) {
                this.activeGamepadIndex = Number(indices[0]);
            } else {
                this.updateStatus("No Gamepad");
            }
        }
    }

    updateStatus(msg) {
        const el = document.getElementById('gamepad-name');
        if (el) el.textContent = msg;
    }

    update() {
        // Poll Gamepads (Chrome requires polling)
        const gps = navigator.getGamepads ? navigator.getGamepads() : [];
        if (!gps) return;

        // Auto-detect if no active gamepad selected yet
        if (this.activeGamepadIndex === null) {
            for (let i = 0; i < gps.length; i++) {
                if (gps[i] && gps[i].connected) {
                    console.log("Auto-detected gamepad at index", i);
                    this.activeGamepadIndex = i;
                    this.updateStatus(`Detected: ${gps[i].id}`);
                    break;
                }
            }
        }

        let gp = null;
        if (this.activeGamepadIndex !== null && gps[this.activeGamepadIndex]) {
            gp = gps[this.activeGamepadIndex];
        }

        if (gp && gp.connected) {
            this.handleInput(gp);
        } else if (this.activeGamepadIndex !== null) {
            // Lost connection to specific index
            this.activeGamepadIndex = null;
            this.updateStatus("Searching for Gamepad...");
        }
    }

    handleInput(gp) {
        // Threshold for sticks
        const DEADZONE = 0.2;

        // D-PAD & Stick handling for Cursor Movement
        // Mapping (Standard Gamepad)
        // Axes 0,1: Left Stick
        // Axes 2,3: Right Stick
        // Buttons 12,13,14,15: D-Pad Top, Bottom, Left, Right

        let dx = 0;
        let dy = 0;

        const map = this.buttonMap;

        // Check button states
        const aButtonHeld = gp.buttons[map.A] && gp.buttons[map.A].pressed;
        const bButtonHeld = gp.buttons[map.B] && gp.buttons[map.B].pressed;
        const yButtonHeld = gp.buttons[map.Y] && gp.buttons[map.Y].pressed;
        const l1Pressed = gp.buttons[map.L1] && gp.buttons[map.L1].pressed;
        const r1Pressed = gp.buttons[map.R1] && gp.buttons[map.R1].pressed;
        const l2Pressed = gp.buttons[map.L2] && gp.buttons[map.L2].pressed;
        const r2Pressed = gp.buttons[map.R2] && gp.buttons[map.R2].pressed;
        const startButtonHeld = gp.buttons[map.START] && gp.buttons[map.START].pressed;
        const selectButtonHeld = gp.buttons[map.SELECT] && gp.buttons[map.SELECT].pressed;

        // D-Pad
        if (gp.buttons[map.UP].pressed) dy = 1; // Up
        if (gp.buttons[map.DOWN].pressed) dy = -1; // Down

        // Undo / Redo (L1 / R1)
        if (l1Pressed && !this.lastButtonState[map.L1]) {
            this.app.undo();
        }
        if (r1Pressed && !this.lastButtonState[map.R1]) {
            this.app.redo();
        }

        if (startButtonHeld) {
            dx = 0;
            dy = 0;

            const track = this.app.songData.tracks[this.app.currentTrackId];

            // Volume (Up/Down)
            if (gp.buttons[map.UP].pressed && !this.lastButtonState[map.UP]) {
                track.volume = Math.min(1.0, track.volume + 0.05);
                this.app.audio.setTrackVolume(this.app.currentTrackId, track.volume);
                this.updateStatus(`Vol: ${track.volume.toFixed(2)}`);
                this.startComboUsed = true;
            }
            if (gp.buttons[map.DOWN].pressed && !this.lastButtonState[map.DOWN]) {
                track.volume = Math.max(0, track.volume - 0.05);
                this.app.audio.setTrackVolume(this.app.currentTrackId, track.volume);
                this.updateStatus(`Vol: ${track.volume.toFixed(2)}`);
                this.startComboUsed = true;
            }

            // Pan (Left/Right)
            if (gp.buttons[map.LEFT].pressed && !this.lastButtonState[map.LEFT]) {
                track.pan = Math.max(-1.0, track.pan - 0.1);
                this.app.audio.setTrackPan(this.app.currentTrackId, track.pan);
                this.updateStatus(`Pan: ${track.pan.toFixed(1)}`);
                this.startComboUsed = true;
            }
            if (gp.buttons[map.RIGHT].pressed && !this.lastButtonState[map.RIGHT]) {
                track.pan = Math.min(1.0, track.pan + 0.1);
                this.app.audio.setTrackPan(this.app.currentTrackId, track.pan);
                this.updateStatus(`Pan: ${track.pan.toFixed(1)}`);
                this.startComboUsed = true;
            }

            // Solo (A)
            if (gp.buttons[map.A].pressed && !this.lastButtonState[map.A]) {
                track.solo = !track.solo;
                this.updateStatus(`Solo: ${track.solo ? 'ON' : 'OFF'}`);
                this.startComboUsed = true;
            }

            // Mute (B)
            if (gp.buttons[map.B].pressed && !this.lastButtonState[map.B]) {
                track.muted = !track.muted;
                this.updateStatus(`Mute: ${track.muted ? 'ON' : 'OFF'}`);
                this.startComboUsed = true;
            }
        } else {
            if (this.wasStartButtonHeld) {
                if (!this.startComboUsed) {
                    this.app.currentTrackId = (this.app.currentTrackId + 1) % 8;
                    this.updateStatus(`Track: ${this.app.currentTrackId + 1}`);
                    if (this.app.updateTrackUI) this.app.updateTrackUI();
                }
                this.startComboUsed = false;
            }

            if (r2Pressed) {
            // Grid Shortcuts
            if (gp.buttons[map.LEFT].pressed && !this.lastButtonState[map.LEFT]) {
                let div = this.app.ui.gridDivisions;
                if (div < 64) this.app.ui.setGridDivisions(div * 2);
            }
            if (gp.buttons[map.RIGHT].pressed && !this.lastButtonState[map.RIGHT]) {
                let div = this.app.ui.gridDivisions;
                if (div > 2) this.app.ui.setGridDivisions(div / 2);
            }
            } else {
            // Normal D-Pad
            if (gp.buttons[map.LEFT].pressed) dx = -1;
            if (gp.buttons[map.RIGHT].pressed) dx = 1;
            }
        }

        // Left Stick
        if (Math.abs(gp.axes[0]) > DEADZONE) dx = gp.axes[0] > 0 ? 1 : -1;
        if (Math.abs(gp.axes[1]) > DEADZONE) dy = gp.axes[1] > 0 ? -1 : 1;

        if (startButtonHeld) {
            dx = 0;
            dy = 0;
        }
        if (Math.abs(gp.axes[1]) > DEADZONE) dy = gp.axes[1] > 0 ? -1 : 1;

        // Y Button: Selection Mode
        if (yButtonHeld) {
            // Start selection if just pressed
            if (!this.wasYButtonHeld) {
                if (this.state.hasSelection) {
                    this.clearSelection();
                } else {
                    this.state.selectionStart = {
                        time: this.state.cursor.time,
                        pitch: this.state.cursor.pitch
                    };
                    this.state.selectedNotes = [];
                }
            }

            // Move cursor and update range selection
            if (this.state.selectionStart) {
                this.processMovement('x', dx);
                this.processMovement('y', dy);
                this.updateRangeSelection();
            }

        } else if (this.wasYButtonHeld && !yButtonHeld) {
            // Y button just released - finalize selection
            if (this.state.selectionStart) {
                this.finalizeSelection();
            }

        } else if (this.state.hasSelection && (dx !== 0 || dy !== 0)) {
            // Have selection and moving - move selected notes
            this.moveSelectedNotes(dx, dy);

        } else if (aButtonHeld && dx !== 0) {
            // A + Left/Right = Change note duration
            this.processNoteLengthChange(dx);

        } else {
            // Normal cursor movement
            // Check for L1 modifier for fast movement
            const unitX = l2Pressed ? 'measure' : 'grid';
            const unitY = l2Pressed ? 'octave' : 'semitone';

            this.processMovement('x', dx, unitX);
            this.processMovement('y', dy, unitY);
        }

        // Clear continuous action timers if not in use
        if (!aButtonHeld) delete this.repeatTimers['note_length'];
        if (!this.state.hasSelection) delete this.repeatTimers['move_selection'];

        this.wasYButtonHeld = yButtonHeld;
        this.wasStartButtonHeld = startButtonHeld;

        // Buttons (Action)
        // 0: South (A/Cross) -> Place Note (only when no d-pad pressed)
        // 1: East (B/Circle) -> Clear selection / Remove
        // 2: West (X/Square) -> Play/Stop

        // Edge detection for buttons
        this.handleButtons(gp, dx, dy, startButtonHeld, selectButtonHeld);

        // Update UI info
        document.getElementById('time-val').textContent = this.state.cursor.time.toFixed(2);
        document.getElementById('pitch-val').textContent = this.midiToNoteName(this.state.cursor.pitch);
    }

    handleButtons(gp, dx, dy, suppressActions = false, selectButtonHeld = false) {
        const map = this.buttonMap;
        // Helper for button down
        const isDown = (i) => gp.buttons[i] && gp.buttons[i].pressed;
        const wasDown = (i) => this.lastButtonState[i];

        try {
            if (!suppressActions) {
            // Button 0 (A/Cross): Copy selection, Paste, or Place Note
            if (isDown(map.A) && !wasDown(map.A) && dx === 0 && dy === 0) {
                if (this.state.hasSelection) {
                    this.copySelection();
                } else if (this.state.clipboard) {
                    this.pasteClipboard();
                } else {
                    this.placeNote();
                }
            }

            // Button 2 (X/Square): Play from cursor position
            if (isDown(map.X) && !wasDown(map.X)) {
                this.playFromCursor();
            }

            // Button 1 (B/Circle): Delete selection or Clear Clipboard
            if (isDown(map.B) && !wasDown(map.B)) {
                if (this.state.hasSelection) {
                    this.deleteSelectedNotes();
                } else if (this.state.clipboard) {
                    this.state.clipboard = null;
                    this.updateStatus("Clipboard cleared");
                }
            }

            // Button 8 (Select): Set Loop / Toggle Loop
            if (isDown(map.SELECT) && !wasDown(map.SELECT)) {
                if (this.state.hasSelection && this.state.selectedNotes.length > 0) {
                    // Set Loop to Selection
                    let minTime = Infinity;
                    let maxEnd = -Infinity;
                    
                    this.state.selectedNotes.forEach(n => {
                        if (n.time < minTime) minTime = n.time;
                        const end = n.time + (n.duration || 0);
                        if (end > maxEnd) maxEnd = end;
                    });

                    if (minTime !== Infinity) {
                        this.app.loopRegion = { start: minTime, end: maxEnd };
                        this.app.isLooping = true;
                        this.app.showToast(`Loop Set: ${minTime.toFixed(1)} - ${maxEnd.toFixed(1)}`);
                    }
                } else {
                    // Toggle Loop
                    this.app.isLooping = !this.app.isLooping;
                    this.app.showToast(this.app.isLooping ? "Loop ON" : "Loop OFF");
                }
            }
            }

            // ... (Other button checks handled in update() or previous logic?) 
            // Wait, previous logic for shortcuts was in handleInput/update?
            // Need to make sure we don't double process or miss processing.
            // The method snippet shown in previous view_file was handleButtons lines 242-272.
            // The shortcut logic (B+Up etc) was usually in update() or handleInput() in my previous edits?
            // Let's check where the shortcut logic is.
            // Step 494 showed shortcuts in handleInput? No, it showed lines 110-140 which looked like inside handleInput or update.
            // Step 437 showed handleButtons having basic A/B/X logic.

            // If the shortcuts are in `update` or `handleInput` *before* `handleButtons` is called, 
            // and `handleButtons` is just updating state...
            // Actually, usually `handleButtons` is called by `update` or `handleInput`.
            // Let's look at `update` or `handleInput` to see where `lastButtonState` is updated.

        } catch (e) {
            console.error("Error in handleButtons:", e);
        } finally {
            // Store state
            for (let i = 0; i < gp.buttons.length; i++) {
                this.lastButtonState[i] = gp.buttons[i].pressed;
            }
        }
    }

    copySelection() {
        if (!this.state.hasSelection || this.state.selectedNotes.length === 0) return;

        // Find the bounding box of the selection to use as anchor
        let minTime = Infinity;

        this.state.selectedNotes.forEach(n => {
            if (n.time < minTime) minTime = n.time;
        });

        const refTime = minTime;

        this.state.clipboard = this.state.selectedNotes.map(n => ({
            deltaTime: n.time - refTime,
            pitch: n.pitch,
            duration: n.duration,
            velocity: n.velocity
        }));

        // Deselect to allow cursor movement
        this.state.selectedNotes = [];
        this.state.hasSelection = false;
        this.updateStatus(`Copied ${this.state.clipboard.length} notes`);
    }

    pasteClipboard() {
        if (!this.state.clipboard) return;
        this.app.saveState();

        const track = this.app.songData.tracks[this.app.currentTrackId];
        const refTime = this.state.cursor.time;

        const newNotes = this.state.clipboard.map(n => ({
            time: Math.max(0, refTime + n.deltaTime),
            pitch: n.pitch,
            duration: n.duration,
            velocity: n.velocity
        }));

        track.notes.push(...newNotes);
        
        // Keep clipboard for continuous pasting
        this.updateStatus(`Pasted ${newNotes.length} notes`);
    }

    deleteSelectedNotes() {
        if (!this.state.hasSelection) return;
        this.app.saveState();

        const track = this.app.songData.tracks[this.app.currentTrackId];
        track.notes = track.notes.filter(n => !this.state.selectedNotes.includes(n));
        
        this.updateStatus(`Deleted ${this.state.selectedNotes.length} notes`);
        this.clearSelection();
    }

    placeNote() {
        try {
            this.app.saveState();
            const { time, pitch } = this.state.cursor;

            if (!this.app.songData || !this.app.songData.tracks) {
                console.error("SongData or Tracks missing");
                return;
            }

            const trackId = this.app.currentTrackId;
            const track = this.app.songData.tracks[trackId];

            if (!track) {
                console.error(`Track ${trackId} not found`);
                return;
            }

            if (!track.notes) track.notes = [];
            const notes = track.notes;

            // Toggle: if exists, remove. if not, add.
            // Use epsilon for float comparison on time
            const EPSILON = 0.001;
            const existingIndex = notes.findIndex(n => Math.abs(n.time - time) < EPSILON && n.pitch === pitch);

            if (existingIndex >= 0) {
                // Remove
                notes.splice(existingIndex, 1);
            } else {
                // Add
                // Duration should match current grid step? Or default 1?
                // Let's use current grid step as duration default
                // Guard against division by zero just in case
                let duration = this.lastNoteDuration;
                if (!duration) {
                    const divs = this.app.ui.gridDivisions || 4;
                    duration = 4 / divs;
                }
                this.lastNoteDuration = duration;

                notes.push({ time, pitch, duration });

                // Play feedback
                if (this.app.audio && this.app.audio.playNote) {
                    this.app.audio.playNote(pitch, 0.25, trackId);
                }
            }
        } catch (e) {
            console.error("Error in placeNote:", e);
        }
    }

    processNoteLengthChange(dx) {
        // Change duration of note at cursor position
        const { time, pitch } = this.state.cursor;
        const track = this.app.songData.tracks[this.app.currentTrackId];
        const notes = track.notes;
        const EPSILON = 0.001;
        const note = notes.find(n => Math.abs(n.time - time) < EPSILON && n.pitch === pitch);

        if (note) {
            // Apply rate-limited change (slower than cursor movement)
            const now = Date.now();
            const key = 'note_length';
            const NOTE_LENGTH_DELAY = 150; // Initial delay before repeat
            const NOTE_LENGTH_RATE = 120;  // Rate when holding (slower than cursor)
            const step = 4 / this.app.ui.gridDivisions; // Change by grid step

            if (!this.repeatTimers[key]) {
                this.app.saveState();
                note.duration += dx > 0 ? step : -step;
                if (note.duration < step) note.duration = step;
                this.lastNoteDuration = note.duration;
                this.repeatTimers[key] = { start: now, lastInfo: now };
            } else {
                const timer = this.repeatTimers[key];
                if (now - timer.start > NOTE_LENGTH_DELAY) {
                    if (now - timer.lastInfo > NOTE_LENGTH_RATE) {
                        note.duration += dx > 0 ? step : -step;
                        if (note.duration < step) note.duration = step;
                        this.lastNoteDuration = note.duration;
                        timer.lastInfo = now;
                    }
                }
            }
        }
    }

    clearNoteLengthTimer() {
        delete this.repeatTimers['note_length'];
    }

    updateRangeSelection() {
        // While Y is held, continuously update which notes fall within selection range
        if (!this.state.selectionStart) return;

        const start = this.state.selectionStart;
        const end = this.state.cursor;

        const minTime = Math.min(start.time, end.time);
        const maxTime = Math.max(start.time, end.time);
        const minPitch = Math.min(start.pitch, end.pitch);
        const maxPitch = Math.max(start.pitch, end.pitch);

        // Find all notes within the range
        // Selection only works for current track for now
        const track = this.app.songData.tracks[this.app.currentTrackId];
        const notes = track.notes;

        this.state.selectedNotes = notes.filter(n =>
            n.time >= minTime - 0.001 && n.time <= maxTime + 0.001 &&
            n.pitch >= minPitch && n.pitch <= maxPitch
        );
    }

    finalizeSelection() {
        // Y button released - check if we have any selected notes
        if (this.state.selectedNotes.length > 0) {
            this.state.hasSelection = true;
        } else {
            this.state.hasSelection = false;
        }
        this.state.selectionStart = null;
    }

    moveSelectedNotes(dx, dy) {
        // Move all selected notes by dx (time) and dy (pitch)
        const now = Date.now();
        const key = 'move_selection';
        const MOVE_DELAY = 150;
        const MOVE_RATE = 100;

        const step = 4 / this.app.ui.gridDivisions;

        const doMove = () => {
            for (const note of this.state.selectedNotes) {
                note.time += dx * step;
                note.pitch += dy;

                // Clamp values
                if (note.time < 0) note.time = 0;
                if (note.pitch < 0) note.pitch = 0;
                if (note.pitch > 127) note.pitch = 127;
            }
            // Update cursor as well so we stay with the selection
            this.state.cursor.time += dx * step;
            if (this.state.cursor.time < 0) this.state.cursor.time = 0;
            this.state.cursor.pitch += dy;
            if (this.state.cursor.pitch < 0) this.state.cursor.pitch = 0;
            if (this.state.cursor.pitch > 127) this.state.cursor.pitch = 127;
        };

        if (!this.repeatTimers[key]) {
            this.app.saveState();
            doMove();
            this.repeatTimers[key] = { start: now, lastInfo: now };
        } else {
            const timer = this.repeatTimers[key];
            if (now - timer.start > MOVE_DELAY) {
                if (now - timer.lastInfo > MOVE_RATE) {
                    doMove();
                    timer.lastInfo = now;
                }
            }
        }
    }

    clearSelection() {
        this.state.selectedNotes = [];
        this.state.hasSelection = false;
        this.state.selectionStart = null;
        delete this.repeatTimers['move_selection'];
    }

    playFromCursor() {
        // Toggle: if playing, stop. If stopped, play from cursor.
        if (this.app.isPlaying) {
            this.app.isPlaying = false;
            this.app.cardinalTime = this.app.playbackStartTime;
        } else {
            // Ensure audio is initialized (required for first user gesture)
            if (!this.app.audio.ctx) {
                this.app.audio.init();
            }
            this.app.audio.resume();

            if (this.app.isLooping && this.app.loopRegion) {
                this.app.cardinalTime = this.app.loopRegion.start;
            } else {
                this.app.cardinalTime = this.state.cursor.time;
            }
            this.app.playbackStartTime = this.app.cardinalTime;
            this.app.isPlaying = true;
        }
    }

    processMovement(axis, dir, unit = 'grid') {
        // Simple discrete movement for now
        // TODO: Implement proper repeat logic (wait then fast repeat)

        const now = Date.now();
        const key = `move_${axis}`;

        // If unit changes, treating as new key to reset repeat timer
        const storageKey = `${key}_${unit}`;

        if (dir !== 0) {
            if (!this.repeatTimers[storageKey]) {
                // First press
                this.moveCursor(axis, dir, unit);
                this.repeatTimers[storageKey] = { start: now, lastInfo: now, dir: dir };
            } else {
                // Holding
                const timer = this.repeatTimers[storageKey];
                // Check if direction changed, reset if so
                if (timer.dir !== dir) {
                    this.moveCursor(axis, dir, unit);
                    this.repeatTimers[storageKey] = { start: now, lastInfo: now, dir: dir };
                    return;
                }

                if (now - timer.start > this.REPEAT_DELAY) {
                    if (now - timer.lastInfo > this.REPEAT_RATE) {
                        this.moveCursor(axis, dir, unit);
                        timer.lastInfo = now;
                    }
                }
            }
        } else {
            // Released (clear all variants for this axis to be safe, or just iterate)
            // Ideally we track which one was active.
            // For simplicity, just clearing likely candidates
            delete this.repeatTimers[`move_${axis}_grid`];
            delete this.repeatTimers[`move_${axis}_measure`];
            delete this.repeatTimers[`move_${axis}_semitone`];
            delete this.repeatTimers[`move_${axis}_octave`];
        }
    }

    moveCursor(axis, dir, unit) {
        let step = 0;
        if (unit === 'grid') {
            step = 4 / this.app.ui.gridDivisions;
        } else if (unit === 'measure') {
            step = 4.0;
        } else if (unit === 'semitone') {
            step = 1;
        } else if (unit === 'octave') {
            step = 12;
        }

        if (axis === 'x') {
            this.state.cursor.time += dir > 0 ? step : -step;
            if (this.state.cursor.time < 0) this.state.cursor.time = 0;
            // Snap logic could be here
            this.state.cursor.time = Math.round(this.state.cursor.time * 1000) / 1000;

        } else if (axis === 'y') {
            this.state.cursor.pitch += dir > 0 ? step : -step;
            if (this.state.cursor.pitch > 127) this.state.cursor.pitch = 127;
            if (this.state.cursor.pitch < 0) this.state.cursor.pitch = 0;
        }

        // Auto scroll UI to keep cursor in view
        // Ideally App calls UI to scroll, or we just update state and UI handles it in draw()
        // For now let's just update UI scroll based on cursor "pushing" the view
        this.updateViewScroll(axis);
    }

    updateViewScroll(axis) {
        // Quick hack to scroll view
        const ui = this.app.ui;
        // ... (Later implementation for smooth scrolling)
        // Manual "Push" scrolling:
        const cursorX = this.state.cursor.time * ui.beatWidth - ui.scrollX;
        const cursorY = (127 - this.state.cursor.pitch) * ui.keyHeight - ui.scrollY;

        // Horizontal
        if (cursorX > ui.width - 100) {
            ui.scrollX += ui.beatWidth; // Maybe scroll by grid size?
        } else if (cursorX < 100) {
            ui.scrollX -= ui.beatWidth;
            if (ui.scrollX < 0) ui.scrollX = 0;
        }

        // Vertical (scrollY increases = view moves down = higher notes visible)
        // cursorY is calculated as (127 - pitch) * keyHeight - scrollY
        // When cursor goes to high note (high pitch), cursorY becomes small
        // When cursorY < 100 (near top), we need to see higher notes -> increase scrollY
        // When cursorY > height-100 (near bottom), we need to see lower notes -> decrease scrollY
        if (cursorY > ui.height - 100) {
            ui.scrollY += ui.keyHeight;
        } else if (cursorY < 100) {
            ui.scrollY -= ui.keyHeight;
            if (ui.scrollY < 0) ui.scrollY = 0;
        }

    }

    midiToNoteName(midi) {
        const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
        const octave = Math.floor(midi / 12) - 1;
        const note = notes[midi % 12];
        return `${note}${octave}`;
    }
}
