// Song data model: tracks (instrument + mixer), patterns (per-track phrases)
// and clips (pattern placements on the song timeline).
//
// songData = {
//   version: 2,
//   nextId,
//   tracks:   [{ id, name, volume, pan, muted, solo, program, bank, presetIndex }],
//   patterns: [{ id, trackId, name, length, notes: [{ time, pitch, duration, velocity }] }],
//   clips:    [{ id, trackId, patternId, start }]
// }
// All times are in beats. Note times are relative to the pattern start.

export const TRACK_COUNT = 8;
export const SONG_VERSION = 2;

export function createSong() {
    return {
        version: SONG_VERSION,
        nextId: 1,
        tracks: Array.from({ length: TRACK_COUNT }, (_, i) => ({
            id: i,
            name: `Track ${i + 1}`,
            volume: 0.8,
            pan: 0.0,
            muted: false,
            solo: false,
            program: 0,
            bank: 0,
            presetIndex: 0
        })),
        patterns: [],
        clips: []
    };
}

export function newId(song) {
    return song.nextId++;
}

export function getPattern(song, patternId) {
    return song.patterns.find(p => p.id === patternId) || null;
}

export function patternsOfTrack(song, trackId) {
    return song.patterns
        .filter(p => p.trackId === trackId)
        .sort((a, b) => a.id - b.id);
}

// First unused name in the sequence A, B, ..., Z, AA, AB, ...
export function nextPatternName(song, trackId) {
    const used = new Set(patternsOfTrack(song, trackId).map(p => p.name));
    for (let n = 0; ; n++) {
        const name = indexToLetters(n);
        if (!used.has(name)) return name;
    }
}

function indexToLetters(n) {
    let label = '';
    do {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
}

export function createPattern(song, trackId, length, notes = []) {
    const pattern = {
        id: newId(song),
        trackId,
        name: nextPatternName(song, trackId),
        length,
        notes
    };
    song.patterns.push(pattern);
    return pattern;
}

export function duplicatePattern(song, pattern) {
    return createPattern(song, pattern.trackId, pattern.length, pattern.notes.map(n => ({ ...n })));
}

export function addClip(song, trackId, patternId, start) {
    const clip = { id: newId(song), trackId, patternId, start };
    song.clips.push(clip);
    return clip;
}

export function removeClip(song, clip) {
    song.clips = song.clips.filter(c => c !== clip);
}

export function clipEnd(song, clip) {
    const pattern = getPattern(song, clip.patternId);
    return clip.start + (pattern ? pattern.length : 0);
}

// Clip of the track that covers the given beat (latest start wins when clips overlap)
export function clipAt(song, trackId, beat) {
    let found = null;
    for (const clip of song.clips) {
        if (clip.trackId !== trackId) continue;
        if (clip.start <= beat + 1e-6 && beat < clipEnd(song, clip) - 1e-6) {
            if (!found || clip.start > found.start) found = clip;
        }
    }
    return found;
}

export function songEnd(song) {
    let end = 0;
    for (const clip of song.clips) end = Math.max(end, clipEnd(song, clip));
    return end;
}

export function isTrackAudible(song, track) {
    if (track.muted) return false;
    const anySolo = song.tracks.some(t => t.solo);
    return !anySolo || track.solo;
}

// Calls fn(trackId, absoluteTime, note) for every note of audible tracks
// whose absolute start time is in [fromBeat, toBeat).
// Notes that start outside their pattern length are not played.
export function forEachSongNote(song, fromBeat, toBeat, fn) {
    for (const clip of song.clips) {
        const track = song.tracks[clip.trackId];
        if (!track || !isTrackAudible(song, track)) continue;
        const pattern = getPattern(song, clip.patternId);
        if (!pattern) continue;
        const clipEndBeat = clip.start + pattern.length;
        if (clipEndBeat <= fromBeat || clip.start >= toBeat) continue;
        for (const note of pattern.notes) {
            if (note.time >= pattern.length) continue;
            const t = clip.start + note.time;
            if (t < fromBeat || t >= toBeat) continue;
            // Notes are cut at the end of their pattern
            const duration = Math.min(note.duration, pattern.length - note.time);
            fn(clip.trackId, t, duration === note.duration ? note : { ...note, duration });
        }
    }
}

// All notes of one track with absolute times (for MIDI export)
export function flattenTrack(song, trackId) {
    const out = [];
    for (const clip of song.clips) {
        if (clip.trackId !== trackId) continue;
        const pattern = getPattern(song, clip.patternId);
        if (!pattern) continue;
        for (const note of pattern.notes) {
            if (note.time >= pattern.length) continue;
            const end = Math.min(note.time + note.duration, pattern.length);
            out.push({ ...note, time: clip.start + note.time, duration: end - note.time });
        }
    }
    return out.sort((a, b) => a.time - b.time);
}

