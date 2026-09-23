// Design tokens for canvas drawing.
// The single source of truth is the CSS custom properties in style.css (:root);
// loadTheme() copies them here so canvas code and HTML use the same values.

export const theme = {
    trackColors: []
};

const TOKENS = {
    bg: '--bg',
    surface1: '--surface-1',
    surface2: '--surface-2',
    surface3: '--surface-3',
    border: '--border',
    borderStrong: '--border-strong',
    text: '--text',
    textMuted: '--text-muted',
    textDim: '--text-dim',
    accent: '--accent',
    selection: '--selection',
    loop: '--loop',
    marker: '--marker',
    playhead: '--playhead',
    danger: '--danger',
    gridLine: '--grid-line',
    gridBar: '--grid-bar',
    keyWhite: '--key-white',
    keyBlack: '--key-black',
    fontFamily: '--font-main'
};

export function loadTheme() {
    const css = getComputedStyle(document.documentElement);
    for (const [key, name] of Object.entries(TOKENS)) {
        theme[key] = css.getPropertyValue(name).trim();
    }
    theme.trackColors = Array.from({ length: 8 }, (_, i) => css.getPropertyValue(`--track-${i + 1}`).trim());
}

// Canvas font string using the app font, e.g. font(12, 'bold')
export function font(size, weight = '') {
    return `${weight ? weight + ' ' : ''}${size}px ${theme.fontFamily}`;
}

// '#rrggbb' + alpha -> 'rgba(...)'
export function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function trackColor(trackId) {
    return theme.trackColors[trackId % theme.trackColors.length];
}
