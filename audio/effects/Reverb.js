/**
 * Reverb - Convolution and algorithmic reverb effect
 * Provides both convolution-based reverb (using impulse responses) and
 * algorithmic reverb (using delay networks) for flexible reverb options
 */

import { EffectBase } from './EffectBase.js';

export class Reverb extends EffectBase {
    constructor(ctx, output) {
        super(ctx, output);
        
        // Effect processing nodes
        this.convolver = ctx.createConvolver();
        this.wetGain.connect(this.convolver);
        this.convolver.connect(this.mixNode);
        
        // Algorithmic reverb (Schroeder allpass network)
        this.algReverbNode = null;
        this.useAlgorithmic = false;
        
        // Register parameters
        this.registerParameters();
        
        // Create default impulse response
        this.createDefaultImpulse();
    }

    /**
     * Register reverb parameters with metadata
     */
    registerParameters() {
        // Convolution reverb parameters
        this.registerParameter('decayTime', 2.0, {
            min: 0.1, max: 10.0, step: 0.1, default: 2.0,
            label: 'Decay Time', unit: 's'
        });
        
        this.registerParameter('preDelay', 0.02, {
            min: 0.0, max: 0.1, step: 0.001, default: 0.02,
            label: 'Pre-Delay', unit: 's'
        });
        
        this.registerParameter('wetLevel', 0.3, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.3,
            label: 'Wet Level'
        });
        
