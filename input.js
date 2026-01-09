export class InputManager {
    constructor(app) {
        this.app = app;
        this.gamepads = {};
        this.activeGamepadIndex = null;
        this.lastL2StickState = { x: 0, y: 0 }; // L2+スティック用の状態記憶
        this.lastStartStickState = { x: 0, y: 0 }; // Start+スティック用の状態記憶
        this.bButtonDownTime = 0;
        this.bButtonActionHandled = false;
        this.startPressTime = 0;

        this.lastNoteDuration = null;
        this.lastNoteVelocity = 100;

        // State
        this.state = {
            // ... (existing state)
        };

        // Button Mapping (Standard Gamepad Layout)
        // DirectInput controllers may require different indices.
        this.defaultButtonMap = {
            A: 0, B: 1, X: 3, Y: 4,
            L1: 8, R1: 9, L2: 6, R2: 7,
            SELECT: 10, START: 11,
            UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15
        };
        this.buttonMap = { ...this.defaultButtonMap };
        this.loadMapping();

        this.isMapping = false;
        this.mappingTarget = null;
        this.onMappingComplete = null;

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

    loadMapping() {
        const saved = localStorage.getItem('gamepad_mapping');
        if (saved) {
            try {
                this.buttonMap = JSON.parse(saved);
            } catch (e) { console.error("Failed to load mapping", e); }
        }
    }

    saveMapping() {
        localStorage.setItem('gamepad_mapping', JSON.stringify(this.buttonMap));
    }

    resetMapping() {
        this.buttonMap = { ...this.defaultButtonMap };
        this.saveMapping();
    }

    startMapping(action, callback) {
        this.isMapping = true;
        this.mappingTarget = action;
        this.onMappingComplete = callback;
        // Reset last button state to avoid immediate trigger if something is held
        // But we need edge detection, so we rely on the user releasing buttons first usually.
        // We will handle the detection in handleInput.
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
        const DEADZONE = 0.2; // 通常のデッドゾーン
        const SHORTCUT_DEADZONE = 0.6; // ショートカット用の高いデッドゾーン

        // Mapping Mode Check
        if (this.isMapping) {
            for (let i = 0; i < gp.buttons.length; i++) {
                if (gp.buttons[i].pressed && !this.lastButtonState[i]) {
                    // Button detected (pressed edge)
                    console.log(`Mapping ${this.mappingTarget} to button ${i}`);
                    this.buttonMap[this.mappingTarget] = i;
                    this.saveMapping();
                    
                    const callback = this.onMappingComplete;
                    const target = this.mappingTarget;
                    
                    this.isMapping = false;
                    this.mappingTarget = null;
                    this.onMappingComplete = null;

                    if (callback) callback(target, i);
                    break;
                }
            }
            // Update state to prevent re-triggering and allow edge detection
            for (let i = 0; i < gp.buttons.length; i++) {
                this.lastButtonState[i] = gp.buttons[i].pressed;
            }
            return; // Skip normal input processing
        }

        // D-PAD & Stick handling for Cursor Movement
        // Mapping (Standard Gamepad)
        // Axes 0,1: Left Stick
        // Axes 2,3: Right Stick
        // Buttons 12,13,14,15: D-Pad Top, Bottom, Left, Right

        let dx = 0;
        let dy = 0;

        const map = this.buttonMap;

        // Helper to safely check button state
        const isPressed = (idx) => gp.buttons[idx] && gp.buttons[idx].pressed;

        // Check button states
        const aButtonHeld = isPressed(map.A);
        const bButtonHeld = isPressed(map.B);
        const yButtonHeld = isPressed(map.Y);
        const l1Pressed = isPressed(map.L1);
        const r1Pressed = isPressed(map.R1);
        const l2Pressed = isPressed(map.L2);
        const r2Pressed = isPressed(map.R2);
        const startButtonHeld = isPressed(map.START);
        const selectButtonHeld = isPressed(map.SELECT);

        // D-Pad
        if (isPressed(map.UP)) dy = 1; // Up
        if (isPressed(map.DOWN)) dy = -1; // Down

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

            if (!this.wasStartButtonHeld) {
                this.startPressTime = Date.now();
            }

            // Long Press (250ms) to open Track List
            if (!this.startComboUsed && !this.app.isTrackListOpen) {
                if (Date.now() - this.startPressTime > 500) {
                    this.app.toggleTrackListModal(true);
                    this.startComboUsed = true; // Prevent short-press action
                }
            }

        const track = this.app.songData.tracks[this.app.currentTrackId];

        // スティックをデジタル化（高いデッドゾーン）
        let stickX = 0;
        let stickY = 0;
        if (Math.abs(gp.axes[0]) > SHORTCUT_DEADZONE) {
            stickX = gp.axes[0] > 0 ? 1 : -1;
        }
        if (Math.abs(gp.axes[1]) > SHORTCUT_DEADZONE) {
            stickY = gp.axes[1] > 0 ? -1 : 1;
        }

        // エッジ検出
        const stickXChanged = stickX !== this.lastStartStickState.x;
        const stickYChanged = stickY !== this.lastStartStickState.y;

        // Volume (Up/Down) - スティックまたは十字キー
        if ((isPressed(map.UP) && !this.lastButtonState[map.UP]) || (stickYChanged && stickY > 0)) {
            track.volume = Math.min(1.0, track.volume + 0.05);
            this.app.audio.setTrackVolume(this.app.currentTrackId, track.volume);
            this.updateStatus(`Vol: ${track.volume.toFixed(2)}`);
            this.startComboUsed = true;
        }
        if ((isPressed(map.DOWN) && !this.lastButtonState[map.DOWN]) || (stickYChanged && stickY < 0)) {
            track.volume = Math.max(0, track.volume - 0.05);
            this.app.audio.setTrackVolume(this.app.currentTrackId, track.volume);
            this.updateStatus(`Vol: ${track.volume.toFixed(2)}`);
            this.startComboUsed = true;
        }

        // Pan (Left/Right) - スティックまたは十字キー
        if ((isPressed(map.LEFT) && !this.lastButtonState[map.LEFT]) || (stickXChanged && stickX < 0)) {
            track.pan = Math.max(-1.0, track.pan - 0.1);
            this.app.audio.setTrackPan(this.app.currentTrackId, track.pan);
            this.updateStatus(`Pan: ${track.pan.toFixed(1)}`);
            this.startComboUsed = true;
        }
        if ((isPressed(map.RIGHT) && !this.lastButtonState[map.RIGHT]) || (stickXChanged && stickX > 0)) {
            track.pan = Math.min(1.0, track.pan + 0.1);
            this.app.audio.setTrackPan(this.app.currentTrackId, track.pan);
            this.updateStatus(`Pan: ${track.pan.toFixed(1)}`);
            this.startComboUsed = true;
        }

        // Solo (A)
        if (isPressed(map.A) && !this.lastButtonState[map.A]) {
            track.solo = !track.solo;
            this.updateStatus(`Solo: ${track.solo ? 'ON' : 'OFF'}`);
            this.startComboUsed = true;
        }

        // Mute (B)
        if (isPressed(map.B) && !this.lastButtonState[map.B]) {
            track.muted = !track.muted;
            this.updateStatus(`Mute: ${track.muted ? 'ON' : 'OFF'}`);
            this.startComboUsed = true;
        }

        // Start+スティックの状態を保存
        this.lastStartStickState.x = stickX;
        this.lastStartStickState.y = stickY;

    } else {
        // Startを離した時、状態をリセット
        this.lastStartStickState.x = 0;
        this.lastStartStickState.y = 0;

        if (this.wasStartButtonHeld) {
            if (!this.startComboUsed) {
                if (this.app.isTrackListOpen) {
                    this.app.toggleTrackListModal(false);
                } else {
                    this.app.currentTrackId = (this.app.currentTrackId + 1) % 8;
                    this.updateStatus(`Track: ${this.app.currentTrackId + 1}`);
                    if (this.app.updateTrackUI) this.app.updateTrackUI();
                }
            }
            this.startComboUsed = false;
        }

            if (l2Pressed) {
            // グリッドショートカット用：高いデッドゾーンでデジタル化
            let stickX = 0;
            if (Math.abs(gp.axes[0]) > SHORTCUT_DEADZONE) {
                stickX = gp.axes[0] > 0 ? 1 : -1;
            }
            
            // エッジ検出：前回と違う場合のみ反応
            const stickXChanged = stickX !== this.lastL2StickState.x;
            
            // Grid Shortcuts - スティックまたは十字キー
            let newDiv = this.app.ui.gridDivisions;
            let gridChanged = false;

            if ((isPressed(map.RIGHT) && !this.lastButtonState[map.RIGHT]) || (stickXChanged && stickX > 0)) {
                if (newDiv > 2) { newDiv /= 2; gridChanged = true; }
            }
            if ((isPressed(map.LEFT) && !this.lastButtonState[map.LEFT]) || (stickXChanged && stickX < 0)) {
                if (newDiv < 32) { newDiv *= 2; gridChanged = true; }
            }

            if (gridChanged) {
                this.app.ui.setGridDivisions(newDiv);
                // Update default note duration and snap cursor
                const step = 4 / newDiv;
                this.lastNoteDuration = step;
                this.state.cursor.time = Math.round(this.state.cursor.time / step) * step;
                this.updateStatus(`Grid: 1/${newDiv}`);
            }
            
            // L2+スティックの状態を保存
            this.lastL2StickState.x = stickX;
            
            // L2を押している間は通常の左右移動を無効化
            dx = 0;
        } else {
            // L2を離した時、状態をリセット
            this.lastL2StickState.x = 0;
            
            // 通常のスティック操作（連続入力OK、低いデッドゾーン）
            // Normal D-Pad
            if (isPressed(map.LEFT)) dx = -1;
            if (isPressed(map.RIGHT)) dx = 1;
        }
    }

    // Left Stick（通常操作時のみ、連続入力可能）
    if (!startButtonHeld && !l2Pressed) {
        if (Math.abs(gp.axes[0]) > DEADZONE) dx = gp.axes[0] > 0 ? 1 : -1;
        if (Math.abs(gp.axes[1]) > DEADZONE) dy = gp.axes[1] > 0 ? -1 : 1;
    }

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
                this.processMovement('x', dx, 'grid');
                this.processMovement('y', dy, 'semitone');
                this.updateRangeSelection();
            }

        } else if (this.wasYButtonHeld && !yButtonHeld) {
            // Y button just released - finalize selection
            if (this.state.selectionStart) {
                this.finalizeSelection();
            }

        } else if (aButtonHeld && (dx !== 0 || dy !== 0)) {
            // A + Left/Right = Change note duration, A + Up/Down = Change Velocity
            if (dx !== 0) this.processNoteLengthChange(dx);
            if (dy !== 0) this.processNoteVelocityChange(dy);

        } else if (this.state.hasSelection && (dx !== 0 || dy !== 0)) {
            // Have selection and moving - move selected notes
            this.moveSelectedNotes(dx, dy);

        } else {
            // Normal cursor movement
            // Check for R2 modifier for fast movement
            const unitX = r2Pressed ? 'measure' : 'grid';
            const unitY = r2Pressed ? 'octave' : 'semitone';

            this.processMovement('x', dx, unitX);
            this.processMovement('y', dy, unitY);
        }

        // Clear continuous action timers if not in use
        if (!aButtonHeld) {
            delete this.repeatTimers['note_length'];
            delete this.repeatTimers['note_velocity'];
        }
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
        
        // Update Velocity Display
        const noteAtCursor = this.getNoteAtCursor();
        const displayVel = noteAtCursor ? (noteAtCursor.velocity || 100) : this.lastNoteVelocity;
        const velEl = document.getElementById('vel-val');
        if (velEl) velEl.textContent = Math.round(displayVel);
    }

    handleButtons(gp, dx, dy, suppressActions = false, selectButtonHeld = false) {
        const map = this.buttonMap;
        // Helper for button down
        const isDown = (i) => gp.buttons[i] && gp.buttons[i].pressed;
        const wasDown = (i) => this.lastButtonState[i];
        const now = Date.now();

        try {
            if (!suppressActions) {
            // Button 0 (A/Cross): Paste or Place Note
            if (isDown(map.A) && !wasDown(map.A) && dx === 0 && dy === 0) {
                if (!this.state.hasSelection) {
                    if (this.state.clipboard) {
                        this.pasteClipboard();
                    } else {
                        this.placeNote();
                    }
                }
            }

            // Button 2 (X/Square): Play from cursor position
            if (isDown(map.X) && !wasDown(map.X)) {
                this.playFromCursor();
            }

            // Button 1 (B/Circle): Short=Copy/Clear, Long=Delete
            if (isDown(map.B)) {
                if (!wasDown(map.B)) {
                    this.bButtonDownTime = now;
                    this.bButtonActionHandled = false;
                } else {
                    // Holding
                    if (!this.bButtonActionHandled && (now - this.bButtonDownTime > 300)) {
                        if (this.state.hasSelection) {
                            this.deleteSelectedNotes();
                            this.app.showToast("Selection Deleted");
                            this.bButtonActionHandled = true;
                        }
                    }
                }
            } else if (wasDown(map.B)) {
                // Released
                if (!this.bButtonActionHandled) {
                    if (this.state.hasSelection) {
                        this.copySelection();
                        this.app.showToast("Copied");
                    } else if (this.state.clipboard) {
                        this.state.clipboard = null;
                        this.updateStatus("Clipboard cleared");
                        this.app.showToast("Clipboard Cleared");
                    }
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
                const velocity = this.lastNoteVelocity;

                notes.push({ time, pitch, duration, velocity });

                // Play feedback
                if (this.app.audio && this.app.audio.playNote) {
                    this.app.audio.playNote(pitch, 0.25, trackId, velocity);
                }
            }
        } catch (e) {
            console.error("Error in placeNote:", e);
        }
    }

    processNoteLengthChange(dx) {
        let targets = [];
        if (this.state.hasSelection && this.state.selectedNotes.length > 0) {
            targets = this.state.selectedNotes;
        } else {
            const { time, pitch } = this.state.cursor;
            const track = this.app.songData.tracks[this.app.currentTrackId];
            const notes = track.notes;
            const EPSILON = 0.001;
            const note = notes.find(n => Math.abs(n.time - time) < EPSILON && n.pitch === pitch);
            if (note) targets.push(note);
        }

        if (targets.length > 0) {
            // Apply rate-limited change (slower than cursor movement)
            const now = Date.now();
            const key = 'note_length';
            const NOTE_LENGTH_DELAY = 150; // Initial delay before repeat
            const NOTE_LENGTH_RATE = 120;  // Rate when holding (slower than cursor)
            const step = 4 / this.app.ui.gridDivisions; // Change by grid step

            const applyChange = () => {
                targets.forEach(note => {
                    note.duration += dx > 0 ? step : -step;
                    if (note.duration < step) note.duration = step;
                    this.lastNoteDuration = note.duration;
                });
            };

            if (!this.repeatTimers[key]) {
                this.app.saveState();
                applyChange();
                this.repeatTimers[key] = { start: now, lastInfo: now };
            } else {
                const timer = this.repeatTimers[key];
                if (now - timer.start > NOTE_LENGTH_DELAY) {
                    if (now - timer.lastInfo > NOTE_LENGTH_RATE) {
                        applyChange();
                        timer.lastInfo = now;
                    }
                }
            }
        }
    }

    processNoteVelocityChange(dy) {
        let targets = [];
        if (this.state.hasSelection && this.state.selectedNotes.length > 0) {
            targets = this.state.selectedNotes;
        } else {
            const { time, pitch } = this.state.cursor;
            const track = this.app.songData.tracks[this.app.currentTrackId];
            const EPSILON = 0.001;
            const note = track.notes.find(n => Math.abs(n.time - time) < EPSILON && n.pitch === pitch);
            if (note) targets.push(note);
        }

        if (targets.length > 0) {
            const now = Date.now();
            const key = 'note_velocity';
            const DELAY = 150;
            const RATE = 50; // Faster than length change
            const step = 5; // Velocity step

            const applyChange = () => {
                targets.forEach(note => {
                    if (note.velocity === undefined) note.velocity = 100;
                    note.velocity += dy > 0 ? step : -step;
                    if (note.velocity < 1) note.velocity = 1;
                    if (note.velocity > 127) note.velocity = 127;
                    this.lastNoteVelocity = note.velocity;
                });
            };

            if (!this.repeatTimers[key]) {
                this.app.saveState();
                applyChange();
                this.repeatTimers[key] = { start: now, lastInfo: now };
            } else {
                const timer = this.repeatTimers[key];
                if (now - timer.start > DELAY && now - timer.lastInfo > RATE) {
                    applyChange();
                    timer.lastInfo = now;
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

    getNoteAtCursor() {
        const { time, pitch } = this.state.cursor;
        const track = this.app.songData.tracks[this.app.currentTrackId];
        const EPSILON = 0.001;
        return track.notes.find(n => Math.abs(n.time - time) < EPSILON && n.pitch === pitch);
    }
}
