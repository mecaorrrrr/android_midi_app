import {
    getPattern, patternsOfTrack, createPattern, duplicatePattern, addClip, removeClip, clipAt, clipEnd
} from './song.js';

const LONG_PRESS_MS = 300;
const MAX_PATTERN_BARS = 64;

/**
 * Gamepad handling for the song (arrangement) view.
 * Mirrors the piano roll controls:
 *   D-pad        move cursor (bar / track), R2 = 4 bars
 *   A (release)  paste clipboard / open clip in the pattern editor / place a clip
 *   A + L/R      pattern length (bars)      A + U/D   switch the clip's pattern
 *   B short      copy selection / clear clipboard / make the clip's pattern unique
 *   B long       delete selection or clip
 *   Y + D-pad    select a range of bars and tracks, then D-pad L/R moves the clips
 *   SELECT       set loop from selection / toggle loop
 *   L2 + L/R     zoom
 */
export class SongInput {
    constructor(input) {
        this.input = input;
        this.aUsedForCombo = false;
        this.editUndoSaved = false;
        this.bDownTime = 0;
        this.bHandled = false;
    }

    get app() { return this.input.app; }
    get song() { return this.app.songData; }
    get state() { return this.app.songState; }
    get transport() { return this.app.transport; }

    clipUnderCursor() {
        const beat = this.transport.barToBeat(this.state.cursorBar);
        return clipAt(this.song, this.app.currentTrackId, beat);
    }

    clipStartBar(clip) {
        return Math.round(this.transport.beatToBar(clip.start));
    }

    // ------------------------------------------------------------ Movement

    update(dx, dy, held) {
        const st = this.state;
        const timers = this.input.repeatTimers;

        if (held.y) {
            if (!this.input.wasYButtonHeld) {
                if (st.selection) {
                    this.clearSelection();
                } else {
                    st.selectionStart = { bar: st.cursorBar, track: this.app.currentTrackId };
                }
            }
            if (st.selectionStart) {
                this.input.repeatAction('song_x', dx, () => this.moveCursorBar(dx));
                this.input.repeatAction('song_y', dy, () => this.moveTrack(-dy));
                st.selection = this.makeRect(st.selectionStart, { bar: st.cursorBar, track: this.app.currentTrackId });
            }
            return;
        }
        if (this.input.wasYButtonHeld) st.selectionStart = null;

        if (held.a) {
            const clip = this.clipUnderCursor();
            if (clip && (dx !== 0 || dy !== 0)) this.aUsedForCombo = true;
            if (clip) {
                this.input.repeatAction('clip_length', dx, () => this.changePatternLength(clip, dx), 150, 120);
                this.input.repeatAction('clip_pattern', dy, () => this.cyclePattern(clip, dy), 250, 150);
            }
            return;
        }
        delete timers.clip_length;
        delete timers.clip_pattern;

        if (st.selection) {
            this.input.repeatAction('move_clips', dx, () => this.moveSelectedClips(dx), 150, 100);
            return;
        }

        const step = held.r2 ? 4 : 1;
        this.input.repeatAction('song_x', dx, () => this.moveCursorBar(dx * step));
        this.input.repeatAction('song_y', dy, () => this.moveTrack(-dy));
    }

    moveCursorBar(delta) {
        this.state.cursorBar = Math.max(0, this.state.cursorBar + delta);
    }

    moveTrack(delta) {
        const next = this.app.currentTrackId + delta;
        if (next < 0 || next >= this.song.tracks.length) return;
        this.app.selectTrack(next);
    }

    zoom(dir) {
        const view = this.app.songView;
        view.barWidth = Math.max(24, Math.min(192, dir > 0 ? view.barWidth * 2 : view.barWidth / 2));
        this.input.updateStatus(`Zoom: ${view.barWidth}px/bar`);
    }

    makeRect(a, b) {
        return {
            bar0: Math.min(a.bar, b.bar),
            bar1: Math.max(a.bar, b.bar),
            track0: Math.min(a.track, b.track),
            track1: Math.max(a.track, b.track)
        };
    }

