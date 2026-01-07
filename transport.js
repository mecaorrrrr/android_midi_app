export class TransportManager {
    constructor(app) {
        this.app = app;

        // Data Structures
        // Sorted by beat
        this.tempoMap = [
            { beat: 0, bpm: 120 }
        ];

        this.timeSigMap = [
            { beat: 0, num: 4, den: 4 }
        ];
    }

    getBpmAt(beat) {
        // Find the last tempo change event before or at 'beat'
        for (let i = this.tempoMap.length - 1; i >= 0; i--) {
            if (this.tempoMap[i].beat <= beat) {
                return this.tempoMap[i].bpm;
            }
        }
        return 120;
    }

    getTimeSigAt(beat) {
        for (let i = this.timeSigMap.length - 1; i >= 0; i--) {
            if (this.timeSigMap[i].beat <= beat) {
                return this.timeSigMap[i];
            }
        }
        return { num: 4, den: 4 };
    }

    addTempoChange(beat, bpm) {
        // Check if exists
        const idx = this.tempoMap.findIndex(e => Math.abs(e.beat - beat) < 0.001);
        if (idx >= 0) {
            this.tempoMap[idx].bpm = bpm;
        } else {
            this.tempoMap.push({ beat, bpm });
            this.tempoMap.sort((a, b) => a.beat - b.beat);
        }
    }

    addTimeSigChange(beat, num, den) {
        const idx = this.timeSigMap.findIndex(e => Math.abs(e.beat - beat) < 0.001);
        if (idx >= 0) {
            this.timeSigMap[idx].num = num;
            this.timeSigMap[idx].den = den;
        } else {
            this.timeSigMap.push({ beat, num, den });
            this.timeSigMap.sort((a, b) => a.beat - b.beat);
        }
    }

    // Get context (Measure number, etc.) at a given absolute beat
    getMeasureAt(beat) {
        let currentBeat = 0;
        let tsIndex = 0;
        let measureCount = 1;

        // Optimization: Could cache bar starts map if performance is an issue.

        while (true) {
            const ts = this.timeSigMap[tsIndex];
            const nextTs = this.timeSigMap[tsIndex + 1];

            // Length of one bar in beats under current TimeSig
            // num * (4/den)
            const barLength = ts.num * (4 / ts.den);

            // Limit of this TimeSig section
            let sectionEnd = nextTs ? nextTs.beat : Infinity;

            // Check if 'beat' is within this section
            if (beat < sectionEnd) {
                // How many full bars from currentBeat to 'beat'?
                const diff = beat - currentBeat;
                const bars = Math.floor(diff / barLength);

                measureCount += bars;
                const localBeat = diff - (bars * barLength);

                return {
                    measure: measureCount,
                    localBeat: localBeat,
                    beatInBar: localBeat, // same as localBeat currently
                    timeSig: ts
                };
            }

            // Advance to next TS section
            // Calculate how many bars fit in this section
            const sectionLen = sectionEnd - currentBeat;
            // Assuming TS changes allow partial bars? Or assume aligned?
            // Usually aligned.
            const barsInSection = sectionLen / barLength; // Should be integer
            measureCount += barsInSection;

            currentBeat = sectionEnd;
            tsIndex++;
            if (!nextTs) break; // Should be caught by infinity check but safety
        }
        return { measure: 1, localBeat: 0, timeSig: this.timeSigMap[0] };
    }

    // Determine if a beat is the start of a bar
    isBarStart(beat) {
        // We need to integrate through time signatures to find bar lines
        // This is a bit expensive for every frame/line, so caching might be needed later
        // For now, simple simulation

        let currentBeat = 0;
        let tsIndex = 0;

        // If beat is 0, yes
        if (Math.abs(beat) < 0.001) return true;

        while (currentBeat < beat + 0.001) { // slight epsilon
            const ts = this.timeSigMap[tsIndex];
            const nextTs = this.timeSigMap[tsIndex + 1];
            const barLength = ts.num * (4 / ts.den); // length in beats. 4/4=4. 3/4=3. 6/8=3.

            // Check if we hit the target beat exactly
            if (Math.abs(currentBeat - beat) < 0.001) return true;

            // Advance by one bar
            currentBeat += barLength;

            // Check if we passed into next time sig
            if (nextTs && currentBeat >= nextTs.beat) {
                // Adjust currentBeat to exact start of next TS?
                // Usually TimeSig changes happen at bar lines. 
                // If not, we reset the "bar phase" at the TS change point.
                currentBeat = nextTs.beat;
                tsIndex++;
            }
        }
        return false;
    }
}
