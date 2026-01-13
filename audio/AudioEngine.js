/**
 * AudioEngine - Main audio engine for Android MIDI App
 * Acts as a facade for the audio subsystem, delegating to specialized managers.
 * Phase 3: Added SFZ support, effects chain, and OscVoice fallback.
 */

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.voiceManager = null;
        this.soundFontManager = null;
        
        // Effect instances
        this.effects = {
            reverb: null,
            chorus: null,
            filter: null
        };
        
        // Effect chain
        this.effectChain = null;
        this.effectsEnabled = false;
        
        this.initialized = false;
        
        // Track instrument settings: each track can have different preset
        this.trackInstruments = Array.from({ length: 8 }, () => ({ 
            bank: 0, 
            program: 0, 
            presetIndex: -1,
            fontId: null,
            type: 'sf2' // 'sf2', 'sfz', 'osc'
        }));
        
        // SFZ data storage
        this.sfzData = null;
        this.sfzParser = null;
        
        // Oscillator presets
        this.oscPreset = 'Sine';
        
        this.mode = 'oscillator'; // 'oscillator', 'sfz', 'sf2'
    }

    /**
     * Initialize the audio engine
     */
    async init() {
        if (this.initialized) return;

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        
        // Create master gain
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.5;
        this.masterGain.connect(this.ctx.destination);

        // Initialize effect chain
        await this.initEffects();

        console.log("AudioEngine initialized");
        this.initialized = true;
    }

    /**
     * Initialize effects chain
     */
    async initEffects() {
        try {
            // Import effects
            const { EffectChain, EffectBase } = await import('./effects/EffectBase.js');
            const { Reverb } = await import('./effects/Reverb.js');
            const { Chorus } = await import('./effects/Chorus.js');
            const { Filter } = await import('./effects/Filter.js');
            
            // Create effect chain
            this.effectChain = new EffectChain(this.ctx);
            
            // Create individual effects - connect in reverse order (last effect = closest to source)
            // Voice -> Filter -> Chorus -> Reverb -> Master
            
            // Filter is first (closest to source)
            this.effects.filter = new Filter(this.ctx, this.effectChain.getInput());
            
            // Chorus is in the middle
            this.effects.chorus = new Chorus(this.ctx, this.effects.filter.getOutput());
            
            // Reverb is last in chain (furthest from source)
            this.effects.reverb = new Reverb(this.ctx, this.effects.chorus.getOutput());
            
            // Add to chain in order: Filter -> Chorus -> Reverb
            this.effectChain.addEffect(this.effects.filter);
            this.effectChain.addEffect(this.effects.chorus);
            this.effectChain.addEffect(this.effects.reverb);
            
            // Connect chain output to master
            this.effectChain.getOutput().connect(this.masterGain);
            
            console.log("[DEBUG] AudioEngine: Effects chain initialized");
            console.log("[DEBUG] Audio path: Voice -> Filter -> Chorus -> Reverb -> Master");
            console.log("[DEBUG] Filter wetLevel:", this.effects.filter.wetLevel);
            
        } catch (e) {
            console.warn("AudioEngine: Failed to initialize effects:", e);
        }
    }

    /**
     * Enable or disable effects
     */
    setEffectsEnabled(enabled) {
        this.effectsEnabled = enabled;
        console.log("[DEBUG] AudioEngine.setEffectsEnabled:", enabled);
        if (this.effectChain) {
            if (enabled) {
                this.effectChain.unbypassAll();
                console.log("[DEBUG] EffectChain unbypassed");
            } else {
                this.effectChain.bypassAll();
                console.log("[DEBUG] EffectChain bypassed");
            }
        }
    }

    /**
     * Set master volume
     */
    setMasterVolume(volume) {
        if (this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    /**
     * Set reverb parameters
     */
    setReverb(params) {
        if (this.effects.reverb) {
            if (params.decayTime !== undefined) this.effects.reverb.setParameter('decayTime', params.decayTime);
            if (params.wetLevel !== undefined) this.effects.reverb.setParameter('wetLevel', params.wetLevel);
            if (params.preDelay !== undefined) this.effects.reverb.setParameter('preDelay', params.preDelay);
        }
    }

    /**
     * Set chorus parameters
     */
    setChorus(params) {
        if (this.effects.chorus) {
            if (params.rate !== undefined) this.effects.chorus.setParameter('rate', params.rate);
            if (params.depth !== undefined) this.effects.chorus.setParameter('depth', params.depth);
            if (params.wetLevel !== undefined) this.effects.chorus.setParameter('wetLevel', params.wetLevel);
        }
    }

    /**
     * Set filter parameters
     */
    setFilter(params) {
        console.log(`[DEBUG] AudioEngine.setFilter called:`, params);
        if (this.effects.filter) {
            // Handle both 'frequency' and 'cutoff' parameter names
            const freqValue = params.frequency !== undefined ? params.frequency : params.cutoff;
            
            if (params.filterType !== undefined) this.effects.filter.setFilterType(params.filterType);
            if (freqValue !== undefined) {
                console.log(`[DEBUG] AudioEngine.setFilter: Setting frequency to ${freqValue}`);
                this.effects.filter.setParameter('frequency', freqValue);
            }
            if (params.resonance !== undefined) this.effects.filter.setParameter('resonance', params.resonance);
            if (params.gain !== undefined) this.effects.filter.setParameter('gain', params.gain);
            if (params.wetLevel !== undefined) this.effects.filter.setParameter('wetLevel', params.wetLevel);
            if (params.lfoRate !== undefined) this.effects.filter.setParameter('lfoRate', params.lfoRate);
            if (params.lfoDepth !== undefined) this.effects.filter.setParameter('lfoDepth', params.lfoDepth);
            if (params.lfoType !== undefined) this.effects.filter.setParameter('lfoType', params.lfoType);
            if (params.envModAmount !== undefined) this.effects.filter.setParameter('envModAmount', params.envModAmount);
            if (params.filterAttack !== undefined) this.effects.filter.setParameter('filterAttack', params.filterAttack);
            if (params.filterDecay !== undefined) this.effects.filter.setParameter('filterDecay', params.filterDecay);
            if (params.filterSustain !== undefined) this.effects.filter.setParameter('filterSustain', params.filterSustain);
            if (params.filterRelease !== undefined) this.effects.filter.setParameter('filterRelease', params.filterRelease);
            console.log(`[DEBUG] AudioEngine.setFilter: Filter params applied successfully`);
        } else {
            console.warn(`[DEBUG] AudioEngine.setFilter: effects.filter is null!`);
        }
    }

    /**
     * Get effects state
     */
    getEffectsState() {
        return {
            enabled: this.effectsEnabled,
            reverb: this.effects.reverb?.getState(),
            chorus: this.effects.chorus?.getState(),
            filter: this.effects.filter?.getState()
        };
    }

    /**
     * Resume audio context if suspended
     */
    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    /**
     * Set instrument for a specific track
     */
    setTrackInstrument(trackId, bank, program, presetIndex = -1, fontId = null) {
        if (trackId >= 0 && trackId < 8) {
            this.trackInstruments[trackId] = { bank, program, presetIndex, fontId };
            console.log(`AudioEngine: Track ${trackId} instrument set to Bank:${bank} Prog:${program} PresetIndex:${presetIndex}`);
        }
    }

    /**
     * Set volume for a specific track
     */
    setTrackVolume(trackId, volume) {
        if (this.voiceManager) {
            this.voiceManager.setTrackVolume(trackId, volume);
        }
    }

    /**
     * Set pan for a specific track
     */
    setTrackPan(trackId, pan) {
        if (this.voiceManager) {
            this.voiceManager.setTrackPan(trackId, pan);
        }
    }

    /**
     * Load SF2 file
     */
    async loadSF2(file) {
        await this.init();
        this.resume();

        try {
            const { SF2Parser } = await import('../sf2parser.js');
            const arrayBuffer = await file.arrayBuffer();
            const parser = new SF2Parser(arrayBuffer);
            const sf2Data = parser.parse();

            console.log(`AudioEngine: Parsed SF2: ${sf2Data.presets.length} presets, ${sf2Data.samples.length} samples`);

            // Create a font ID
            const fontId = `sf2_${Date.now()}`;
            
            // Initialize SoundFontManager if needed
            if (!this.soundFontManager) {
                const { SoundFontManager } = await import('./SoundFontManager.js');
                this.soundFontManager = new SoundFontManager(this.ctx);
                console.log("[DEBUG] AudioEngine: SoundFontManager created");
            } else {
                console.log("[DEBUG] AudioEngine: SoundFontManager already exists");
            }
            
            // Set progress callback if available (for streaming decode)
            if (this.progressCallback) {
                this.soundFontManager.setProgressCallback(this.progressCallback);
            }
            
            // Register the SF2 with the manager
            await this.soundFontManager.loadFont(fontId, sf2Data, arrayBuffer);
            
            console.log(`AudioEngine: SF2 loaded successfully, presets count: ${sf2Data.presets.length}`);

            // Initialize all tracks to first preset
            for (let i = 0; i < 8; i++) {
                this.trackInstruments[i] = {
                    bank: sf2Data.presets[0]?.bank || 0,
                    program: sf2Data.presets[0]?.preset || 0,
                    presetIndex: 0,
                    fontId: fontId
                };
            }

            // Initialize VoiceManager
            if (!this.voiceManager) {
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64, this); // Pass 'this' for filter propagation
                this.voiceManager.setMasterOutput(this.masterGain);
                // FIX: Inject SoundFontManager into VoiceManager
                this.voiceManager.soundFontManager = this.soundFontManager;
                console.log("[DEBUG] AudioEngine: VoiceManager created and SoundFontManager injected");
            }
            
            // Connect VoiceManager to effects chain
            if (this.effectChain) {
                this.voiceManager.setEffectsOutput(this.effectChain.getInput());
                console.log("[DEBUG] loadSF2: VoiceManager connected to effect chain");
            }
            
            this.mode = 'sf2';
            return true;
        } catch (e) {
            console.error("AudioEngine: Failed to load SF2:", e);
            return false;
        }
    }

    /**
     * Set progress callback for loading operations
     */
    setProgressCallback(callback) {
        this.progressCallback = callback;
        if (this.soundFontManager) {
            this.soundFontManager.setProgressCallback(callback);
        }
    }

    /**
     * Load SFZ file (simplified - parses SFZ text format)
     */
    async loadSFZ(fileList) {
        await this.init();
        this.resume();
        
        try {
            // Import SFZVoice and SFZParser
            const { SFZVoice, SFZParser } = await import('./voices/SFZVoice.js');
            
            const sfzFile = fileList[0];
            const text = await sfzFile.text();
            
            // Parse SFZ file
            const parser = new SFZParser();
            parser.parse(text, sfzFile.name.replace(/[^\/]*$/, ''));
            
            this.sfzParser = parser;
            this.sfzData = parser.getRegions();
            
            console.log(`AudioEngine: SFZ loaded - ${this.sfzData.length} regions`);
            
            // Initialize VoiceManager for SFZ
            if (!this.voiceManager) {
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64, this); // Pass 'this' for filter propagation
                this.voiceManager.setMasterOutput(this.masterGain);
                
                // Inject effects chain output
                if (this.effectChain) {
                    this.voiceManager.setEffectsOutput(this.effectChain.getInput());
                    console.log("[DEBUG] loadSFZ: VoiceManager connected to effect chain");
                }
            }
            
            // Ensure effects are connected
            this.ensureEffectsConnected();
            
            // Initialize all tracks for SFZ mode
            for (let i = 0; i < 8; i++) {
                this.trackInstruments[i] = {
                    bank: 0,
                    program: 0,
                    presetIndex: -1,
                    fontId: 'sfz',
                    type: 'sfz',
                    regionIndex: 0
                };
            }
            
            this.mode = 'sfz';
            return true;
        } catch (e) {
            console.error("AudioEngine: Failed to load SFZ:", e);
            return false;
        }
    }

    /**
     * Get SFZ regions for display
     */
    getSFZRegions() {
        if (!this.sfzData) return [];
        
        return this.sfzData.map((region, index) => ({
            index: index,
            name: region.sample || `Region ${index + 1}`,
            keyLo: region.keyLo || 0,
            keyHi: region.keyHi || 127,
            velLo: region.velLo || 0,
            velHi: region.velHi || 127,
            lokey: region.lokey,
            hikey: region.hikey
        }));
    }

    /**
     * Set oscillator preset
     */
    setOscPreset(presetName) {
        this.oscPreset = presetName;
    }

    /**
     * Get available oscillator presets
     */
    getOscPresets() {
        return ['Sine', 'Square', 'Sawtooth', 'Triangle', 'Synth Lead', 'Synth Bass', 'Pad', 'Pluck', 'Bell', 'Electric Piano', 'Vibraphone'];
    }

    /**
     * Play oscillator note (fallback voice)
     */
    async playOscillator(midi, duration = 0.5, trackId = 0, velocity = 100) {
        console.log("[DEBUG] playOscillator: called with midi=", midi, "trackId=", trackId);
        
        await this.init();
        this.resume();
        
        console.log("[DEBUG] playOscillator: init completed, checking voiceManager");
        
        try {
            const { OscVoice, getOscillatorPreset } = await import('./voices/OscVoice.js');
            
            // Get preset parameters
            const preset = getOscillatorPreset(this.oscPreset);
            console.log("[DEBUG] playOscillator: preset=", this.oscPreset);
            
            // Initialize VoiceManager for oscillator
            if (!this.voiceManager) {
                console.log("[DEBUG] playOscillator: creating VoiceManager");
                const { VoiceManager } = await import('./VoiceManager.js');
                this.voiceManager = new VoiceManager(this.ctx, 64, this); // Pass 'this' for filter propagation
                this.voiceManager.setMasterOutput(this.masterGain);
                
                // Inject effects chain output
                if (this.effectChain) {
                    this.voiceManager.setEffectsOutput(this.effectChain.getInput());
                    console.log("[DEBUG] playOscillator: VoiceManager connected to effect chain");
                }
            }
            
            // Ensure effects are connected
            this.ensureEffectsConnected();
            
            console.log("[DEBUG] playOscillator: calling voiceManager.playOscNote");
            
            // Play using VoiceManager
            await this.voiceManager.playOscNote(
                preset,
                midi,
                velocity,
                duration,
                trackId
            );
            
            console.log("[DEBUG] playOscillator: playOscNote completed");
            
        } catch (e) {
            console.error("AudioEngine: Failed to play oscillator:", e);
            
            // Fallback to direct oscillator
            this.playOscillatorDirect(midi, duration, trackId, velocity);
        }
    }

    /**
     * Direct oscillator playback (no VoiceManager)
     */
    playOscillatorDirect(midi, duration = 0.2, trackId = 0, velocity = 100) {
        if (!this.ctx) this.init();
        this.resume();

        const osc = this.ctx.createOscillator();
        const envelope = this.ctx.createGain();
        const pan = this.ctx.createStereoPanner();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.midiToFreq(midi), this.ctx.currentTime);

        const gainVal = (velocity / 127) * 0.3;
        envelope.gain.setValueAtTime(0, this.ctx.currentTime);
        envelope.gain.linearRampToValueAtTime(gainVal, this.ctx.currentTime + 0.01);
        envelope.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        // Pan based on track
        pan.pan.value = (trackId - 3.5) / 4;

        osc.connect(envelope);
        envelope.connect(pan);
        
        // Connect to effects or direct to master
        if (this.effectsEnabled && this.effectChain) {
            pan.connect(this.effectChain.getInput());
        } else {
            pan.connect(this.masterGain);
        }

        osc.start();
        osc.stop(this.ctx.currentTime + duration + 0.1);
    }

    /**
     * Get list of presets from loaded soundfonts
     */
    getPresets() {
        if (this.soundFontManager) {
            return this.soundFontManager.getAllPresets();
        }
        return [];
    }

    /**
     * Select preset for a specific track
     */
    selectPreset(trackId, presetIndex) {
        if (!this.soundFontManager) return;
        
        const presets = this.soundFontManager.getAllPresets();
        if (presetIndex < 0 || presetIndex >= presets.length) {
            console.warn("AudioEngine: Invalid preset index:", presetIndex);
            return;
        }
        
        const preset = presets[presetIndex];
        this.setTrackInstrument(trackId, preset.bank, preset.preset, presetIndex, preset.fontId);
        console.log(`AudioEngine: Track ${trackId} preset changed to: ${preset.name} (Index: ${presetIndex})`);
    }

    /**
     * Ensure effects output is properly connected to VoiceManager
     */
    ensureEffectsConnected() {
        if (this.voiceManager && this.effectChain) {
            this.voiceManager.setEffectsOutput(this.effectChain.getInput());
            console.log("[DEBUG] AudioEngine.ensureEffectsConnected: VoiceManager connected to effect chain");
        }
    }

    /**
     * Play a note
     */
    playNote(midi, duration = 1.0, trackId = 0, velocity = 100) {
        if (!this.ctx) {
            console.log("[DEBUG] AudioEngine.playNote: ctx is null, returning");
            return;
        }

        // Check AudioContext state
        console.log(`[DEBUG] AudioEngine.playNote: AudioContext state=${this.ctx.state}`);
        if (this.ctx.state === 'suspended') {
            console.log("[DEBUG] AudioEngine.playNote: Context is suspended, attempting to resume...");
            this.ctx.resume();
        }

        const instrument = this.trackInstruments[trackId];
        console.log(`[DEBUG] AudioEngine.playNote: mode=${this.mode}, midi=${midi}, trackId=${trackId}`);
        
        // Ensure effects chain is connected before playing
        this.ensureEffectsConnected();
        
        // Log connection status
        if (this.voiceManager) {
            console.log(`[DEBUG] AudioEngine.playNote: voiceManager.effectsOutput=${this.voiceManager.effectsOutput ? 'set' : 'null'}`);
            console.log(`[DEBUG] AudioEngine.playNote: voiceManager.masterOutput=${this.voiceManager.masterOutput ? 'exists' : 'null'}`);
        }
        
        if (this.mode === 'sf2' && this.soundFontManager && instrument.fontId) {
            // Play using VoiceManager with SF2
            if (this.voiceManager) {
                console.log(`[DEBUG] AudioEngine.playNote: calling playSF2Note`);
                this.voiceManager.playSF2Note(
                    instrument.fontId,
                    instrument.presetIndex,
                    midi,
                    velocity,
                    duration,
                    trackId
                );
            } else {
                console.log("[DEBUG] AudioEngine.playNote: voiceManager is null");
            }
        } else if (this.mode === 'sfz') {
            // Use legacy SFZ implementation - would need to be migrated
            console.warn("AudioEngine: SFZ playback via legacy engine not implemented yet");
        } else {
            // Use oscillator fallback
            console.log(`[DEBUG] AudioEngine.playNote: using oscillator fallback`);
            this.playOscillator(midi, duration, trackId, velocity);
        }
    }

    /**
     * Convert MIDI note to frequency
     */
    midiToFreq(m) {
        return 440 * Math.pow(2, (m - 69) / 12);
    }

    /**
     * Get ADSR parameters for the current track's preset
     * @returns {Object} ADSR parameters { attack, decay, sustain, release }
     */
    getCurrentPresetAdsrParams() {
        if (!this.soundFontManager) {
            console.warn('AudioEngine: SoundFontManager not available');
            return null;
        }
        
        const trackId = 0; // Use first track as default
        const instrument = this.trackInstruments[trackId];
        
        if (!instrument || !instrument.fontId || instrument.presetIndex < 0) {
            console.warn('AudioEngine: No valid preset selected');
            return null;
        }
        
        return this.soundFontManager.getPresetAdsrParams(instrument.fontId, instrument.presetIndex);
    }

    /**
     * Panic - stop all playing voices immediately
     */
    panic() {
        if (this.voiceManager) {
            this.voiceManager.panic();
        }
    }

    /**
     * Clean up resources
     */
    dispose() {
        this.panic();
        if (this.ctx) {
            this.ctx.close();
            this.ctx = null;
        }
        this.initialized = false;
        
        // Dispose effect chain
        if (this.effectChain) {
            this.effectChain.dispose();
            this.effectChain = null;
            console.log("[DEBUG] EffectChain disposed");
        }
        if (this.voiceManager) {
            this.voiceManager.dispose();
            this.voiceManager = null;
            console.log("[DEBUG] VoiceManager disposed");
        }
    }
    
    /**
     * Diagnose the entire audio signal path
     * Call this from browser console: diagnoseAudio()
     */
    diagnoseAudioPath() {
        console.log("=== Audio Signal Path Diagnosis ===");
        
        // Check AudioContext
        console.log(`AudioContext: ${this.ctx ? 'exists' : 'null'}`);
        if (this.ctx) {
            console.log(`  State: ${this.ctx.state}`);
            console.log(`  CurrentTime: ${this.ctx.currentTime.toFixed(3)}s`);
            console.log(`  SampleRate: ${this.ctx.sampleRate}Hz`);
        }
        
        // Check master gain
        console.log(`MasterGain: ${this.masterGain ? 'exists' : 'null'}`);
        if (this.masterGain) {
            console.log(`  Gain: ${this.masterGain.gain.value}`);
            console.log(`  Connected to: ${this.masterGain.output?.nodeName || 'destination'}`);
            
            // Check if master gain is effectively muted
            if (this.masterGain.gain.value <= 0.001) {
                console.warn(`  WARNING: Master gain is effectively 0! Sound will be inaudible.`);
            }
        }
        
        // Check effect chain
        console.log(`EffectChain: ${this.effectChain ? 'exists' : 'null'}`);
        if (this.effectChain) {
            console.log(`  Input node: ${this.effectChain.input ? 'GainNode (exists)' : 'null'}`);
            console.log(`  Output node: ${this.effectChain.output ? 'GainNode (exists)' : 'null'}`);
            console.log(`  Effects count: ${this.effectChain.effects?.length || 0}`);
            
            // Verify effect chain routing
            if (this.effectChain.input && this.effectChain.output) {
                console.log(`  Chain routing: input -> effects -> output`);
                const inputConnections = this.effectChain.input._connections || [];
                console.log(`  Input connected to: ${inputConnections.length} nodes`);
            }
            
            // Check effect bypass state
            for (const effect of this.effectChain.effects || []) {
                console.log(`  Effect ${effect.constructor.name}: bypassed=${effect.bypassed}, wetLevel=${effect.wetLevel}, enabled=${effect.enabled}`);
                console.log(`    inputGain connected: ${effect.inputGain?._connections?.length > 0}`);
                console.log(`    outputGain connections: ${effect.outputGain?._connections?.length || 0}`);
            }
        }
        
        // Check voice manager
        console.log(`VoiceManager: ${this.voiceManager ? 'exists' : 'null'}`);
        if (this.voiceManager) {
            console.log(`  effectsOutput: ${this.voiceManager.effectsOutput ? 'set' : 'null'}`);
            console.log(`  masterOutput: ${this.voiceManager.masterOutput ? 'exists' : 'null'}`);
            console.log(`  Active voices: ${this.voiceManager.activeVoices?.size || 0}`);
            console.log(`  Track channels: ${this.voiceManager.trackChannels?.length || 0}`);
            
            // Check track channel connections and gain values
            if (this.voiceManager.trackChannels) {
                for (let i = 0; i < this.voiceManager.trackChannels.length; i++) {
                    const ch = this.voiceManager.trackChannels[i];
                    if (ch) {
                        console.log(`  Track ${i}: gain=${ch.gain?.gain?.value?.toFixed(4) || 'N/A'}, panner=${ch.panner?.pan?.value?.toFixed(2) || 'N/A'}`);
                        if (ch.panner) {
                            // More robust connection check - try to trace the connection
                            // Get the output nodes that this panner is connected to
                            const pannerConnections = this.getPannerConnections(ch.panner);
                            console.log(`    Panner connected to: ${pannerConnections.length > 0 ? pannerConnections.join(', ') : 'NOTHING - THIS IS THE BUG!'}`);
                        }
                    }
                }
            }
            
            // Check active voices
            if (this.voiceManager.activeVoices && this.voiceManager.activeVoices.size > 0) {
                console.log(`  Active voice details:`);
                for (const [id, voice] of this.voiceManager.activeVoices) {
                    console.log(`    Voice ${id}: type=${voice.constructor.name}`);
                    console.log(`      gainNode.gain.value=${voice.gainNode?.gain?.value?.toFixed(4) || 'N/A'}`);
                    const gainAtTime = voice.gainNode?.gain?.valueAtTime;
                    if (gainAtTime && typeof gainAtTime === 'function') {
                        console.log(`      gainNode.gain at currentTime=${gainAtTime.call(voice.gainNode.gain, this.ctx?.currentTime || 0)?.toFixed(4) || 'N/A'}`);
                    } else {
                        console.log(`      gainNode.gain at currentTime: method not available`);
                    }
                    console.log(`      output=${voice.output?.constructor?.name || 'null'}`);
                    console.log(`      source.buffer exists=${!!voice.source?.buffer}`);
                    if (voice.source?.buffer) {
                        console.log(`      source.buffer.duration=${voice.source.buffer.duration}s`);
                        console.log(`      source.buffer.sampleRate=${voice.source.buffer.sampleRate}Hz`);
                        // Check buffer content (first 10 samples)
                        const channelData = voice.source.buffer.getChannelData(0);
                        let sum = 0;
                        const samples = Math.min(100, channelData.length);
                        for (let i = 0; i < samples; i++) {
                            sum += Math.abs(channelData[i]);
                        }
                        console.log(`      source.buffer avg amplitude (first ${samples} samples)=${(sum/samples).toFixed(6)}`);
                        if (sum/samples < 0.000001) {
                            console.warn(`      WARNING: Buffer appears to be silent!`);
                        }
                    }
                }
            }
        }
        
        // Check sound font manager
        console.log(`SoundFontManager: ${this.soundFontManager ? 'exists' : 'null'}`);
        if (this.soundFontManager) {
            console.log(`  Loaded fonts: ${this.soundFontManager.fonts?.size || 0}`);
            
            // Check buffer cache
            if (this.soundFontManager.buffers) {
                let totalBuffers = 0;
                for (const fontBuffers of this.soundFontManager.buffers.values()) {
                    totalBuffers += fontBuffers.size;
                }
                console.log(`  Cached buffers: ${totalBuffers}`);
            }
        }
        
        // Check mode
        console.log(`Mode: ${this.mode}`);
        console.log(`Initialized: ${this.initialized}`);
        
        console.log("=== End Diagnosis ===");
        
        // Provide actionable recommendations
        console.log("\n=== Recommendations ===");
        if (this.masterGain?.gain?.value <= 0.001) {
            console.log("FIX: Increase master gain: audioEngine.setMasterVolume(0.5)");
        }
        if (this.ctx?.state === 'suspended') {
            console.log("FIX: Resume audio context: audioEngine.ctx.resume()");
        }
    }
    
    /**
     * Get panner connections for diagnosis
     */
    getPannerConnections(panner) {
        const connections = [];
        if (!panner) return connections;
        
        // Check against known outputs
        if (this.effectChain?.input && this.isNodeConnectedTo(panner, this.effectChain.input)) {
            connections.push('EffectChain.input');
        }
        if (this.masterGain && this.isNodeConnectedTo(panner, this.masterGain)) {
            connections.push('MasterGain');
        }
        if (this.voiceManager?.effectsOutput && this.isNodeConnectedTo(panner, this.voiceManager.effectsOutput)) {
            connections.push('VoiceManager.effectsOutput');
        }
        if (this.voiceManager?.masterOutput && this.isNodeConnectedTo(panner, this.voiceManager.masterOutput)) {
            connections.push('VoiceManager.masterOutput');
        }
        
        // Check ctx.destination
        if (panner.context?.destination && this.isNodeConnectedTo(panner, panner.context.destination)) {
            connections.push('destination');
        }
        
        return connections;
    }
    
    /**
     * Check if a node is connected to a specific destination
     */
    isNodeConnectedTo(node, destination) {
        if (!node || !destination) return false;
        
        // Use internal connection tracking if available
        const connections = node._connections || node._activeInputs;
        if (connections && Array.isArray(connections)) {
            return connections.some(conn => {
                if (Array.isArray(conn)) {
                    return conn.includes(destination);
                }
                return conn === destination;
            });
        }
        
        // Fallback: Check if destination is in the node's downstream graph
        // This is a simplified check - in practice, we'd need more robust tracing
        try {
            // Get all nodes this node is connected to
            // Note: This is a workaround since Web Audio API doesn't expose direct connection info
            const dummyGain = this.ctx.createGain();
            node.connect(dummyGain);
            const isConnected = true; // If connect succeeded, it was likely connected
            dummyGain.disconnect();
            dummyGain.disconnect();
            return isConnected;
        } catch (e) {
            return false;
        }
    }
}
