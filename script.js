/* Passport Photo Maker
   - Auto background removal (MediaPipe Selfie Segmentation, runs fully client-side)
   - White background fill
   - Crop to 3:4 (passport ratio) centered on detected person
   - Resize to exactly 600x800 px
   - Compress to 10KB - 25KB using JPEG quality binary search
*/

const TARGET_W = 600;
const TARGET_H = 800;
const MIN_BYTES = 10 * 1024;
const MAX_BYTES = 25 * 1024;

const fileInput   = document.getElementById('fileInput');
const dropzone     = document.getElementById('dropzone');
const uploadPanel  = document.getElementById('uploadPanel');
const processPanel = document.getElementById('processPanel');
const sourceCanvas = document.getElementById('sourceCanvas');
const resultCanvas = document.getElementById('resultCanvas');
const statusLine    = document.getElementById('statusLine');
const progressFill  = document.getElementById('progressFill');
const downloadBtn   = document.getElementById('downloadBtn');
const retryBtn      = document.getElementById('retryBtn');
const infoStrip      = document.getElementById('infoStrip');

let selfieSegmentation = null;
let modelReady = false;
let finalBlob = null;

/* ---- Model setup ---- */
function initModel() {
  selfieSegmentation = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
  });
  selfieSegmentation.setOptions({ modelSelection: 1 }); // 1 = better quality landscape/portrait model
  selfieSegmentation.onResults(onSegmentationResults);
  modelReady = true;
}

/* ---- File handling ---- */
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

['dragover', 'dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => e.preventDefault());
});
dropzone.addEventListener('dragover', () => dropzone.classList.add('dragover'));
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

retryBtn.addEventListener('click', () => {
  uploadPanel.classList.remove('hidden');
  processPanel.classList.add('hidden');
  fileInput.value = '';
  finalBlob = null;
  downloadBtn.disabled = true;
  infoStrip.textContent = '';
  infoStrip.classList.remove('ok');
});

