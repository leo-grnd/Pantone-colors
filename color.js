// color.js — color-space conversions and perceptual color difference.
//
// The matching pipeline works in CIELAB and compares colors with CIEDE2000 (ΔE00),
// the industry-standard perceptual metric — far more reliable than a raw RGB distance.
// All inputs are treated as sRGB (what an HTML canvas gives us via getImageData).

// ---------------------------------------------------------------------------
// Basic hex / rgb helpers
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
    } : null;
}

export function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
}

export function normalizeHex(hex) {
    const h = hex.startsWith('#') ? hex : '#' + hex;
    return h.toUpperCase();
}

// ---------------------------------------------------------------------------
// sRGB <-> linear light
// ---------------------------------------------------------------------------

// sRGB channel in [0,255] -> linear light in [0,1]
export function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// linear light in [0,1] -> sRGB channel in [0,255]
export function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, Math.round(v * 255)));
}

// ---------------------------------------------------------------------------
// sRGB -> CIELAB (D65)
// ---------------------------------------------------------------------------

function pivot(t) {
    return t > 0.008856451679 ? Math.cbrt(t) : (7.787037 * t + 16 / 116);
}

// r,g,b in [0,255] -> [L, a, b]
export function rgbToLab(r, g, b) {
    const rl = srgbToLinear(r);
    const gl = srgbToLinear(g);
    const bl = srgbToLinear(b);

    // linear sRGB -> XYZ (D65)
    const x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
    const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
    const z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;

    // Normalize by D65 reference white
    const fx = pivot(x / 0.95047);
    const fy = pivot(y / 1.00000);
    const fz = pivot(z / 1.08883);

    return [
        116 * fy - 16,
        500 * (fx - fy),
        200 * (fy - fz),
    ];
}

// ---------------------------------------------------------------------------
// CIEDE2000 perceptual color difference
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

export function ciede2000(lab1, lab2) {
    const [L1, a1, b1] = lab1;
    const [L2, a2, b2] = lab2;

    const C1 = Math.hypot(a1, b1);
    const C2 = Math.hypot(a2, b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar7 = Math.pow(Cbar, 7);
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7 = 6103515625

    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1);
    const C2p = Math.hypot(a2p, b2);

    const h1p = hueAngle(b1, a1p);
    const h2p = hueAngle(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    let dhp = 0;
    if (C1p * C2p !== 0) {
        dhp = h2p - h1p;
        if (dhp > 180) dhp -= 360;
        else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * DEG) / 2);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;

    let hbarp;
    if (C1p * C2p === 0) {
        hbarp = h1p + h2p;
    } else if (Math.abs(h1p - h2p) <= 180) {
        hbarp = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
        hbarp = (h1p + h2p + 360) / 2;
    } else {
        hbarp = (h1p + h2p - 360) / 2;
    }

    const T = 1
        - 0.17 * Math.cos((hbarp - 30) * DEG)
        + 0.24 * Math.cos((2 * hbarp) * DEG)
        + 0.32 * Math.cos((3 * hbarp + 6) * DEG)
        - 0.20 * Math.cos((4 * hbarp - 63) * DEG);

    const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
    const Cbarp7 = Math.pow(Cbarp, 7);
    const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
    const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
    const SC = 1 + 0.045 * Cbarp;
    const SH = 1 + 0.015 * Cbarp * T;
    const RT = -Math.sin((2 * dTheta) * DEG) * RC;

    return Math.sqrt(
        Math.pow(dLp / SL, 2) +
        Math.pow(dCp / SC, 2) +
        Math.pow(dHp / SH, 2) +
        RT * (dCp / SC) * (dHp / SH)
    );
}

function hueAngle(b, ap) {
    if (b === 0 && ap === 0) return 0;
    let h = Math.atan2(b, ap) / DEG;
    if (h < 0) h += 360;
    return h;
}

// ---------------------------------------------------------------------------
// Confidence label from a ΔE00 value
// ---------------------------------------------------------------------------

// Returns { label, level } where level is a slug used for styling.
export function confidenceFromDeltaE(dE) {
    if (dE < 1) return { label: 'Perfect match', level: 'perfect' };
    if (dE < 2) return { label: 'Excellent', level: 'excellent' };
    if (dE < 5) return { label: 'Good', level: 'good' };
    if (dE < 10) return { label: 'Fair', level: 'fair' };
    return { label: 'Approximate', level: 'approximate' };
}

// ---------------------------------------------------------------------------
// Region sampling — averages an N×N neighborhood in linear light.
// ---------------------------------------------------------------------------
//
// Averaging in linear light (not gamma-encoded sRGB) is the physically correct
// way to combine pixels and removes most JPEG/sensor noise. `radius` is the
// number of pixels around the center (0 = a single pixel, 2 = 5×5, 5 = 11×11).
// Fully transparent pixels are ignored. Returns sRGB {r,g,b} or null.

export function sampleRegion(ctx, cx, cy, radius, width, height) {
    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(width - 1, cx + radius);
    const y1 = Math.min(height - 1, cy + radius);
    const sw = x1 - x0 + 1;
    const sh = y1 - y0 + 1;
    if (sw <= 0 || sh <= 0) return null;

    const data = ctx.getImageData(x0, y0, sw, sh).data;
    let rl = 0, gl = 0, bl = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue; // skip transparent
        rl += srgbToLinear(data[i]);
        gl += srgbToLinear(data[i + 1]);
        bl += srgbToLinear(data[i + 2]);
        count++;
    }
    if (count === 0) return null;

    return {
        r: linearToSrgb(rl / count),
        g: linearToSrgb(gl / count),
        b: linearToSrgb(bl / count),
    };
}
