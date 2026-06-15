// data.js — loads the Pantone reference libraries and normalizes them to a
// common shape, precomputing CIELAB for fast perceptual matching.
//
// Three search modes are supported:
//   - C     : PANTONE Solid Coated (pantone.json)        e.g. "100-c"
//   - TCX   : PANTONE Fashion, Home + Interiors (TCX)     e.g. "11-0103" / "egret"
//   - MIXED : combined C + TCX library, ranked by the same ΔE score
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

// Parallel Float32Array Lab columns for a library, enabling a tight,
// allocation-free distance scan during matching.
function toColumns(entries) {
    const n = entries.length;
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), Ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const lab = entries[i].lab;
        L[i] = lab[0];
        A[i] = lab[1];
        B[i] = lab[2];
        Ch[i] = Math.hypot(lab[1], lab[2]); // chroma, for the ΔE94-style prefilter
    }
    return { L, A, B, Ch };
}

export async function loadLibraries() {
    const [coatedRaw, tcxRaw, metalRaw, pastelRaw] = await Promise.all([
        fetch('pantone.json').then(r => r.json()).catch(() => []),
        fetch('pantone-tcx.json').then(r => r.json()).catch(() => ({})),
        fetch('pantone-metallic.json').then(r => r.json()).catch(() => []),
        fetch('pantone-pastels-neons.json').then(r => r.json()).catch(() => []),
    ]);

    // Coated, Metallic and Pastels/Neons share the same {pantone, hex} array shape
    // and the same "-c"-style codes, so they build identically.
    const fromArray = (raw, lib) => (Array.isArray(raw) ? raw : [])
        .map(item => buildEntry(lib, item.pantone, item.hex, null))
        .filter(Boolean);

    const C = fromArray(coatedRaw, 'C');
    const TCX = Object.entries(tcxRaw || {})
        .map(([code, v]) => buildEntry('TCX', code, v.hex, titleCase(v.name || '')))
        .filter(Boolean);
    const METALLIC = fromArray(metalRaw, 'METALLIC');
    const PASTEL = fromArray(pastelRaw, 'PASTEL');

    const MIXED = [...C, ...TCX, ...METALLIC, ...PASTEL];

    return {
        C, TCX, METALLIC, PASTEL, MIXED,
        cols: {
            C: toColumns(C), TCX: toColumns(TCX),
            METALLIC: toColumns(METALLIC), PASTEL: toColumns(PASTEL),
            MIXED: toColumns(MIXED),
        },
    };
}
