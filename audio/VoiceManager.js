/**
 * VoiceManager - Manages voice allocation and playback
 * Handles polyphony, voice pooling, and track routing
 */

export class VoiceManager {
    constructor(ctx, maxVoices = 64) {
        this.ctx = ctx;
        this.maxVoices = maxVoices;
        this.activeVoices = new Map(); // voiceId -> voice object
        this.voicePool = []; // available voices for reuse
        this.nextVoiceId = 0;
        
        // Track outputs for routing
        this.trackChannels = []; // Array of { gain: GainNode, panner: StereoPannerNode }
        this.masterOutput = null;
        
        // Initialize track channels
        this.initTrackChannels();
    }

    /**
     * Initialize track channel outputs
     */
    initTrackChannels() {
        for (let i = 0; i < 8; i++) {
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            
            gain.connect(panner);
            panner.connect(this.ctx.destination); // Temporary - will be re-routed
            
            this.trackChannels.push({ gain, panner });
        }
    }

    /**
     * Set master output for all track channels
     */
    setMasterOutput(masterGain) {
        this.masterOutput = masterGain;
        // Re-route all track channels to master
        for (const channel of this.trackChannels) {
            channel.panner.disconnect();
            channel.panner.connect(masterGain);
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.trackChannels[trackId]) {
            this.trackChannels[trackId].panner.pan.setValueAtTime(pan, this.ctx.currentTime);
        }
    }

    /**
     * Play an SF2 note
     */
    async playSF2Note(fontId, presetIndex, midi, velocity, duration, trackId) {
        if (!this.soundFontManager) {
            console.warn("VoiceManager: SoundFontManager not initialized");
            return;
        }

        // Resolve the sample for this note
        const sampleInfo = this.soundFontManager.resolveSample(fontId, presetIndex, midi, velocity);
        if (!sampleInfo) {
            console.warn(`VoiceManager: No sample found for note ${midi} in preset ${presetIndex}`);
            return;
        }

        // Allocate a voice
        const voice = this.allocateVoice(trackId);
        if (!voice) {
            console.warn("VoiceManager: Failed to allocate voice");
            return;
        }

        // Start playback
        await voice.start(sampleInfo, midi, velocity, duration);
    }

    /**
     * Allocate a voice for a track
     * Returns a voice instance or null if max voices reached
     */
    async allocateVoice(trackId) {
        // Check if we've reached max voices
        if (this.activeVoices.size >= this.maxVoices) {
            // Steal the oldest voice
            const oldestVoiceId = this.activeVoices.keys().next().value;
            if (oldestVoiceId) {
                const oldVoice = this.activeVoices.get(oldestVoiceId);
                if (oldVoice) {
                    oldVoice.stop();
                }
                this.activeVoices.delete(oldestVoiceId);
            }
        }

        // Get voice from pool or create new
        let voice;
        if (this.voicePool.length > 0) {
            voice = this.voicePool.pop();
        } else {
            // Import SF2Voice dynamically
            const { SF2Voice } = await import('./voices/SF2Voice.js');
            const trackChannel = this.trackChannels[trackId] || this.trackChannels[0];
            voice = new SF2Voice(this.ctx, trackChannel.gain);
        }

        const voiceId = ++this.nextVoiceId;
        voice.voiceId = voiceId;
        voice.trackId = trackId;
        
        this.activeVoices.set(voiceId, voice);
        
        // Set up cleanup callback
        voice.onEnded = () => {
            this.activeVoices.delete(voiceId);
            this.voicePool.push(voice);
        };

        return voice;
    }

    /**
     * Stop all active voices immediately
     */
    panic() {
        for (const [voiceId, voice] of this.activeVoices) {
            voice.stop();
        }
        this.activeVoices.clear();
    }

    /**
     * Get count of active voices
     */
    getActiveVoiceCount() {
        return this.activeVoices.size;
    }

    /**
     * Get polyphony usage
     */
    getPolyphonyInfo() {
        return {
            active: this.activeVoices.size,
            max: this.maxVoices,
            available: this.maxVoices - this.activeVoices.size
        };
    }
}
