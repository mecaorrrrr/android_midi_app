import { theme, font, withAlpha } from './theme.js';

/**
 * Pattern view: piano roll of the edited pattern (canvas).
 * Rows are pitches (127 at the top), columns are beats. The ruler overlays the top edge.
 */
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
        this.scrollY = 0; // Pitch pixels (0 = pitch 127 at the top)

        // Settings
        this.beatWidth = 50; // Pixels per beat/quarter note
        this.keyHeight = 20; // Pixels per key
        this.headerHeight = 24; // Ruler height

        // Grid Settings
        this.gridDivisions = 4; // Divisions per bar (4 beats). 4 = quarter notes.

        // State
        this.cursorTime = 0; // In beats
        this.cursorPitch = 60; // MIDI Note Number (Middle C)
        this.hasCursor = false;
        this.pianoKeyWidth = 44;
    }

    setGridDivisions(divisions) {
        const oldBeatWidth = this.beatWidth;
        this.gridDivisions = divisions;

        // Keep grid lines at least MIN_PIXELS_PER_GRID apart.
        // 1/16 uses the 1/8 scaling so a measure keeps the same width.
        const MIN_PIXELS_PER_GRID = 8;
        const scalingDivisions = divisions === 16 ? 8 : divisions;
        const scalingStep = 4 / scalingDivisions;
        this.beatWidth = Math.max(50, MIN_PIXELS_PER_GRID / scalingStep);

        // Keep the cursor at the same screen position
        if (this.hasCursor) {
            this.scrollX += this.cursorTime * (this.beatWidth - oldBeatWidth);
            if (this.scrollX < 0) this.scrollX = 0;
        }
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
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Center view on Middle C initially
        this.scrollY = (127 - 60) * this.keyHeight - this.height / 2;
    }

    // Screen position helpers
    timeToX(time) {
        return time * this.beatWidth - this.scrollX + this.pianoKeyWidth;
    }

    pitchToY(pitch) {
        return (127 - pitch) * this.keyHeight - this.scrollY;
    }

    draw(inputState, playheadTime = -1) {
        const ctx = this.ctx;
        const pattern = this.app.currentPattern;
        const notes = pattern ? pattern.notes : [];
        const selectedNotes = inputState ? inputState.selectedNotes || [] : [];
        const selectionStart = inputState ? inputState.selectionStart : null;

        if (inputState && inputState.cursor) {
            this.hasCursor = true;
            this.cursorTime = inputState.cursor.time;
            this.cursorPitch = inputState.cursor.pitch;
        } else {
            this.hasCursor = false;
        }

        this.autoScroll(playheadTime);

        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, this.width, this.height);

        this.drawGrid();
        this.drawGhostNotes(this.app.getGhostNotes());

        // Area after the end of the pattern (notes there are not played)
        if (pattern) {
            const endX = this.timeToX(pattern.length);
            if (endX < this.width) {
                const x = Math.max(endX, this.pianoKeyWidth);
                ctx.fillStyle = withAlpha(theme.ink, 0.12);
                ctx.fillRect(x, 0, this.width - x, this.height);
                ctx.fillStyle = theme.ink;
                ctx.fillRect(endX - 0.5, 0, 1, this.height);
            }
        }

        if (selectionStart && inputState.cursor) {
            this.drawSelectionRange(selectionStart, inputState.cursor);
        }

        this.drawNotes(notes, selectedNotes);

        if (inputState && inputState.cursor) {
            this.drawCursor(inputState.cursor);
        }

        if (this.app.isPlaying && playheadTime >= 0) {
            const x = this.timeToX(playheadTime);
            if (x >= this.pianoKeyWidth && x <= this.width) {
                ctx.fillStyle = theme.trig;
                ctx.fillRect(x - 1, 0, 2, this.height);
            }
        }

        this.drawPianoKeys();
        this.drawRuler();
    }

    autoScroll(playheadTime) {
        // Follow the playhead
        if (this.app.isPlaying && playheadTime >= 0) {
            const x = this.timeToX(playheadTime);
            if (x > this.width || x < this.pianoKeyWidth) {
                this.scrollX = Math.max(0, playheadTime * this.beatWidth);
            }
        }

        // Keep the cursor in view
        if (this.hasCursor) {
            const cursorX = this.timeToX(this.cursorTime);
            const cursorY = this.pitchToY(this.cursorPitch);
            const marginX = 50;
            const marginY = 50;
            if (cursorX > this.width - marginX) {
                this.scrollX = this.cursorTime * this.beatWidth - marginX;
            }
            if (cursorX < this.pianoKeyWidth + marginX) {
                this.scrollX = this.cursorTime * this.beatWidth - this.pianoKeyWidth - marginX;
            }
            if (cursorY > this.height - marginY) {
                this.scrollY = (127 - this.cursorPitch) * this.keyHeight - this.height + marginY;
            }
            if (cursorY < this.headerHeight + marginY) {
                this.scrollY = (127 - this.cursorPitch) * this.keyHeight - this.headerHeight - marginY;
            }
            if (this.scrollX < 0) this.scrollX = 0;
            if (this.scrollY < 0) this.scrollY = 0;
        }
    }

    drawSelectionRange(start, end) {
        const ctx = this.ctx;
        const minTime = Math.min(start.time, end.time);
        const maxTime = Math.max(start.time, end.time);
        const minPitch = Math.round(Math.min(start.pitch, end.pitch));
        const maxPitch = Math.round(Math.max(start.pitch, end.pitch));

        const step = 4 / this.gridDivisions;
        const x = this.timeToX(minTime);
        const y = this.pitchToY(maxPitch);
        const w = (maxTime - minTime + step) * this.beatWidth;
        const h = (maxPitch - minPitch + 1) * this.keyHeight;

        ctx.fillStyle = withAlpha(theme.trig, 0.1);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = theme.trig;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.setLineDash([]);
    }

    drawNotes(notes, selectedNotes = []) {
        const ctx = this.ctx;
        for (const note of notes) {
            const x = this.timeToX(note.time);
            const y = this.pitchToY(note.pitch);
            const w = (note.duration || 1) * this.beatWidth;
            if (x + w < 0 || x > this.width || y + this.keyHeight < 0 || y > this.height) continue;

            // Velocity is shown as ink density
            const velocity = note.velocity !== undefined ? note.velocity : 100;
            ctx.globalAlpha = selectedNotes.includes(note) ? 1 : 0.35 + velocity / 195;
            ctx.fillStyle = selectedNotes.includes(note) ? theme.trig : theme.ink;
            ctx.fillRect(x + 1, y + 2, w - 2, this.keyHeight - 4);
        }
        ctx.globalAlpha = 1;
    }

    drawGhostNotes(notes) {
        const ctx = this.ctx;
        ctx.strokeStyle = theme.ghost;
        ctx.lineWidth = 1;
        for (const note of notes) {
            const x = this.timeToX(note.time);
            const y = this.pitchToY(note.pitch);
            const w = (note.duration || 1) * this.beatWidth;
            if (x + w < 0 || x > this.width || y + this.keyHeight < 0 || y > this.height) continue;
            ctx.strokeRect(x + 1.5, y + 2.5, w - 3, this.keyHeight - 5);
        }
    }

    drawGrid() {
        const ctx = this.ctx;
        const left = this.pianoKeyWidth;

        // Pitch rows
        ctx.fillStyle = theme.lane;
        ctx.fillRect(left, 0, this.width - left, this.height);
        const topNote = 127 - Math.floor(this.scrollY / this.keyHeight);
        const bottomNote = 127 - Math.floor((this.scrollY + this.height) / this.keyHeight);
        for (let note = topNote; note >= Math.max(0, bottomNote); note--) {
            const y = this.pitchToY(note);
            if (this.isBlackKey(note)) {
                ctx.fillStyle = withAlpha(theme.ink, 0.05);
                ctx.fillRect(left, y, this.width - left, this.keyHeight);
            }
            ctx.fillStyle = note % 12 === 0 ? theme.line : theme.rowLine;
            ctx.fillRect(left, y + this.keyHeight - 1, this.width - left, 1);
        }

        // Time columns: grid steps, beats and bars
        const step = 4 / this.gridDivisions;
        const startBeat = Math.floor(this.scrollX / this.beatWidth);
        const endBeat = startBeat + Math.ceil(this.width / this.beatWidth) + 1;
        const firstLine = Math.floor(startBeat / step) * step;
        for (let t = firstLine; t < endBeat; t += step) {
            const x = Math.round(this.timeToX(t));
            if (x < left) continue;
            const isBar = this.app.transport.isBarStart(t);
            const isBeat = Math.abs(t - Math.round(t)) < 1e-6;
            ctx.fillStyle = isBar ? theme.ink : (isBeat ? theme.line : withAlpha(theme.line, 0.55));
            ctx.fillRect(x, 0, 1, this.height);
        }
    }

    drawCursor(cursor) {
        const ctx = this.ctx;
        const x = this.timeToX(cursor.time);
        const y = this.pitchToY(cursor.pitch);
        const w = (4 / this.gridDivisions) * this.beatWidth;
        ctx.strokeStyle = theme.trig;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y, w + 2, this.keyHeight);
    }

    drawRuler() {
        const ctx = this.ctx;
        const h = this.headerHeight;
        const left = this.pianoKeyWidth;
        const transport = this.app.transport;

        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, this.width, h);
        ctx.fillStyle = theme.ink;
        ctx.fillRect(left, h - 1, this.width - left, 1);

        // Loop region (red bar along the top)
        if (this.app.loopRegion) {
            const x0 = Math.max(left, this.timeToX(this.app.loopRegion.start));
            const x1 = Math.min(this.width, this.timeToX(this.app.loopRegion.end));
            if (x1 > x0) {
                ctx.fillStyle = this.app.isLooping ? theme.trig : theme.graphite;
                ctx.fillRect(x0, 0, x1 - x0, 3);
            }
        }

        // Bar numbers and beat ticks
        const startBeat = Math.floor(this.scrollX / this.beatWidth);
        const endBeat = startBeat + Math.ceil(this.width / this.beatWidth) + 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        for (let b = startBeat; b < endBeat; b++) {
            const x = Math.round(this.timeToX(b));
            if (x < left) continue;
            const context = transport.getMeasureAt(b);
            if (Math.abs(context.beatInBar) < 0.001) {
                ctx.fillStyle = theme.ink;
                ctx.fillRect(x, 4, 1, h - 4);
                ctx.font = font(12);
                ctx.fillText(String(context.measure), x + 4, h - 7);

                // Tempo / time signature at the start and where they change
                const changes = b === 0
                    || transport.timeSigMap.some(e => Math.abs(e.beat - b) < 0.001)
                    || transport.tempoMap.some(e => Math.abs(e.beat - b) < 0.001);
                if (changes) {
                    ctx.fillStyle = theme.graphite;
                    ctx.font = font(10);
                    const ts = context.timeSig;
                    ctx.fillText(`${transport.getBpmAt(b)} bpm  ${ts.num}/${ts.den}`, x + 20, h - 7);
                }
            } else {
                ctx.fillStyle = theme.line;
                ctx.fillRect(x, h - 6, 1, 5);
            }
        }

        // Markers live on the song timeline: shift them into pattern-local time
        ctx.font = font(11, '600');
        for (const marker of transport.markerMap) {
            const x = this.timeToX(marker.beat - this.app.patternContextStart);
            if (x < left || x > this.width) continue;
            ctx.fillStyle = theme.trig;
            ctx.fillText(marker.label, x + 4, 11);
        }

        // Corner above the keyboard
        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, left, h);
    }

    isBlackKey(note) {
        const n = note % 12;
        return (n === 1 || n === 3 || n === 6 || n === 8 || n === 10);
    }

    drawPianoKeys() {
        const ctx = this.ctx;
        const w = this.pianoKeyWidth - 6;
        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, this.pianoKeyWidth, this.height);

        const topNote = 127 - Math.floor(this.scrollY / this.keyHeight);
        const bottomNote = 127 - Math.floor((this.scrollY + this.height) / this.keyHeight);
        ctx.font = font(10);
        ctx.textAlign = 'right';
        for (let note = topNote; note >= Math.max(0, bottomNote); note--) {
            const y = this.pitchToY(note);
            const black = this.isBlackKey(note);
            ctx.fillStyle = black ? theme.ink : theme.keyWhite;
            ctx.fillRect(0, y, w, this.keyHeight);
            ctx.fillStyle = black ? theme.ink : theme.line;
            ctx.fillRect(0, y + this.keyHeight - 1, w, 1);
            if (note % 12 === 0) {
                ctx.fillStyle = theme.graphite;
                ctx.fillText(`C${Math.floor(note / 12) - 1}`, w - 4, y + this.keyHeight - 5);
            }
        }
        ctx.fillStyle = theme.ink;
        ctx.fillRect(w, 0, 1, this.height);
    }
}
