'use client';
import { paperBox, stretch } from './ocr-prep';

/* Leitura de foto de comanda no próprio aparelho (Tesseract.js, WebAssembly). Os arquivos do OCR e o idioma português ficam em
   /public/ocr (nada é enviado para fora e funciona sem internet depois da primeira vez). */

type Worker = import('tesseract.js').Worker;
let workerP: Promise<Worker> | null = null;
let onProgress: ((p: number) => void) | null = null;

function getWorker() {
  if (!workerP) {
    workerP = import('tesseract.js').then(T => T.createWorker('por', 1, {
      workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr', gzip: true, workerBlobURL: false,
      logger: m => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); },
    })).catch(e => { workerP = null; throw e; });
  }
  return workerP;
}

interface Gray { data: Uint8Array; w: number; h: number }

async function loadGray(file: File, maxSide: number): Promise<Gray> {
  const bmp = await createImageBitmap(file);                      // respeita a rotação EXIF da câmera
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, h); bmp.close();
  const px = g.getImageData(0, 0, w, h).data, data = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  return { data, w, h };
}

// Recorta o papel, estica o contraste e gira (0/90/270) para um canvas em tons de cinza.
function toCanvas(src: Gray, rot: 0 | 90 | 270): HTMLCanvasElement {
  const b = paperBox(src.data, src.w, src.h);
  const crop = new Uint8Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) crop.set(src.data.subarray((b.y + y) * src.w + b.x, (b.y + y) * src.w + b.x + b.w), y * b.w);
  const g = stretch(crop), rgba = new Uint8ClampedArray(b.w * b.h * 4);
  for (let i = 0; i < g.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g[i]; rgba[i * 4 + 3] = 255; }
  const base = document.createElement('canvas'); base.width = b.w; base.height = b.h;
  base.getContext('2d')!.putImageData(new ImageData(rgba, b.w, b.h), 0, 0);
  if (!rot) return base;
  const out = document.createElement('canvas'); out.width = b.h; out.height = b.w;
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2); ctx.rotate((rot * Math.PI) / 180); ctx.drawImage(base, -b.w / 2, -b.h / 2);
  return out;
}

// Lê o texto da comanda. Tenta a foto como está e, se a leitura vier ruim (foto de lado), gira 90°/270°.
export async function readComanda(file: File, progress?: (p: number, label: string) => void): Promise<string> {
  const src = await loadGray(file, 1500), worker = await getWorker();
  let best = { conf: -1, text: '' };
  const rots: (0 | 90 | 270)[] = [0, 90, 270];
  for (const [i, rot] of rots.entries()) {
    onProgress = p => progress?.((i + p) / rots.length, i ? 'Girando a foto…' : 'Lendo a comanda…');
    const r = await worker.recognize(toCanvas(src, rot));
    if (r.data.confidence > best.conf) best = { conf: r.data.confidence, text: r.data.text };
    if (best.conf >= 58) break;                                   // boa o bastante: não precisa girar
  }
  onProgress = null;
  return best.text;
}
