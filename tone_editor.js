import { DEFAULT_TONE } from './song.js';

// Controls of the editor. Envelope/filter are relative to the preset (0 = preset as is).
const PARAMS = {
    attack:    { label: 'A', min: -64, max: 63, format: signed },
    decay:     { label: 'D', min: -64, max: 63, format: signed },
    sustain:   { label: 'S', min: -64, max: 63, format: signed },
    release:   { label: 'R', min: -64, max: 63, format: signed },
    cutoff:    { label: 'Cutoff', min: -64, max: 63, format: signed, knob: 'bipolar' },
    resonance: { label: 'Resonance', min: -64, max: 63, format: signed, knob: 'bipolar' },
    transpose: { label: 'Transpose', min: -24, max: 24, format: signed },
    fine:      { label: 'Fine (cent)', min: -100, max: 100, format: signed },
    delay:     { label: 'Delay', min: 0, max: 127, format: String, knob: 'unipolar' },
    chorus:    { label: 'Chorus', min: 0, max: 127, format: String, knob: 'unipolar' },
    reverb:    { label: 'Reverb', min: 0, max: 127, format: String, knob: 'unipolar' }
};

const ENVELOPE_KEYS = ['attack', 'decay', 'sustain', 'release'];
const FAST_STEP = 8;
const DRAG_PIXELS_PER_STEP = 3;

function signed(v) {
    return v > 0 ? `+${v}` : String(v);
}

/**
 * Per-track tone editor (modal). Gamepad:
 *   D-pad            move between controls
 *   A + D-pad        change value (R2: fast)
 *   Y                reset control      X  preview note
 *   L1 / R1          previous / next track
 *   B / START        close
 * Mouse: drag up/down or wheel on a control, double click resets.
 */
