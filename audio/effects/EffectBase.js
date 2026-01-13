/**
 * EffectBase - Base class for audio effects
 * Provides common functionality for all effects including:
 * - Wet/dry mixing
 * - Bypass control
 * - Parameter automation
 * - State management
 */

export class EffectBase {
    constructor(ctx, output) {
        this.ctx = ctx;
        this.output = output;
        
        // Input and output gain nodes for mixing
        this.inputGain = this.ctx.createGain();
        this.outputGain = this.ctx.createGain();
        
        // Wet/dry mix control
        this.wetGain = this.ctx.createGain();
        this.dryGain = this.ctx.createGain();
        
        // Mix node
        this.mixNode = this.ctx.createGain();
        
        // Effect processing node (to be implemented by subclasses)
        this.effectNode = null;
        
        // State
        this.enabled = true;
        this.bypassed = false;
        this.wetLevel = 0.5; // 0.0 = dry, 1.0 = wet
        this.dryLevel = 1.0;
        
        // Parameter metadata for UI
        this.parameters = {};
        this.parameterInfo = {};
        
        // Initialize routing
        this.setupRouting();
    }

    /**
     * Set up audio routing: Input -> Wet/Dry Mix -> Output
     */
    setupRouting() {
        // Connect input to dry path
        this.inputGain.connect(this.dryGain);
        
        // Connect dry path to mix
        this.dryGain.connect(this.mixNode);
        
        // Connect output
        this.mixNode.connect(this.outputGain);
        this.outputGain.connect(this.output);
        
        // Update mix levels
        this.updateMix();
    }

    /**
     * Update wet/dry mix levels
     */
    updateMix() {
        const now = this.ctx.currentTime;
        
        if (this.bypassed) {
            // Full dry signal when bypassed
            this.dryGain.gain.setValueAtTime(1, now);
            this.wetGain.gain.setValueAtTime(0, now);
        } else if (this.effectNode) {
            // Apply wet/dry mix
            this.dryGain.gain.setValueAtTime(this.dryLevel, now);
            this.wetGain.gain.setValueAtTime(this.wetLevel, now);
        }
    }

    /**
     * Enable or disable the effect
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        
        if (!enabled) {
            this.bypass();
        } else {
            this.unbypass();
        }
    }

    /**
     * Bypass the effect (dry signal only)
     */
    bypass() {
        this.bypassed = true;
        this.updateMix();
        
        // Optionally suspend processing
        if (this.effectNode && this.effectNode.suspend) {
            // Keep it connected but muted
        }
    }

    /**
     * Unbypass the effect
     */
    unbypass() {
        this.bypassed = false;
        this.updateMix();
    }

    /**
     * Set wet/dry mix ratio
     * @param {number} wet - Wet level (0.0 to 1.0)
     */
    setMix(wet) {
        this.wetLevel = Math.max(0, Math.min(1, wet));
        this.dryLevel = 1 - this.wetLevel;
        this.updateMix();
    }

    /**
     * Set wet level directly
     * @param {number} wet - Wet level (0.0 to 1.0)
     */
    setWetLevel(wet) {
        this.wetLevel = Math.max(0, Math.min(1, wet));
        this.dryLevel = 1 - this.wetLevel;
        this.updateMix();
    }

    /**
     * Set dry level directly
     * @param {number} dry - Dry level (0.0 to 1.0)
     */
    setDryLevel(dry) {
        this.dryLevel = Math.max(0, Math.min(1, dry));
        this.wetLevel = 1 - this.dryLevel;
        this.updateMix();
    }

