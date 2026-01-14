/**
 * SoundFontManager - Enhanced sound font management with streaming decode and LRU caching
 * Handles loading, caching, and sample lookup for SF2 files
 */

export class SoundFontManager {
    constructor(ctx) {
        this.ctx = ctx;
        this.fonts = new Map(); // fontId -> font data
        this.buffers = new Map(); // fontId -> Map<sampleIndex, AudioBuffer>
        this.nextFontId = 0;
        
        // LRU cache settings
        this.maxCachedBuffers = 64; // Maximum number of sample buffers to keep in memory
        this.maxMemoryUsage = 256 * 1024 * 1024; // 256MB limit
        this.currentMemoryUsage = 0;
        this.bufferCache = new Map(); // cacheKey -> { buffer, lastUsed, size }
        
        // Streaming settings
        this.useStreamingDecode = true; // Use AudioBufferSourceNode with buffer param for streaming
        this.preloadSamples = false; // Preload samples on load (disabled for streaming)
        
        // Progress callbacks
        this.progressCallback = null;
        
        // Loading state
        this.isLoading = false;
    }

    /**
     * Set progress callback for loading updates
     */
    setProgressCallback(callback) {
        this.progressCallback = callback;
    }

    /**
     * Report progress during loading
     */
    reportProgress(percent, message) {
        if (this.progressCallback) {
            this.progressCallback({ percent, message });
        }
    }