export class ToneEditor {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('tone-modal');
        this.trackId = 0;
        this.focusKey = 'instrument';
        this.presetOptionsKey = null;
        this.editUndoSaved = false;
        this.buildDom();
    }

    get isOpen() {
        return this.modal.classList.contains('open');
    }

    get tone() {
        return this.app.songData.tracks[this.trackId].tone;
    }

    open(trackId = this.app.currentTrackId) {
        this.trackId = trackId;
        this.modal.classList.add('open');
        this.render();
    }

    close() {
        this.modal.classList.remove('open');
    }

    // ----------------------------------------------------------------- DOM

    buildDom() {
        const knob = (key) => `
            <div class="tone-control" data-key="${key}">
                <svg class="knob" viewBox="0 0 80 80" data-knob="${key}"></svg>
                <span class="tone-value" data-value="${key}"></span>
                <span class="tone-label">${PARAMS[key].label}</span>
            </div>`;
        const number = (key) => `
            <div class="tone-control" data-key="${key}">
                <span class="tone-number" data-value="${key}"></span>
                <span class="tone-label">${PARAMS[key].label}</span>
            </div>`;

        this.modal.querySelector('.tone-body').innerHTML = `
            <section class="tone-section tone-instrument">
                <div class="tone-control instrument" data-key="instrument">
                    <span class="tone-label">Instrument</span>
                    <div class="inst-row">
                        <button class="btn icon small" data-inst-prev title="Previous instrument">◀</button>
                        <div class="inst-name-wrap">
                            <b class="inst-name"></b>
                            <span class="inst-sub"></span>
                            <select class="inst-select" title="Choose an instrument"></select>
                        </div>
                        <button class="btn icon small" data-inst-next title="Next instrument">▶</button>
                    </div>
                </div>
            </section>
            <section class="tone-section">
                <h3>Amp Envelope</h3>
                <svg class="env-graph" viewBox="0 0 240 100" preserveAspectRatio="none"></svg>
                <div class="env-controls">
                    ${ENVELOPE_KEYS.map(key => `
                        <div class="tone-control env-control" data-key="${key}">
                            <span class="tone-label">${PARAMS[key].label}</span>
                            <span class="tone-value" data-value="${key}"></span>
                        </div>`).join('')}
                </div>
            </section>
            <section class="tone-section">
                <h3>Filter</h3>
                <div class="tone-controls">${knob('cutoff')}${knob('resonance')}</div>
            </section>
            <section class="tone-section">
                <h3>Tune</h3>
                <div class="tone-controls">${number('transpose')}${number('fine')}</div>
            </section>
            <section class="tone-section">
                <h3>Effects</h3>
                <div class="tone-controls">${knob('delay')}${knob('chorus')}${knob('reverb')}</div>
            </section>`;

        this.modal.querySelectorAll('.tone-control:not(.instrument)').forEach(el => this.bindMouse(el));
        this.bindInstrument();
        this.modal.querySelector('[data-tone-close]').addEventListener('click', () => this.close());
        this.modal.querySelector('[data-tone-reset-all]').addEventListener('click', () => this.resetAll());
        this.modal.querySelector('[data-tone-preview]').addEventListener('click', () => this.preview());
        this.modal.querySelector('[data-tone-prev]').addEventListener('click', () => this.switchTrack(-1));
        this.modal.querySelector('[data-tone-next]').addEventListener('click', () => this.switchTrack(1));
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });
    }

    bindInstrument() {
        const control = this.modal.querySelector('.tone-control.instrument');
        control.addEventListener('pointerdown', () => {
            this.focusKey = 'instrument';
            this.editUndoSaved = false;
            this.render();
        });
        control.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.change('instrument', e.deltaY < 0 ? -1 : 1);
        }, { passive: false });
        this.modal.querySelector('[data-inst-prev]').addEventListener('click', () => this.change('instrument', -1));
        this.modal.querySelector('[data-inst-next]').addEventListener('click', () => this.change('instrument', 1));
        this.modal.querySelector('.inst-select').addEventListener('change', (e) => {
            const index = parseInt(e.target.value);
            if (isNaN(index)) return;
            this.app.saveState();
            this.app.setTrackPreset(this.trackId, index);
            this.render();
        });
    }

    // Presets in bank / program order (the order used for stepping)
    sortedPresets() {
        return [...this.app.audio.getPresets()].sort((a, b) => a.bank - b.bank || a.preset - b.preset);
    }

    changeInstrument(delta) {
        const presets = this.sortedPresets();
        if (presets.length === 0) return;
        const track = this.app.songData.tracks[this.trackId];
        let pos = presets.findIndex(p => p.index === track.presetIndex);
        if (pos < 0) pos = presets.findIndex(p => p.bank === track.bank && p.preset === track.program);
        const next = Math.max(0, Math.min(presets.length - 1, pos + delta));
        if (next === pos) return;
        if (!this.editUndoSaved) {
            this.app.saveState();
            this.editUndoSaved = true;
        }
        this.app.setTrackPreset(this.trackId, presets[next].index);
        this.render();
    }

    renderInstrument(track) {
        const hasBank = this.app.audio.hasSoundBank();
        const presets = this.sortedPresets();
        const select = this.modal.querySelector('.inst-select');

        this.modal.querySelector('.inst-name').textContent = this.app.getInstrumentName(track);
        this.modal.querySelector('.inst-sub').textContent = hasBank
            ? `Bank ${track.bank}, program ${track.program}`
            : 'Load a SoundFont from File to change instruments';
        this.modal.querySelectorAll('[data-inst-prev], [data-inst-next]').forEach(b => { b.disabled = !hasBank; });
        select.disabled = !hasBank;

        // Rebuild the list only when the sound bank changes
        const key = presets.map(p => p.index).join(',');
        if (key !== this.presetOptionsKey) {
            this.presetOptionsKey = key;
            select.replaceChildren(...presets.map(p => new Option(`${p.bank}:${p.preset} ${p.name}`, String(p.index))));
        }
        if (hasBank) select.value = String(track.presetIndex);
    }

    bindMouse(el) {
        const key = el.dataset.key;
        let dragY = null;
        let accumulated = 0;

        el.addEventListener('pointerdown', (e) => {
            this.focusKey = key;
            this.editUndoSaved = false;
            dragY = e.clientY;
            accumulated = 0;
            el.setPointerCapture(e.pointerId);
            this.render();
        });
        el.addEventListener('pointermove', (e) => {
            if (dragY === null) return;
            accumulated += dragY - e.clientY;
            dragY = e.clientY;
            const steps = Math.trunc(accumulated / DRAG_PIXELS_PER_STEP);
            if (steps !== 0) {
                accumulated -= steps * DRAG_PIXELS_PER_STEP;
                this.change(key, steps);
            }
        });
        const end = () => { dragY = null; };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.focusKey = key;
            this.editUndoSaved = false;
            this.change(key, e.deltaY < 0 ? 1 : -1);
        }, { passive: false });
        el.addEventListener('dblclick', () => this.reset(key));
    }

    // -------------------------------------------------------------- Values

    change(key, delta) {
        if (key === 'instrument') {
            this.changeInstrument(delta);
            return;
        }
        const p = PARAMS[key];
        const value = Math.max(p.min, Math.min(p.max, this.tone[key] + delta));
        if (value === this.tone[key]) return;
        if (!this.editUndoSaved) {
            this.app.saveState();
            this.editUndoSaved = true;
        }
        this.tone[key] = value;
        this.apply();
    }

    reset(key) {
        if (key === 'instrument' || this.tone[key] === DEFAULT_TONE[key]) return;
        this.app.saveState();
        this.tone[key] = DEFAULT_TONE[key];
        this.apply();
    }

    resetAll() {
        this.app.saveState();
        Object.assign(this.tone, DEFAULT_TONE);
        this.apply();
    }

    apply() {
        this.app.audio.setTrackTone(this.trackId, this.tone);
        this.render();
    }

    preview() {
        const pitch = this.app.view === 'pattern' ? this.app.input.state.cursor.pitch : 60;
        this.app.audio.init();
        this.app.audio.resume();
        this.app.audio.playNote(pitch, 0.8, this.trackId, 100);
    }

    switchTrack(delta) {
        const count = this.app.songData.tracks.length;
        this.trackId = (this.trackId + delta + count) % count;
        this.editUndoSaved = false;
        this.render();
    }

    // ------------------------------------------------------------- Gamepad

    // Called every frame while open. `edge(name)` = pressed this frame, `held(name)` = held.
    handleGamepad(edge, held, dx, dy) {
        if (edge('B') || edge('START')) {
            this.close();
            return;
        }
        if (edge('X')) this.preview();
        if (edge('Y')) this.reset(this.focusKey);
        if (edge('L1')) this.switchTrack(-1);
        if (edge('R1')) this.switchTrack(1);
        if (edge('A')) this.editUndoSaved = false;

        const input = this.app.input;
        if (held('A')) {
            // Right / Up increase
            const dir = dx !== 0 ? dx : dy;
            const step = held('R2') ? FAST_STEP : 1;
            input.repeatAction('tone_value', dir, () => this.change(this.focusKey, dir * step), 250, 40);
            delete input.repeatTimers.tone_focus_x;
            delete input.repeatTimers.tone_focus_y;
        } else {
            delete input.repeatTimers.tone_value;
            input.repeatAction('tone_focus_x', dx, () => this.moveFocus(dx, 0), 250, 150);
            input.repeatAction('tone_focus_y', dy, () => this.moveFocus(0, -dy), 250, 150);
        }
    }

    // Move focus to the nearest control in a screen direction
    moveFocus(dx, dy) {
        const controls = [...this.modal.querySelectorAll('.tone-control')];
        const center = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        const current = center(controls.find(el => el.dataset.key === this.focusKey));
        let best = null;
        let bestScore = Infinity;
        for (const el of controls) {
            const c = center(el);
            const along = (c.x - current.x) * dx + (c.y - current.y) * dy;
            if (along <= 1) continue;
            const across = Math.abs((c.x - current.x) * dy) + Math.abs((c.y - current.y) * dx);
            const score = along + across * 2;
            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        }
        if (best) {
            this.focusKey = best.dataset.key;
            this.render();
        }
    }

    // --------------------------------------------------------------- Render

    render() {
        const track = this.app.songData.tracks[this.trackId];
        const tone = this.tone;

        this.modal.querySelector('.tone-track-name').textContent =
            `T${this.trackId + 1}  ${track.name}, ${this.app.getInstrumentName(track)}`;

        for (const el of this.modal.querySelectorAll('.tone-control')) {
            const key = el.dataset.key;
            el.classList.toggle('focused', key === this.focusKey);
            el.classList.toggle('modified', key in DEFAULT_TONE && tone[key] !== DEFAULT_TONE[key]);
        }
        this.renderInstrument(track);
        for (const el of this.modal.querySelectorAll('[data-value]')) {
            const key = el.dataset.value;
            el.textContent = PARAMS[key].format(tone[key]);
        }
        for (const svg of this.modal.querySelectorAll('[data-knob]')) {
            svg.innerHTML = knobSvg(PARAMS[svg.dataset.knob], tone[svg.dataset.knob]);
        }
        this.modal.querySelector('.env-graph').innerHTML =
            envelopeSvg(tone, ENVELOPE_KEYS.includes(this.focusKey) ? this.focusKey : null);
    }
}

