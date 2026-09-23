// Design tokens for canvas drawing.
// The single source of truth is the CSS custom properties in style.css (:root);
// loadTheme() copies them here so canvas code and HTML use the same values.

export const theme = {};

const TOKENS = {
    body: '--body',
    lane: '--lane',
    laneCur: '--lane-cur',
    laneCurBorder: '--lane-cur-border',
    ink: '--ink',
    graphite: '--graphite',
    textOff: '--text-off',
    line: '--line',
    rowLine: '--row-line',
    ghost: '--ghost',
    trig: '--trig',
    clipMuted: '--clip-muted',
    clipNote: '--clip-note',
    clipNoteMuted: '--clip-note-muted',
    keyTop: '--key-top',
    keyBottom: '--key-bottom',
    keyPressedTop: '--key-pressed-top',
    keyPressedBottom: '--key-pressed-bottom',
    keyBorder: '--key-border',
    keySkirt: '--key-skirt',
    keyText: '--key-text',
    keyWhite: '--key-white',
    ledOn: '--led-on',
    ledRim: '--led-rim',
    ledOff: '--led-off',
    fontFamily: '--font-main'
};

export function loadTheme() {
    const css = getComputedStyle(document.documentElement);
    for (const [key, name] of Object.entries(TOKENS)) {
        theme[key] = css.getPropertyValue(name).trim();
    }
}

// Canvas font string using the app font, e.g. font(12, '600')
export function font(size, weight = '') {
    return `${weight ? weight + ' ' : ''}${size}px ${theme.fontFamily}`;
}

// '#rrggbb' + alpha -> 'rgba(...)'
export function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
