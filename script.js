// script.js — main application logic for the Pantone Matcher.
//
// Picking pipeline:
//   pointer move  -> sample an N×N region (linear-light average) -> sRGB color
//                 -> CIEDE2000 against the active library -> top-3 matches
//   pointer lock  -> load the official chip for the best match (direct -> proxy -> swatch)

import {
    rgbToHex, rgbToLab, ciede2000, sampleRegion, confidenceFromDeltaE,
} from './color.js';
import { loadLibraries, chipUrlDirect, chipUrlProxy } from './data.js';

const MAX_DIM = 4096;       // cap the canvas backing store to bound memory
const LOUPE_ZOOM = 8;       // magnification factor of the zoom loupe

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let libraries = { C: [], TCX: [] };
let currentLibrary = 'C';
let sampleRadius = 2;       // 0 = 1px, 2 = 5×5, 5 = 11×11
let lastPick = null;        // { x, y, rgb }  (intrinsic canvas coords)
let currentMatches = [];
let selectedMatch = null;
let downloadProxyUrl = null; // proxy URL of the currently displayed official chip (for download)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const els = {};
document.addEventListener('DOMContentLoaded', init);

async function init() {
    cache(['dropzone', 'file-input', 'canvas-container', 'image-canvas', 'lens', 'loupe-canvas',
        'reset-btn', 'pick-hint', 'picked-hex', 'picked-rgb', 'picked-swatch',
        'pantone-name', 'pantone-colorname', 'pantone-hex', 'pantone-confidence',
        'pantone-image-container', 'pantone-image', 'chip-spinner', 'chip-badge',
        'pantone-swatch-container', 'pantone-swatch', 'pantone-strip',
        'download-btn', 'alt-matches', 'alt-list', 'toast', 'sr-live']);

    els.ctx = els['image-canvas'].getContext('2d', { willReadFrequently: true });
    els.loupeCtx = els['loupe-canvas'].getContext('2d');

    libraries = await loadLibraries();
    console.log(`${libraries.C.length} couleurs Pantone Couché et ${libraries.TCX.length} couleurs TCX chargées`);

    setupControls();
    setupUpload();
    setupCanvasPicking();
    setupClipboard();
    setupDownload();
}

function cache(ids) {
    for (const id of ids) els[id] = document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Controls (library + sample size)
// ---------------------------------------------------------------------------

function setupControls() {
    document.querySelectorAll('input[name="library"]').forEach(r => {
        r.addEventListener('change', () => {
            currentLibrary = r.value;
            recomputeFromLastPick(false);
        });
    });
    document.querySelectorAll('input[name="sample"]').forEach(r => {
        r.addEventListener('change', () => {
            sampleRadius = parseInt(r.value, 10);
            recomputeFromLastPick(true);
            if (lastPick) refreshLoupeFromLastEvent();
        });
    });
}

// ---------------------------------------------------------------------------
// Upload / drag & drop / reset
// ---------------------------------------------------------------------------

function setupUpload() {
    els['file-input'].addEventListener('change', e => {
        if (e.target.files && e.target.files[0]) loadImageFile(e.target.files[0]);
    });

    const dz = els['dropzone'];
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
        e.preventDefault();
        dz.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
    });

    els['reset-btn'].addEventListener('click', () => {
        els['dropzone'].hidden = false;
        els['canvas-container'].hidden = true;
        els['file-input'].value = '';
        lastPick = null;
    });
}

async function loadImageFile(file) {
    if (!file.type.startsWith('image/')) return;
    let source;
    try {
        // createImageBitmap honours EXIF orientation so rotated photos sample correctly.
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
        source = await loadViaImgElement(file); // fallback for older browsers
    }
    drawToCanvas(source);
}

