// Input layer: keyboard + mouse → InputFrame, sampled at 60Hz by net.ts.
// Button presses are latched so a tap between two samples is never lost.
// Keyboard movement is team-mirrored because the camera sits behind the local
// team's baseline (screen-forward is +x for team 0, -x for team 1).

import { v3 } from '../shared/physics';
import type { InputFrame, TeamId, Vec3 } from '../shared/types';

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
const ATTACK_KEYS = new Set(['KeyJ', 'KeyZ']);
const PASS_KEYS = new Set(['KeyK', 'KeyX']);
/** keys we preventDefault on so the page never scrolls mid-match */
const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export class InputManager {
  private enabled = false;
  private localTeam: TeamId = 0;
  private raycast: ((clientX: number, clientY: number) => { x: number; z: number } | null) | null =
    null;

  private keys = new Set<string>();
  private attackMouse = false;
  private passMouse = false;
  // latches survive until the next sample() so quick taps always register
  private attackLatch = false;
  private passLatch = false;
  private jumpLatch = false;

  private aim: { x: number; z: number } | null = null;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.clearHeld);
  }

  /** Renderer's court-plane unprojection; null while no renderer is mounted. */
  setRaycaster(
    fn: ((clientX: number, clientY: number) => { x: number; z: number } | null) | null,
  ): void {
    this.raycast = fn;
  }

  setLocalTeam(team: TeamId): void {
    this.localTeam = team;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.clearHeld();
      this.aim = null;
    }
  }

  /** Current aim point in court space, for the reticle. */
  getAim(): Vec3 | null {
    return this.aim ? v3(this.aim.x, 0, this.aim.z) : null;
  }

  /** Called by net.ts every 60Hz tick; consumes the latched taps. */
  sample(seq: number): InputFrame {
    const s = this.localTeam === 0 ? 1 : -1;
    let mx = 0;
    let mz = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mx += s;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mx -= s;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mz += s;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mz -= s;
      const len = Math.hypot(mx, mz);
      if (len > 1) {
        mx /= len;
        mz /= len;
      }
    }

    const frame: InputFrame = {
      seq,
      mx,
      mz,
      jump: this.enabled && (this.keys.has('Space') || this.jumpLatch),
      attack:
        this.enabled &&
        (this.attackMouse || this.hasKeyOf(ATTACK_KEYS) || this.attackLatch),
      pass: this.enabled && (this.passMouse || this.hasKeyOf(PASS_KEYS) || this.passLatch),
      ax: this.aim ? this.aim.x : 0,
      az: this.aim ? this.aim.z : 0,
    };
    this.attackLatch = false;
    this.passLatch = false;
    this.jumpLatch = false;
    return frame;
  }

  private hasKeyOf(set: Set<string>): boolean {
    for (const k of set) if (this.keys.has(k)) return true;
    return false;
  }

  private clearHeld = (): void => {
    this.keys.clear();
    this.attackMouse = false;
    this.passMouse = false;
    this.attackLatch = false;
    this.passLatch = false;
    this.jumpLatch = false;
  };

  // ── DOM handlers ──────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e.target)) return;
    if (!this.enabled) return;
    const c = e.code;
    const isGameKey =
      MOVE_KEYS.has(c) || ATTACK_KEYS.has(c) || PASS_KEYS.has(c) || c === 'Space';
    if (!isGameKey) return;
    if (SCROLL_KEYS.has(c)) e.preventDefault();
    if (!e.repeat) {
      if (c === 'Space') this.jumpLatch = true;
      if (ATTACK_KEYS.has(c)) this.attackLatch = true;
      if (PASS_KEYS.has(c)) this.passLatch = true;
    }
    this.keys.add(c);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    // clicks on UI chrome (mute, menus…) must not swing
    if (e.target instanceof Element && e.target.closest('#ui')) return;
    if (e.button === 0) {
      this.attackMouse = true;
      this.attackLatch = true;
    } else if (e.button === 2) {
      this.passMouse = true;
      this.passLatch = true;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0) this.attackMouse = false;
    else if (e.button === 2) this.passMouse = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.enabled || !this.raycast) return;
    const hit = this.raycast(e.clientX, e.clientY);
    // keep the last good point when the ray misses the court plane
    if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.z)) this.aim = hit;
  };

  private onContextMenu = (e: Event): void => {
    if (this.enabled) e.preventDefault();
  };
}
