export class MidiEncoder {
    constructor() {
        this.tracks = []; // Array of byte arrays
    }

    // Helper: append string characters
    writeString(arr, str) {
        for (let i = 0; i < str.length; i++) {
            arr.push(str.charCodeAt(i));
        }
    }

    // Helper: write variable length quantity
    writeVarInt(arr, value) {
        let buffer = value & 0x7F;
        while ((value >>= 7) > 0) {
            buffer <<= 8;
            buffer |= 0x80;
            buffer += (value & 0x7F);
        }

        while (true) {
            arr.push(buffer & 0xFF);
            if (buffer & 0x80) buffer >>= 8;
            else break;
        }
    }

    // Helper: write ints (Big Endian)
    writeInt32(arr, val) {
        arr.push((val >> 24) & 0xFF);
        arr.push((val >> 16) & 0xFF);
        arr.push((val >> 8) & 0xFF);
        arr.push(val & 0xFF);
    }

    writeInt16(arr, val) {
        arr.push((val >> 8) & 0xFF);
        arr.push(val & 0xFF);
    }

    writeInt24(arr, val) {
        arr.push((val >> 16) & 0xFF);
        arr.push((val >> 8) & 0xFF);
        arr.push(val & 0xFF);
    }

    createTrack() {
        return { events: [] };
    }

    addEvent(track, time, data) {
        track.events.push({ time, data });
    }

    // Encode events to track chunk
    encodeTrack(track) {
        // Sort events by time
        track.events.sort((a, b) => a.time - b.time);

        const bytes = [];
        this.writeString(bytes, 'MTrk');

        // Placeholder for length
        const lengthIndex = bytes.length;
        this.writeInt32(bytes, 0);

        let currentTime = 0;

        for (const event of track.events) {
            const deltaTime = event.time - currentTime;
            currentTime = event.time;

            this.writeVarInt(bytes, deltaTime);
            bytes.push(...event.data);
        }

        // End of Track
        this.writeVarInt(bytes, 0);
        bytes.push(0xFF, 0x2F, 0x00);

        // Fill length
        const trackLength = bytes.length - lengthIndex - 4;
        bytes[lengthIndex] = (trackLength >> 24) & 0xFF;
        bytes[lengthIndex + 1] = (trackLength >> 16) & 0xFF;
        bytes[lengthIndex + 2] = (trackLength >> 8) & 0xFF;
        bytes[lengthIndex + 3] = trackLength & 0xFF;

        return bytes;
    }

    buildFile(tracks, ppq = 480) {
        const fileBytes = [];

        // Header Chunk
        this.writeString(fileBytes, 'MThd');
        this.writeInt32(fileBytes, 6);
        this.writeInt16(fileBytes, 1); // Format 1 (multi-track)
        this.writeInt16(fileBytes, tracks.length);
        this.writeInt16(fileBytes, ppq);

        // Tracks
        for (const track of tracks) {
            const trackBytes = this.encodeTrack(track);
            fileBytes.push(...trackBytes);
        }

        return new Uint8Array(fileBytes);
    }
}
