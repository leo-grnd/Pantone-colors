let pantoneData = null;
let parsedPantones = [];

async function loadPantoneData() {
    try {
        const response = await fetch('pantone.json');
        pantoneData = await response.json();
        
        // Pre-parse hex to rgb for faster distance calculation
        for (const item of pantoneData) {
            const hex = item.hex;
            const rgb = hexToRgb(hex);
            if (rgb) {
                parsedPantones.push({
                    name: formatPantoneName(item.pantone),
                    code: item.pantone,
                    hex: hex,
                    r: rgb.r,
                    g: rgb.g,
                    b: rgb.b
                });
            }
        }
        console.log(`Loaded ${parsedPantones.length} Pantone colors`);
    } catch (e) {
        console.error("Failed to load Pantone data", e);
    }
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function rgbToHex(r, g, b) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1).toUpperCase();
}

function formatPantoneName(code) {
    return code.split('-').map(word => word.toUpperCase()).join(' ');
}

// Color distance (Weighted RGB for better human perception approximation)
function getColorDistance(r1, g1, b1, r2, g2, b2) {
    const rmean = (r1 + r2) / 2;
    const r = r1 - r2;
    const g = g1 - g2;
    const b = b1 - b2;
    return Math.sqrt((((512+rmean)*r*r)>>8) + 4*g*g + (((767-rmean)*b*b)>>8));
}

function findClosestPantone(r, g, b) {
    if (!parsedPantones.length) return null;
    
    let minDistance = Infinity;
    let closest = null;
    
    for (const p of parsedPantones) {
        const dist = getColorDistance(r, g, b, p.r, p.g, p.b);
        if (dist < minDistance) {
            minDistance = dist;
            closest = p;
        }
    }
    return closest;
}

// UI Interaction
document.addEventListener('DOMContentLoaded', () => {
    loadPantoneData();
    
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const canvasContainer = document.getElementById('canvas-container');
    const canvas = document.getElementById('image-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const lens = document.getElementById('lens');
    const resetBtn = document.getElementById('reset-btn');
    
    // UI Elements
    const pickedHex = document.getElementById('picked-hex');
    const pickedRgb = document.getElementById('picked-rgb');
    const pickedSwatch = document.getElementById('picked-swatch');
    
    const pantoneName = document.getElementById('pantone-name');
    const pantoneHex = document.getElementById('pantone-hex');
    const pantoneSwatch = document.getElementById('pantone-swatch');
    
    // Setup File Upload
    fileInput.addEventListener('change', handleFileSelect);
    
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelect({ target: fileInput });
        }
    });
    
    resetBtn.addEventListener('click', () => {
        dropzone.style.display = 'flex';
        canvasContainer.style.display = 'none';
        fileInput.value = '';
    });
    
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(event) {
            const img = new Image();
            img.onload = function() {
                // Set actual canvas size to match image intrinsic dimensions for exact pixel mapping
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
                
                dropzone.style.display = 'none';
                canvasContainer.style.display = 'flex';
            }
            img.src = event.target.result;
        }
        reader.readAsDataURL(file);
    }
    
    // Canvas interaction
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        
        // Update lens position (visual overlay)
        lens.style.display = 'block';
        lens.style.left = `${e.clientX - rect.left}px`;
        lens.style.top = `${e.clientY - rect.top}px`;
        
        // We could also dynamically update color while hovering, but let's just use click to lock
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        
        // Ensure coordinates are within bounds
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            lens.style.backgroundColor = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
            lens.style.borderColor = (pixel[0] + pixel[1] + pixel[2] > 382) ? '#000' : '#fff';
        }
    });
    
    canvas.addEventListener('mouseleave', () => {
        lens.style.display = 'none';
    });
    
    canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            const r = pixel[0], g = pixel[1], b = pixel[2];
            
            updatePickedColor(r, g, b);
            
            const pantone = findClosestPantone(r, g, b);
            if (pantone) {
                updatePantoneUI(pantone);
            }
        }
    });
    
    function updatePickedColor(r, g, b) {
        const hex = rgbToHex(r, g, b);
        pickedHex.textContent = hex;
        pickedRgb.textContent = `rgb(${r}, ${g}, ${b})`;
        pickedSwatch.style.backgroundColor = hex;
    }
    
    function updatePantoneUI(pantone) {
        pantoneName.textContent = "PANTONE " + pantone.name;
        pantoneHex.textContent = pantone.hex.toUpperCase();
        
        const chipUrl = `https://www.pantone.com/media/color-finder/img/chips/pantone-color-chip-${pantone.code}.webp`;
        
        const pantoneImageContainer = document.getElementById('pantone-image-container');
        const pantoneImage = document.getElementById('pantone-image');
        const pantoneSwatchContainer = document.getElementById('pantone-swatch-container');
        const downloadBtn = document.getElementById('download-btn');
        
        // Error handling for image load
        pantoneImage.onerror = () => {
            pantoneImageContainer.style.display = 'none';
            pantoneSwatchContainer.style.display = 'flex';
            document.getElementById('pantone-swatch').style.backgroundColor = pantone.hex;
        };

        pantoneImage.onload = () => {
            pantoneImageContainer.style.display = 'block';
            pantoneSwatchContainer.style.display = 'none';
        };

        const chipUrlPath = `www.pantone.com/media/color-finder/img/chips/pantone-color-chip-${pantone.code}.webp`;
        const proxyUrl = `https://wsrv.nl/?url=${chipUrlPath}`;
        
        pantoneImage.src = proxyUrl;
        
        // Setup download button
        downloadBtn.onclick = async () => {
            try {
                downloadBtn.disabled = true;
                downloadBtn.textContent = 'Processing...';
                
                const response = await fetch(proxyUrl);
                const blob = await response.blob();
                
                // Convert blob to object URL
                const blobUrl = URL.createObjectURL(blob);
                
                // Create an off-screen image to draw on canvas
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    // Convert to PNG and download
                    const pngUrl = canvas.toDataURL('image/png');
                    const a = document.createElement('a');
                    a.href = pngUrl;
                    a.download = `pantone-${pantone.code}.png`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    
                    URL.revokeObjectURL(blobUrl);
                    downloadBtn.disabled = false;
                    downloadBtn.textContent = 'Download PNG';
                };
                img.src = blobUrl;
            } catch (err) {
                console.error('Failed to download image:', err);
                alert('Failed to download image. The Pantone server might be blocking requests.');
                downloadBtn.disabled = false;
                downloadBtn.textContent = 'Download PNG';
            }
        };
    }
    
    // Copy to clipboard features
    [pickedHex, pickedRgb, pantoneName, pantoneHex].forEach(el => {
        el.addEventListener('click', () => {
            if (el.textContent === '-') return;
            navigator.clipboard.writeText(el.textContent).then(() => {
                showToast();
            });
        });
    });
    
    function showToast() {
        const toast = document.getElementById('toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    }
});
