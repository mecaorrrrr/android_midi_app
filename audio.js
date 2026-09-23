import { WorkletSynthesizer } from './vendor/spessasynth/spessasynth_lib.min.js';
import { DEFAULT_TONE } from './song.js';

const TRACK_COUNT = 8;
const PROCESSOR_URL = new URL('./vendor/spessasynth/spessasynth_processor.min.js', import.meta.url);

// MIDI CC numbers
const CC_BANK_MSB = 0;
const CC_DATA_ENTRY_MSB = 6;
const CC_VOLUME = 7;
const CC_PAN = 10;
const CC_BANK_LSB = 32;
const CC_DATA_ENTRY_LSB = 38;
const CC_RESONANCE = 71;
const CC_RELEASE = 72;
const CC_ATTACK = 73;
const CC_CUTOFF = 74;
const CC_DECAY = 75;
const CC_REVERB = 91;
const CC_CHORUS = 93;
const CC_DELAY = 94;
const CC_NRPN_LSB = 98;
const CC_NRPN_MSB = 99;
const CC_RPN_LSB = 100;
const CC_RPN_MSB = 101;

const NRPN_SF2 = 120;            // SoundFont 2.01 NRPN: per-channel generator offsets
const GEN_SUSTAIN_VOL_ENV = 37;  // sustainVolEnv (attenuation in centibels)
const SUSTAIN_CB_PER_STEP = 15;  // Tone sustain -64..63 -> about +-96 dB
const RPN_FINE_TUNING = 1;
const RPN_COARSE_TUNING = 2;

/**
 * MIDI messages (channel-less [controller, value] pairs) that apply a track tone.
 * Shared by the live synth and the MIDI file export so both sound the same.
 */
export function toneControllerMessages(tone) {
    const t = { ...DEFAULT_TONE, ...tone };
    const rel = (v) => clamp7(64 + Math.round(v));
    const param = (msbCC, lsbCC, msb, lsb, value14) => [
        [msbCC, msb], [lsbCC, lsb],
        [CC_DATA_ENTRY_MSB, (value14 >> 7) & 127], [CC_DATA_ENTRY_LSB, value14 & 127]
    ];
    const clamp14 = (v) => Math.max(0, Math.min(16383, Math.round(v)));
    return [
        [CC_ATTACK, rel(t.attack)],
        [CC_DECAY, rel(t.decay)],
        [CC_RELEASE, rel(t.release)],
        [CC_CUTOFF, rel(t.cutoff)],
        [CC_RESONANCE, rel(t.resonance)],
        [CC_REVERB, clamp7(t.reverb)],
        [CC_CHORUS, clamp7(t.chorus)],
        [CC_DELAY, clamp7(t.delay)],
        ...param(CC_NRPN_MSB, CC_NRPN_LSB, NRPN_SF2, GEN_SUSTAIN_VOL_ENV, 8192 - t.sustain * SUSTAIN_CB_PER_STEP),
        ...param(CC_RPN_MSB, CC_RPN_LSB, 0, RPN_COARSE_TUNING, (64 + t.transpose) << 7),
        ...param(CC_RPN_MSB, CC_RPN_LSB, 0, RPN_FINE_TUNING, clamp14(8192 + t.fine * 81.92)),
        [CC_RPN_MSB, 127], [CC_RPN_LSB, 127] // RPN null
    ];
}

// Envelope used by the sine-wave fallback (seconds / 0..1 level)
const OSC_ENVELOPE = { delay: 0, attack: 0.005, hold: 0, decay: 0.3, sustain: 0.6, release: 0.15 };

/**
 * Audio engine.
 * - SF2/SF3/DLS: rendered by spessasynth (AudioWorklet), which implements the full
 *   SoundFont spec (volume/modulation envelopes, filters, LFOs, modulators, effects).
 *   Track N is played on MIDI channel N.
 * - SFZ: small built-in sampler (Web Audio) with ampeg_* envelope support.
 * - No sound bank: sine-wave fallback.
 * All note playback goes through playNoteAt() with AudioContext timestamps.
 */
export class AudioManager {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.trackChannels = []; // Web Audio path (SFZ / oscillator): { gain, panner }

        this.synth = null;        // spessasynth WorkletSynthesizer
        this.synthReady = null;   // Promise resolved once the worklet is running
        this.presets = [];        // Normalized preset list of the loaded sound bank
        this.pendingNoteOns = []; // Future noteOns queued in the synth (to cancel on stop)

