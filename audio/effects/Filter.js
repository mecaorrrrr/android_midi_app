/**
 * Filter - Multi-mode filter with envelope and LFO modulation support
 * Supports: Lowpass, Highpass, Bandpass, Notch, Peaking, Allpass
 * Includes optional envelope follower and LFO for dynamic filtering
 */

import { EffectBase } from './EffectBase.js';

export class Filter extends EffectBase {
    constructor(ctx, output) {
        super(ctx, output);
        
        // Create biquad filter
        this.filter = ctx.createBiquadFilter();
        
        // Connect filter to wet path
        this.inputGain.connect(this.filter);
        this.filter.connect(this.wetGain);
        
        // Additional gain for dynamics
        this.outputGainNode = ctx.createGain();
        this.filter.connect(this.outputGainNode);
        this.outputGainNode.connect(this.wetGain);
        
        // LFO for filter modulation
        this.lfo = ctx.createOscillator();
        this.lfo.type = 'sine';
        this.lfo.frequency.value = 0;
        
        this.lfoGain = ctx.createGain();
        this.lfoGain.gain.value = 0;
        
        // Connect LFO to filter frequency
        this.lfo.connect(this.lfoGain);
        this.lfoGain.connect(this.filter.frequency);
        
        // Envelope follower for dynamic filtering
        this.envelopeFollower = ctx.createScriptProcessor
            ? this.createEnvelopeFollower() : null;
        
        // Start LFO
        this.lfo.start();
        
        // Register parameters
        this.registerParameters();
        
        // Set default values
        this.setDefaults();
    }

    /**
     * Create envelope follower (fallback for non-script processor browsers)
     */
    createEnvelopeFollower() {
        try {
            const processor = this.ctx.createScriptProcessor(2048, 1, 1);
            this.envelopeValue = 0;
            
            processor.onaudioprocess = (event) => {
                const input = event.inputBuffer.getChannelData(0);
                const output = event.outputBuffer.getChannelData(0);
                
                // Simple envelope follower
                const attack = 0.01;
                const release = 0.1;
                
                for (let i = 0; i < input.length; i++) {
                    const abs = Math.abs(input[i]);
                    if (abs > this.envelopeValue) {
                        this.envelopeValue += (abs - this.envelopeValue) * attack;
                    } else {
                        this.envelopeValue += (abs - this.envelopeValue) * release;
                    }
                    output[i] = this.envelopeValue;
                }
            };
            
            return processor;
        } catch (e) {
            console.warn('Filter: ScriptProcessor not available');
            return null;
        }
    }

    /**
     * Set default parameter values
     */
    setDefaults() {
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 1000;
        this.filter.Q.value = 1;
        this.filter.gain.value = 0;
    }

    /**
     * Register filter parameters
     */
    registerParameters() {
        // Filter type
        this.registerParameter('filterType', 'lowpass', {
            min: 0, max: 5, step: 1, default: 0,
            label: 'Type'
        });
        
        // Cutoff frequency
        this.registerParameter('frequency', 1000, {
            min: 20, max: 20000, step: 1, default: 1000,
            label: 'Cutoff', unit: 'Hz'
        });
        
        // Resonance/Q
        this.registerParameter('resonance', 1, {
            min: 0.1, max: 20, step: 0.1, default: 1,
            label: 'Resonance', unit: 'Q'
        });
        
        // Filter gain (for peaking filter)
        this.registerParameter('gain', 0, {
            min: -24, max: 24, step: 0.5, default: 0,
            label: 'Gain', unit: 'dB'
        });
        
        // Wet level
        this.registerParameter('wetLevel', 1.0, {
            min: 0.0, max: 1.0, step: 0.01, default: 1.0,
            label: 'Wet Level'
        });
        
        // LFO rate for modulation
        this.registerParameter('lfoRate', 0, {
            min: 0, max: 20, step: 0.1, default: 0,
            label: 'LFO Rate', unit: 'Hz'
        });
        
        // LFO depth for modulation
        this.registerParameter('lfoDepth', 0, {
            min: 0, max: 5000, step: 10, default: 0,
            label: 'LFO Depth', unit: 'Hz'
        });
        
        // LFO type
        this.registerParameter('lfoType', 'sine', {
            min: 0, max: 3, step: 1, default: 0,
            label: 'LFO Type'
        });
        
        // Envelope modulation amount
        this.registerParameter('envModAmount', 0, {
            min: -5000, max: 5000, step: 10, default: 0,
            label: 'Env Mod', unit: 'Hz'
        });
    }

