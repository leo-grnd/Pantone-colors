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
    if (dE < 1) return { label: 'Correspondance parfaite', level: 'perfect' };
    if (dE < 2) return { label: 'Excellent', level: 'excellent' };
    if (dE < 5) return { label: 'Bonne', level: 'good' };
    if (dE < 10) return { label: 'Correcte', level: 'fair' };
    return { label: 'Approximative', level: 'approximate' };
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

    const data = ctx.getImageData(x0, y0, sw, sh, { colorSpace: 'srgb' }).data;
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

// ---------------------------------------------------------------------------
// Edge-aware sampling — dominant colour of the N×N window.
// ---------------------------------------------------------------------------
//
// A plain average (sampleRegion) is wrong when the window straddles a boundary
// between two colours: it returns a blend that matches neither. Instead we split
// the window's pixels into two perceptual clusters (k=2, deterministic
// farthest-first seeding in Lab) and return the linear-light mean of the larger
// cluster — i.e. the colour the user is actually pointing at. On a uniform window
// the two clusters collapse together, so the result matches the plain average.
//
// Falls back to sampleRegion for a single pixel or a tiny window. Returns sRGB
// {r,g,b} or null.

export function sampleDominant(ctx, cx, cy, radius, width, height) {
    if (radius <= 0) return sampleRegion(ctx, cx, cy, radius, width, height);

    const x0 = Math.max(0, cx - radius);
    const y0 = Math.max(0, cy - radius);
    const x1 = Math.min(width - 1, cx + radius);
    const y1 = Math.min(height - 1, cy + radius);
    const sw = x1 - x0 + 1;
    const sh = y1 - y0 + 1;
    if (sw <= 0 || sh <= 0) return null;

    const data = ctx.getImageData(x0, y0, sw, sh, { colorSpace: 'srgb' }).data;

    // Collect opaque pixels: Lab (for clustering) + linear RGB (for the result).
    const px = data.length / 4;
    const labL = new Float64Array(px), labA = new Float64Array(px), labB = new Float64Array(px);
    const linR = new Float64Array(px), linG = new Float64Array(px), linB = new Float64Array(px);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lab = rgbToLab(r, g, b);
        labL[n] = lab[0]; labA[n] = lab[1]; labB[n] = lab[2];
        linR[n] = srgbToLinear(r); linG[n] = srgbToLinear(g); linB[n] = srgbToLinear(b);
        n++;
    }
    if (n === 0) return null;
    if (n <= 4) return sampleRegion(ctx, cx, cy, radius, width, height); // too few to cluster

    // Two seeds: first pixel, then the pixel farthest from it (Lab, squared).
    let c0L = labL[0], c0A = labA[0], c0B = labB[0];
    let far = 0, farD = -1;
    for (let i = 0; i < n; i++) {
        const dl = labL[i] - c0L, da = labA[i] - c0A, db = labB[i] - c0B;
        const d = dl * dl + da * da + db * db;
        if (d > farD) { farD = d; far = i; }
    }
    let c1L = labL[far], c1A = labA[far], c1B = labB[far];

    // A few Lloyd iterations.
    let n0 = 0;
    let s0R = 0, s0G = 0, s0B = 0, s1R = 0, s1G = 0, s1B = 0;
    for (let iter = 0; iter < 6; iter++) {
        let a0L = 0, a0A = 0, a0B = 0, cnt0 = 0;
        let a1L = 0, a1A = 0, a1B = 0;
        s0R = 0; s0G = 0; s0B = 0; s1R = 0; s1G = 0; s1B = 0;
        for (let i = 0; i < n; i++) {
            const d0l = labL[i] - c0L, d0a = labA[i] - c0A, d0b = labB[i] - c0B;
            const d1l = labL[i] - c1L, d1a = labA[i] - c1A, d1b = labB[i] - c1B;
            if (d0l * d0l + d0a * d0a + d0b * d0b <= d1l * d1l + d1a * d1a + d1b * d1b) {
                a0L += labL[i]; a0A += labA[i]; a0B += labB[i]; cnt0++;
                s0R += linR[i]; s0G += linG[i]; s0B += linB[i];
            } else {
                a1L += labL[i]; a1A += labA[i]; a1B += labB[i];
                s1R += linR[i]; s1G += linG[i]; s1B += linB[i];
            }
        }
        n0 = cnt0;
        const cnt1 = n - cnt0;
        if (cnt0) { c0L = a0L / cnt0; c0A = a0A / cnt0; c0B = a0B / cnt0; }
        if (cnt1) { c1L = a1L / cnt1; c1A = a1A / cnt1; c1B = a1B / cnt1; }
    }

    // Return the linear-light mean of the larger cluster.
    const cnt1 = n - n0;
    const useFirst = n0 >= cnt1;
    const cnt = useFirst ? n0 : cnt1;
    const r = useFirst ? s0R : s1R, g = useFirst ? s0G : s1G, b = useFirst ? s0B : s1B;
    return {
        r: linearToSrgb(r / cnt),
        g: linearToSrgb(g / cnt),
        b: linearToSrgb(b / cnt),
    };
}