        this.regions = []; // SFZ regions
        this.buffers = {}; // SFZ sample path -> AudioBuffer
        this.voices = new Set(); // Active Web Audio voices: { source, gain }

        this.trackMix = Array.from({ length: TRACK_COUNT }, () => ({ volume: 0.8, pan: 0 }));
        this.trackTones = Array.from({ length: TRACK_COUNT }, () => ({ ...DEFAULT_TONE }));
        this.trackInstruments = Array.from({ length: TRACK_COUNT }, () => ({
            bank: 0,
            program: 0,
            presetIndex: 0
        }));
        this.mode = 'oscillator'; // 'oscillator', 'sfz', 'sf2'
    }

    init() {
        if (this.ctx) return;

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.8;
        this.masterGain.connect(this.ctx.destination);

        for (let i = 0; i < TRACK_COUNT; i++) {
            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            gain.connect(panner);
            panner.connect(this.masterGain);
            gain.gain.value = this.trackMix[i].volume;
            panner.pan.value = this.trackMix[i].pan;
            this.trackChannels.push({ gain, panner });
        }

        this.synthReady = this.initSynth().catch(e => {
            console.error('AudioManager: failed to start spessasynth', e);
            this.synth = null;
        });

        console.log('AudioManager initialized');
    }

    async initSynth() {
        await this.ctx.audioWorklet.addModule(PROCESSOR_URL);
        const synth = new WorkletSynthesizer(this.ctx);
        synth.connect(this.masterGain);
        await synth.isReady;
        synth.setLogLevel(false, true, false);
        this.synth = synth;
        for (let i = 0; i < TRACK_COUNT; i++) {
            this.applyTrackMix(i);
            this.applyTone(i);
        }
    }

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    // ---------------------------------------------------------------- Mixer

    setTrackVolume(trackId, volume) {
        if (!this.trackMix[trackId]) return;
        this.trackMix[trackId].volume = volume;
        this.applyTrackMix(trackId);
    }

    setTrackPan(trackId, pan) {
        if (!this.trackMix[trackId]) return;
        this.trackMix[trackId].pan = pan;
        this.applyTrackMix(trackId);
    }

    applyTrackMix(trackId) {
        const { volume, pan } = this.trackMix[trackId];
        const channel = this.trackChannels[trackId];
        if (channel) {
            channel.gain.gain.setValueAtTime(volume, this.ctx.currentTime);
            channel.panner.pan.setValueAtTime(pan, this.ctx.currentTime);
        }
        if (this.synth) {
            this.synth.controllerChange(trackId, CC_VOLUME, clamp7(Math.round(volume * 127)));
            this.synth.controllerChange(trackId, CC_PAN, clamp7(Math.round((pan + 1) * 64)));
        }
    }

    // ----------------------------------------------------------------- Tone

    setTrackTone(trackId, tone) {
        if (!this.trackTones[trackId]) return;
        this.trackTones[trackId] = { ...DEFAULT_TONE, ...tone };
        this.applyTone(trackId);
    }

    applyTone(trackId) {
        if (!this.synth) return;
        for (const [cc, value] of toneControllerMessages(this.trackTones[trackId])) {
            this.synth.controllerChange(trackId, cc, value);
        }
    }

    // ---------------------------------------------------------- Instruments

    async loadSF2(file) {
        this.init();
        this.resume();
        await this.synthReady;
        if (!this.synth) return false;

        try {
            const buffer = await file.arrayBuffer();
            const presetsChanged = new Promise(resolve => {
                this.synth.eventHandler.addEvent('presetListChange', 'audio-manager-load', resolve);
                setTimeout(resolve, 3000); // Fall back to synth.presetList if the event never fires
            });
            await this.synth.soundBankManager.addSoundBank(buffer, 'main');
            await presetsChanged;
            this.synth.eventHandler.removeEvent('presetListChange', 'audio-manager-load');

            this.presets = this.synth.presetList.map((p, index) => {
                const bank = p.isDrum ? 128 : p.bankMSB;
                return {
                    index,
                    name: p.name,
                    bank,
                    bankLSB: p.bankLSB,
                    preset: p.program,
                    isDrum: p.isDrum,
                    fullName: `${bank}:${p.program} ${p.name}`
                };
            });
            if (this.presets.length === 0) return false;

            console.log(`Loaded sound bank: ${this.presets.length} presets`);
            this.mode = 'sf2';
            for (let i = 0; i < TRACK_COUNT; i++) {
                this.trackInstruments[i] = { bank: this.presets[0].bank, program: this.presets[0].preset, presetIndex: 0 };
                this.applyInstrument(i);
                this.applyTone(i);
            }
            return true;
        } catch (e) {
            console.error('Failed to load SF2:', e);
            return false;
        }
    }

    hasSoundBank() {
        return this.mode === 'sf2' && this.presets.length > 0;
    }

    getPresets() {
        return this.presets;
    }

    setTrackInstrument(trackId, bank, program, presetIndex = -1) {
        if (trackId < 0 || trackId >= TRACK_COUNT) {
            console.warn('AudioManager: Invalid trackId for instrument set:', trackId);
            return;
        }
        this.trackInstruments[trackId] = { bank, program, presetIndex };
        this.applyInstrument(trackId);
    }

    selectPreset(trackId, presetIndex) {
        const preset = this.presets[presetIndex];
        if (!preset) {
            console.warn('Invalid preset index:', presetIndex);
            return;
        }
        this.setTrackInstrument(trackId, preset.bank, preset.preset, presetIndex);
    }

    // Send bank select / program change for a track to the synth
    applyInstrument(trackId) {
        if (!this.synth || !this.hasSoundBank()) return;
        const inst = this.trackInstruments[trackId];
        let preset = this.presets[inst.presetIndex];
        if (!preset || preset.bank !== inst.bank || preset.preset !== inst.program) {
            preset = this.presets.find(p => p.bank === inst.bank && p.preset === inst.program) || preset || this.presets[0];
        }

        const channel = this.synth.midiChannels[trackId];
        channel.setDrums(preset.isDrum);
        if (!preset.isDrum) {
            this.synth.controllerChange(trackId, CC_BANK_MSB, preset.bank);
            this.synth.controllerChange(trackId, CC_BANK_LSB, preset.bankLSB);
        }
        this.synth.programChange(trackId, preset.preset);
    }

    // ------------------------------------------------------------- Playback

    // Preview a note right now (duration in seconds)
    playNote(midi, duration = 1.0, trackId = 0, velocity = 100) {
        if (!this.ctx) return;
        this.resume();
        const now = this.ctx.currentTime;
        this.playNoteAt(trackId, midi, velocity, now, now + duration);
    }

    // Play a note between two AudioContext timestamps
    playNoteAt(trackId, midi, velocity, startTime, endTime) {
        if (!this.ctx) return;
        velocity = Math.max(1, clamp7(Math.round(velocity)));

        if (this.hasSoundBank() && this.synth) {
            const now = this.ctx.currentTime;
            this.synth.noteOn(trackId, midi, velocity, { time: startTime });
            this.synth.noteOff(trackId, midi, { time: endTime });
            this.pendingNoteOns = this.pendingNoteOns.filter(n => n.time > now);
            if (startTime > now) this.pendingNoteOns.push({ trackId, midi, time: startTime });
        } else if (this.mode === 'sfz' && this.regions.length > 0) {
            this.playSFZNote(trackId, midi, velocity, startTime, endTime);
        } else {
            this.playOscillator(trackId, midi, velocity, startTime, endTime);
        }
    }

    // Silence everything, including notes already queued for the future
    stopAll() {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;

        if (this.synth) {
            // Queued synth events cannot be removed, so pair each future noteOn with a noteOff at the same time
            for (const n of this.pendingNoteOns) {
                if (n.time > now) this.synth.noteOff(n.trackId, n.midi, { time: n.time });
            }
            this.pendingNoteOns = [];
            this.synth.stopAll();
        }

        for (const voice of this.voices) {
            const g = voice.gain.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0, now + 0.03);
            try { voice.source.stop(now + 0.05); } catch (e) { /* already stopped */ }
        }
        this.voices.clear();
    }

    playOscillator(trackId, midi, velocity, startTime, endTime) {
        const tone = this.trackTones[trackId];
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = midiToFreq(midi);
        osc.detune.value = tone.transpose * 100 + tone.fine;
        const peak = (velocity / 127) * 0.4;
        this.startVoice(osc, trackId, peak, applyToneToEnvelope(OSC_ENVELOPE, tone), startTime, endTime);
    }

    // Connect a source through an ADSR gain to the track and schedule start/stop
    startVoice(source, trackId, peak, env, startTime, endTime) {
        const gain = this.ctx.createGain();
        const stopTime = scheduleEnvelope(gain.gain, peak, env, startTime, endTime);

        source.connect(gain);
        const channel = this.trackChannels[trackId];
        gain.connect(channel ? channel.gain : this.masterGain);

        const voice = { source, gain };
        this.voices.add(voice);
        source.onended = () => {
            this.voices.delete(voice);
            gain.disconnect();
        };
        source.start(startTime);
        source.stop(stopTime + 0.02);
    }

    // ------------------------------------------------------------------ SFZ

    async loadSFZ(fileList) {
        this.init();
        this.resume();

        this.regions = [];
        this.buffers = {};

        let sfzFile = null;
        const assetFiles = {}; // lowercase file name -> File

        for (const f of fileList) {
            if (f.name.toLowerCase().endsWith('.sfz')) {
                sfzFile = f;
            } else {
                assetFiles[f.name.toLowerCase()] = f;
            }
        }

        if (!sfzFile) {
            console.error('No .sfz file found in selection');
            return false;
        }

        console.log('Parsing SFZ:', sfzFile.name);
        this.parseSFZ(await sfzFile.text());
        console.log(`Parsed ${this.regions.length} regions. Loading samples...`);

        const baseName = (path) => path.split(/[\\/]/).pop().toLowerCase();
        for (const region of this.regions) {
            if (!region.sample) continue;
            const file = assetFiles[baseName(region.sample)];
            if (this.buffers[region.sample] || !file) continue;
            try {
                this.buffers[region.sample] = await this.ctx.decodeAudioData(await file.arrayBuffer());
            } catch (e) {
                console.error('Failed to load sample:', region.sample, e);
            }
        }

        console.log('Loaded samples:', Object.keys(this.buffers).length);
        this.mode = 'sfz';
        this.presets = [];
        return true;
    }

    // Opcodes inherit <global> -> <master> -> <group> -> <region>
    parseSFZ(text) {
        text = text.replace(/\/\/[^\n]*/g, '');
        const scopes = { global: {}, master: {}, group: {}, control: {} };
        let current = null;

        const parts = text.split(/<(\w+)>/);
        // parts: [before, header1, body1, header2, body2, ...]
        for (let i = 1; i < parts.length; i += 2) {
            const header = parts[i].toLowerCase();
            const body = parts[i + 1] || '';

            if (header === 'region') {
                current = { ...scopes.global, ...scopes.master, ...scopes.group };
                this.parseOpCodes(body, current);
                if (current.sample && scopes.control.default_path) {
                    current.sample = scopes.control.default_path + current.sample;
                }
                this.regions.push(current);
                continue;
            }

            if (header in scopes) {
                scopes[header] = {};
                if (header === 'global') { scopes.master = {}; scopes.group = {}; }
                if (header === 'master') scopes.group = {};
                this.parseOpCodes(body, scopes[header]);
            }
        }
    }

    parseOpCodes(text, targetObj) {
        // Values may contain spaces (e.g. sample paths), so a value runs until the next "opcode="
        const regex = /([a-zA-Z0-9_]+)=(.*?)(?=\s+[a-zA-Z0-9_]+=|\s*$)/gs;
        let match;
        while ((match = regex.exec(text.trim())) !== null) {
            const key = match[1];
            let val = match[2].trim();

            if (key === 'sample' || key === 'default_path') {
                targetObj[key] = val.replace(/\\/g, '/');
            } else if (['key', 'lokey', 'hikey', 'pitch_keycenter'].includes(key)) {
                targetObj[key] = noteNameToMidi(val);
            } else if (val !== '' && !isNaN(val)) {
                targetObj[key] = parseFloat(val);
            } else {
                targetObj[key] = val;
            }
        }
    }

    playSFZNote(trackId, midi, velocity, startTime, endTime) {
        const region = this.regions.find(r => {
            const key = r.key !== undefined ? r.key : -1;
            const lokey = r.lokey !== undefined ? r.lokey : (key !== -1 ? key : 0);
            const hikey = r.hikey !== undefined ? r.hikey : (key !== -1 ? key : 127);
            const lovel = r.lovel !== undefined ? r.lovel : 1;
            const hivel = r.hivel !== undefined ? r.hivel : 127;
            return midi >= lokey && midi <= hikey && velocity >= lovel && velocity <= hivel
                && r.sample && this.buffers[r.sample];
        });

        if (!region) {
            console.warn('No SFZ region found for note', midi);
            return;
        }

        const buffer = this.buffers[region.sample];
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;

        const rootKey = region.pitch_keycenter !== undefined ? region.pitch_keycenter
            : (region.key !== undefined ? region.key : 60);
        const keytrack = region.pitch_keytrack !== undefined ? region.pitch_keytrack : 100;
        const tone = this.trackTones[trackId];
        source.detune.value = (midi - rootKey) * keytrack
            + (region.transpose || 0) * 100 + (region.tune || 0)
            + tone.transpose * 100 + tone.fine;

        const loopMode = region.loop_mode || (region.loop_start !== undefined ? 'loop_continuous' : 'no_loop');
        if (loopMode === 'loop_continuous' || loopMode === 'loop_sustain') {
            const sr = buffer.sampleRate;
            const loopStart = region.loop_start !== undefined ? region.loop_start : 0;
            const loopEnd = region.loop_end !== undefined ? region.loop_end : buffer.length - 1;
            if (loopEnd > loopStart) {
                source.loop = true;
                source.loopStart = loopStart / sr;
                source.loopEnd = (loopEnd + 1) / sr;
            }
        }

        // amp_veltrack (default 100%) scales the velocity curve; volume is in dB
        const veltrack = (region.amp_veltrack !== undefined ? region.amp_veltrack : 100) / 100;
        const velGain = 1 - veltrack + veltrack * (velocity / 127) ** 2;
        const peak = velGain * dbToGain(region.volume || 0);

        const env = applyToneToEnvelope({
            delay: region.ampeg_delay || 0,
            attack: region.ampeg_attack || 0.001,
            hold: region.ampeg_hold || 0,
            decay: region.ampeg_decay || 0,
            sustain: region.ampeg_sustain !== undefined ? region.ampeg_sustain / 100 : 1,
            release: Math.max(region.ampeg_release || 0.01, 0.01)
        }, tone);

        // one_shot plays the whole sample regardless of note length
        if (loopMode === 'one_shot') {
            endTime = Math.max(endTime, startTime + buffer.duration / source.playbackRate.value / 2 ** (source.detune.value / 1200));
        }
        this.startVoice(source, trackId, peak, env, startTime, endTime);
    }
}

