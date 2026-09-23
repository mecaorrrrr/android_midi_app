import { getPattern, clipAt } from './song.js';

// One color per track (clips, header stripes)
export const TRACK_COLORS = ['#fd79a8', '#74b9ff', '#55efc4', '#ffeaa7', '#a29bfe', '#fab1a0', '#81ecec', '#ff7675'];

/**
 * Song (arrangement) view: tracks as rows, bars as columns, clips as blocks.
 * Shares the canvas with the piano roll (UIManager owns size / DPI handling).
 */
export class SongView {
    constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('piano-roll');
        this.ctx = this.canvas.getContext('2d');

        this.headerWidth = 150;   // Track header column
        this.rulerHeight = 30;
        this.barWidth = 48;       // Pixels per bar (L2 + Left/Right zooms)
        this.scrollX = 0;         // Pixels
        this.scrollY = 0;

        this.canvas.addEventListener('click', (e) => this.onClick(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    }

    get width() { return this.app.ui.width; }
    get height() { return this.app.ui.height; }

    get rowHeight() {
        const available = this.height - this.rulerHeight;
        return Math.max(40, Math.min(80, Math.floor(available / this.app.songData.tracks.length)));
    }

    barToX(bar) {
        return this.headerWidth + bar * this.barWidth - this.scrollX;
    }

    trackToY(trackId) {
        return this.rulerHeight + trackId * this.rowHeight - this.scrollY;
    }

    // ------------------------------------------------------------- Mouse

    hitTest(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (x < this.headerWidth && y > this.rulerHeight) {
            return { bar: null, track: Math.floor((y - this.rulerHeight + this.scrollY) / this.rowHeight) };
        }
        if (y < this.rulerHeight) return null;
        return {
            bar: Math.floor((x - this.headerWidth + this.scrollX) / this.barWidth),
            track: Math.floor((y - this.rulerHeight + this.scrollY) / this.rowHeight)
        };
    }

    onClick(e) {
        if (this.app.view !== 'song') return;
        const hit = this.hitTest(e);
        if (!hit || hit.track < 0 || hit.track >= this.app.songData.tracks.length) return;
        if (hit.bar !== null && hit.bar >= 0) this.app.songState.cursorBar = hit.bar;
        if (hit.track !== this.app.currentTrackId) this.app.selectTrack(hit.track);
    }

    onDoubleClick(e) {
        if (this.app.view !== 'song') return;
        const hit = this.hitTest(e);
        if (!hit || hit.bar === null) return;
        this.app.input.song.pressA();
    }

    // --------------------------------------------------------------- Draw

    draw(playheadBeat) {
        const ctx = this.ctx;
        const transport = this.app.transport;
        const song = this.app.songData;
        const state = this.app.songState;
        const rowH = this.rowHeight;

        this.autoScroll(playheadBeat);

        ctx.fillStyle = '#272A2D';
        ctx.fillRect(0, 0, this.width, this.height);

        const firstBar = Math.max(0, Math.floor(this.scrollX / this.barWidth));
        const lastBar = firstBar + Math.ceil((this.width - this.headerWidth) / this.barWidth) + 1;

        // Rows
        for (const track of song.tracks) {
            const y = this.trackToY(track.id);
            ctx.fillStyle = track.id === this.app.currentTrackId
                ? 'rgba(108, 92, 231, 0.12)'
                : (track.id % 2 ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.02)');
            ctx.fillRect(this.headerWidth, y, this.width - this.headerWidth, rowH);
        }

        // Bar lines (stronger every 4 bars)
        for (let bar = firstBar; bar <= lastBar; bar++) {
            const x = this.barToX(bar);
            ctx.strokeStyle = bar % 4 === 0 ? '#636e72' : '#3d4448';
            ctx.lineWidth = bar % 4 === 0 ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(x, this.rulerHeight);
            ctx.lineTo(x, this.height);
            ctx.stroke();
        }

        // Loop region
        const loop = this.app.loops.song;
        if (loop.region) {
            const x0 = this.barToX(transport.beatToBar(loop.region.start));
            const x1 = this.barToX(transport.beatToBar(loop.region.end));
            ctx.fillStyle = loop.enabled ? 'rgba(0, 206, 201, 0.08)' : 'rgba(255, 255, 255, 0.03)';
            ctx.fillRect(x0, this.rulerHeight, x1 - x0, this.height);
        }

        // Clips
        for (const clip of song.clips) this.drawClip(clip);

        // Selection
        if (state.selection) {
            const sel = state.selection;
            const x = this.barToX(sel.bar0);
            const y = this.trackToY(sel.track0);
            const w = (sel.bar1 - sel.bar0 + 1) * this.barWidth;
            const h = (sel.track1 - sel.track0 + 1) * rowH;
            ctx.fillStyle = 'rgba(0, 184, 148, 0.15)';
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = '#00b894';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
        }

        // Cursor cell (highlights the whole clip when on one)
        const cursorBeat = transport.barToBeat(state.cursorBar);
        const clipUnder = clipAt(song, this.app.currentTrackId, cursorBeat);
        const cy = this.trackToY(this.app.currentTrackId);
        if (clipUnder) {
            const pattern = getPattern(song, clipUnder.patternId);
            const x0 = this.barToX(transport.beatToBar(clipUnder.start));
            const x1 = this.barToX(transport.beatToBar(clipUnder.start + pattern.length));
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 1, cy + 2, x1 - x0 - 2, rowH - 4);
        }
        ctx.fillStyle = 'rgba(108, 92, 231, 0.35)';
        ctx.fillRect(this.barToX(state.cursorBar), cy, this.barWidth, rowH);
        ctx.strokeStyle = '#6c5ce7';
        ctx.lineWidth = 2;
        ctx.strokeRect(this.barToX(state.cursorBar), cy, this.barWidth, rowH);

        // Playhead
        if (this.app.isPlaying) {
            const x = this.barToX(transport.beatToBar(playheadBeat));
            if (x >= this.headerWidth && x <= this.width) {
                ctx.strokeStyle = '#0984e3';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, this.rulerHeight);
                ctx.lineTo(x, this.height);
                ctx.stroke();
            }
        }