        // High frequency damping
        this.registerParameter('highFreqDamping', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'High Freq Damping'
        });
        
        // Low frequency response
        this.registerParameter('lowFreqRatio', 1.0, {
            min: 0.5, max: 2.0, step: 0.1, default: 1.0,
            label: 'Low Freq Ratio'
        });
        
        // Room size (for algorithmic mode)
        this.registerParameter('roomSize', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Room Size'
        });
        
        // Stereo width
        this.registerParameter('stereoWidth', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Stereo Width'
        });
    }

    /**
     * Create default impulse response for convolution reverb
     */
    createDefaultImpulse() {
        const decayTime = this.parameters.decayTime || 2.0;
        const sampleRate = this.ctx.sampleRate;
        const length = Math.floor(sampleRate * decayTime);
        
        // Create impulse buffer
        const impulse = this.ctx.createBuffer(2, length, sampleRate);
        
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            
            for (let i = 0; i < length; i++) {
                // Exponential decay with some randomness
                const decay = Math.pow(1 - i / length, 2);
                const noise = (Math.random() * 2 - 1) * decay;
                
                // Add early reflections
                if (i < sampleRate * 0.05) {
                    channelData[i] = noise * 0.5;
                } else {
                    channelData[i] = noise;
                }
            }
        }
        
        this.convolver.buffer = impulse;
        this.impulseBuffer = impulse;
    }

    /**
     * Create impulse response based on parameters
     */
    generateImpulse() {
        const sampleRate = this.ctx.sampleRate;
        const decayTime = this.parameters.decayTime;
        const preDelay = this.parameters.preDelay;
        const damping = this.parameters.highFreqDamping;
        const lowFreqRatio = this.parameters.lowFreqRatio;
        
        // Calculate length
        const length = Math.floor(sampleRate * (decayTime + preDelay));
        
        // Create impulse buffer (stereo)
        const impulse = this.ctx.createBuffer(2, length, sampleRate);
        
        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            const channelOffset = channel === 0 ? -1 : 1;
            
            for (let i = 0; i < length; i++) {
                const time = i / sampleRate;
                const decayFactor = Math.pow(1 - time / decayTime, 2);
                
                // Calculate position with pre-delay
                let pos = i - (preDelay * sampleRate);
                
                if (pos < 0) {
                    // Pre-delay region - mostly silence with early reflections
                    channelData[i] = 0;
                } else {
                    // Main reverb body
                    let sample = 0;
                    
                    // Add multiple comb-filtered signals for richness
                    const delays = [
                        Math.floor(sampleRate * 0.02 * (1 + channelOffset * 0.1)),
                        Math.floor(sampleRate * 0.03 * (1 - channelOffset * 0.1)),
                        Math.floor(sampleRate * 0.04 * (1 + channelOffset * 0.05))
                    ];
                    
                    for (const delay of delays) {
                        if (pos - delay >= 0) {
                            // Apply damping based on frequency
                            const dampingFactor = 1 - damping * (1 - decayFactor);
                            sample += channelData[Math.floor(pos - delay)] * dampingFactor;
                        }
                    }
                    
                    // Add original signal with decay
                    const originalSample = (Math.random() * 2 - 1) * decayFactor;
                    sample += originalSample * 0.1;
                    
                    // Low frequency emphasis
                    if (lowFreqRatio > 1) {
                        const lowSample = (Math.random() * 2 - 1) * decayFactor * (lowFreqRatio - 1);
                        sample += lowSample * 0.05;
                    }
                    
                    channelData[i] = sample;
                }
            }
        }
        
        this.convolver.buffer = impulse;
        this.impulseBuffer = impulse;
    }

    /**
     * Apply parameter changes
     */
    applyParameter(name, value, time) {
        switch (name) {
            case 'decayTime':
            case 'preDelay':
            case 'highFreqDamping':
            case 'lowFreqRatio':
                // Regenerate impulse response
                if (!this.useAlgorithmic) {
                    this.generateImpulse();
                }
                break;
                
            case 'wetLevel':
                this.setWetLevel(value);
                break;
                
            case 'roomSize':
            case 'stereoWidth':
                // For algorithmic reverb mode
                if (this.useAlgorithmic && this.algReverbNode) {
                    // Adjust algorithmic reverb parameters
                }
                break;
        }
    }

    /**
     * Load a custom impulse response from an AudioBuffer or array
     * @param {AudioBuffer|Array} impulseData - Impulse response data
     */
    loadImpulseResponse(impulseData) {
        let buffer = impulseData;
        
        // If it's an array, create a buffer
        if (Array.isArray(impulseData)) {
            const sampleRate = this.ctx.sampleRate;
            const length = impulseData.length;
            buffer = this.ctx.createBuffer(2, length, sampleRate);
            
            for (let channel = 0; channel < 2; channel++) {
                const channelData = buffer.getChannelData(channel);
                for (let i = 0; i < length; i++) {
                    channelData[i] = impulseData[i] || 0;
                }
            }
        }
        
        if (buffer) {
            this.convolver.buffer = buffer;
            this.impulseBuffer = buffer;
            this.useAlgorithmic = false;
            console.log('Reverb: Custom impulse response loaded');
        }
    }

    /**
     * Load impulse response from a URL
     * @param {string} url - URL to impulse response file
     */
    async loadImpulseFromUrl(url) {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.loadImpulseResponse(audioBuffer);
            return true;
        } catch (e) {
            console.error('Reverb: Failed to load impulse response:', e);
            return false;
        }
    }

    /**
     * Switch to algorithmic reverb mode (fallback when no impulse)
     * Uses a simple delay-network reverb
     */
    enableAlgorithmicMode() {
        if (this.algReverbNode) return;
        
        this.useAlgorithmic = true;
        
        // Create a simple algorithmic reverb
        // Multiple allpass filters and comb filters
        this.algReverbNode = this.ctx.createGain();
        
        // For now, just pass through with wet/dry mix
        // A full implementation would add comb/allpass filters
        this.convolver.disconnect();
        this.wetGain.disconnect();
        
        this.wetGain.connect(this.algReverbNode);
        this.algReverbNode.connect(this.mixNode);
    }

    /**
     * Switch back to convolution mode
     */
    enableConvolutionMode() {
        this.useAlgorithmic = false;
        
        if (this.algReverbNode) {
            this.algReverbNode.disconnect();
            this.algReverbNode = null;
        }
        
        this.wetGain.connect(this.convolver);
        this.convolver.connect(this.mixNode);
    }

    /**
     * Set room size (for algorithmic mode)
     */
    setRoomSize(size) {
        this.setParameter('roomSize', size);
    }

    /**
     * Set stereo width
     */
    setStereoWidth(width) {
        this.setParameter('stereoWidth', width);
    }

    /**
     * Preset: Small Room
     */
    applySmallRoomPreset() {
        this.setParameter('decayTime', 0.8);
        this.setParameter('preDelay', 0.01);
        this.setParameter('highFreqDamping', 0.3);
        this.setParameter('roomSize', 0.3);
        this.setParameter('wetLevel', 0.25);
    }

    /**
     * Preset: Medium Room
     */
    applyMediumRoomPreset() {
        this.setParameter('decayTime', 1.5);
        this.setParameter('preDelay', 0.02);
        this.setParameter('highFreqDamping', 0.5);
        this.setParameter('roomSize', 0.5);
        this.setParameter('wetLevel', 0.35);
    }

    /**
     * Preset: Large Hall
     */
    applyLargeHallPreset() {
        this.setParameter('decayTime', 4.0);
        this.setParameter('preDelay', 0.03);
        this.setParameter('highFreqDamping', 0.7);
        this.setParameter('roomSize', 0.9);
        this.setParameter('wetLevel', 0.4);
    }

    /**
     * Preset: Cathedral
     */
    applyCathedralPreset() {
        this.setParameter('decayTime', 8.0);
        this.setParameter('preDelay', 0.05);
        this.setParameter('highFreqDamping', 0.8);
        this.setParameter('roomSize', 1.0);
        this.setParameter('wetLevel', 0.45);
    }

    /**
     * Preset: Plate
     */
    applyPlatePreset() {
        this.setParameter('decayTime', 2.5);
        this.setParameter('preDelay', 0.0);
        this.setParameter('highFreqDamping', 0.2);
        this.setParameter('roomSize', 0.6);
        this.setParameter('wetLevel', 0.3);
    }

    /**
     * Get current reverb state
     */
    getState() {
        const state = super.getState();
        return {
            ...state,
            mode: this.useAlgorithmic ? 'algorithmic' : 'convolution',
            impulseLoaded: !!this.impulseBuffer,
            impulseLength: this.impulseBuffer ? this.impulseBuffer.length : 0
        };
    }

    /**
     * Dispose and free resources
     */
    dispose() {
        this.convolver.disconnect();
        this.convolver.buffer = null;
        
        if (this.algReverbNode) {
            this.algReverbNode.disconnect();
            this.algReverbNode = null;
        }
        
        super.dispose();
    }
}