downloadBtn.addEventListener('click', () => {
  if (!finalBlob) return;
  const url = URL.createObjectURL(finalBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'passport-photo-600x800.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

async function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Sirf image file (JPG/PNG) choose karein.');
    return;
  }
  uploadPanel.classList.add('hidden');
  processPanel.classList.remove('hidden');
  setStatus('Photo load ho rahi hai...', 8);
  infoStrip.textContent = '';
  infoStrip.classList.remove('ok');
  downloadBtn.disabled = true;

  const img = await loadImageFromFile(file);

  const sctx = sourceCanvas.getContext('2d');
  const previewScale = Math.min(1, 500 / Math.max(img.width, img.height));
  sourceCanvas.width = img.width * previewScale;
  sourceCanvas.height = img.height * previewScale;
  sctx.drawImage(img, 0, 0, sourceCanvas.width, sourceCanvas.height);

  if (!modelReady) initModel();

  setStatus('Background hata rahe hain (AI model)...', 25);
  try {
    await selfieSegmentation.send({ image: img });
  } catch (err) {
    console.error(err);
    setStatus('Model load nahi ho paya. Internet connection check karein.', 0);
    infoStrip.textContent = 'Error: background removal model fail ho gaya.';
    return;
  }

  window.__lastImage = img; // stash for onSegmentationResults
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function setStatus(text, pct) {
  statusLine.textContent = text;
  if (typeof pct === 'number') progressFill.style.width = pct + '%';
}

/* ---- Segmentation result -> white background composite -> crop -> resize -> compress ---- */
function onSegmentationResults(results) {
  const img = window.__lastImage;
  const w = img.width, h = img.height;

  // 1. Composite: keep person pixels (via mask), fill rest with white
  const compCanvas = document.createElement('canvas');
  compCanvas.width = w;
  compCanvas.height = h;
  const cctx = compCanvas.getContext('2d');

  cctx.drawImage(results.segmentationMask, 0, 0, w, h);
  cctx.globalCompositeOperation = 'source-in';
  cctx.drawImage(results.image, 0, 0, w, h);
  cctx.globalCompositeOperation = 'destination-over';
  cctx.fillStyle = '#ffffff';
  cctx.fillRect(0, 0, w, h);
  cctx.globalCompositeOperation = 'source-over';

  setStatus('Chehra detect karke crop kar rahe hain...', 55);

  // 2. Find bounding box of the person using the mask (downsampled for speed)
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  mctx.drawImage(results.segmentationMask, 0, 0, w, h);
  const maskData = mctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  const stride = 3; // sample every 3px for speed
  const threshold = 60; // alpha/luminance threshold
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const idx = (y * w + x) * 4;
      const v = maskData[idx]; // mask is grayscale, R channel holds value
      if (v > threshold) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  let cropLeft, cropTop, cropW, cropH;
  const targetRatio = TARGET_W / TARGET_H; // 0.75

  if (found) {
    const personH = maxY - minY;
    const centerX = (minX + maxX) / 2;
    // person (head+shoulders) should occupy ~78% of final photo height
    cropH = personH / 0.78;
    cropW = cropH * targetRatio;
    cropTop = minY - cropH * 0.14; // headroom above hair
    cropLeft = centerX - cropW / 2;
  } else {
    // fallback: plain center crop of full image
    if (w / h > targetRatio) {
      cropH = h;
      cropW = h * targetRatio;
    } else {
      cropW = w;
      cropH = w / targetRatio;
    }
    cropLeft = (w - cropW) / 2;
    cropTop = (h - cropH) / 2;
  }

  // 3. Build final canvas: white background, draw composite shifted, then scale to 600x800
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.round(cropW);
  cropCanvas.height = Math.round(cropH);
  const crctx = cropCanvas.getContext('2d');
  crctx.fillStyle = '#ffffff';
  crctx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  crctx.drawImage(compCanvas, -cropLeft, -cropTop);

  const rctx = resultCanvas.getContext('2d');
  resultCanvas.width = TARGET_W;
  resultCanvas.height = TARGET_H;
  rctx.fillStyle = '#ffffff';
  rctx.fillRect(0, 0, TARGET_W, TARGET_H);
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(cropCanvas, 0, 0, cropCanvas.width, cropCanvas.height, 0, 0, TARGET_W, TARGET_H);

  setStatus('File size 10-25KB range mein compress kar rahe hain...', 80);
  compressToTargetSize(resultCanvas).then(({ blob, quality, attempts }) => {
    finalBlob = blob;
    downloadBtn.disabled = false;
    setStatus('Ready! Photo neeche dekh sakte hain.', 100);
    const kb = (blob.size / 1024).toFixed(1);
    const okRange = blob.size >= MIN_BYTES && blob.size <= MAX_BYTES;
    infoStrip.textContent =
      `Final size: ${kb} KB • ${TARGET_W}×${TARGET_H}px` +
      (okRange ? ' • 10-25KB range ke andar ✓' : ' • target range ke bahar, phir bhi best result diya gaya hai');
    infoStrip.classList.toggle('ok', okRange);
  });
}

/* ---- Binary-search JPEG quality until file size lands in [MIN_BYTES, MAX_BYTES] ---- */
function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function compressToTargetSize(canvas) {
  let low = 0.05, high = 0.95;
  let best = null;
  let attempts = 0;
  const maxAttempts = 10;

  // initial guess
  let quality = 0.75;

  while (attempts < maxAttempts) {
    attempts++;
    const blob = await canvasToBlob(canvas, quality);
    const size = blob.size;

    if (!best || Math.abs(size - (MIN_BYTES + MAX_BYTES) / 2) < Math.abs(best.blob.size - (MIN_BYTES + MAX_BYTES) / 2)) {
      best = { blob, quality };
    }

    if (size >= MIN_BYTES && size <= MAX_BYTES) {
      best = { blob, quality };
      break;
    }

    if (size > MAX_BYTES) {
      high = quality;
      quality = (low + quality) / 2;
    } else {
      low = quality;
      quality = (quality + high) / 2;
    }

    if (high - low < 0.02) break;
  }

  return { blob: best.blob, quality: best.quality, attempts };
}

/* ---- Register service worker for offline/PWA use ---- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