        this.drawTrackHeaders();
        this.drawRuler(firstBar, lastBar);
    }

    autoScroll(playheadBeat) {
        const bar = this.app.isPlaying
            ? this.app.transport.beatToBar(playheadBeat)
            : this.app.songState.cursorBar;
        const viewWidth = this.width - this.headerWidth;
        const x = bar * this.barWidth - this.scrollX;
        const margin = Math.min(this.barWidth * 2, viewWidth / 4);
        if (x > viewWidth - margin - this.barWidth) this.scrollX = bar * this.barWidth - viewWidth + margin + this.barWidth;
        if (x < margin) this.scrollX = bar * this.barWidth - margin;
        if (this.scrollX < 0) this.scrollX = 0;

        const rowH = this.rowHeight;
        const y = this.app.currentTrackId * rowH - this.scrollY;
        const viewHeight = this.height - this.rulerHeight;
        if (y + rowH > viewHeight) this.scrollY = (this.app.currentTrackId + 1) * rowH - viewHeight;
        if (y < 0) this.scrollY = this.app.currentTrackId * rowH;
        if (this.scrollY < 0) this.scrollY = 0;
    }

    drawClip(clip) {
        const ctx = this.ctx;
        const transport = this.app.transport;
        const pattern = getPattern(this.app.songData, clip.patternId);
        if (!pattern) return;

        const x0 = this.barToX(transport.beatToBar(clip.start));
        const x1 = this.barToX(transport.beatToBar(clip.start + pattern.length));
        if (x1 < this.headerWidth || x0 > this.width) return;

        const y = this.trackToY(clip.trackId) + 3;
        const h = this.rowHeight - 6;
        const w = x1 - x0 - 2;
        const color = TRACK_COLORS[clip.trackId % TRACK_COLORS.length];
        const track = this.app.songData.tracks[clip.trackId];
        const dimmed = track.muted || (this.app.songData.tracks.some(t => t.solo) && !track.solo);

        ctx.save();
        ctx.globalAlpha = dimmed ? 0.35 : 1;

        ctx.fillStyle = hexToRgba(color, 0.25);
        ctx.fillRect(x0 + 1, y, w, h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 1, y, w, h);

        // Clip label
        ctx.beginPath();
        ctx.rect(x0 + 1, y, w, h);
        ctx.clip();
        ctx.fillStyle = color;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(pattern.name, x0 + 5, y + 13);

        // Mini note preview
        if (pattern.notes.length > 0) {
            let lo = 127;
            let hi = 0;
            for (const n of pattern.notes) {
                lo = Math.min(lo, n.pitch);
                hi = Math.max(hi, n.pitch);
            }
            const top = y + 17;
            const areaH = h - 20;
            const range = Math.max(hi - lo, 11);
            const noteH = Math.max(1.5, Math.min(4, areaH / (range + 1)));
            const pxPerBeat = w / pattern.length;
            ctx.fillStyle = color;
            for (const n of pattern.notes) {
                if (n.time >= pattern.length) continue;
                const nx = x0 + 1 + n.time * pxPerBeat;
                const nw = Math.max(1.5, Math.min(n.duration, pattern.length - n.time) * pxPerBeat - 1);
                const ny = top + (hi - n.pitch) / range * (areaH - noteH);
                ctx.fillRect(nx, ny, nw, noteH);
            }
        }
        ctx.restore();
    }

    drawTrackHeaders() {
        const ctx = this.ctx;
        const rowH = this.rowHeight;
        const anySolo = this.app.songData.tracks.some(t => t.solo);

        ctx.fillStyle = '#1e272e';
        ctx.fillRect(0, this.rulerHeight, this.headerWidth, this.height);

        for (const track of this.app.songData.tracks) {
            const y = this.trackToY(track.id);
            if (y + rowH < this.rulerHeight || y > this.height) continue;
            const active = track.id === this.app.currentTrackId;
            const color = TRACK_COLORS[track.id % TRACK_COLORS.length];

            ctx.fillStyle = active ? '#2d3436' : '#1e272e';
            ctx.fillRect(0, y, this.headerWidth, rowH);
            ctx.fillStyle = color;
            ctx.fillRect(0, y, 4, rowH);

            ctx.textAlign = 'left';
            ctx.fillStyle = active ? '#ffffff' : '#dfe6e9';
            ctx.font = `${active ? 'bold ' : ''}12px sans-serif`;
            ctx.fillText(track.name, 10, y + 16);
            ctx.fillStyle = '#b2bec3';
            ctx.font = '10px sans-serif';
            ctx.fillText(truncate(this.app.getInstrumentName(track), 20), 10, y + 30);

            // Mute / Solo badges and volume bar
            const badgeY = y + rowH - 16;
            if (rowH >= 48) {
                drawBadge(ctx, 10, badgeY, 'M', track.muted, '#d63031');
                drawBadge(ctx, 30, badgeY, 'S', track.solo, '#00b894');
                ctx.fillStyle = '#3d4448';
                ctx.fillRect(52, badgeY + 5, 80, 4);
                ctx.fillStyle = anySolo && !track.solo ? '#636e72' : color;
                ctx.fillRect(52, badgeY + 5, 80 * track.volume, 4);
            } else {
                const flags = `${track.muted ? 'M ' : ''}${track.solo ? 'S' : ''}`;
                ctx.fillStyle = track.muted ? '#d63031' : '#00b894';
                ctx.textAlign = 'right';
                ctx.fillText(flags, this.headerWidth - 6, y + 16);
            }

            ctx.strokeStyle = '#2d3436';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, y + rowH);
            ctx.lineTo(this.width, y + rowH);
            ctx.stroke();
        }

        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.moveTo(this.headerWidth, this.rulerHeight);
        ctx.lineTo(this.headerWidth, this.height);
        ctx.stroke();
    }

    drawRuler(firstBar, lastBar) {
        const ctx = this.ctx;
        const transport = this.app.transport;

        ctx.fillStyle = '#2d3436';
        ctx.fillRect(0, 0, this.headerWidth, this.rulerHeight);
        ctx.fillStyle = 'rgba(30, 30, 30, 0.95)';
        ctx.fillRect(this.headerWidth, 0, this.width - this.headerWidth, this.rulerHeight);

        ctx.fillStyle = '#b2bec3';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('SONG', 10, 19);

        // Loop
        const loop = this.app.loops.song;
        if (loop.region) {
            const x0 = Math.max(this.headerWidth, this.barToX(transport.beatToBar(loop.region.start)));
            const x1 = Math.min(this.width, this.barToX(transport.beatToBar(loop.region.end)));
            if (x1 > x0) {
                ctx.fillStyle = loop.enabled ? 'rgba(0, 206, 201, 0.3)' : 'rgba(30, 39, 46, 0.5)';
                ctx.fillRect(x0, 0, x1 - x0, this.rulerHeight);
                ctx.strokeStyle = loop.enabled ? '#00cec9' : '#555';
                ctx.lineWidth = 2;
                ctx.strokeRect(x0, 0, x1 - x0, this.rulerHeight);
            }
        }

        // Bar numbers (skip some when zoomed out)
        const every = this.barWidth < 36 ? 4 : 1;
        for (let bar = firstBar; bar <= lastBar; bar++) {
            const x = this.barToX(bar);
            if (x < this.headerWidth - 1) continue;
            ctx.strokeStyle = '#999';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, bar % every === 0 ? 0 : this.rulerHeight - 6);
            ctx.lineTo(x, this.rulerHeight);
            ctx.stroke();
            if (bar % every === 0) {
                ctx.fillStyle = '#dfe6e9';
                ctx.font = '12px sans-serif';
                ctx.fillText(String(bar + 1), x + 4, 14);
            }
        }

        // Markers
        ctx.font = 'bold 11px sans-serif';
        for (const marker of transport.markerMap) {
            const x = this.barToX(transport.beatToBar(marker.beat));
            if (x < this.headerWidth || x > this.width) continue;
            ctx.fillStyle = '#fdcb6e';
            ctx.fillText(marker.label, x + 4, 27);
        }

        ctx.strokeStyle = '#555';
        ctx.beginPath();
        ctx.moveTo(0, this.rulerHeight);
        ctx.lineTo(this.width, this.rulerHeight);
        ctx.stroke();
    }
}

function drawBadge(ctx, x, y, label, on, color) {
    ctx.fillStyle = on ? color : '#2d3436';
    ctx.fillRect(x, y, 16, 14);
    ctx.strokeStyle = on ? color : '#636e72';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, 16, 14);
    ctx.fillStyle = on ? '#fff' : '#636e72';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 8, y + 11);
    ctx.textAlign = 'left';
}

function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
