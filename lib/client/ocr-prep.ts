/* Pré-processamento de foto de comanda térmica (papel amassado, fundo escuro, luz irregular) antes do OCR.
   Funciona sobre uma imagem em tons de cinza (1 byte por pixel); não depende do navegador.
   Testado com fotos reais: binarizar (limiar) piora (o fundo vira ruído); o que ajuda é esticar o contraste e recortar só o papel. */

// Estica o contraste usando os percentis 2% e 98% (a foto quase nunca usa o preto e o branco inteiros).
export function stretch(gray: Uint8Array): Uint8Array {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;
  const cut = (p: number) => { let a = 0; const t = gray.length * p; for (let i = 0; i < 256; i++) { a += hist[i]; if (a >= t) return i; } return 255; };
  const lo = cut(0.02), hi = Math.max(lo + 1, cut(0.98)), out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = Math.max(0, Math.min(255, ((gray[i] - lo) * 255) / (hi - lo)));
  return out;
}

export interface Box { x: number; y: number; w: number; h: number }

// Retângulo do papel: linhas e colunas onde há bastante pixel claro (o papel é bem mais claro que o fundo e que os dedos).
export function paperBox(gray: Uint8Array, w: number, h: number): Box {
  const s = stretch(gray), thr = 150, rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (s[y * w + x] > thr) { rows[y]++; cols[x]++; }
  const span = (cnt: Uint32Array, size: number, other: number) => {
    const min = other * 0.12;
    let a = 0, b = size - 1;
    while (a < size && cnt[a] < min) a++;
    while (b > a && cnt[b] < min) b--;
    return [a, b] as const;
  };
  const [y0, y1] = span(rows, h, w), [x0, x1] = span(cols, w, h);
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  // se achou pouca coisa (foto sem papel claro), não recorta
  return box.w < w * 0.25 || box.h < h * 0.25 ? { x: 0, y: 0, w, h } : box;
}