// ---------------------------------------------------------------------------
// CIELAB -> sRGB (inverse of rgbToLab), needed to render cluster centroids.
// ---------------------------------------------------------------------------

function pivotInv(f) {
    const f3 = f * f * f;
    return f3 > 0.008856451679 ? f3 : (f - 16 / 116) / 7.787037;
}

export function labToRgb(L, a, b) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const x = pivotInv(fx) * 0.95047;
    const y = pivotInv(fy) * 1.00000;
    const z = pivotInv(fz) * 1.08883;

    // XYZ (D65) -> linear sRGB
    const rl = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
    const gl = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
    const bl = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

    return { r: linearToSrgb(rl), g: linearToSrgb(gl), b: linearToSrgb(bl) };
}

// ---------------------------------------------------------------------------
// Dominant-color palette extraction (k-means in CIELAB)
// ---------------------------------------------------------------------------
//
// Clustering in Lab gives perceptually meaningful groups (unlike naive RGB
// frequency counting which yields near-duplicates). Seeding is a deterministic
// farthest-first traversal (greedy k-means++), so the palette is stable across
// runs and the colors are well spread. Input is a flat RGBA byte array (already
// downscaled by the caller for speed); output is sorted by dominance.
//
// Returns: [{ r, g, b, hex, weight }]  (weight = fraction of sampled pixels)

export function extractPalette(rgba, k = 5) {
    const L = [], A = [], B = [];
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 125) continue; // skip mostly-transparent
        const lab = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
        L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
    }
    const n = L.length;
    if (!n) return [];
    const K = Math.min(k, n);

    const cL = new Array(K), cA = new Array(K), cB = new Array(K);
    cL[0] = L[0]; cA[0] = A[0]; cB[0] = B[0];

    // Farthest-first seeding (deterministic).
    const nearest = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < K; c++) {
        let far = 0, farD = -1;
        for (let i = 0; i < n; i++) {
            const dl = L[i] - cL[c - 1], da = A[i] - cA[c - 1], db = B[i] - cB[c - 1];
            const d = dl * dl + da * da + db * db;
            if (d < nearest[i]) nearest[i] = d;
            if (nearest[i] > farD) { farD = nearest[i]; far = i; }
        }
        cL[c] = L[far]; cA[c] = A[far]; cB[c] = B[far];
    }

    // Lloyd's iterations.
    const assign = new Int32Array(n);
    for (let iter = 0; iter < 12; iter++) {
        let moved = false;
        for (let i = 0; i < n; i++) {
            let best = 0, bestD = Infinity;
            for (let c = 0; c < K; c++) {
                const dl = L[i] - cL[c], da = A[i] - cA[c], db = B[i] - cB[c];
                const d = dl * dl + da * da + db * db;
                if (d < bestD) { bestD = d; best = c; }
            }
            if (assign[i] !== best) { assign[i] = best; moved = true; }
        }
        const sL = new Float64Array(K), sA = new Float64Array(K), sB = new Float64Array(K), cnt = new Float64Array(K);
        for (let i = 0; i < n; i++) {
            const c = assign[i];
            sL[c] += L[i]; sA[c] += A[i]; sB[c] += B[i]; cnt[c]++;
        }
        for (let c = 0; c < K; c++) {
            if (cnt[c]) { cL[c] = sL[c] / cnt[c]; cA[c] = sA[c] / cnt[c]; cB[c] = sB[c] / cnt[c]; }
        }
        if (!moved && iter > 0) break;
    }

    const counts = new Float64Array(K);
    for (let i = 0; i < n; i++) counts[assign[i]]++;

    let clusters = [];
    for (let c = 0; c < K; c++) {
        if (counts[c]) clusters.push({ lab: [cL[c], cA[c], cB[c]], weight: counts[c] / n });
    }
    clusters.sort((p, q) => q.weight - p.weight);

    // Merge centroids that are perceptually near-identical (ΔE76).
    const merged = [];
    for (const cl of clusters) {
        const dup = merged.find(m => {
            const dl = m.lab[0] - cl.lab[0], da = m.lab[1] - cl.lab[1], db = m.lab[2] - cl.lab[2];
            return Math.sqrt(dl * dl + da * da + db * db) < 4;
        });
        if (dup) dup.weight += cl.weight;
        else merged.push(cl);
    }

    return merged.map(c => {
        const rgb = labToRgb(c.lab[0], c.lab[1], c.lab[2]);
        return { r: rgb.r, g: rgb.g, b: rgb.b, hex: rgbToHex(rgb.r, rgb.g, rgb.b), weight: c.weight };
    });
}
