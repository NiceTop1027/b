// Tiny DOM helpers so screen code reads declaratively without a framework.

type Attrs = Record<string, string | number | boolean | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | string = {},
  children: Array<Node | string> | string = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (typeof attrs === 'string') {
    e.className = attrs;
  } else {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'html') e.innerHTML = String(v);
      else if (k === 'text') e.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (typeof v === 'boolean') {
        if (v) e.setAttribute(k, '');
      } else {
        e.setAttribute(k, String(v));
      }
    }
  }
  const kids = typeof children === 'string' ? [children] : children;
  for (const c of kids) e.append(c);
  return e;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** requestAnimationFrame-based number tween for currency count-ups. */
export function tweenNumber(
  el: HTMLElement,
  from: number,
  to: number,
  ms = 700,
  fmt: (n: number) => string = formatCompact,
): void {
  const start = performance.now();
  const step = (now: number): void => {
    const p = Math.min(1, (now - start) / ms);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 12_400 → "12.4K", 1_250_000 → "1.25M" */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return trim(n / 1_000_000) + 'M';
  if (abs >= 1_000) return trim(n / 1_000) + 'K';
  return String(n);
}

function trim(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Ripple on pointer-down for tactile buttons. */
export function attachRipple(el: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => {
    const rect = el.getBoundingClientRect();
    const r = document.createElement('span');
    r.className = 'ripple';
    const size = Math.max(rect.width, rect.height);
    r.style.width = r.style.height = size + 'px';
    r.style.left = e.clientX - rect.left - size / 2 + 'px';
    r.style.top = e.clientY - rect.top - size / 2 + 'px';
    el.appendChild(r);
    r.addEventListener('animationend', () => r.remove());
  });
}
