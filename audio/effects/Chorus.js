/**
 * Chorus - Modulation effect with delay-based chorus, enhancer, and flanger
 * Uses modulated delay lines to create pitch variation effects
 */

import { EffectBase } from './EffectBase.js';

export class Chorus extends EffectBase {
    constructor(ctx, output) {
        super(ctx, output);
        
        // Create chorus processing nodes
        this.createChorusNodes();
        
        // Register parameters
        this.registerParameters();
        
        // Set default mode
        this.mode = 'chorus';
    }

    /**
     * Create chorus processing nodes
     */
    createChorusNodes() {
        // Input splitter
        this.inputSplitter = this.ctx.createGain();
        this.inputGain.connect(this.inputSplitter);
        
        // Wet path with modulation
        this.wetPath = this.ctx.createGain();
        this.inputSplitter.connect(this.wetPath);
        this.wetPath.connect(this.wetGain);
        
        // Create multiple modulated delay lines
        this.delayLines = [];
        this.lfoOscillators = [];
        this.lfoGains = [];
        
        // For stereo chorus
        this.leftDelay = null;
        this.rightDelay = null;
        this.leftLFO = null;
        this.rightLFO = null;
        
        // Create 2-channel modulated delays
        this.createDelayLine('left');
        this.createDelayLine('right');
    }

    /**
     * Create a modulated delay line
     */
    createDelayLine(channel) {
        const delay = this.ctx.createDelay(5.0); // 5 second max delay
        delay.delayTime.value = 0.02; // Base delay time
        
        const lfo = this.ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.5; // LFO frequency
        
        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = 0.005; // LFO depth (delay modulation amount)
        
        // Connect LFO -> LFO Gain -> Delay Time
        lfo.connect(lfoGain);
        lfoGain.connect(delay.delayTime);
        
        // Connect delay to wet gain
        delay.connect(this.wetGain);
        
        // Store references
        if (channel === 'left') {
            this.leftDelay = delay;
            this.leftLFO = lfo;
            this.lfoGains.push(lfoGain);
        } else {
            this.rightDelay = delay;
            this.rightLFO = lfo;
            this.lfoGains.push(lfoGain);
        }
        
        this.delayLines.push(delay);
        this.lfoOscillators.push(lfo);
        
        // Start LFOs
        lfo.start();
    }

    /**
     * Register chorus parameters
     */
    registerParameters() {
        // Rate (LFO frequency)
        this.registerParameter('rate', 1.0, {
            min: 0.1, max: 10.0, step: 0.1, default: 1.0,
            label: 'Rate', unit: 'Hz'
        });
        
        // Depth (LFO amplitude)
        this.registerParameter('depth', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Depth'
        });
        
        // Base delay time
        this.registerParameter('delayTime', 25, {
            min: 5, max: 50, step: 1, default: 25,
            label: 'Delay Time', unit: 'ms'
        });
        
