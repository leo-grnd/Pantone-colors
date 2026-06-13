// data.js — loads the Pantone reference libraries and normalizes them to a
// common shape, precomputing CIELAB for fast perceptual matching.
//
// Two libraries are supported:
//   - C   : PANTONE Solid Coated (pantone.json)        e.g. "100-c"
//   - TCX : PANTONE Fashion, Home + Interiors (TCX)     e.g. "11-0103" / "egret"
//
// Each normalized entry:
//   { library, code, displayName, colorName, hex, r, g, b, lab }
// where `code` is the raw code used to build the official chip filename.

import { hexToRgb, normalizeHex, rgbToLab } from './color.js';

const CHIP_DIR = 'media/color-finder/img/chips/';

// Turn a coated code like "warm-gray-1-c" into a readable "Warm Gray 1 C".
function formatCode(code) {
    return code.split('-').map(tok => {
        if (/^[a-z]$/i.test(tok)) return tok.toUpperCase(); // suffix letter (c/u/m)
        if (/^\d/.test(tok)) return tok;                    // numbers stay as-is (100, 012)
        return tok.charAt(0).toUpperCase() + tok.slice(1);  // words -> Title Case
    }).join(' ');
}

function titleCase(name) {
    return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Filename portion of the official chip for a given entry.
function chipFile(library, code) {
    return library === 'TCX'
        ? `pantone-color-chip-${code}-tcx.webp`
        : `pantone-color-chip-${code}.webp`;
}

// Direct official URL (used for plain <img> display — no CORS needed).
export function chipUrlDirect(library, code) {
    return `https://www.pantone.com/${CHIP_DIR}${chipFile(library, code)}`;
}

// Proxied URL via wsrv.nl (needed when we must read pixels into a canvas, e.g. download).
export function chipUrlProxy(library, code) {
    return `https://wsrv.nl/?url=www.pantone.com/${CHIP_DIR}${chipFile(library, code)}`;
}

function buildEntry(library, code, hex, colorName) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    return {
        library,
        code,
        displayName: library === 'TCX'
            ? `PANTONE ${code} TCX`
            : `PANTONE ${formatCode(code)}`,
        colorName: colorName || null,
        hex: normalizeHex(hex),
        r: rgb.r, g: rgb.g, b: rgb.b,
        lab: rgbToLab(rgb.r, rgb.g, rgb.b),
    };
}

export async function loadLibraries() {
    const [coatedRaw, tcxRaw] = await Promise.all([
        fetch('pantone.json').then(r => r.json()).catch(() => []),
        fetch('pantone-tcx.json').then(r => r.json()).catch(() => ({})),
    ]);

    const C = (Array.isArray(coatedRaw) ? coatedRaw : [])
        .map(item => buildEntry('C', item.pantone, item.hex, null))
        .filter(Boolean);

    const TCX = Object.entries(tcxRaw || {})
        .map(([code, v]) => buildEntry('TCX', code, v.hex, titleCase(v.name || '')))
        .filter(Boolean);

    return { C, TCX };
}