// Relative tone edits for the Web Audio path: +-64 scales times by up to x8 / /8
function applyToneToEnvelope(env, tone) {
    const scale = (v) => Math.pow(2, v / 21);
    return {
        ...env,
        attack: Math.max(0.001, env.attack * scale(tone.attack)),
        decay: env.decay * scale(tone.decay),
        sustain: Math.max(0, Math.min(1, env.sustain + tone.sustain / 64)),
        release: Math.max(0.01, env.release * scale(tone.release))
    };
}

/**
 * Schedules a DAHDSR envelope on an AudioParam for a note held from startTime to
 * endTime. The release starts from the level actually reached at endTime (so short
 * notes do not jump), and the note rings for `release` seconds after endTime.
 * Returns the time at which the envelope reaches silence.
 */
function scheduleEnvelope(param, peak, env, startTime, endTime) {
    const attackStart = startTime + env.delay;
    const attackEnd = attackStart + env.attack;
    const holdEnd = attackEnd + env.hold;
    const sustainLevel = peak * env.sustain;
    const decayTau = Math.max(env.decay, 0.001) / 4; // ~98% of the way to sustain after `decay` seconds

    param.setValueAtTime(0, startTime);

    let levelAtEnd;
    if (endTime <= attackStart) {
        levelAtEnd = 0;
    } else if (endTime <= attackEnd) {
        levelAtEnd = peak * (endTime - attackStart) / env.attack;
        param.setValueAtTime(0, attackStart);
        param.linearRampToValueAtTime(levelAtEnd, endTime);
    } else {
        param.setValueAtTime(0, attackStart);
        param.linearRampToValueAtTime(peak, attackEnd);
        if (endTime <= holdEnd) {
            levelAtEnd = peak;
        } else {
            param.setValueAtTime(peak, holdEnd);
            param.setTargetAtTime(sustainLevel, holdEnd, decayTau);
            levelAtEnd = sustainLevel + (peak - sustainLevel) * Math.exp(-(endTime - holdEnd) / decayTau);
        }
    }

    param.setValueAtTime(levelAtEnd, endTime);
    param.linearRampToValueAtTime(0, endTime + env.release);
    return endTime + env.release;
}

function noteNameToMidi(str) {
    // Handles both numbers and note names like C4, D#5, Eb3
    if (!isNaN(str)) return parseInt(str);

    const match = str.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) return parseInt(str) || 60;

    const noteMap = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    let midi = noteMap[match[1].toUpperCase()] + (parseInt(match[3]) + 1) * 12;
    if (match[2] === '#') midi += 1;
    if (match[2] === 'b') midi -= 1;
    return midi;
}

function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
}

function dbToGain(db) {
    return Math.pow(10, db / 20);
}

function clamp7(v) {
    return Math.max(0, Math.min(127, v));
}