        // Wet mix level
        this.registerParameter('wetLevel', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Wet Level'
        });
        
        // Feedback (for flanger-like effects)
        this.registerParameter('feedback', 0.0, {
            min: 0.0, max: 0.9, step: 0.01, default: 0.0,
            label: 'Feedback'
        });
        
        // Stereo width
        this.registerParameter('stereoWidth', 1.0, {
            min: 0.0, max: 1.0, step: 0.01, default: 1.0,
            label: 'Stereo Width'
        });
        
        // Mode selection
        this.mode = 'chorus';
    }

    /**
     * Apply parameter changes
     */
    applyParameter(name, value, time) {
        const now = time || this.ctx.currentTime;
        
        switch (name) {
            case 'rate':
                // Update LFO frequency for all oscillators
                for (const lfo of this.lfoOscillators) {
                    lfo.frequency.setValueAtTime(value, now);
                }
                break;
                
            case 'depth':
                // Update LFO depth (modulation amount)
                const depthMs = value * 0.01; // Convert 0-1 to seconds
                for (const lfoGain of this.lfoGains) {
                    lfoGain.gain.setValueAtTime(depthMs, now);
                }
                break;
                
            case 'delayTime':
                // Update base delay time
                const delaySec = value / 1000; // Convert ms to seconds
                for (const delay of this.delayLines) {
                    delay.delayTime.setValueAtTime(delaySec, now);
                }
                break;
                
            case 'wetLevel':
                this.setWetLevel(value);
                break;
                
            case 'feedback':
                // Apply feedback (for flanger mode)
                // This would require additional delay routing
                break;
                
            case 'stereoWidth':
                // Adjust stereo phase difference
                if (this.rightLFO) {
                    const phaseOffset = value * 0.5; // Up to 180 degrees
                    this.rightLFO.detune.value = phaseOffset * 360;
                }
                break;
        }
    }

    /**
     * Set chorus mode (chorus, flanger, vibrato)
     */
    setMode(mode) {
        this.mode = mode;
        
        switch (mode) {
            case 'chorus':
                // Standard chorus: light modulation, wet/dry mix
                this.setParameter('depth', 0.5);
                this.setParameter('feedback', 0.0);
                break;
                
            case 'flanger':
                // Flanger: faster rate, feedback
                this.setParameter('rate', 0.5);
                this.setParameter('depth', 0.7);
                this.setParameter('feedback', 0.3);
                break;
                
            case 'vibrato':
                // Vibrato: wet only, no dry signal
                this.setParameter('wetLevel', 1.0);
                this.setParameter('rate', 4.0);
                this.setParameter('depth', 0.8);
                break;
                
            case 'enhancer':
                // Enhancer: subtle modulation for richness
                this.setParameter('wetLevel', 0.2);
                this.setParameter('rate', 0.3);
                this.setParameter('depth', 0.3);
                break;
        }
    }

    /**
     * Set rate in Hz
     */
    setRate(rate) {
        this.setParameter('rate', rate);
    }

    /**
     * Set depth (modulation amount)
     */
    setDepth(depth) {
        this.setParameter('depth', depth);
    }

    /**
     * Set delay time in milliseconds
     */
    setDelayTime(ms) {
        this.setParameter('delayTime', ms);
    }

    /**
     * Set feedback amount (0-1)
     */
    setFeedback(feedback) {
        this.setParameter('feedback', feedback);
    }

    /**
     * Set stereo width (0-1)
     */
    setStereoWidth(width) {
        this.setParameter('stereoWidth', width);
    }

    /**
     * Preset: Light Chorus
     */
    applyLightChorusPreset() {
        this.setMode('chorus');
        this.setRate(0.5);
        this.setDepth(0.3);
        this.setDelayTime(30);
        this.setWetLevel(0.4);
    }

    /**
     * Preset: Deep Chorus
     */
    applyDeepChorusPreset() {
        this.setMode('ch chorus');
        this.setRate(1.2);
        this.setDepth(0.7);
        this.setDelayTime(35);
        this.setWetLevel(0.5);
    }

    /**
     * Preset: Classic Flanger
     */
    applyFlangerPreset() {
        this.setMode('flanger');
        this.setRate(0.4);
        this.setDepth(0.6);
        this.setDelayTime(20);
        this.setFeedback(0.4);
        this.setWetLevel(0.6);
    }

    /**
     * Preset: Vibrato
     */
    applyVibratoPreset() {
        this.setMode('vibrato');
        this.setRate(5.0);
        this.setDepth(0.8);
        this.setDelayTime(25);
    }

    /**
     * Preset: Stereo Enhancer
     */
    applyEnhancerPreset() {
        this.setMode('enhancer');
        this.setRate(0.25);
        this.setDepth(0.2);
        this.setDelayTime(20);
        this.setWetLevel(0.15);
        this.setStereoWidth(1.0);
    }

    /**
     * Sync rate to tempo (for rhythmically synchronized chorus)
     * @param {number} bpm - Beats per minute
     * @param {number} noteValue - Note value (1=quarter, 2=eighth, 4=sixteenth)
     */
    setRateToTempo(bpm, noteValue = 4) {
        const beatsPerSecond = bpm / 60;
        const rate = beatsPerSecond / noteValue;
        this.setRate(rate);
    }

    /**
     * Get current chorus state
     */
    getState() {
        const state = super.getState();
        return {
            ...state,
            mode: this.mode,
            delayLines: this.delayLines.length,
            lfoFrequency: this.lfoOscillators[0]?.frequency.value || 0,
            lfoDepth: this.lfoGains[0]?.gain.value || 0
        };
    }

    /**
     * Dispose and free resources
     */
    dispose() {
        // Stop LFOs
        for (const lfo of this.lfoOscillators) {
            lfo.stop();
            lfo.disconnect();
        }
        
        // Disconnect delay lines
        for (const delay of this.delayLines) {
            delay.disconnect();
        }
        
        this.inputSplitter.disconnect();
        this.wetPath.disconnect();
        
        super.dispose();
    }
}

/**
 * Simple Chorus - Lightweight single-channel chorus
 * For cases where stereo isn't needed
 */
export class SimpleChorus extends EffectBase {
    constructor(ctx, output) {
        super(ctx, output);
        
        // Create delay node
        this.delay = ctx.createDelay(5.0);
        this.delay.delayTime.value = 0.025; // 25ms base delay
        
        // LFO for modulation
        this.lfo = ctx.createOscillator();
        this.lfo.type = 'sine';
        this.lfo.frequency.value = 1.0;
        
        this.lfoGain = ctx.createGain();
        this.lfoGain.gain.value = 0.005; // 5ms depth
        
        // Connect LFO to delay time
        this.lfo.connect(this.lfoGain);
        this.lfoGain.connect(this.delay.delayTime);
        
        // Connect to wet path
        this.inputGain.connect(this.delay);
        this.delay.connect(this.wetGain);
        this.wetGain.connect(this.mixNode);
        
        // Register parameters
        this.registerSimpleParameters();
        
        // Start LFO
        this.lfo.start();
    }

    /**
     * Register simple parameters
     */
    registerSimpleParameters() {
        this.registerParameter('rate', 1.0, {
            min: 0.1, max: 10.0, step: 0.1, default: 1.0,
            label: 'Rate', unit: 'Hz'
        });
        
        this.registerParameter('depth', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Depth'
        });
        
        this.registerParameter('delayTime', 25, {
            min: 5, max: 50, step: 1, default: 25,
            label: 'Delay', unit: 'ms'
        });
        
        this.registerParameter('wetLevel', 0.5, {
            min: 0.0, max: 1.0, step: 0.01, default: 0.5,
            label: 'Wet'
        });
    }

    /**
     * Apply parameter changes
     */
    applyParameter(name, value, time) {
        const now = time || this.ctx.currentTime;
        
        switch (name) {
            case 'rate':
                this.lfo.frequency.setValueAtTime(value, now);
                break;
            case 'depth':
                this.lfoGain.gain.setValueAtTime(value * 0.01, now);
                break;
            case 'delayTime':
                this.delay.delayTime.setValueAtTime(value / 1000, now);
                break;
            case 'wetLevel':
                this.setWetLevel(value);
                break;
        }
    }

    /**
     * Dispose
     */
    dispose() {
        this.lfo.stop();
        this.lfo.disconnect();
        this.lfoGain.disconnect();
        this.delay.disconnect();
        super.dispose();
    }
}