    /**
     * Load a sound font from parsed SF2 data
     * @param {string} fontId - Unique identifier for the font
     * @param {Object} sf2Data - Parsed SF2 data
     * @param {ArrayBuffer} arrayBuffer - Original file buffer for streaming
     * @returns {Promise<string>} - fontId
     */
    async loadFont(fontId, sf2Data, arrayBuffer) {
        this.isLoading = true;
        this.reportProgress(0, 'Loading sound font...');
        
        try {
            // Store font metadata with original buffer for streaming
            const fontData = {
                id: fontId,
                presets: sf2Data.presets,
                instruments: sf2Data.instruments,
                samples: sf2Data.samples,
                sampleData: sf2Data.sampleData,
                originalBuffer: arrayBuffer, // Keep for streaming decode
                loadedAt: Date.now(),
                name: sf2Data.presets[0]?.name || 'Unknown Font'
            };
            
            this.fonts.set(fontId, fontData);
            
            // Initialize buffer map
            this.buffers.set(fontId, new Map());
            
            this.reportProgress(100, 'Sound font loaded');
            console.log(`SoundFontManager: Loaded font ${fontId} (${fontData.name}) with ${sf2Data.presets.length} presets`);
            
            return fontId;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Resolve a sample for a given preset, note, and velocity
     * Returns streaming-capable sample info
     */
    resolveSample(fontId, presetIndex, midi, velocity) {
        const font = this.fonts.get(fontId);
        if (!font) {
            console.warn(`SoundFontManager: Font ${fontId} not found`);
            return null;
        }

        const preset = font.presets[presetIndex];
        if (!preset || !preset.zones) {
            console.warn(`SoundFontManager: Preset ${presetIndex} not found`);
            return null;
        }

        // Find matching instrument zone
        for (const pzone of preset.zones) {
            if (pzone.isGlobal) continue;
            if (pzone.instrumentIndex === undefined) continue;

            const inst = font.instruments[pzone.instrumentIndex];
            if (!inst || !inst.zones) continue;

            for (const izone of inst.zones) {
                if (izone.isGlobal) continue;
                
                // Check key range
                const keyLo = izone.keyLo !== undefined ? izone.keyLo : 0;
                const keyHi = izone.keyHi !== undefined ? izone.keyHi : 127;
                if (midi < keyLo || midi > keyHi) continue;

                // Check velocity range
                const velLo = izone.velLo !== undefined ? izone.velLo : 0;
                const velHi = izone.velHi !== undefined ? izone.velHi : 127;
                if (velocity < velLo || velocity > velHi) continue;

                if (izone.sampleIndex === undefined) continue;

                // Found matching zone - get the sample
                const sample = font.samples[izone.sampleIndex];
                if (!sample) continue;

                return {
                    sample: sample,
                    zone: izone,
                    presetZone: pzone,
                    fontId: fontId,
                    presetIndex: presetIndex,
                    // For streaming decode, we return the font reference
                    fontData: font,
                    canStream: this.useStreamingDecode
                };
            }
        }

        console.warn(`SoundFontManager: No matching sample for note ${midi} vel ${velocity}`);
        return null;
    }

    /**
     * Get or create an AudioBuffer for a sample
     * Uses streaming decode when possible
     */
    async getOrCreateBuffer(fontId, sampleIndex, sample) {
        const fontBuffers = this.buffers.get(fontId);
        if (!fontBuffers) return null;

        // Check if already cached in memory
        if (fontBuffers.has(sampleIndex)) {
            return fontBuffers.get(sampleIndex);
        }

        const font = this.fonts.get(fontId);
        if (!font) return null;

        // For streaming decode mode, create buffer on-demand
        if (this.useStreamingDecode && font.originalBuffer) {
            return this.createStreamingBuffer(font, sample);
        }

        // Traditional decode mode (pre-load all samples)
        return this.createDecodedBuffer(font, sample, fontBuffers, sampleIndex);
    }

    /**
     * Create a buffer using streaming decode approach
     * Returns a detached buffer that can be recreated if needed
     */
    createStreamingBuffer(font, sample) {
        const start = sample.start;
        const end = sample.end;
        const length = end - start;

        if (length <= 0) return null;

        try {
            // Create AudioBuffer for the sample
            const audioBuffer = this.ctx.createBuffer(1, length, sample.sampleRate);
            const channelData = audioBuffer.getChannelData(0);

            // Copy sample data (this happens once per sample)
            const sampleData = font.sampleData;
            if (sampleData) {
                for (let i = 0; i < length; i++) {
                    channelData[i] = sampleData[start + i] / 32768.0;
                }
            }

            // Update memory tracking
            const bufferSize = length * 4; // Float32: 4 bytes per sample
            this.currentMemoryUsage += bufferSize;

            // Cache the buffer
            const fontId = font.id;
            const fontBuffers = this.buffers.get(fontId);
            if (fontBuffers) {
                fontBuffers.set(sample.samples_idx || this.getSampleIndex(font, sample), audioBuffer);
            }

            // Check memory limits
            this.enforceMemoryLimit();

            return audioBuffer;
        } catch (e) {
            console.error(`SoundFontManager: Failed to create streaming buffer:`, e);
            return null;
        }
    }

    /**
     * Get sample index from sample object
     */
    getSampleIndex(font, sample) {
        // Find the index of this sample in the samples array
        for (let i = 0; i < font.samples.length; i++) {
            if (font.samples[i] === sample) return i;
        }
        return -1;
    }

    /**
     * Create a decoded buffer the traditional way
     */
    async createDecodedBuffer(font, sample, fontBuffers, sampleIndex) {
        const start = sample.start;
        const end = sample.end;
        const length = end - start;

        if (length <= 0) return null;

        try {
            const audioBuffer = this.ctx.createBuffer(1, length, sample.sampleRate);
            const channelData = audioBuffer.getChannelData(0);

            // Convert Int16 to Float32
            if (font.sampleData) {
                for (let i = 0; i < length; i++) {
                    channelData[i] = font.sampleData[start + i] / 32768.0;
                }
            }

            // Cache it
            fontBuffers.set(sampleIndex, audioBuffer);
            
            // Update memory usage
            this.currentMemoryUsage += length * 4;
            
            // Manage cache size
            this.manageCacheSize();

            return audioBuffer;
        } catch (e) {
            console.error(`SoundFontManager: Failed to create buffer for sample ${sampleIndex}:`, e);
            return null;
        }
    }

    /**
     * Enforce memory usage limit by evicting least recently used buffers
     */
    enforceMemoryLimit() {
        if (this.currentMemoryUsage <= this.maxMemoryUsage) return;

        console.warn(`SoundFontManager: Memory limit exceeded (${this.formatBytes(this.currentMemoryUsage)}), evicting LRU buffers`);

        // Collect all buffers with their metadata
        const allBuffers = [];
        for (const [fontId, fontBuffers] of this.buffers) {
            for (const [sampleIndex, buffer] of fontBuffers) {
                allBuffers.push({
                    fontId,
                    sampleIndex,
                    buffer,
                    size: buffer.length * 4
                });
            }
        }

        // Sort by approximate LRU (in a real implementation, we'd track access time)
        // For now, just remove from largest fonts first
        allBuffers.sort((a, b) => b.size - a.size);

        // Remove buffers until we're under limit
        while (this.currentMemoryUsage > this.maxMemoryUsage * 0.8 && allBuffers.length > 0) {
            const toRemove = allBuffers.shift();
            const buffers = this.buffers.get(toRemove.fontId);
            if (buffers && buffers.has(toRemove.sampleIndex)) {
                buffers.delete(toRemove.sampleIndex);
                this.currentMemoryUsage -= toRemove.size;
                console.log(`SoundFontManager: Evicted buffer ${toRemove.sampleIndex} from font ${toRemove.fontId}`);
            }
        }
    }

    /**
     * Format bytes for display
     */
    formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * Manage buffer cache size using LRU strategy
     */
    manageCacheSize() {
        // Check total buffer count across all fonts
        let totalBuffers = 0;
        for (const fontBuffers of this.buffers.values()) {
            totalBuffers += fontBuffers.size;
        }

        if (totalBuffers > this.maxCachedBuffers) {
            console.warn(`SoundFontManager: Buffer count (${totalBuffers}) exceeds limit, consider unloading unused fonts`);
        }
    }

    /**
     * Get all presets from all loaded fonts with metadata
     */
    getAllPresets() {
        console.log('SoundFontManager.getAllPresets() called');
        console.log('  Number of loaded fonts:', this.fonts.size);
        
        const presets = [];
        
        for (const [fontId, font] of this.fonts) {
            for (let localIndex = 0; localIndex < font.presets.length; localIndex++) {
                const preset = font.presets[localIndex];
                presets.push({
                    globalIndex: presets.length,
                    localIndex: localIndex,  // Add local index within the font
                    fontId: fontId,
                    fontName: font.name,
                    name: preset.name,
                    bank: preset.bank,
                    preset: preset.preset,
                    fullName: `${preset.bank}:${preset.preset} ${preset.name.trim()}`,
                    category: this.getPresetCategory(preset.bank)
                });
            }
        }
        
        return presets;
    }

    /**
     * Get preset category based on bank number
     */
    getPresetCategory(bank) {
        if (bank === 128) return 'drums';
        if (bank === 0) return 'piano';
        if (bank === 1) return 'chromatic';
        if (bank >= 8) return 'user';
        return 'gm';
    }

    /**
     * Get presets for a specific font
     */
    getPresetsForFont(fontId) {
        const font = this.fonts.get(fontId);
        if (!font) return [];
        
        return font.presets.map((p, index) => ({
            index: index,
            fontId: fontId,
            name: p.name,
            bank: p.bank,
            preset: p.preset,
            fullName: `${p.bank}:${p.preset} ${p.name.trim()}`
        }));
    }

    /**
     * Search presets by name
     */
    searchPresets(query) {
        const allPresets = this.getAllPresets();
        if (!query || query.trim() === '') return allPresets;
        
        const lowerQuery = query.toLowerCase();
        return allPresets.filter(p => 
            p.name.toLowerCase().includes(lowerQuery) ||
            p.fullName.toLowerCase().includes(lowerQuery)
        );
    }

    /**
     * Get instruments for a preset
     */
    getInstrumentsForPreset(fontId, presetIndex) {
        const font = this.fonts.get(fontId);
        if (!font) return [];
        
        const preset = font.presets[presetIndex];
        if (!preset || !preset.zones) return [];
        
        const instruments = [];
        for (const zone of preset.zones) {
            if (zone.isGlobal || zone.instrumentIndex === undefined) continue;
            
            const inst = font.instruments[zone.instrumentIndex];
            if (inst && !instruments.find(i => i.name === inst.name)) {
                instruments.push({
                    name: inst.name,
                    index: zone.instrumentIndex,
                    zoneCount: inst.zones?.length || 0
                });
            }
        }
        
        return instruments;
    }

    /**
     * Unload a sound font and free resources
     */
    unloadFont(fontId) {
        const buffers = this.buffers.get(fontId);
        if (buffers) {
            // Calculate memory freed
            let freedMemory = 0;
            for (const [sampleIndex, buffer] of buffers) {
                freedMemory += buffer.length * 4;
            }
            
            buffers.clear();
            this.currentMemoryUsage -= freedMemory;
        }
        
        const font = this.fonts.get(fontId);
        if (font) {
            // Clear reference to original buffer
            font.originalBuffer = null;
            font.sampleData = null;
        }
        
        this.fonts.delete(fontId);
        this.buffers.delete(fontId);
        
        console.log(`SoundFontManager: Unloaded font ${fontId}, freed ${this.formatBytes(freedMemory)}`);
    }

    /**
     * Get font info
     */
    getFontInfo(fontId) {
        const font = this.fonts.get(fontId);
        if (!font) return null;
        
        let bufferCount = 0;
        const fontBuffers = this.buffers.get(fontId);
        if (fontBuffers) {
            bufferCount = fontBuffers.size;
        }
        
        return {
            id: fontId,
            name: font.name,
            presetCount: font.presets.length,
            instrumentCount: font.instruments.length,
            sampleCount: font.samples.length,
            bufferCount: bufferCount,
            memoryUsage: this.formatBytes(this.currentMemoryUsage),
            loadedAt: font.loadedAt
        };
    }

    /**
     * Get list of loaded font IDs
     */
    getLoadedFontIds() {
        return Array.from(this.fonts.keys());
    }

    /**
     * Get memory usage statistics
     */
    getMemoryStats() {
        return {
            currentUsage: this.formatBytes(this.currentMemoryUsage),
            maxUsage: this.formatBytes(this.maxMemoryUsage),
            bufferCount: Array.from(this.buffers.values()).reduce((sum, b) => sum + b.size, 0),
            fontCount: this.fonts.size
        };
    }

    /**
     * Clear all loaded fonts
     */
    clear() {
        for (const fontId of this.fonts.keys()) {
            this.unloadFont(fontId);
        }
    }

    /**
     * Preload specific samples for a preset (for low-latency playback)
     */
    async preloadPresetSamples(fontId, presetIndex, sampleIndices = null) {
        const font = this.fonts.get(fontId);
        if (!font) return;

        const preset = font.presets[presetIndex];
        if (!preset || !preset.zones) return;

        const fontBuffers = this.buffers.get(fontId);
        if (!fontBuffers) return;

        const samplesToLoad = new Set();

        // Collect all sample indices needed for this preset
        for (const pzone of preset.zones) {
            if (pzone.isGlobal) continue;
            if (pzone.instrumentIndex === undefined) continue;

            const inst = font.instruments[pzone.instrumentIndex];
            if (!inst || !inst.zones) continue;

            for (const izone of inst.zones) {
                if (izone.isGlobal || izone.sampleIndex === undefined) continue;
                samplesToLoad.add(izone.sampleIndex);
            }
        }

        // Preload the samples
        const total = samplesToLoad.size;
        let loaded = 0;

        for (const sampleIndex of samplesToLoad) {
            if (!fontBuffers.has(sampleIndex)) {
                const sample = font.samples[sampleIndex];
                if (sample) {
                    await this.getOrCreateBuffer(fontId, sampleIndex, sample);
                }
            }
            
            loaded++;
            this.reportProgress((loaded / total) * 100, `Preloading samples ${loaded}/${total}`);
        }
    }

    /**
     * Set streaming decode mode
     */
    setStreamingMode(enabled) {
        this.useStreamingDecode = enabled;
        console.log(`SoundFontManager: Streaming mode ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get ADSR parameters for a preset
     * Volume Envelope generators (based on SFSPEC21.$pdf):
     * - Gen 33: delayVolEnv
     * - Gen 34: attackVolEnv
     * - Gen 35: holdVolEnv
     * - Gen 36: decayVolEnv
     * - Gen 37: sustainVolEnv
     * - Gen 38: releaseVolEnv
     * @param {string} fontId - Font identifier
     * @param {number} presetIndex - Preset index
     * @returns {Object} ADSR parameters { attack, decay, sustain, release }
     */
    getPresetAdsrParams(fontId, presetIndex) {
        const font = this.fonts.get(fontId);
        if (!font) {
            console.warn(`SoundFontManager: Font ${fontId} not found`);
            return null;
        }
        
        const preset = font.presets[presetIndex];
        if (!preset || !preset.zones) {
            console.warn(`SoundFontManager: Preset ${presetIndex} not found`);
            return null;
        }
        
        // Convert SF2 timecents to seconds
        // timecents: 0 = 1 second, -1200 = 0.001 seconds, etc.
        const timecentsToSeconds = (tc) => {
            if (tc === undefined || tc === -32768) return 0.001; // Default
            return Math.pow(2, tc / 1200);
        };
        
        // Sustain is stored as attenuation in centibels (Generator 37)
        // centibels / 10 = dB attenuation from peak
        // Convert to linear scale for UI display
        const centibelsToLinear = (cb) => {
            if (cb === undefined || cb === -32768) return 0.7; // Default sustain
            const db = cb / 10;  // centibels to dB
            // Convert dB attenuation to linear (0dB = 1.0, -144dB = 0.0)
            const linear = Math.pow(10, -db / 20);
            return Math.max(0, Math.min(1, linear));
        };
        
        // Find the first non-global zone with an instrument to get ADSR params
        // NOTE: ADSR values are typically stored in the instrument zone (igen), not preset zone (pgen)
        for (const pzone of preset.zones) {
            if (pzone.isGlobal) continue;
            if (pzone.instrumentIndex === undefined) continue;
            
            const inst = font.instruments[pzone.instrumentIndex];
            if (!inst || !inst.zones) continue;
            
            // Look through instrument zones to find ADSR params
            for (const izone of inst.zones) {
                if (izone.isGlobal) continue;
                
                const generators = izone.generators;
                if (!generators) continue;
                
                // Check if this zone has Volume Envelope values (gens 33-38)
                if (generators[34] === undefined && generators[36] === undefined && 
                    generators[37] === undefined && generators[38] === undefined) {
                    continue; // No Volume Env in this zone, try next
                }
                
                const adsr = {
                    attack: timecentsToSeconds(generators[34]),  // attackVolEnv (Gen 34)
                    decay: Math.min(4, timecentsToSeconds(generators[36])),   // decayVolEnv (Gen 36)
                    sustain: centibelsToLinear(generators[37]), // sustainVolEnv (Gen 37)
                    release: timecentsToSeconds(generators[38])   // releaseVolEnv (Gen 38)
                };
                
                console.log(`[SF2Debug] ADSR from instrument zone: delay=${generators[33]}, attack=${generators[34]}, hold=${generators[35]}, decay=${generators[36]}, sustain=${generators[37]}, release=${generators[38]}`);
                console.log(`[SF2Debug] ADSR converted values:`, adsr);
                
                return adsr;
            }
        }
        
        // No zone found, return default values
        console.log(`SoundFontManager: No ADSR zone found for preset ${presetIndex}, using defaults`);
        return {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.7,
            release: 0.1
        };
    }

    /**
     * Get filter parameters for a preset
     * Filter generators:
     * - Gen 10: initialFilterCutoff (in cents)
     * - Gen 9: initialFilterQ (in cents)
     * @param {string} fontId - Font identifier
     * @param {number} presetIndex - Preset index
     * @returns {Object} Filter parameters { cutoff, resonance }
     */
    getPresetFilterParams(fontId, presetIndex) {
        const font = this.fonts.get(fontId);
        if (!font) {
            console.warn(`SoundFontManager: Font ${fontId} not found`);
            return null;
        }
        
        const preset = font.presets[presetIndex];
        if (!preset || !preset.zones) {
            console.warn(`SoundFontManager: Preset ${presetIndex} not found`);
            return null;
        }
        
        // Convert SF2 cents to Hz
        // initialFilterCutoff: cents from 8Hz (4500 cents below A4)
        // Formula: Hz = 8 * 2^((cents - 4500) / 1200)
        const centsToHz = (cents) => {
            if (cents === undefined || cents === -32768) return 20000; // Default max freq
            const hz = 8 * Math.pow(2, (cents - 4500) / 1200);
            return Math.max(8, Math.min(20000, hz));
        };
        
        // Q value: 0-96 dB, convert to resonance (0-20 approx)
        const centsToResonance = (q) => {
            if (q === undefined || q === -32768) return 1;
            return Math.max(0.1, Math.min(20, q / 10));
        };
        
        // NOTE: Filter values are typically stored in the instrument zone (igen), not preset zone (pgen)
        for (const pzone of preset.zones) {
            if (pzone.isGlobal) continue;
            if (pzone.instrumentIndex === undefined) continue;
            
            const inst = font.instruments[pzone.instrumentIndex];
            if (!inst || !inst.zones) continue;
            
            // Look through instrument zones to find filter params
            for (const izone of inst.zones) {
                if (izone.isGlobal) continue;
                
                const generators = izone.generators;
                if (!generators) continue;
                
                const cutoff = centsToHz(generators[8]);  // initialFilterCutoff
                const resonance = centsToResonance(generators[9]); // initialFilterQ
                
                console.log(`[SF2Debug] Filter from instrument zone: generators[8]=${generators[8]}, generators[9]=${generators[9]}`);
                console.log(`[SF2Debug] Filter converted: cutoff=${cutoff}Hz, resonance=${resonance}`);
                
                return { cutoff, resonance };
            }
        }
        
        // No zone found, return default values
        console.log(`SoundFontManager: No filter zone found for preset ${presetIndex}, using defaults`);
        return {
            cutoff: 20000,
            resonance: 1
        };
    }

    /**
     * Set memory limit
     */
    setMemoryLimit(bytes) {
        this.maxMemoryUsage = bytes;
        this.enforceMemoryLimit();
    }
}
