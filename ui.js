export class UIManager {
    constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('piano-roll');
        this.ctx = this.canvas.getContext('2d');

        // Dimensions
        this.width = 0;
        this.height = 0;

        // View State
        this.scrollX = 0; // Time in pixels
        this.scrollY = 0; // Pitch pixels (calculated from C8 down usually)

        // Settings
        this.beatWidth = 50; // Pixels per beat/quarter note
        this.keyHeight = 20; // Pixels per key
        this.headerHeight = 30; // Ruler height
        this.gridColor = '#2d3436';
        this.barColor = '#636e72';
        this.bgColor = '#111';

        // Grid Settings
        this.gridDivisions = 4; // Divisions per bar (4 beats). 4 = quarter notes.

        // State
        this.cursorTime = 0; // In beats
        this.cursorPitch = 60; // MIDI Note Number (Middle C)
        this.hasCursor = false;
        this.pianoKeyWidth = 40;
    }

    setGridDivisions(divisions) {
        const oldBeatWidth = this.beatWidth;
        this.gridDivisions = divisions;

        // Dynamic Scaling
        // Ensure minimal visibility for grid lines
        const step = 4 / divisions; // Beats per grid line
        const MIN_PIXELS_PER_GRID = 15; // Minimum pixels between grid lines

        // Exception: 1/16 grid uses 1/8 grid's scaling factor to maintain same measure width
        let scalingDivisions = divisions;
        if (divisions === 16) {
            scalingDivisions = 8;
        }
        const scalingStep = 4 / scalingDivisions;

        this.beatWidth = Math.max(50, MIN_PIXELS_PER_GRID / scalingStep);

        // Adjust scrollX to keep cursor at the same screen position
        if (this.hasCursor) {
            const cursorTime = this.cursorTime;
            this.scrollX += cursorTime * (this.beatWidth - oldBeatWidth);
            if (this.scrollX < 0) this.scrollX = 0;
        }

        console.log(`Grid: ${divisions}, BeatWidth: ${this.beatWidth}, ScrollX: ${this.scrollX}`);
    }

    resize() {
        const container = document.getElementById('canvas-container');
        this.width = container.clientWidth;
        this.height = container.clientHeight;

        // Handle High DPI
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.width * dpr;
        this.canvas.height = this.height * dpr;
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;
        this.ctx.scale(dpr, dpr);

        // Center view on Middle C initially if needed
        // For now, let's just ensure we render something
        this.scrollY = (127 - 60) * this.keyHeight - this.height / 2;
    }

    draw(inputState, playheadTime = -1) {
        // Get data
        const currentTrack = this.app.songData.tracks[this.app.currentTrackId];
        const notes = currentTrack ? currentTrack.notes : [];
        const selectedNotes = inputState ? inputState.selectedNotes || [] : [];
        const selectionStart = inputState ? inputState.selectionStart : null;

        // Update local cursor state
        if (inputState && inputState.cursor) {
            this.hasCursor = true;
            this.cursorTime = inputState.cursor.time;
            this.cursorPitch = inputState.cursor.pitch;
        } else {
            this.hasCursor = false;
        }

        // Auto-scroll Playhead
        if (this.app.isPlaying && playheadTime >= 0) {
            const playheadScreenX = playheadTime * this.beatWidth - this.scrollX + this.pianoKeyWidth;
            if (playheadScreenX > this.width) {
                this.scrollX = playheadTime * this.beatWidth;
            } else if (playheadScreenX < this.pianoKeyWidth) {
                this.scrollX = playheadTime * this.beatWidth;
            }
            if (this.scrollX < 0) this.scrollX = 0;
        }

        // Clear
        this.ctx.fillStyle = this.bgColor;
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Draw Grid
        this.drawGrid();

        // Draw Ghost Notes (Other tracks)
        this.app.songData.tracks.forEach(track => {
            if (track.id !== this.app.currentTrackId && !track.muted) {
                this.drawGhostNotes(track.notes);
            }
        });

        // Draw Selection Range (if selecting)
        if (selectionStart && inputState.cursor) {
            this.drawSelectionRange(selectionStart, inputState.cursor);
        }

        // Draw Notes
        this.drawNotes(notes, selectedNotes);

        // Draw Cursor
        if (inputState && inputState.cursor) {
            this.drawCursor(inputState.cursor);
        }

        // Draw Playhead
        if (playheadTime >= 0) {
            const x = playheadTime * this.beatWidth - this.scrollX + this.pianoKeyWidth;
            if (x >= 0 && x <= this.width) {
                this.ctx.strokeStyle = '#0984e3';
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, this.height);
                this.ctx.stroke();
            }
        }

        // Draw Piano Keys
        this.drawPianoKeys();

        // Draw Ruler Overlay
        this.drawRuler();
    }

    drawSelectionRange(start, end) {
        const minTime = Math.min(start.time, end.time);
        const maxTime = Math.max(start.time, end.time);
        const minPitch = Math.round(Math.min(start.pitch, end.pitch));
        const maxPitch = Math.round(Math.max(start.pitch, end.pitch));

        const x = minTime * this.beatWidth - this.scrollX + this.pianoKeyWidth;
        const y = (127 - maxPitch) * this.keyHeight - this.scrollY;
        const w = (maxTime - minTime + 4 / this.gridDivisions) * this.beatWidth; // Expand to cover grid slot roughly
        // Ideally selection should be inclusive of the full grid slot
        // But for now point-based selection logic might define size differently
        // Reverting w calc safely:
        // const w = (Math.abs(start.time - end.time) + ... ) 
        // Let's stick to simple box for now, maybe refined later.

        // Actually, let's use the width of the current note duration or grid step
        const step = 4 / this.gridDivisions;
        const width = (maxTime - minTime) * this.beatWidth + (step * this.beatWidth);
        const h = (maxPitch - minPitch + 1) * this.keyHeight;

        this.ctx.fillStyle = 'rgba(0, 184, 148, 0.15)';
        this.ctx.fillRect(x, y, width, h);

        this.ctx.strokeStyle = '#00b894';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(x, y, width, h);
        this.ctx.setLineDash([]);
    }

    drawNotes(notes, selectedNotes = []) {
        // For prototype, simple loop is fine
        for (const note of notes) {
            const x = note.time * this.beatWidth - this.scrollX + this.pianoKeyWidth;
            const y = (127 - note.pitch) * this.keyHeight - this.scrollY;

            // Basic culling
            if (x + this.beatWidth < 0 || x > this.width || y + this.keyHeight < 0 || y > this.height) continue;

            const w = (note.duration || 1) * this.beatWidth;

            // Check if selected
            const isSelected = selectedNotes.includes(note);

            if (isSelected) {
                this.ctx.fillStyle = '#00cec9'; // Cyan for selected
                this.ctx.strokeStyle = '#00b894';
            } else {
                this.ctx.fillStyle = '#fd79a8'; // Normal pink
                this.ctx.strokeStyle = '#e84393';
            }

            this.ctx.lineWidth = isSelected ? 2 : 1;
            this.ctx.fillRect(x + 1, y + 1, w - 2, this.keyHeight - 2);
            this.ctx.strokeRect(x + 1, y + 1, w - 2, this.keyHeight - 2);
        }
    }

    drawGhostNotes(notes) {
        this.ctx.fillStyle = 'rgba(120, 120, 120, 0.2)';
        this.ctx.strokeStyle = 'rgba(150, 150, 150, 0.3)';
        this.ctx.lineWidth = 1;

        for (const note of notes) {
            const x = note.time * this.beatWidth - this.scrollX + this.pianoKeyWidth;
            const y = (127 - note.pitch) * this.keyHeight - this.scrollY;

            if (x + this.beatWidth < 0 || x > this.width || y + this.keyHeight < 0 || y > this.height) continue;

            const w = (note.duration || 1) * this.beatWidth;

            this.ctx.fillRect(x + 1, y + 1, w - 2, this.keyHeight - 2);
            this.ctx.strokeRect(x + 1, y + 1, w - 2, this.keyHeight - 2);
        }
    }

    drawGrid() {
        // Calculate step size in beats based on gridDivisions (divisions per bar of 4 beats)
        const step = 4 / this.gridDivisions;

        const startBeat = Math.floor(this.scrollX / this.beatWidth);
        const endBeat = startBeat + Math.ceil(this.width / this.beatWidth) + 1;



        // Draw Vertical Lines (Time/Beats)
        this.ctx.lineWidth = 1;

        // Align start to grid
        const gridStart = Math.floor(startBeat / step) * step;

        // Draw Background Highlights for Even Beats (2nd, 4th, etc.) relative to Bar Start
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';

        // Loop beats for highlights
        for (let b = Math.floor(startBeat); b < endBeat; b++) {
            // Find which bar this beat belongs to to calculate relative index
            // This is slightly complex with variable time signatures effectively.
            // Simplified approach: Ask transport for bar context or just checking modulo?
            // "Regardless of time signature, always highlight even beats of the bar"

            // We need to know "Beat Index in Bar" (0-based)
            // Implementation: Scan backwards from 'b' to find the last bar start?
            // Or more efficiently, transport could return { beatInBar, barNum } ?
            // Let's implement a helper properly?

            // Since we don't have helper yet, let's iterate bars from 0?
            // Expensive.
            // Let's assume constant time signature for now within the view or use simple scan?
            // No, user requested "variable" support.

            // Optimization: Transport likely has sparse TimeSig map.
            // We can find the active TimeSig at 'b'.
            // But we need to know the phase offset from the TimeSig change point.

            const ts = this.app.transport.getTimeSigAt(b);
            // Calculate beat index relative to the TimeSig change beat
            const relBeat = b - ts.beat;
            const beatsPerBar = ts.num * (4 / ts.den);

            // Current beat index in the sequence of bars starting from ts.beat
            const beatInBar = relBeat % beatsPerBar;

            // "Even beats" means 2nd (index 1), 4th (index 3), etc.
            // check if floor(beatInBar) is odd (1, 3, 5...)
            // Note: beatInBar is float if 'b' is float? 'b' here is loop int iterator.

            // Warning: Floating point precision.
            // beatInBar should be close to integer.
            const beatIndex = Math.round(beatInBar);

            if (beatIndex % 2 === 1) { // 1 (2nd beat), 3 (4th beat)...
                const x = b * this.beatWidth - this.scrollX + this.pianoKeyWidth;
                this.ctx.fillRect(x, 0, this.beatWidth, this.height);
            }
        }

        for (let t = gridStart; t < endBeat; t += step) {
            const x = t * this.beatWidth - this.scrollX + this.pianoKeyWidth;

            // Avoid drawing off-screen too much
            if (x < -10) continue;

            this.ctx.beginPath();

            // Check if Bar Start
            const isBar = this.app.transport.isBarStart(t);

            if (isBar) {
                this.ctx.strokeStyle = this.barColor; // Bar line
                this.ctx.lineWidth = 2;
            } else {
                this.ctx.strokeStyle = this.gridColor; // Beat/Subdivision line
                this.ctx.lineWidth = 1;
            }

            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.height);
            this.ctx.stroke();
        }



        // Draw Horizontal Lines (Pitch)
        // Standard MIDI range 0-127
        // Let's assume Top is 127
        const startNote = 127 - Math.floor((this.scrollY) / this.keyHeight);
        const endNote = 127 - Math.floor((this.scrollY + this.height) / this.keyHeight);

        // Note: Rendering optimization needed later, just drawing visible range
        for (let note = 127; note >= 0; note--) {
            const y = (127 - note) * this.keyHeight - this.scrollY;

            if (y < -this.keyHeight || y > this.height) continue;

            // Draw Background for Black Keys
            const isBlack = this.isBlackKey(note);
            if (isBlack) {
                this.ctx.fillStyle = '#1e272e';
                this.ctx.fillRect(this.pianoKeyWidth, y, this.width - this.pianoKeyWidth, this.keyHeight);
            }

            // Line
            this.ctx.strokeStyle = this.gridColor;
            this.ctx.beginPath();
            this.ctx.moveTo(this.pianoKeyWidth, y);
            this.ctx.lineTo(this.width, y);
            this.ctx.stroke();
        }
    }

    drawCursor(cursor) {
        // Cursor is defined by Time (beats) and Pitch (int)
        const x = cursor.time * this.beatWidth - this.scrollX + this.pianoKeyWidth;
        const y = (127 - cursor.pitch) * this.keyHeight - this.scrollY;

        const step = 4 / this.gridDivisions;
        const w = step * this.beatWidth;

        this.ctx.fillStyle = 'rgba(108, 92, 231, 0.5)';
        this.ctx.fillRect(x, y, w, this.keyHeight);

        this.ctx.strokeStyle = '#6c5ce7';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x, y, w, this.keyHeight);
    }

    drawRuler() {
        // Corner Box
        this.ctx.fillStyle = '#2d3436';
        this.ctx.fillRect(0, 0, this.pianoKeyWidth, this.headerHeight);

        // Overlay background
        this.ctx.fillStyle = 'rgba(30, 30, 30, 0.9)';
        this.ctx.fillRect(this.pianoKeyWidth, 0, this.width - this.pianoKeyWidth, this.headerHeight);

        this.ctx.strokeStyle = '#555';
        this.ctx.beginPath();
        this.ctx.moveTo(0, this.headerHeight);
        this.ctx.lineTo(this.width, this.headerHeight);
        this.ctx.stroke();

        // Draw Ruler Info
        const startBeat = Math.floor(this.scrollX / this.beatWidth);
        const endBeat = startBeat + Math.ceil(this.width / this.beatWidth) + 1;

        // Optimize: Iterate by bars? 
        // We need to iterate all beats to check for bar starts or BPM changes if we want to be safe,
        // or just iterate visual width.
        // Let's iterate visual width in steps of 1 beat (display beat numbers)

        this.ctx.font = '12px sans-serif';
        this.ctx.textAlign = 'left';

        // To avoid overlapping text, maybe only draw measure numbers on bar starts?
        // And BPM changes?

        for (let b = startBeat; b < endBeat; b++) {
            const x = b * this.beatWidth - this.scrollX + this.pianoKeyWidth;
            if (x < -20) continue;

            const context = this.app.transport.getMeasureAt(b);

            // Check if bar start
            const isBarStart = Math.abs(context.beatInBar) < 0.001;

            if (isBarStart) {
                // Draw Measure Number
                this.ctx.fillStyle = '#dfe6e9';
                this.ctx.fillText(context.measure.toString(), x + 5, 20);

                // Show BPM/TS only at Measure 1 or if there is a change event at this beat
                let showInfo = (Math.abs(b) < 0.001); // Always show at beat 0

                // Check for TS Change at this beat
                if (this.app.transport.timeSigMap.some(e => Math.abs(e.beat - b) < 0.001)) {
                    showInfo = true;
                }

                // Check for Tempo Change at this beat
                if (this.app.transport.tempoMap.some(e => Math.abs(e.beat - b) < 0.001)) {
                    showInfo = true;
                }

                if (showInfo) {
                    // Draw BPM/TS small below measure number
                    this.ctx.font = '10px sans-serif';
                    this.ctx.fillStyle = '#b2bec3';
                    const bpm = this.app.transport.getBpmAt(b);
                    const ts = context.timeSig;
                    this.ctx.fillText(`${bpm}bpm ${ts.num}/${ts.den}`, x + 20, 20);
                }

                this.ctx.strokeStyle = '#999';
                this.ctx.beginPath();
                this.ctx.moveTo(x, 0);
                this.ctx.lineTo(x, this.headerHeight);
                this.ctx.stroke();

                // Restore font
                this.ctx.font = '12px sans-serif';
            } else {
                // Draw beat ticks (small)
                if (b % 1 === 0) { // Full beats
                    this.ctx.fillStyle = '#636e72';
                    this.ctx.fillRect(x, this.headerHeight - 5, 1, 5);
                    // Optional: Draw beat number (1.2, 1.3...)
                    // this.ctx.fillText(`${Math.floor(context.beatInBar) + 1}`, x + 2, this.headerHeight - 8);
                }
            }
        }
    }

    isBlackKey(note) {
        const n = note % 12;
        return (n === 1 || n === 3 || n === 6 || n === 8 || n === 10);
    }

    drawPianoKeys() {
        // Draw background for keys column
        this.ctx.fillStyle = '#1e272e';
        this.ctx.fillRect(0, 0, this.pianoKeyWidth, this.height);

        const startNote = 127 - Math.floor((this.scrollY) / this.keyHeight);
        const endNote = 127 - Math.floor((this.scrollY + this.height) / this.keyHeight);

        for (let note = startNote; note >= endNote; note--) {
            const y = (127 - note) * this.keyHeight - this.scrollY;
            if (y < -this.keyHeight || y > this.height) continue;

            const isBlack = this.isBlackKey(note);

            this.ctx.fillStyle = isBlack ? '#000000' : '#ffffff';
            this.ctx.fillRect(0, y, this.pianoKeyWidth, this.keyHeight);

            this.ctx.strokeStyle = '#b2bec3';
            this.ctx.strokeRect(0, y, this.pianoKeyWidth, this.keyHeight);

            // Label C notes
            if (note % 12 === 0) {
                this.ctx.fillStyle = isBlack ? '#fff' : '#000';
                this.ctx.font = '10px sans-serif';
                this.ctx.textAlign = 'right';
                this.ctx.fillText(`C${Math.floor(note / 12) - 1}`, this.pianoKeyWidth - 5, y + this.keyHeight - 5);
            }
        }
        
        // Border right
        this.ctx.strokeStyle = '#000';
        this.ctx.beginPath();
        this.ctx.moveTo(this.pianoKeyWidth, 0);
        this.ctx.lineTo(this.pianoKeyWidth, this.height);
        this.ctx.stroke();
    }
}