    /**
     * Apply parameter changes
     */
    applyParameter(name, value, time) {
        const now = time || this.ctx.currentTime;
        
        switch (name) {
            case 'filterType':
                const types = ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'allpass'];
                if (value >= 0 && value < types.length) {
                    this.filter.type = types[value];
                }
                break;
                
            case 'frequency':
                this.filter.frequency.setValueAtTime(Math.max(20, Math.min(20000, value)), now);
                break;
                
            case 'resonance':
                this.filter.Q.setValueAtTime(Math.max(0.1, Math.min(20, value)), now);
                break;
                
            case 'gain':
                this.filter.gain.setValueAtTime(Math.max(-24, Math.min(24, value)), now);
                break;
                
            case 'wetLevel':
                this.setWetLevel(value);
                break;
                
            case 'lfoRate':
                this.lfo.frequency.setValueAtTime(value, now);
                break;
                
            case 'lfoDepth':
                this.lfoGain.gain.setValueAtTime(value, now);
                break;
                
            case 'lfoType':
                const lfoTypes = ['sine', 'square', 'sawtooth', 'triangle'];
                if (value >= 0 && value < lfoTypes.length) {
                    this.lfo.type = lfoTypes[value];
                }
                break;
                
            case 'envModAmount':
                // Store for envelope modulation
                this.envModAmount = value;
                break;
        }
    }

    /**
     * Set filter type by name
     */
    setFilterType(typeName) {
        const types = {
            'lowpass': 0,
            'highpass': 1,
            'bandpass': 2,
            'notch': 3,
            'peaking': 4,
            'allpass': 5
        };
        
        if (types[typeName] !== undefined) {
            this.setParameter('filterType', types[typeName]);
        }
    }

    /**
     * Set cutoff frequency in Hz
     */
    setFrequency(freq) {
        this.setParameter('frequency', freq);
    }

    /**
     * Set resonance/Q value
     */
    setResonance(q) {
        this.setParameter('resonance', q);
    }

    /**
     * Set filter gain in dB (for peaking filter)
     */
    setGain(gainDb) {
        this.setParameter('gain', gainDb);
    }

    /**
     * Set LFO modulation
     */
    setLFO(rate, depth, type = 'sine') {
        this.setParameter('lfoRate', rate);
        this.setParameter('lfoDepth', depth);
        
        if (type) {
            const typeMap = { 'sine': 0, 'square': 1, 'sawtooth': 2, 'triangle': 3 };
            if (typeMap[type] !== undefined) {
                this.setParameter('lfoType', typeMap[type]);
            }
        }
    }

    /**
     * Enable/disable LFO modulation
     */
    setLFOEnabled(enabled) {
        if (enabled) {
            this.lfo.start();
        } else {
            this.lfo.stop();
        }
    }

    /**
     * Set envelope modulation
     */
    setEnvelopeModulation(amount) {
        this.setParameter('envModAmount', amount);
    }

    /**
     * Connect to input signal for envelope detection
     */
    connectEnvelopeInput(source) {
        if (this.envelopeFollower) {
            source.connect(this.envelopeFollower);
            this.envelopeFollower.connect(this.ctx.destination); // Don't lose the signal
        }
    }

    /**
     * Apply frequency curve (for velocity-dependent filtering)
     */
    applyVelocityCurve(velocity, baseFreq, curveType = 'linear') {
        const velNorm = velocity / 127;
        let freqMult = 1;
        
        switch (curveType) {
            case 'linear':
                freqMult = 0.5 + velNorm * 0.5;
                break;
            case 'exponential':
                freqMult = Math.pow(velNorm + 0.1, 2);
                break;
            case 'inverse':
                freqMult = 1.0 - velNorm * 0.5;
                break;
            case 'bright':
                freqMult = Math.pow(velNorm, 0.5);
                break;
            case 'dark':
                freqMult = Math.pow(velNorm, 2) * 0.5 + 0.5;
                break;
            default:
                freqMult = velNorm;
        }
        
        this.setFrequency(baseFreq * freqMult);
    }

    /**
     * Preset: Low Pass (warm, muffled sound)
     */
    applyLowPassPreset() {
        this.setFilterType('lowpass');
        this.setFrequency(2000);
        this.setResonance(1);
        this.setWetLevel(1.0);
    }

    /**
     * Preset: High Pass (clear, thin sound)
     */
    applyHighPassPreset() {
        this.setFilterType('highpass');
        this.setFrequency(200);
        this.setResonance(1);
        this.setWetLevel(1.0);
    }

    /**
     * Preset: Band Pass (telephone-like)
     */
    applyBandPassPreset() {
        this.setFilterType('bandpass');
        this.setFrequency(1000);
        this.setResonance(5);
        this.setWetLevel(1.0);
    }

    /**
     * Preset: Notch (remove frequencies)
     */
    applyNotchPreset() {
        this.setFilterType('notch');
        this.setFrequency(2000);
        this.setResonance(10);
        this.setWetLevel(1.0);
    }

    /**
     * Preset: Wah (auto-wah effect)
     */
    applyWahPreset() {
        this.setFilterType('lowpass');
        this.setFrequency(800);
        this.setResonance(5);
        this.setLFO(0.5, 1000, 'sine');
    }

    /**
     * Preset: Acid (resonant lowpass)
     */
    applyAcidPreset() {
        this.setFilterType('lowpass');
        this.setFrequency(800);
        this.setResonance(15);
        this.setLFO(4, 200, 'square');
    }

    /**
     * Get current filter state
     */
    getState() {
        const state = super.getState();
        return {
            ...state,
            type: this.filter.type,
            frequency: this.filter.frequency.value,
            resonance: this.filter.Q.value,
            gain: this.filter.gain.value,
            lfoRate: this.lfo.frequency.value,
            lfoDepth: this.lfoGain.gain.value,
            lfoType: this.lfo.type
        };
    }

    /**
     * Get filter node for direct connection
     */
    getFilterNode() {
        return this.filter;
    }

    /**
     * Dispose and free resources
     */
    dispose() {
        // Stop LFO
        this.lfo.stop();
        this.lfo.disconnect();
        this.lfoGain.disconnect();
        
        // Disconnect filter
        this.filter.disconnect();
        this.outputGainNode.disconnect();
        
        // Disconnect envelope follower
        if (this.envelopeFollower) {
            this.envelopeFollower.disconnect();
        }
        
        super.dispose();
    }
}

