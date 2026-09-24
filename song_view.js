import { getPattern, clipAt, isTrackAudible } from './song.js';
import { theme, font, withAlpha } from './theme.js';

const LANE_GAP = 5;

/**
 * Song (arrangement) view: track keys on the left, one lane per track, clips at their real length.
 * Shares the canvas with the piano roll (UIManager owns size / DPI handling).
 */
export class SongView {
    constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('piano-roll');
        this.ctx = this.canvas.getContext('2d');

        this.headerWidth = 176;   // Track keys and names
        this.rulerHeight = 24;
        this.barWidth = 48;       // Pixels per bar (L2 + Left/Right zooms)
        this.scrollX = 0;         // Pixels
        this.scrollY = 0;

        this.canvas.addEventListener('click', (e) => this.onClick(e));
        this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    }

    get width() { return this.app.ui.width; }
    get height() { return this.app.ui.height; }

    get rowHeight() {
        const available = this.height - this.rulerHeight - 4;
        return Math.max(38, Math.min(76, Math.floor(available / this.app.songData.tracks.length)));
    }

    barToX(bar) {
        return this.headerWidth + bar * this.barWidth - this.scrollX;
    }

    trackToY(trackId) {
        return this.rulerHeight + 4 + trackId * this.rowHeight - this.scrollY;
    }

    // ------------------------------------------------------------- Mouse

    hitTest(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        if (y < this.rulerHeight) return null;
        const track = Math.floor((y - this.rulerHeight - 4 + this.scrollY) / this.rowHeight);
        if (x < this.headerWidth) return { bar: null, track };
        return { bar: Math.floor((x - this.headerWidth + this.scrollX) / this.barWidth), track };
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
        const laneH = rowH - LANE_GAP;

        this.autoScroll(playheadBeat);

        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, this.width, this.height);

        const firstBar = Math.max(0, Math.floor(this.scrollX / this.barWidth));
        const lastBar = firstBar + Math.ceil((this.width - this.headerWidth) / this.barWidth) + 1;
        const laneX = this.headerWidth;
        const laneW = this.width - this.headerWidth - 2;

        ctx.save();
        ctx.beginPath();
        ctx.rect(laneX, this.rulerHeight, this.width - laneX, this.height - this.rulerHeight);
        ctx.clip();

        // Lanes with bar lines
        for (const track of song.tracks) {
            const y = this.trackToY(track.id);
            const current = track.id === this.app.currentTrackId;
            ctx.fillStyle = current ? theme.laneCur : theme.lane;
            ctx.beginPath();
            ctx.roundRect(laneX, y, laneW, laneH, 4);
            ctx.fill();
            if (current) {
                ctx.strokeStyle = theme.laneCurBorder;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            for (let bar = firstBar; bar <= lastBar; bar++) {
                const x = Math.round(this.barToX(bar));
                ctx.fillStyle = bar % 4 === 0 ? withAlpha(theme.ink, 0.28) : theme.line;
                ctx.fillRect(x, y, 1, laneH);
            }
        }

        // Clips
        for (const clip of song.clips) this.drawClip(clip, laneH);

        // Range selection
        if (state.selection) {
            const sel = state.selection;
            const x = this.barToX(sel.bar0);
            const y = this.trackToY(sel.track0);
            const w = (sel.bar1 - sel.bar0 + 1) * this.barWidth;
            const h = (sel.track1 - sel.track0) * rowH + laneH;
            ctx.fillStyle = withAlpha(theme.trig, 0.12);
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = theme.trig;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 4]);
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            ctx.setLineDash([]);
        }

        // Cursor cell
        const cy = this.trackToY(this.app.currentTrackId);
        ctx.strokeStyle = theme.trig;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(this.barToX(state.cursorBar) + 1, cy + 1, this.barWidth - 2, laneH - 2, 4);
        ctx.stroke();

        // Playhead
        if (this.app.isPlaying) {
            const x = this.barToX(transport.beatToBar(playheadBeat));
            if (x >= laneX) {
                ctx.fillStyle = theme.trig;
                ctx.fillRect(x - 1, this.rulerHeight, 2, this.height);
            }
        }
        ctx.restore();

        this.drawTrackHeaders();
        this.drawRuler(firstBar, lastBar, playheadBeat);
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
        const viewHeight = this.height - this.rulerHeight - 4;
        if (y + rowH > viewHeight) this.scrollY = (this.app.currentTrackId + 1) * rowH - viewHeight;
        if (y < 0) this.scrollY = this.app.currentTrackId * rowH;
        if (this.scrollY < 0) this.scrollY = 0;
    }

    drawClip(clip, laneH) {
        const ctx = this.ctx;
        const song = this.app.songData;
        const transport = this.app.transport;
        const pattern = getPattern(song, clip.patternId);
        if (!pattern) return;

        const x0 = this.barToX(transport.beatToBar(clip.start)) + 2;
        const x1 = this.barToX(transport.beatToBar(clip.start + pattern.length)) - 2;
        if (x1 < this.headerWidth || x0 > this.width) return;
        const y = this.trackToY(clip.trackId) + 4;
        const h = laneH - 8;
        const w = x1 - x0;
        const audible = isTrackAudible(song, song.tracks[clip.trackId]);

        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x0, y, w, h, 3);
        ctx.fillStyle = audible ? theme.ink : theme.clipMuted;
        ctx.fill();
        ctx.clip();

        ctx.fillStyle = theme.body;
        ctx.font = font(12, '600');
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(pattern.name, x0 + 7, y + 15);

        // Mini note preview
        if (pattern.notes.length > 0 && h > 22) {
            let lo = 127;
            let hi = 0;
            for (const n of pattern.notes) {
                lo = Math.min(lo, n.pitch);
                hi = Math.max(hi, n.pitch);
            }
            const top = y + 20;
            const areaH = h - 24;
            const range = Math.max(hi - lo, 11);
            const noteH = 2.5;
            const pxPerBeat = w / pattern.length;
            ctx.fillStyle = audible ? theme.clipNote : theme.clipNoteMuted;
            for (const n of pattern.notes) {
                if (n.time >= pattern.length) continue;
                const nx = x0 + n.time * pxPerBeat;
                const nw = Math.max(2, Math.min(n.duration, pattern.length - n.time) * pxPerBeat - 1);
                const ny = top + (hi - n.pitch) / range * (areaH - noteH);
                ctx.fillRect(nx, ny, nw, noteH);
            }
        }
        ctx.restore();
    }

    drawTrackHeaders() {
        const ctx = this.ctx;
        const rowH = this.rowHeight;
        const laneH = rowH - LANE_GAP;
        const song = this.app.songData;

        ctx.fillStyle = theme.body;
        ctx.fillRect(0, this.rulerHeight, this.headerWidth, this.height);

        for (const track of song.tracks) {
            const y = this.trackToY(track.id);
            if (y + rowH < this.rulerHeight || y > this.height) continue;
            const current = track.id === this.app.currentTrackId;
            const size = Math.min(44, laneH - 6);
            const keyY = y + (laneH - size) / 2;
            const led = track.solo ? 'solo' : (track.muted ? 'off' : 'on');
            drawTrackKey(ctx, 6, keyY, size, `T${track.id + 1}`, current, led);

            const textX = 6 + size + 12;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = track.muted ? theme.textOff : theme.ink;
            ctx.font = font(14, current ? '600' : '400');
            const nameY = y + laneH / 2 - 1;
            ctx.fillText(truncate(ctx, track.name, this.headerWidth - textX - 8), textX, nameY);
            ctx.fillStyle = theme.graphite;
            ctx.font = font(11);
            ctx.fillText(truncate(ctx, this.app.getInstrumentName(track), this.headerWidth - textX - 8), textX, nameY + 15);
        }
    }

    drawRuler(firstBar, lastBar) {
        const ctx = this.ctx;
        const transport = this.app.transport;
        const h = this.rulerHeight;

        ctx.fillStyle = theme.body;
        ctx.fillRect(0, 0, this.width, h);

        ctx.save();
        ctx.beginPath();
        ctx.rect(this.headerWidth, 0, this.width - this.headerWidth, h);
        ctx.clip();

        // Bar numbers (skip some when zoomed out)
        const every = this.barWidth < 36 ? 4 : 1;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        for (let bar = firstBar; bar <= lastBar; bar++) {
            const x = Math.round(this.barToX(bar));
            const major = bar % 4 === 0;
            ctx.fillStyle = major ? theme.ink : theme.line;
            ctx.fillRect(x, major ? 4 : h - 8, 1, major ? h - 4 : 8);
            if (bar % every === 0) {
                ctx.fillStyle = major ? theme.ink : theme.graphite;
                ctx.font = font(12);
                ctx.fillText(String(bar + 1), x + 4, h - 5);
            }
        }

        // Loop region: red bar along the top
        const loop = this.app.loops.song;
        if (loop.region) {
            const x0 = this.barToX(transport.beatToBar(loop.region.start));
            const x1 = this.barToX(transport.beatToBar(loop.region.end));
            ctx.fillStyle = loop.enabled ? theme.trig : theme.graphite;
            ctx.fillRect(x0, 0, x1 - x0, 3);
        }

        // Markers
        ctx.font = font(11, '600');
        for (const marker of transport.markerMap) {
            const x = this.barToX(transport.beatToBar(marker.beat));
            ctx.fillStyle = theme.trig;
            ctx.fillText(marker.label, x + 4, 12);
        }

        // Playhead dot
        if (this.app.isPlaying) {
            const x = this.barToX(transport.beatToBar(this.app.cardinalTime));
            ctx.fillStyle = theme.trig;
            ctx.beginPath();
            ctx.arc(x, h - 3, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }
}

// Hardware-style track key with an LED in the top-right corner.
// led: 'on' (audible, white), 'off' (muted), 'solo' (red). Pressed = selected track.
function drawTrackKey(ctx, x, y, size, label, pressed, led) {
    const r = 5;
    const skirt = 2;
    const top = pressed ? y + skirt : y;

    if (!pressed) {
        ctx.fillStyle = theme.keySkirt;
        ctx.beginPath();
        ctx.roundRect(x, y + skirt, size, size, r);
        ctx.fill();
    }
    const face = ctx.createLinearGradient(0, top, 0, top + size);
    face.addColorStop(0, pressed ? theme.keyPressedTop : theme.keyTop);
    face.addColorStop(1, pressed ? theme.keyPressedBottom : theme.keyBottom);
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.roundRect(x, top, size, size, r);
    ctx.fill();
    ctx.strokeStyle = theme.keyBorder;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Top edge: highlight when up, a thin shadow when held down
    ctx.fillStyle = pressed ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(x + r, top + 1, size - r * 2, 1);

    // LED (top-right) and label (bottom-left) scale with the key
    const inset = Math.max(4, Math.round(size * 0.16));
    const ledW = Math.round(size * 0.27);
    const ledH = size < 36 ? 3 : 4;
    const ledX = x + size - ledW - inset;
    const ledY = top + inset;
    ctx.save();
    if (led === 'on') {
        ctx.shadowColor = 'rgba(255, 255, 235, 0.95)';
        ctx.shadowBlur = 6;
        ctx.fillStyle = theme.ledOn;
    } else if (led === 'solo') {
        ctx.shadowColor = withAlpha(theme.trig, 0.85);
        ctx.shadowBlur = 6;
        ctx.fillStyle = theme.trig;
    } else {
        ctx.fillStyle = theme.ledOff;
    }
    ctx.beginPath();
    ctx.roundRect(ledX, ledY, ledW, ledH, 2);
    ctx.fill();
    ctx.restore();
    if (led === 'on') {
        ctx.strokeStyle = theme.ledRim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(ledX - 0.5, ledY - 0.5, ledW + 1, ledH + 1, 2.5);
        ctx.stroke();
    }

    // Label
    ctx.fillStyle = pressed ? theme.ink : theme.keyText;
    ctx.font = font(Math.max(9, Math.round(size * 0.28)), '500');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x + inset, top + size - inset);
}

function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
}