    /**
     * Set output volume
     * @param {number} volume - Volume level (0.0 to 1.0)
     */
    setOutputVolume(volume) {
        const now = this.ctx.currentTime;
        this.outputGain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now);
    }

    /**
     * Connect input source to this effect
     * @param {AudioNode} source - Source node to connect
     */
    connectInput(source) {
        source.connect(this.inputGain);
    }

    /**
     * Connect effect output to destination
     * @param {AudioNode} destination - Destination node
     */
    connectOutput(destination) {
        this.outputGain.disconnect();
        this.outputGain.connect(destination);
        this.output = destination;
    }

    /**
     * Disconnect all connections
     */
    disconnect() {
        this.inputGain.disconnect();
        this.dryGain.disconnect();
        this.wetGain.disconnect();
        this.mixNode.disconnect();
        this.outputGain.disconnect();
    }

    /**
     * Get the effect input node for connection
     */
    getInput() {
        return this.inputGain;
    }

    /**
     * Get the effect output node for connection
     */
    getOutput() {
        return this.outputGain;
    }

    /**
     * Get current state information
     */
    getState() {
        return {
            enabled: this.enabled,
            bypassed: this.bypassed,
            wetLevel: this.wetLevel,
            dryLevel: this.dryLevel,
            outputVolume: this.outputGain.gain.value,
            parameters: { ...this.parameters }
        };
    }

    /**
     * Register a parameter with metadata
     * @param {string} name - Parameter name
     * @param {*} value - Current value
     * @param {Object} info - Parameter metadata
     */
    registerParameter(name, value, info = {}) {
        this.parameters[name] = value;
        this.parameterInfo[name] = {
            min: info.min !== undefined ? info.min : 0,
            max: info.max !== undefined ? info.max : 1,
            step: info.step !== undefined ? info.step : 0.01,
            default: info.default !== undefined ? info.default : value,
            label: info.label || name,
            unit: info.unit || '',
            automatable: info.automatable !== undefined ? info.automatable : true
        };
    }

    /**
     * Set a parameter value
     * @param {string} name - Parameter name
     * @param {*} value - New value
     * @param {number} [time] - Optional ramp time
     */
    setParameter(name, value, time) {
        if (this.parameters[name] === undefined) {
            console.warn(`EffectBase: Unknown parameter "${name}"`);
            return;
        }
        
        const now = this.ctx.currentTime;
        const rampTime = time || 0;
        
        // Store the value
        this.parameters[name] = value;
        
        // Apply the parameter change (to be overridden by subclasses)
        this.applyParameter(name, value, now + rampTime);
    }

    /**
     * Apply parameter change - to be implemented by subclasses
     */
    applyParameter(name, value, time) {
        // Override in subclass
    }

    /**
     * Get parameter value
     * @param {string} name - Parameter name
     */
    getParameter(name) {
        return this.parameters[name];
    }

    /**
     * Get parameter info
     * @param {string} name - Parameter name
     */
    getParameterInfo(name) {
        return this.parameterInfo[name];
    }

    /**
     * Get all parameter info
     */
    getAllParameters() {
        return { ...this.parameterInfo };
    }

    /**
     * Reset all parameters to defaults
     */
    resetParameters() {
        for (const [name, info] of Object.entries(this.parameterInfo)) {
            this.setParameter(name, info.default);
        }
    }

    /**
     * Suspend the effect
     */
    suspend() {
        if (this.effectNode && this.effectNode.suspend) {
            this.effectNode.suspend();
        }
    }

    /**
     * Resume the effect
     */
    resume() {
        if (this.effectNode && this.effectNode.resume) {
            this.effectNode.resume();
        }
    }

    /**
     * Dispose of the effect and free resources
     */
    dispose() {
        this.disconnect();
        
        if (this.effectNode) {
            if (this.effectNode.disconnect) {
                this.effectNode.disconnect();
            }
            this.effectNode = null;
        }
        
        this.inputGain = null;
        this.outputGain = null;
        this.wetGain = null;
        this.dryGain = null;
        this.mixNode = null;
        this.output = null;
    }
}

/**
 * EffectChain - Manages a chain of effects
 */
export class EffectChain {
    constructor(ctx) {
        this.ctx = ctx;
        this.effects = [];
        this.input = this.ctx.createGain();
        this.output = this.ctx.createGain();
        
        // Connect input to first effect
        this.input.connect(this.output);
    }

    /**
     * Add an effect to the chain
     * @param {EffectBase} effect - Effect to add
     * @param {number} [index] - Optional insertion index
     */
    addEffect(effect, index = -1) {
        if (index < 0 || index > this.effects.length) {
            index = this.effects.length;
        }
        
        this.effects.splice(index, 0, effect);
        this.rebuildRouting();
    }

    /**
     * Remove an effect from the chain
     * @param {EffectBase} effect - Effect to remove
     */
    removeEffect(effect) {
        const index = this.effects.indexOf(effect);
        if (index >= 0) {
            effect.disconnect();
            this.effects.splice(index, 1);
            this.rebuildRouting();
        }
    }

    /**
     * Rebuild audio routing based on current effect list
     */
    rebuildRouting() {
        // Disconnect everything
        this.input.disconnect();
        
        let lastNode = this.input;
        
        for (const effect of this.effects) {
            effect.disconnect();
            effect.connectInput(lastNode);
            lastNode = effect.getOutput();
        }
        
        lastNode.connect(this.output);
    }

    /**
     * Get chain input
     */
    getInput() {
        return this.input;
    }

    /**
     * Get chain output
     */
    getOutput() {
        return this.output;
    }

    /**
     * Bypass all effects
     */
    bypassAll() {
        for (const effect of this.effects) {
            effect.bypass();
        }
    }

    /**
     * Unbypass all effects
     */
    unbypassAll() {
        for (const effect of this.effects) {
            effect.unbypass();
        }
    }

    /**
     * Set enabled state for all effects
     */
    setEnabled(enabled) {
        for (const effect of this.effects) {
            effect.setEnabled(enabled);
        }
    }

    /**
     * Get all effects
     */
    getEffects() {
        return [...this.effects];
    }

    /**
     * Dispose all effects
     */
    dispose() {
        for (const effect of this.effects) {
            effect.dispose();
        }
        this.effects = [];
        this.input.disconnect();
        this.output.disconnect();
    }
}
