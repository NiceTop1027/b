// Hand-built inline SVG icon set — one consistent 24px grid, 2px stroke, round
// joins. Using real vector icons (not emoji) is the single biggest thing that
// keeps the UI from reading as a generic template.

export type IconName =
  | 'home'
  | 'match'
  | 'shop'
  | 'mission'
  | 'roster'
  | 'settings'
  | 'coin'
  | 'ticket'
  | 'gem'
  | 'plus'
  | 'back'
  | 'exit'
  | 'volley'
  | 'bolt'
  | 'trophy'
  | 'users'
  | 'check'
  | 'lock'
  | 'star'
  | 'flame'
  | 'sound-on'
  | 'sound-off'
  | 'chevron'
  | 'copy'
  | 'code';

const P: Record<IconName, string> = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9.5h12V10"/><path d="M10 20v-5h4v5"/>',
  match:
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8c3 3 3 13.4 0 16.4M12 3.8c-3 3-3 13.4 0 16.4"/><path d="M4.2 9.2c4 1.4 11.6 1.4 15.6 0M4.2 14.8c4-1.4 11.6-1.4 15.6 0"/>',
  shop: '<path d="M4.5 8h15l-1 4.5H5.5z"/><path d="M4.5 8 5 5.5h14l.5 2.5"/><path d="M6.5 12.5V19h11v-6.5"/><path d="M9.8 8v11.5M14.2 8v11.5"/>',
  mission:
    '<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1"/>',
  roster:
    '<circle cx="9" cy="8.5" r="3.1"/><path d="M3.5 19.5c.4-3.3 2.7-5.4 5.5-5.4s5.1 2.1 5.5 5.4"/><path d="M16 6.2a3 3 0 0 1 0 5.9M17.5 19.5c-.2-2-1-3.6-2.3-4.7"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.3M12 18.1v2.3M20.4 12h-2.3M5.9 12H3.6M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"/>',
  coin: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="5.4"/><path d="M12 9.2v5.6M10.2 10.6h2.6a1.3 1.3 0 0 1 0 2.6h-2.6"/>',
  ticket:
    '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v2a1.7 1.7 0 0 0 0 3v2A1.5 1.5 0 0 1 18.5 17h-13A1.5 1.5 0 0 1 4 15.5v-2a1.7 1.7 0 0 0 0-3z"/><path d="M13 7v10" stroke-dasharray="1.6 1.8"/>',
  gem: '<path d="M7 4h10l3.5 5-8.5 11L3.5 9z"/><path d="M3.5 9h17M9 4l-2 5 5 11 5-11-2-5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  exit: '<path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14"/><path d="M18.5 12H10M15.5 8.5 19 12l-3.5 3.5"/>',
  volley:
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8c3 3 3 13.4 0 16.4M4.2 9.2c4 1.4 11.6 1.4 15.6 0M4.2 14.8c4-1.4 11.6-1.4 15.6 0"/>',
  bolt: '<path d="M13.5 3 5 13.2h5.2L9.5 21l8.5-10.2h-5.2z"/>',
  trophy:
    '<path d="M7 4.5h10V9a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5A3 3 0 0 0 7 10.4M17 6h2.5v1.5A3 3 0 0 1 17 10.4"/><path d="M10 13.6l-.6 3.4h5.2L14 13.6M8 20h8M9.5 17 9 20M14.5 17l.5 3"/>',
  users:
    '<circle cx="8.5" cy="9" r="2.7"/><circle cx="16" cy="9.5" r="2.2"/><path d="M3.5 19c.3-2.9 2.4-4.8 5-4.8s4.7 1.9 5 4.8M15 14.4c2.1.1 3.8 1.8 4.1 4.2"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="1.8"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15" r="1.1"/>',
  star: '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9l-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"/>',
  flame:
    '<path d="M12 3.5c.4 3.2-2.4 4.2-2.4 7.2 0 1.3.9 2.2 1.6 2.6-.2-1.6.6-2.7 1.3-3.3.2 2.4 2.6 3 2.6 5.6a4.7 4.7 0 0 1-9.4.2c0-4.7 5.5-6.3 6.3-12.3z"/>',
  'sound-on':
    '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15 8.5a4 4 0 0 1 0 7M17.5 6a7 7 0 0 1 0 12"/>',
  'sound-off': '<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9.5 20.5 14.5M20.5 9.5 15.5 14.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="1.8"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H5.5A1.5 1.5 0 0 0 4 6v8.5A1.5 1.5 0 0 0 5.5 16H8"/>',
  code: '<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
};

/** Solid-ish glyphs (filled, not stroked) look better for tiny currency chips. */
const FILLED = new Set<IconName>(['coin', 'gem', 'bolt', 'star', 'flame']);

/** Returns an <svg> string. `stroke`/fill inherit `currentColor`. */
export function icon(name: IconName, size = 24): string {
  const body = P[name] ?? '';
  const filled = FILLED.has(name);
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${
    filled ? 'currentColor' : 'none'
  }" stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Convenience: build a span carrying an icon. */
export function iconEl(name: IconName, size = 24, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'icon' + (cls ? ' ' + cls : '');
  s.innerHTML = icon(name, size);
  return s;
}