/**
 * MultiFilter - Cascaded multi-stage filter
 * For steeper roll-off (24dB/oct, 36dB/oct, etc.)
 */
export class MultiFilter extends EffectBase {
    constructor(ctx, output, stages = 2) {
        super(ctx, output);
        
        this.stages = stages;
        this.filters = [];
        
        // Create multiple filter stages
        let lastNode = this.inputGain;
        for (let i = 0; i < stages; i++) {
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1000;
            filter.Q.value = 1;
            
            lastNode.connect(filter);
            lastNode = filter;
            this.filters.push(filter);
        }
        
        // Connect to wet gain
        lastNode.connect(this.wetGain);
        this.wetGain.connect(this.mixNode);
        
        // Register parameters
        this.registerMultiParameters();
    }

    /**
     * Register parameters for multi-stage filter
     */
    registerMultiParameters() {
        this.registerParameter('frequency', 1000, {
            min: 20, max: 20000, step: 1, default: 1000,
            label: 'Cutoff', unit: 'Hz'
        });
        
        this.registerParameter('resonance', 1, {
            min: 0.1, max: 10, step: 0.1, default: 1,
            label: 'Resonance', unit: 'Q'
        });
        
        this.registerParameter('stages', 2, {
            min: 1, max: 4, step: 1, default: 2,
            label: 'Stages'
        });
        
        this.registerParameter('wetLevel', 1.0, {
            min: 0.0, max: 1.0, step: 0.01, default: 1.0,
            label: 'Wet'
        });
    }

    /**
     * Apply parameter changes
     */
    applyParameter(name, value, time) {
        const now = time || this.ctx.currentTime;
        
        switch (name) {
            case 'frequency':
                for (const filter of this.filters) {
                    filter.frequency.setValueAtTime(Math.max(20, Math.min(20000, value)), now);
                }
                break;
            case 'resonance':
                for (const filter of this.filters) {
                    filter.Q.setValueAtTime(Math.max(0.1, Math.min(10, value)), now);
                }
                break;
            case 'wetLevel':
                this.setWetLevel(value);
                break;
        }
    }

    /**
     * Set filter type
     */
    setFilterType(typeName) {
        for (const filter of this.filters) {
            filter.type = typeName;
        }
    }

    /**
     * Dispose
     */
    dispose() {
        for (const filter of this.filters) {
            filter.disconnect();
        }
        super.dispose();
    }
}