    clearSelection() {
        this.state.selection = null;
        this.state.selectionStart = null;
    }

    clipsInSelection() {
        const sel = this.state.selection;
        if (!sel) return [];
        return this.song.clips.filter(c => {
            const bar = this.clipStartBar(c);
            return c.trackId >= sel.track0 && c.trackId <= sel.track1 && bar >= sel.bar0 && bar <= sel.bar1;
        });
    }

    // --------------------------------------------------------------- Buttons

    handleButtons(isDown, wasDown, dx, dy, now) {
        const map = this.input.buttonMap;

        // A acts on release so that A + direction can be used as a modifier
        if (isDown(map.A) && !wasDown(map.A)) {
            this.aUsedForCombo = false;
            this.editUndoSaved = false;
        } else if (!isDown(map.A) && wasDown(map.A) && !this.aUsedForCombo) {
            this.pressA();
        }

        if (isDown(map.B)) {
            if (!wasDown(map.B)) {
                this.bDownTime = now;
                this.bHandled = false;
            } else if (!this.bHandled && now - this.bDownTime > LONG_PRESS_MS) {
                this.bHandled = true;
                this.longPressB();
            }
        } else if (wasDown(map.B) && !this.bHandled) {
            this.shortPressB();
        }
    }

    pressA() {
        const st = this.state;
        if (st.selection) return;
        if (st.clipboard) {
            this.paste();
            return;
        }

        const clip = this.clipUnderCursor();
        if (clip) {
            this.app.openPattern(clip.patternId, clip.start);
            return;
        }

        // Place the track's current pattern (or a new one) at the cursor
        const trackId = this.app.currentTrackId;
        this.app.saveState();
        let pattern = getPattern(this.song, this.app.lastPatternByTrack[trackId]);
        if (!pattern) {
            const patterns = patternsOfTrack(this.song, trackId);
            pattern = patterns.length > 0 ? patterns[patterns.length - 1] : this.app.createEmptyPattern(trackId);
        }
        addClip(this.song, trackId, pattern.id, this.transport.barToBeat(st.cursorBar));
        this.app.lastPatternByTrack[trackId] = pattern.id;
        this.app.showToast(`Placed ${pattern.name}`);
    }

    shortPressB() {
        const st = this.state;
        if (st.selection) {
            this.copySelection();
        } else if (st.clipboard) {
            st.clipboard = null;
            this.app.showToast('Clipboard Cleared');
        } else {
            const clip = this.clipUnderCursor();
            if (clip) this.makeUnique(clip);
        }
    }

    longPressB() {
        const st = this.state;
        if (st.selection) {
            const clips = this.clipsInSelection();
            if (clips.length > 0) {
                this.app.saveState();
                clips.forEach(c => removeClip(this.song, c));
            }
            this.clearSelection();
            this.app.showToast(`Deleted ${clips.length} clip${clips.length === 1 ? '' : 's'}`);
            return;
        }
        const clip = this.clipUnderCursor();
        if (clip) {
            this.app.saveState();
            removeClip(this.song, clip);
            this.app.showToast('Clip Deleted');
        }
    }

    // SELECT short press
    handleLoopButton() {
        const st = this.state;
        const loop = this.app.loops.song;
        if (st.selection) {
            loop.region = {
                start: this.transport.barToBeat(st.selection.bar0),
                end: this.transport.barToBeat(st.selection.bar1 + 1)
            };
            loop.enabled = true;
            this.app.showToast(`Loop Set: bar ${st.selection.bar0 + 1} - ${st.selection.bar1 + 1}`);
            this.clearSelection();
        } else if (loop.region) {
            loop.enabled = !loop.enabled;
            this.app.showToast(loop.enabled ? 'Loop ON' : 'Loop OFF');
        } else {
            const clip = this.clipUnderCursor();
            if (clip) {
                loop.region = { start: clip.start, end: clipEnd(this.song, clip) };
                loop.enabled = true;
                this.app.showToast('Loop Set to clip');
            } else {
                this.app.showToast('Select bars with Y to set a loop');
            }
        }
    }