// ------------------------------------------------------------- SVG helpers

const KNOB_START = 135; // degrees, 0 = 3 o'clock, clockwise
const KNOB_SWEEP = 270;

function polar(cx, cy, r, deg) {
    const rad = deg * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, from, to) {
    if (Math.abs(to - from) < 0.01) return '';
    const [a, b] = from < to ? [from, to] : [to, from];
    const [x0, y0] = polar(cx, cy, r, a);
    const [x1, y1] = polar(cx, cy, r, b);
    const large = b - a > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function knobSvg(param, value) {
    const f = (value - param.min) / (param.max - param.min);
    const valueDeg = KNOB_START + f * KNOB_SWEEP;
    // Bipolar knobs fill from the top (preset value), unipolar from the start
    const zeroDeg = param.knob === 'bipolar' ? KNOB_START + KNOB_SWEEP / 2 : KNOB_START;
    const [px, py] = polar(40, 40, 22, valueDeg);
    return `
        <path class="knob-track" d="${arcPath(40, 40, 30, KNOB_START, KNOB_START + KNOB_SWEEP)}" />
        <path class="knob-fill" d="${arcPath(40, 40, 30, zeroDeg, valueDeg)}" />
        <line class="knob-pointer" x1="40" y1="40" x2="${px.toFixed(2)}" y2="${py.toFixed(2)}" />`;
}

// Relative envelope drawn around a neutral shape (0 = neutral)
function envelopeSvg(tone, focusKey) {
    const time = (v, base) => base * Math.pow(2, v / 32);
    const segments = {
        attack: time(tone.attack, 0.15),
        decay: time(tone.decay, 0.2),
        sustain: 0.25,
        release: time(tone.release, 0.25)
    };
    const total = segments.attack + segments.decay + segments.sustain + segments.release;
    const W = 240;
    const top = 8;
    const bottom = 92;
    const scale = W / total;
    const level = Math.max(0.02, Math.min(1, 0.55 + tone.sustain / 64 * 0.45));
    const sustainY = bottom - (bottom - top) * level;

    const x1 = segments.attack * scale;
    const x2 = x1 + segments.decay * scale;
    const x3 = x2 + segments.sustain * scale;
    const x4 = W;
    const bounds = { attack: [0, x1], decay: [x1, x2], sustain: [x2, x3], release: [x3, x4] };

    let highlight = '';
    if (focusKey) {
        const [a, b] = bounds[focusKey];
        highlight = `<rect class="env-highlight" x="${a}" y="${top}" width="${Math.max(1, b - a)}" height="${bottom - top}" />`;
    }
    return `
        ${highlight}
        <line class="env-axis" x1="0" y1="${bottom}" x2="${W}" y2="${bottom}" />
        <polyline class="env-line" points="0,${bottom} ${x1},${top} ${x2},${sustainY} ${x3},${sustainY} ${x4},${bottom}" />`;
}
