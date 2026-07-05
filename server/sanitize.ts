// Security boundary: everything a client sends crosses through here before it
// can touch room or sim state. A single NaN in an InputFrame would poison the
// whole room's physics, so numeric fields are strictly validated and clamped.

import { clamp } from '../shared/physics';
import type { InputFrame } from '../shared/types';

const MAX_SEQ = 1e9;

/** Returns a fully validated InputFrame, or null if the payload is hostile/garbage. */
export function sanitizeInput(raw: unknown): InputFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const nums = [o.seq, o.mx, o.mz, o.ax, o.az];
  for (const v of nums) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  }
  const seq = Math.floor(o.seq as number);
  // A crafted huge seq would make GameSim.setInput drop every later (normal)
  // frame as stale, freezing the avatar for the match. 1e9 ≈ 193 days at 60Hz —
  // unreachable by any real session (the client seq starts at 0 per page load).
  if (seq < 0 || seq > MAX_SEQ) return null;
  return {
    seq,
    mx: clamp(o.mx as number, -1, 1),
    mz: clamp(o.mz as number, -1, 1),
    jump: !!o.jump,
    pass: !!o.pass,
    attack: !!o.attack,
    ax: clamp(o.ax as number, -30, 30),
    az: clamp(o.az as number, -30, 30),
  };
}

// C0/C1 controls, zero-width chars, bidi controls, line/para separators, BOM.
// Expressed as codepoint ranges (not a regex literal) to keep the source ASCII-clean.
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0xfeff, 0xfeff],
];

function isStrippedCp(cp: number): boolean {
  for (const [lo, hi] of STRIP_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Trim, strip control/invisible chars, cap at 12 chars (codepoint-safe). */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    if (!isStrippedCp(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return Array.from(out.trim()).slice(0, 12).join('');
}

/** Finite number or the fallback — for trivia fields like ping timestamps. */
export function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