    // ------------------------------------------------------------- Editing

    saveUndoOnce() {
        if (!this.editUndoSaved) {
            this.app.saveState();
            this.editUndoSaved = true;
        }
    }

    changePatternLength(clip, dx) {
        const pattern = getPattern(this.song, clip.patternId);
        if (!pattern) return;
        const bar = this.app.getPatternBarLength();
        const length = pattern.length + (dx > 0 ? bar : -bar);
        if (length < bar || length > MAX_PATTERN_BARS * bar) return;
        this.saveUndoOnce();
        pattern.length = length;
        this.app.updateViewUI();
        this.input.updateStatus(`${pattern.name}: ${length / bar} bars`);
    }

    // Up = next pattern of the track (a new empty one after the last), Down = previous
    cyclePattern(clip, dy) {
        const patterns = patternsOfTrack(this.song, clip.trackId);
        const index = patterns.findIndex(p => p.id === clip.patternId);
        let next;
        if (dy > 0) {
            if (index + 1 < patterns.length) {
                next = patterns[index + 1];
            } else if (patterns[patterns.length - 1].notes.length === 0) {
                next = patterns[0]; // Don't pile up empty patterns
            } else {
                this.saveUndoOnce();
                const current = getPattern(this.song, clip.patternId);
                next = createPattern(this.song, clip.trackId, current.length);
            }
        } else {
            next = patterns[(index - 1 + patterns.length) % patterns.length];
        }
        if (next.id === clip.patternId) return;
        this.saveUndoOnce();
        clip.patternId = next.id;
        this.app.lastPatternByTrack[clip.trackId] = next.id;
        this.app.showToast(`Pattern ${next.name}`);
    }

    makeUnique(clip) {
        const pattern = getPattern(this.song, clip.patternId);
        if (!pattern) return;
        this.app.saveState();
        const copy = duplicatePattern(this.song, pattern);
        clip.patternId = copy.id;
        this.app.lastPatternByTrack[clip.trackId] = copy.id;
        this.app.showToast(`${pattern.name} → ${copy.name} (copy)`);
    }

    moveSelectedClips(dx) {
        const sel = this.state.selection;
        const clips = this.clipsInSelection();
        if (sel.bar0 + dx < 0) return;
        this.app.saveState();
        for (const clip of clips) {
            clip.start = this.transport.barToBeat(this.clipStartBar(clip) + dx);
        }
        sel.bar0 += dx;
        sel.bar1 += dx;
        this.moveCursorBar(dx);
    }

    copySelection() {
        const sel = this.state.selection;
        const clips = this.clipsInSelection();
        this.state.clipboard = clips.map(c => ({
            barOffset: this.clipStartBar(c) - sel.bar0,
            trackOffset: c.trackId - sel.track0,
            patternId: c.patternId
        }));
        this.clearSelection();
        this.app.showToast(`Copied ${clips.length} clip${clips.length === 1 ? '' : 's'}`);
    }

    // Pasted clips share patterns with the originals; on another track the pattern is copied
    paste() {
        const clipboard = this.state.clipboard;
        this.app.saveState();
        let count = 0;
        for (const item of clipboard) {
            const trackId = this.app.currentTrackId + item.trackOffset;
            const pattern = getPattern(this.song, item.patternId);
            if (!pattern || trackId >= this.song.tracks.length) continue;
            let patternId = pattern.id;
            if (pattern.trackId !== trackId) {
                patternId = createPattern(this.song, trackId, pattern.length, pattern.notes.map(n => ({ ...n }))).id;
            }
            addClip(this.song, trackId, patternId, this.transport.barToBeat(this.state.cursorBar + item.barOffset));
            count++;
        }
        this.app.showToast(`Pasted ${count} clip${count === 1 ? '' : 's'}`);
    }
}
