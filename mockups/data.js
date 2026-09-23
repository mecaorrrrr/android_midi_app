// Shared sample content for the design mockups (static, not wired to the app)
window.MOCK = (() => {
    const tracks = [
        { name: 'Drums', inst: 'Standard Kit', vol: 0.86, pan: 0 },
        { name: 'Bass', inst: 'Fingered Bass', vol: 0.78, pan: 0 },
        { name: 'Keys', inst: 'Grand Piano', vol: 0.72, pan: -0.2 },
        { name: 'Pad', inst: 'Warm Pad', vol: 0.55, pan: 0.3 },
        { name: 'Lead', inst: 'Square Lead', vol: 0.64, pan: 0.1, solo: true },
        { name: 'Strings', inst: 'String Ensemble', vol: 0.6, pan: -0.3 },
        { name: 'Arp', inst: 'Synth Bells', vol: 0.5, pan: 0.4, mute: true },
        { name: 'FX', inst: 'Reverse Cymbal', vol: 0.45, pan: 0 }
    ];

    // track, start bar, length in bars, pattern name
    const clips = [
        [0, 0, 4, 'A'], [0, 4, 4, 'A'], [0, 8, 4, 'B'], [0, 12, 4, 'A'],
        [1, 0, 4, 'A'], [1, 4, 4, 'A'], [1, 8, 4, 'B'], [1, 12, 4, 'B'],
        [2, 0, 4, 'A'], [2, 4, 4, 'A'], [2, 8, 4, 'B'], [2, 12, 4, 'A'],
        [3, 4, 8, 'A'], [3, 12, 4, 'A'],
        [4, 8, 4, 'A'], [4, 12, 4, 'B'],
        [5, 8, 8, 'A'],
        [6, 0, 4, 'A'], [6, 12, 4, 'A'],
        [7, 7, 1, 'A'], [7, 15, 1, 'A']
    ].map(([track, start, length, pattern]) => ({ track, start, length, pattern }));

    // Deterministic mini preview for a clip: [{ x: 0..1, y: 0..1, w: 0..1 }]
    function preview(track, pattern, lengthBars) {
        let seed = track * 31 + pattern.charCodeAt(0) * 7;
        const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
        const steps = lengthBars * (track === 0 ? 8 : 4);
        const out = [];
        for (let i = 0; i < steps; i++) {
            if (track === 0) {
                if (i % 2 === 0) out.push({ x: i / steps, y: 0.85, w: 0.6 / steps });
                if (i % 4 === 2) out.push({ x: i / steps, y: 0.45, w: 0.6 / steps });
                out.push({ x: i / steps, y: 0.12, w: 0.4 / steps });
            } else if (rand() > (track === 3 || track === 5 ? 0.7 : 0.35)) {
                const long = track === 3 || track === 5 ? 3 : 1;
                out.push({ x: i / steps, y: 0.15 + rand() * 0.7, w: long * 0.9 / steps });
            }
        }
        return out;
    }

    // Piano roll: Keys, pattern B, 2 bars (8 beats), grid 1/8
    const chords = [[0, [57, 60, 64, 67]], [2, [53, 57, 60, 64]], [4, [55, 60, 64, 67]], [6, [55, 59, 62, 67]]];
    const notes = [];
    chords.forEach(([t, pitches], i) => pitches.forEach(p => notes.push({ t, p, d: 2, v: 70 + (i % 2) * 12 })));
    [[0, 72, 1, 100], [1.5, 71, 0.5, 84], [2, 69, 1, 92], [3.5, 67, 0.5, 76], [4, 72, 1.5, 110], [6, 74, 2, 96]]
        .forEach(([t, p, d, v]) => notes.push({ t, p, d, v }));
    const ghosts = [[0, 45, 1.5], [1.5, 45, 0.5], [2, 41, 1.5], [3.5, 41, 0.5], [4, 48, 1.5], [5.5, 48, 0.5], [6, 43, 2]]
        .map(([t, p, d]) => ({ t, p, d }));

    return {
        tracks,
        bars: 16,
        clips,
        preview,
        song: { cursorTrack: 2, cursorBar: 8, playheadBar: 5.4, loop: [8, 12], bpm: 120 },
        roll: {
            track: 2, pattern: 'B', beats: 8, grid: 8, low: 40, high: 77,
            notes, ghosts, cursor: { t: 3.5, p: 67 }, selected: [notes.length - 2]
        },
        noteName(p) {
            return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][p % 12] + (Math.floor(p / 12) - 1);
        },
        isBlack(p) {
            return [1, 3, 6, 8, 10].includes(p % 12);
        }
    };
})();
