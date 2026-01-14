/**
 * SFZVoice - Voice class for SFZ format sample playback
 * Parses SFZ files and manages sample playback with full SFZ opcode support
 */

export class SFZVoice {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        
        this.voiceId = null;
        this.trackId = 0;
        
        // Audio nodes
        this.source = null;
        this.envelope = null;
        this.filter = null;
        this.gainNode = null;
        this.panNode = null;
        
        // State
        this.isPlaying = false;
        this.isReleased = false;
        this.startTime = 0;
        this.releaseTime = 0;
        
        // Callbacks
        this.onEnded = null;
        
        // Default ADSR parameters (will be overridden by SFZ opcodes)
        this.attackTime = 0.001;
        this.decayTime = 0.1;
        this.sustainLevel = 0.8;
        this.releaseTimeValue = 0.2;
        
        // Default filter parameters
        this.filterEnabled = false;
        this.filterType = 'lowpass';
        this.filterFreq = 20000;
        this.filterQ = 1;
        
        // Default pitch parameters
        this.pitchKeyCenter = 60; // C4
        this.pitchVeltrack = 0;
        
        // Default pan and volume
        this.pan = 0;
        this.volume = 0; // dB
        this.globalVolume = 1.0;
        
        // Sample info
        this.sampleBuffer = null;
        this.sampleName = '';
        
        // RTPCRATE: Default pitch change per velocity
        this.pitchKeyTrack = 100; // cents per key
        this.pitchRandom = 0;
        
        // Loop settings
        this.loopMode = 0; // 0: no loop, 1: loop, 2: loop through release
        this.loopStart = 0;
        this.loopEnd = 0;
        
