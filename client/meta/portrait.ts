// Procedural player portrait — a stylized jersey bust drawn from the kit colors.
// Gives every roster card a distinct "character" with zero external art.

import type { Player } from './rosterdata';

export function drawPortrait(p: Player, size = 132): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = size * dpr;
  c.height = size * dpr;
  c.style.width = c.style.height = size + 'px';
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const S = size;

  // backdrop
  const bg = g.createLinearGradient(0, 0, S * 0.3, S);
  bg.addColorStop(0, p.colors[0]);
  bg.addColorStop(1, p.colors[1]);
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  // diagonal sheen bands
  g.save();
  g.globalAlpha = 0.12;
  g.strokeStyle = '#fff';
  g.lineWidth = S * 0.16;
  g.beginPath();
  g.moveTo(-S * 0.2, S * 0.9);
  g.lineTo(S * 0.9, -S * 0.2);
  g.stroke();
  g.restore();

  // big watermark initial
  g.save();
  g.globalAlpha = 0.16;
  g.fillStyle = '#0a0c12';
  g.font = `900 ${S * 0.92}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(p.name[0], S * 0.52, S * 0.58);
  g.restore();

  // silhouette bust
  g.fillStyle = 'rgba(12,14,20,0.32)';
  g.beginPath();
  g.moveTo(S * 0.12, S);
  g.quadraticCurveTo(S * 0.5, S * 0.52, S * 0.88, S);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(S * 0.5, S * 0.42, S * 0.155, 0, Math.PI * 2);
  g.fill();

  // jersey collar highlight
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(S * 0.34, S * 0.82);
  g.quadraticCurveTo(S * 0.5, S * 0.62, S * 0.66, S * 0.82);
  g.stroke();

  // top gloss
  const gl = g.createLinearGradient(0, 0, 0, S * 0.4);
  gl.addColorStop(0, 'rgba(255,255,255,0.28)');
  gl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gl;
  g.fillRect(0, 0, S, S * 0.4);

  return c;
}

const BALL_SKIN_COLORS: Record<string, [string, string, string]> = {
  classic: ['#fbfbf7', '#ff8a3d', '#d9d5c8'],
  sunset: ['#fff1e6', '#ff4d8d', '#ffb14d'],
  neon: ['#12161f', '#39f0c4', '#7cf03a'],
  mono: ['#f4f4f4', '#2a2f3a', '#c9ccd4'],
};

export function drawBallSwatch(skin: string, size = 56): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = size * dpr;
  c.height = size * dpr;
  c.style.width = c.style.height = size + 'px';
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const [base, a, b] = BALL_SKIN_COLORS[skin] ?? BALL_SKIN_COLORS.classic;
  const R = size / 2;
  g.translate(R, R);
  // ball body
  const rg = g.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.2, 0, 0, R);
  rg.addColorStop(0, '#ffffff');
  rg.addColorStop(0.5, base);
  rg.addColorStop(1, shade(base, -0.25));
  g.fillStyle = rg;
  g.beginPath();
  g.arc(0, 0, R * 0.86, 0, Math.PI * 2);
  g.fill();
  // panels
  g.lineWidth = R * 0.16;
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    g.strokeStyle = i % 2 ? a : b;
    g.beginPath();
    const ang = (i * Math.PI * 2) / 3 - 0.4;
    g.arc(Math.cos(ang) * R * 0.5, Math.sin(ang) * R * 0.5, R * 0.6, ang + 1.2, ang + 3.0);
    g.stroke();
  }
  return c;
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    gg = (n >> 8) & 255,
    b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + r * amt)));
  gg = Math.max(0, Math.min(255, Math.round(gg + gg * amt)));
  b = Math.max(0, Math.min(255, Math.round(b + b * amt)));
  return `rgb(${r},${gg},${b})`;
}

export { BALL_SKIN_COLORS };