function loadViaImgElement(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = ev.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function drawToCanvas(source) {
    const iw = source.width, ih = source.height;
    const longest = Math.max(iw, ih);
    const scale = longest > MAX_DIM ? MAX_DIM / longest : 1;
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));

    const canvas = els['image-canvas'];
    canvas.width = w;
    canvas.height = h;
    els.ctx.clearRect(0, 0, w, h);
    els.ctx.drawImage(source, 0, 0, w, h);
    if (typeof source.close === 'function') source.close(); // free the ImageBitmap

    els['dropzone'].hidden = true;
    els['canvas-container'].hidden = false;
}

// ---------------------------------------------------------------------------
// Canvas picking (pointer + touch) and zoom loupe
// ---------------------------------------------------------------------------

let pendingEvent = null;
let rafScheduled = false;

function setupCanvasPicking() {
    const canvas = els['image-canvas'];

    canvas.addEventListener('pointermove', e => {
        // On touch, only preview while the finger is down; mouse always previews on hover.
        if (e.pointerType !== 'mouse' && e.buttons === 0) return;
        schedulePreview(e);
    });
    canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        schedulePreview(e);
    });
    canvas.addEventListener('pointerup', () => lockPick());
    canvas.addEventListener('pointerleave', () => { els['lens'].style.display = 'none'; });
}

function schedulePreview(e) {
    pendingEvent = e;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
        rafScheduled = false;
        if (pendingEvent) processPreview(pendingEvent);
    });
}

function refreshLoupeFromLastEvent() {
    if (pendingEvent) processPreview(pendingEvent);
}

function eventToCanvasCoords(e) {
    const canvas = els['image-canvas'];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);
    return { x, y, rect };
}

function processPreview(e) {
    const canvas = els['image-canvas'];
    const { x, y, rect } = eventToCanvasCoords(e);
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;

    const rgb = sampleRegion(els.ctx, x, y, sampleRadius, canvas.width, canvas.height);
    if (!rgb) return;

    lastPick = { x, y, rgb };
    updatePickedColor(rgb);
    updateLoupe(e, rect, x, y);

    currentMatches = topMatches(rgb);
    if (currentMatches.length) {
        // Live: update text + alt list, but defer the network chip load to lock.
        selectMatch(currentMatches[0], false);
        renderAltList(currentMatches);
    }
}

function lockPick() {
    if (!selectedMatch) return;
    loadChip(selectedMatch);
    els['download-btn'].hidden = false;
    announce(`${selectedMatch.displayName}. ${describeConfidence(selectedMatch.deltaE)}.`);
}

function updateLoupe(e, rect, cx, cy) {
    const lens = els['lens'];
    lens.style.display = 'block';
    // Position the loupe relative to its container (the canvas may be centered within it).
    const containerRect = els['canvas-container'].getBoundingClientRect();
    lens.style.left = `${e.clientX - containerRect.left}px`;
    lens.style.top = `${e.clientY - containerRect.top}px`;

    const canvas = els['image-canvas'];
    const lctx = els.loupeCtx;
    const size = els['loupe-canvas'].width;          // square loupe (px)
    const srcSpan = size / LOUPE_ZOOM;               // source pixels shown

    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, size, size);
    lctx.drawImage(canvas, cx - srcSpan / 2, cy - srcSpan / 2, srcSpan, srcSpan, 0, 0, size, size);

    // Highlight the exact sampled region (2*radius+1 source px) at the center.
    const sampleSpan = (2 * sampleRadius + 1) * LOUPE_ZOOM;
    const o = (size - sampleSpan) / 2;
    lctx.strokeStyle = 'rgba(0,0,0,0.6)';
    lctx.lineWidth = 3;
    lctx.strokeRect(o, o, sampleSpan, sampleSpan);
    lctx.strokeStyle = 'rgba(255,255,255,0.95)';
    lctx.lineWidth = 1;
    lctx.strokeRect(o, o, sampleSpan, sampleSpan);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function topMatches(rgb, k = 3) {
    const lib = libraries[currentLibrary] || [];
    if (!lib.length) return [];
    const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
    const scored = lib.map(p => ({ p, dE: ciede2000(lab, p.lab) }));
    scored.sort((a, b) => a.dE - b.dE);
    return scored.slice(0, k).map(s => ({ ...s.p, deltaE: s.dE }));
}