        // Offset
        this.offset = 0;
        this.end = 0;
    }

    /**
     * Start playing a sample from SFZ region
     * @param {Object} regionInfo - SFZ region information
     * @param {AudioBuffer} sampleBuffer - The audio buffer to play
     * @param {number} midi - MIDI note number
     * @param {number} velocity - MIDI velocity (0-127)
     * @param {number} duration - Optional duration in seconds
     */
    async start(regionInfo, sampleBuffer, midi, velocity, duration) {
        if (this.isPlaying) {
            this.stop();
        }

        this.sampleBuffer = sampleBuffer;
        
        if (!sampleBuffer) {
            console.error("SFZVoice.start: sampleBuffer is missing!");
            return;
        }
        
        try {
            // Apply region parameters
            this.applyRegionParameters(regionInfo, midi, velocity);
            
            // Create audio nodes
            this.createAudioNodes();
            
            // Calculate pitch and detune
            const detune = this.calculateDetune(midi, velocity);
            this.source.detune.value = detune;
            
            // Apply loop settings
            this.configureLoop();
            
            // Connect nodes: Source -> Filter -> Gain -> Pan -> Output
            this.connectNodes();
            
            // Calculate and apply envelope
            const targetGain = this.calculateGain(velocity);
            this.startEnvelope(targetGain, duration);
            
            // Start playback
            this.source.start(0, this.offset);
            this.startTime = this.ctx.currentTime;
            this.isPlaying = true;
            this.isReleased = false;
            
            // Schedule source stop at duration end to ensure sound stops
            const stopTime = this.ctx.currentTime + (duration || 1.0);
            this.source.stop(stopTime);
            
            // Set up end callback
            this.source.onended = () => {
                this.isPlaying = false;
                if (this.onEnded) {
                    this.onEnded();
                }
            };
            
            console.log(`[DEBUG] SFZVoice.start: Playing ${regionInfo.sample || 'unknown'} at MIDI ${midi} vel ${velocity}`);
        } catch (e) {
            console.error("SFZVoice.start: Error during playback:", e);
        }
    }

    /**
     * Apply SFZ region parameters to voice
     */
    applyRegionParameters(region, midi, velocity) {
        if (!region) return;
        
        // Sample
        this.sampleName = region.sample || '';
        
        // Key range
        if (region.lokey !== undefined) this.keyLo = region.lokey;
        if (region.hikey !== undefined) this.keyHi = region.hikey;
        
        // Velocity range
        if (region.lovel !== undefined) this.velLo = region.lovel;
        if (region.hivel !== undefined) this.velHi = region.hivel;
        
        // Pitch parameters
        if (region.pitch_keycenter !== undefined) {
            this.pitchKeyCenter = region.pitch_keycenter;
        }
        if (region.pitch_keytrack !== undefined) {
            this.pitchKeyTrack = region.pitch_keytrack;
        }
        if (region.pitch_veltrack !== undefined) {
            this.pitchVeltrack = region.pitch_veltrack;
        }
        if (region.pitch_random !== undefined) {
            this.pitchRandom = region.pitch_random;
        }
        if (region.tune !== undefined) {
            this.tune = region.tune;
        }
        
        // Envelope parameters (time in seconds)
        if (region.attack !== undefined) {
            this.attackTime = Math.max(0.001, region.attack);
        }
        if (region.decay !== undefined) {
            this.decayTime = Math.min(4, Math.max(0.001, region.decay));
        }
        if (region.sustain !== undefined) {
            this.sustainLevel = Math.max(0, Math.min(100, region.sustain)) / 100;
        }
        if (region.release !== undefined) {
            this.releaseTimeValue = Math.max(0.001, region.release);
        }
        
        // Volume and pan
        if (region.volume !== undefined) {
            this.volume = region.volume;
            this.globalVolume = Math.pow(10, this.volume / 20); // Convert dB to linear
        }
        if (region.pan !== undefined) {
            this.pan = Math.max(-100, Math.min(100, region.pan));
            if (this.panNode) {
                this.panNode.pan.value = this.pan / 100;
            }
        }
        
        // Filter parameters
        if (region.cutoff !== undefined) {
            this.filterEnabled = true;
            this.filterFreq = Math.max(0, region.cutoff);
        }
        if (region.resonance !== undefined) {
            this.filterQ = Math.max(0, region.resonance);
        }
        if (region.filter_type !== undefined) {
            this.filterType = this.mapFilterType(region.filter_type);
        }
        
        // Loop parameters
        if (region.loop_mode !== undefined) {
            this.loopMode = this.mapLoopMode(region.loop_mode);
        }
        if (region.loop_start !== undefined) {
            this.loopStart = region.loop_start;
        }
        if (region.loop_end !== undefined) {
            this.loopEnd = region.loop_end;
        }
        
        // Offset parameters
        if (region.offset !== undefined) {
            this.offset = region.offset;
        }
        if (region.end !== undefined) {
            this.end = region.end;
        }
        
        // Ampeg envelope
        if (region.ampeg_attack !== undefined) {
            this.attackTime = Math.max(0.001, region.ampeg_attack);
        }
        if (region.ampeg_decay !== undefined) {
            this.decayTime = Math.min(4, Math.max(0.001, region.ampeg_decay));
        }
        if (region.ampeg_sustain !== undefined) {
            this.sustainLevel = Math.max(0, Math.min(100, region.ampeg_sustain)) / 100;
        }
        if (region.ampeg_release !== undefined) {
            this.releaseTimeValue = Math.max(0.001, region.ampeg_release);
        }
        
        // Pitch envelope
        if (region.pitcheg_attack !== undefined) {
            this.pitchEgAttack = region.pitcheg_attack;
        }
        if (region.pitcheg_decay !== undefined) {
            this.pitchEgDecay = region.pitcheg_decay;
        }
        if (region.pitcheg_sustain !== undefined) {
            this.pitchEgSustain = region.pitcheg_sustain;
        }
        if (region.pitcheg_release !== undefined) {
            this.pitchEgRelease = region.pitcheg_release;
        }
        
        // Filter envelope
        if (region.fileg_attack !== undefined) {
            this.filterEgAttack = region.fileg_attack;
        }
        if (region.fileg_decay !== undefined) {
            this.filterEgDecay = region.fileg_decay;
        }
        if (region.fileg_sustain !== undefined) {
            this.filterEgSustain = region.fileg_sustain;
        }
        if (region.fileg_release !== undefined) {
            this.filterEgRelease = region.fileg_release;
        }
        if (region.fileg_depth !== undefined) {
            this.filterEgDepth = region.fileg_depth;
        }
    }

    /**
     * Create audio nodes
     */
    createAudioNodes() {
        // Source node
        this.source = this.ctx.createBufferSource();
        this.source.buffer = this.sampleBuffer;
        
        // Gain node for envelope and volume
        this.gainNode = this.ctx.createGain();
        
        // Pan node for stereo positioning
        this.panNode = this.ctx.createStereoPanner();
        this.panNode.pan.value = this.pan / 100;
        
        // Filter node (if enabled)
        if (this.filterEnabled) {
            this.filter = this.ctx.createBiquadFilter();
            this.filter.type = this.filterType;
            this.filter.frequency.value = this.filterFreq;
            this.filter.Q.value = this.filterQ;
        }
    }

    /**
     * Connect audio nodes based on configuration
     */
    connectNodes() {
        if (this.filterEnabled) {
            this.source.connect(this.filter);
            this.filter.connect(this.gainNode);
        } else {
            this.source.connect(this.gainNode);
        }
        this.gainNode.connect(this.panNode);
        this.panNode.connect(this.output);
    }

    /**
     * Calculate detune value based on pitch parameters
     */
    calculateDetune(midi, velocity) {
        let detune = 0;
        
        // Pitch keytrack: 100 cents per key by default
        detune += (midi - this.pitchKeyCenter) * this.pitchKeyTrack;
        
        // Pitch velocity track
        if (this.pitchVeltrack !== 0) {
            const velOffset = ((velocity / 127) - 0.5) * this.pitchVeltrack;
            detune += velOffset * 100;
        }
        
        // Random pitch variation
        if (this.pitchRandom > 0) {
            detune += (Math.random() - 0.5) * this.pitchRandom;
        }
        
        // Manual tune
        if (this.tune !== undefined) {
            detune += this.tune;
        }
        
        return detune;
    }

    /**
     * Calculate gain based on velocity and volume
     */
    calculateGain(velocity) {
        // Velocity to gain (0-1)
        const velGain = velocity / 127;
        
        // Apply volume from SFZ (in dB)
        let gain = velGain * this.globalVolume;
        
        return gain;
    }

    /**
     * Configure loop settings
     */
    configureLoop() {
        if (this.loopMode === 0 || !this.sampleBuffer) return;
        
        const sampleLength = this.sampleBuffer.length;
        const loopStart = this.loopStart > 0 ? this.loopStart : 0;
        const loopEnd = this.loopEnd > 0 ? this.loopEnd : sampleLength;
        
        this.source.loop = true;
        this.source.loopStart = loopStart / this.sampleBuffer.sampleRate;
        this.source.loopEnd = loopEnd / this.sampleBuffer.sampleRate;
    }

    /**
     * Start the ADSR envelope
     */
    startEnvelope(targetGain, duration) {
        const now = this.ctx.currentTime;
        
        // Attack
        this.gainNode.gain.setValueAtTime(0, now);
        this.gainNode.gain.linearRampToValueAtTime(targetGain, now + this.attackTime);
        
        // Decay to sustain
        const decayEnd = now + this.attackTime + this.decayTime;
        this.gainNode.gain.linearRampToValueAtTime(
            targetGain * this.sustainLevel,
            decayEnd
        );
        
        // Hold at sustain
        this.gainNode.gain.setValueAtTime(
            targetGain * this.sustainLevel,
            decayEnd
        );
        
        // Schedule release
        const releaseStart = duration ? (now + duration - this.releaseTimeValue) : 
                          (now + this.attackTime + this.decayTime + 0.1);
        
        if (duration) {
            this.gainNode.gain.setValueAtTime(
                targetGain * this.sustainLevel,
                releaseStart
            );
            this.gainNode.gain.linearRampToValueAtTime(0, releaseStart + this.releaseTimeValue);
            this.releaseTime = releaseStart + this.releaseTimeValue;
        } else {
            this.releaseTime = decayEnd + 0.1;
        }
    }

    /**
     * Release the voice (called when note ends)
     */
    release() {
        if (!this.isPlaying || this.isReleased) return;
        
        const now = this.ctx.currentTime;
        
        // If before scheduled release, cancel and release now
        if (now < this.releaseTime) {
            const currentGain = this.gainNode.gain.value;
            this.gainNode.gain.cancelScheduledValues(now);
            this.gainNode.gain.setValueAtTime(currentGain, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + this.releaseTimeValue);
        }
        
        this.isReleased = true;
    }

    /**
     * Stop the voice immediately
     */
    stop() {
        if (this.source) {
            try {
                this.source.stop(0);
            } catch (e) {
                // Already stopped
            }
            this.source.disconnect();
            this.source = null;
        }
        
        if (this.gainNode) {
            this.gainNode.disconnect();
            this.gainNode = null;
        }
        
        if (this.filter) {
            this.filter.disconnect();
            this.filter = null;
        }
        
        if (this.panNode) {
            this.panNode.disconnect();
            this.panNode = null;
        }
        
        this.isPlaying = false;
        this.isReleased = true;
    }

    /**
     * Map SFZ filter type to Web Audio filter type
     */
    mapFilterType(sfzType) {
        const typeMap = {
            'lp': 'lowpass',
            'hp': 'highpass',
            'bp': 'bandpass',
            'notch': 'notch',
            'allpass': 'allpass',
            'peaking': 'peaking',
            'lowpass': 'lowpass',
            'highpass': 'highpass',
            'bandpass': 'bandpass'
        };
        return typeMap[sfzType.toLowerCase()] || 'lowpass';
    }

    /**
     * Map SFZ loop mode to internal mode
     */
    mapLoopMode(sfzMode) {
        const modeMap = {
            'no_loop': 0,
            'one_shot': 0,
            'loop_continuous': 1,
            'loop': 1,
            'loop_sustain': 2
        };
        return modeMap[sfzMode.toLowerCase()] || 0;
    }

    /**
     * Update filter parameters at runtime
     */
    setFilterFrequency(freq) {
        this.filterFreq = freq;
        if (this.filter && this.filterEnabled) {
            this.filter.frequency.setValueAtTime(freq, this.ctx.currentTime);
        }
    }

    /**
     * Update filter Q at runtime
     */
    setFilterQ(q) {
        this.filterQ = q;
        if (this.filter && this.filterEnabled) {
            this.filter.Q.setValueAtTime(q, this.ctx.currentTime);
        }
    }

    /**
     * Update pan at runtime
     */
    setPan(pan) {
        this.pan = pan;
        if (this.panNode) {
            this.panNode.pan.setValueAtTime(pan / 100, this.ctx.currentTime);
        }
    }

    /**
     * Update volume at runtime
     */
    setVolume(volumeDb) {
        this.volume = volumeDb;
        this.globalVolume = Math.pow(10, volumeDb / 20);
    }

    /**
     * Get current state information
     */
    getState() {
        return {
            isPlaying: this.isPlaying,
            isReleased: this.isReleased,
            sampleName: this.sampleName,
            midi: this.pitchKeyCenter,
            velocity: 127,
            filterFreq: this.filterFreq,
            filterQ: this.filterQ,
            pan: this.pan,
            volume: this.volume
        };
    }
}

