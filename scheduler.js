// Look-ahead playback scheduler.
// Notes are handed to the audio engine slightly ahead of time with exact
// AudioContext timestamps, so timing no longer depends on the frame rate.
//
// Playback is described by "segments": each maps an AudioContext time to a
// beat. Looping appends a new segment that starts at the loop start.
export class Scheduler {
    constructor(app) {
        this.app = app;
        this.lookahead = 0.12;   // seconds scheduled ahead of the audio clock
        this.startDelay = 0.02;  // seconds between pressing play and the first note
        this.segments = [];
        this.scheduledBeat = 0;  // end of the already-scheduled range in the last segment
    }

    get ctx() {
        return this.app.audio.ctx;
    }

    start(fromBeat) {
        this.segments = [{ ctxTime: this.ctx.currentTime + this.startDelay, beat: fromBeat }];
        this.scheduledBeat = fromBeat;
        this.update();
    }

    stop() {
        this.segments = [];
    }

    // Beat that is currently audible
    currentBeat() {
        if (this.segments.length === 0) return 0;
        const now = this.ctx.currentTime;
        let seg = this.segments[0];
        for (const s of this.segments) {
            if (s.ctxTime <= now) seg = s;
        }
        return this.app.transport.beatAfter(seg.beat, now - seg.ctxTime);
    }

    update() {
        if (this.segments.length === 0) return;
        const transport = this.app.transport;
        const now = this.ctx.currentTime;
        const horizon = now + this.lookahead;

        // Bounded so a zero-length loop can never spin forever
        for (let guard = 0; guard < 64; guard++) {
            const seg = this.segments[this.segments.length - 1];
            const region = this.app.getPlaybackLoop();
            const loopEnd = region && region.end > region.start ? region.end : Infinity;

            const horizonBeat = transport.beatAfter(seg.beat, horizon - seg.ctxTime);
            const endBeat = Math.min(horizonBeat, loopEnd);
            if (endBeat > this.scheduledBeat) {
                this.scheduleRange(this.scheduledBeat, endBeat, seg, loopEnd);
                this.scheduledBeat = endBeat;
            }

            if (horizonBeat < loopEnd) break;

            this.segments.push({
                ctxTime: seg.ctxTime + transport.secondsBetween(seg.beat, loopEnd),
                beat: region.start
            });
            this.scheduledBeat = region.start;
        }

        // Drop segments that are fully in the past
        while (this.segments.length > 1 && this.segments[1].ctxTime <= now) {
            this.segments.shift();
        }
    }

    scheduleRange(fromBeat, toBeat, seg, loopEnd) {
        const transport = this.app.transport;
        const toCtxTime = (beat) => seg.ctxTime + transport.secondsBetween(seg.beat, beat);

        this.app.forEachPlaybackNote(fromBeat, toBeat, (trackId, time, note) => {
            const velocity = note.velocity !== undefined ? note.velocity : 100;
            const endBeat = Math.min(time + note.duration, loopEnd);
            this.app.audio.playNoteAt(trackId, note.pitch, velocity, toCtxTime(time), toCtxTime(endBeat));
        });
    }
}