function recomputeFromLastPick(reSample) {
    if (!lastPick) return;
    const canvas = els['image-canvas'];
    if (reSample) {
        const rgb = sampleRegion(els.ctx, lastPick.x, lastPick.y, sampleRadius, canvas.width, canvas.height);
        if (rgb) { lastPick.rgb = rgb; updatePickedColor(rgb); }
    }
    currentMatches = topMatches(lastPick.rgb);
    if (currentMatches.length) {
        selectMatch(currentMatches[0], true);
        renderAltList(currentMatches);
        els['download-btn'].hidden = false;
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function updatePickedColor(rgb) {
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    els['picked-hex'].textContent = hex;
    els['picked-rgb'].textContent = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    els['picked-swatch'].style.backgroundColor = hex;
}

function selectMatch(match, loadChipImage) {
    selectedMatch = match;
    els['pantone-name'].textContent = match.displayName;
    els['pantone-hex'].textContent = match.hex;

    if (match.colorName) {
        els['pantone-colorname'].textContent = match.colorName;
        els['pantone-colorname'].hidden = false;
    } else {
        els['pantone-colorname'].hidden = true;
    }

    const conf = confidenceFromDeltaE(match.deltaE);
    const confEl = els['pantone-confidence'];
    confEl.textContent = `${conf.label} · ΔE ${match.deltaE.toFixed(1)}`;
    confEl.className = `value confidence conf-${conf.level}`;

    // highlight the selected row in the alt list
    els['alt-list'].querySelectorAll('.alt-item').forEach(li => {
        li.classList.toggle('selected', li.dataset.code === match.code && li.dataset.lib === match.library);
    });

    if (loadChipImage) loadChip(match);
    else showSwatchFallback(match, /*quiet=*/true);
}

function renderAltList(matches) {
    const list = els['alt-list'];
    list.innerHTML = '';
    for (const m of matches) {
        const conf = confidenceFromDeltaE(m.deltaE);
        const li = document.createElement('li');
        li.className = 'alt-item';
        li.dataset.code = m.code;
        li.dataset.lib = m.library;
        if (selectedMatch && m.code === selectedMatch.code && m.library === selectedMatch.library) {
            li.classList.add('selected');
        }
        li.innerHTML = `
            <span class="alt-swatch" style="background-color:${m.hex}"></span>
            <span class="alt-info">
                <span class="alt-name">${m.displayName}</span>
                ${m.colorName ? `<span class="alt-sub">${m.colorName}</span>` : ''}
            </span>
            <span class="alt-de conf-${conf.level}">ΔE ${m.deltaE.toFixed(1)}<span class="alt-conf">${conf.label}</span></span>`;
        li.addEventListener('click', () => { selectMatch(m, true); els['download-btn'].hidden = false; });
        list.appendChild(li);
    }
    els['alt-matches'].hidden = matches.length === 0;
}

// ---------------------------------------------------------------------------
// Official chip image — direct (pantone.com) -> proxy (wsrv.nl) -> swatch
// ---------------------------------------------------------------------------

function loadChip(match) {
    const img = els['pantone-image'];
    const direct = chipUrlDirect(match.library, match.code);
    const proxy = chipUrlProxy(match.library, match.code);
    downloadProxyUrl = proxy;

    let stage = 'direct';
    els['pantone-image-container'].hidden = false;
    els['pantone-swatch-container'].hidden = true;
    els['chip-spinner'].hidden = false;
    els['chip-badge'].hidden = true;
    img.style.opacity = '0';

    img.onload = () => {
        // Guard against a stale async load after the user moved to another color.
        if (selectedMatch !== match) return;
        els['chip-spinner'].hidden = true;
        img.style.opacity = '1';
    };
    img.onerror = () => {
        if (selectedMatch !== match) return;
        if (stage === 'direct') { stage = 'proxy'; img.src = proxy; }
        else { showSwatchFallback(match); }
    };
    img.alt = `Pastille de couleur Pantone officielle - ${match.displayName}`;
    img.src = direct;
}

// Flat swatch styled like a chip, used when no official image is available.
function showSwatchFallback(match, quiet) {
    if (!quiet) downloadProxyUrl = null; // no official image to download
    els['pantone-image-container'].hidden = true;
    els['chip-spinner'].hidden = true;
    els['pantone-swatch-container'].hidden = false;
    els['pantone-swatch'].style.backgroundColor = match.hex;
    const strip = els['pantone-strip'];
    strip.hidden = false;
    strip.textContent = match.displayName.replace(/^PANTONE\s*/i, '');
}

// ---------------------------------------------------------------------------
// Download — official chip as PNG, or a generated chip-style PNG as fallback
// ---------------------------------------------------------------------------

function setupDownload() {
    els['download-btn'].addEventListener('click', async () => {
        if (!selectedMatch) return;
        const btn = els['download-btn'];
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Préparation...';
        try {
            const blobUrl = await chipPngUrl(selectedMatch);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `pantone-${selectedMatch.code}${selectedMatch.library === 'TCX' ? '-tcx' : ''}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (err) {
            console.error('Échec du téléchargement :', err);
            alert("Impossible de préparer l'image pour le téléchargement.");
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    });
}

async function chipPngUrl(match) {
    // Prefer the official chip (fetched via proxy so we can read it into a canvas).
    if (downloadProxyUrl) {
        try {
            const resp = await fetch(downloadProxyUrl);
            if (resp.ok) {
                const blob = await resp.blob();
                const bmp = await createImageBitmap(blob);
                const c = document.createElement('canvas');
                c.width = bmp.width; c.height = bmp.height;
                c.getContext('2d').drawImage(bmp, 0, 0);
                return c.toDataURL('image/png');
            }
        } catch { /* fall through to generated chip */ }
    }
    return generatedChipDataUrl(match);
}

// Render a Pantone-style chip locally (clearly an approximation, used only as a fallback).
function generatedChipDataUrl(match) {
    const W = 440, H = 650, strip = 150;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = match.hex;
    x.fillRect(0, 0, W, H - strip);
    x.fillStyle = '#fff';
    x.fillRect(0, H - strip, W, strip);
    x.fillStyle = '#000';
    x.font = '800 34px Inter, Arial, sans-serif';
    x.fillText('PANTONE®', 30, H - strip + 56);
    x.font = '400 30px Inter, Arial, sans-serif';
    x.fillStyle = '#333';
    x.fillText(match.displayName.replace(/^PANTONE\s*/i, ''), 30, H - strip + 100);
    return c.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Clipboard (with non-secure-context fallback)
// ---------------------------------------------------------------------------

function setupClipboard() {
    const copyables = [els['picked-hex'], els['picked-rgb'], els['pantone-name'], els['pantone-hex']];
    for (const el of copyables) {
        el.addEventListener('click', () => copyFrom(el));
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyFrom(el); }
        });
    }
}

function copyFrom(el) {
    const text = el.textContent;
    if (!text || text === '-') return;
    copyText(text);
}

async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            legacyCopy(text);
        }
    } catch {
        legacyCopy(text);
    }
    showToast('Copié dans le presse-papiers !');
}

function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
}

// ---------------------------------------------------------------------------
// Misc UI helpers
// ---------------------------------------------------------------------------

function showToast(message) {
    const toast = els['toast'];
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2000);
}

function announce(message) {
    els['sr-live'].textContent = message;
}

function describeConfidence(dE) {
    const conf = confidenceFromDeltaE(dE);
    return `${conf.label}, delta E ${dE.toFixed(1)}`;
}