/**
 * SFZParser - Parse SFZ file format
 * Handles the text-based SFZ format and creates region definitions
 */
export class SFZParser {
    constructor() {
        this.regions = [];
        this.samples = new Map();
        this.headers = {};
        this.defaultPath = '';
    }

    /**
     * Parse SFZ file content
     * @param {string} content - SFZ file text content
     * @param {string} basePath - Base path for sample files
     */
    parse(content, basePath = '') {
        this.regions = [];
        this.headers = {};
        this.defaultPath = basePath;
        
        const lines = content.split('\n');
        let currentGroup = {};
        let currentRegion = {};
        let currentControl = {};
        
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum].trim();
            
            // Skip empty lines and comments
            if (!line || line.startsWith('//') || line.startsWith(';')) continue;
            
            // Parse header tags like <region>, <group>, <control>
            if (line.startsWith('<') && line.includes('>')) {
                const tagMatch = line.match(/<(\w+)>(.*)/);
                if (tagMatch) {
                    const tagName = tagMatch[1].toLowerCase();
                    const tagContent = tagMatch[2].trim();
                    
                    // Save previous region if exists
                    if (Object.keys(currentRegion).length > 0 && tagName !== 'region' && tagName !== 'group') {
                        this.regions.push({ ...currentRegion });
                        currentRegion = {};
                    }
                    
                    switch (tagName) {
                        case 'control':
                            currentControl = this.parseControl(tagContent);
                            // Set default_path if present
                            if (currentControl.default_path) {
                                this.defaultPath = currentControl.default_path;
                            }
                            break;
                            
                        case 'global':
                            this.headers.global = this.parseKeyValues(tagContent);
                            break;
                        
                        case 'master':
                            this.headers.master = this.parseKeyValues(tagContent);
                            break;
                        
                        case 'group':
                            currentGroup = this.parseKeyValues(tagContent);
                            break;
                        
                        case 'region':
                            const region = this.parseRegion(tagContent, currentGroup, currentControl);
                            if (region.sample) {
                                this.regions.push(region);
                            }
                            currentGroup = {};
                            break;
                        
                        case 'curve':
                        case 'curve':
                            this.headers.curves = this.headers.curves || [];
                            this.headers.curves.push(this.parseKeyValues(tagContent));
                            break;
                        
                        case 'effect':
                            this.headers.effects = this.headers.effects || [];
                            this.headers.effects.push(this.parseKeyValues(tagContent));
                            break;
                    }
                }
            } else if (Object.keys(currentRegion).length > 0 || Object.keys(currentGroup).length > 0) {
                // Continue parsing region/group parameters
                const keyValues = this.parseKeyValues(line);
                if (Object.keys(currentRegion).length > 0) {
                    Object.assign(currentRegion, keyValues);
                } else if (Object.keys(currentGroup).length > 0) {
                    Object.assign(currentGroup, keyValues);
                }
            }
        }
        
        // Don't forget the last region
        if (Object.keys(currentRegion).length > 0) {
            this.regions.push(currentRegion);
        }
        
        console.log(`SFZParser: Parsed ${this.regions.length} regions`);
        return this;
    }

    /**
     * Parse control tag
     */
    parseControl(content) {
        const result = {};
        const assignments = content.split(' ');
        
        for (const assignment of assignments) {
            const [key, value] = assignment.split('=');
            if (key && value !== undefined) {
                result[key.trim()] = value.trim();
            }
        }
        
        return result;
    }

    /**
     * Parse key=value pairs from a line
     */
    parseKeyValues(content) {
        const result = {};
        // Handle multiple key=value pairs separated by spaces or spaces with =
        const pairs = content.match(/(\w+)=(-?\d+\.?\d*|"[^"]*"|\S+)/g);
        
        if (!pairs) return result;
        
        for (const pair of pairs) {
            const eqIndex = pair.indexOf('=');
            const key = pair.substring(0, eqIndex).trim();
            let value = pair.substring(eqIndex + 1).trim();
            
            // Remove quotes if present
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            }
            
            // Convert numeric values
            if (!isNaN(value)) {
                value = parseFloat(value);
            }
            
            result[key] = value;
        }
        
        return result;
    }

    /**
     * Parse a region definition
     */
    parseRegion(content, groupDefaults, controlDefaults) {
        const region = { ...groupDefaults };
        Object.assign(region, this.parseKeyValues(content));
        
        // Apply control defaults
        if (controlDefaults.default_path) {
            // If sample path is relative, prepend default path
            if (region.sample && !region.sample.includes('/') && !region.sample.includes('\\')) {
                const path = controlDefaults.default_path;
                region.sample = path.replace('*', region.sample);
            }
        }
        
        // Parse key range
        if (region.key) {
            // Single key specification
            region.pitch_keycenter = this.midiNoteToNumber(region.key);
        }
        
        if (region.lokey) {
            region.keyLo = this.midiNoteToNumber(region.lokey);
        }
        if (region.hikey) {
            region.keyHi = this.midiNoteToNumber(region.hikey);
        }
        
        // Default key range
        if (region.keyLo === undefined) region.keyLo = 0;
        if (region.keyHi === undefined) region.keyHi = 127;
        
        // Parse velocity range
        if (region.lovel !== undefined) region.velLo = Math.max(0, Math.min(127, region.lovel));
        else region.velLo = 0;
        
        if (region.hivel !== undefined) region.velHi = Math.max(0, Math.min(127, region.hivel));
        else region.velHi = 127;
        
        // Parse loop mode
        if (region.loop_mode) {
            region.loop_mode = region.loop_mode.toLowerCase();
        }
        
        // Parse pitch bend
        if (region.pitch_bend !== undefined) {
            // pitch_bend is in cents, convert to appropriate units
        }
        
        // Parse CC triggers
        for (const [key, value] of Object.entries(region)) {
            if (key.startsWith('set_') && key.length > 4) {
                // This is a CC assignment
            }
        }
        
        return region;
    }

    /**
     * Convert MIDI note name to number
     * Supports formats like: C4, C-1, c5, etc.
     */
    midiNoteToNumber(noteStr) {
        if (typeof noteStr === 'number') return noteStr;
        if (!noteStr || typeof noteStr !== 'string') return 60;
        
        const noteMap = {
            'c': 0, 'c#': 1, 'cs': 1, 'db': 1,
            'd': 2, 'd#': 3, 'ds': 3, 'eb': 3,
            'e': 4, 'fb': 4,
            'f': 5, 'e#': 5,
            'f#': 6, 'fs': 6, 'gb': 6,
            'g': 7, 'g#': 8, 'gs': 8, 'ab': 8,
            'a': 9, 'a#': 10, 'as': 10, 'bb': 10,
            'b': 11, 'cb': 11
        };
        
        try {
            const match = noteStr.toLowerCase().match(/([a-g]#?|b)(-?\d+)/);
            if (match) {
                const noteName = match[1];
                const octave = parseInt(match[2]);
                const noteNum = noteMap[noteName];
                if (noteNum !== undefined) {
                    return (octave + 1) * 12 + noteNum;
                }
            }
        } catch (e) {
            // Fall through
        }
        
        // Default to C4
        return 60;
    }

    /**
     * Get parsed regions
     */
    getRegions() {
        return this.regions;
    }

    /**
     * Find regions matching a note and velocity
     * @param {number} midi - MIDI note number
     * @param {number} velocity - MIDI velocity (0-127)
     * @returns {Array} - Matching regions
     */
    findRegions(midi, velocity) {
        return this.regions.filter(region => {
            // Check key range
            if (midi < region.keyLo || midi > region.keyHi) return false;
            
            // Check velocity range
            if (velocity < region.velLo || velocity > region.velHi) return false;
            
            return true;
        });
    }

    /**
     * Get list of required sample files
     */
    getRequiredSamples() {
        const samples = new Set();
        for (const region of this.regions) {
            if (region.sample) {
                samples.add(region.sample);
            }
        }
        return Array.from(samples);
    }
}
