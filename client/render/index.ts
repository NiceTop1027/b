// Presentation layer entry point — implements IRenderer from client/contracts.
// Pure consumer of ViewState/GameEvent: no netcode, no game rules in here.

import * as THREE from 'three';
import type { GameEvent, Vec3 } from '../../shared/types';
import type { IRenderer, ViewState } from '../contracts';
import { BallVisual } from './ball';
import { TEAM_COLORS } from './colors';
import { Effects } from './effects';
import { PlayerVisuals } from './players';
import { World } from './world';

export function createRenderer(): IRenderer {
  return new Renderer();
}

class Renderer implements IRenderer {
  private el: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, 1, 0.1, 300);
  private resizeObs: ResizeObserver | null = null;

  private world: World | null = null;
  private players: PlayerVisuals | null = null;
  private ball: BallVisual | null = null;
  private effects: Effects | null = null;

  private t = 0;
  private eye = new THREE.Vector3();
  private look = new THREE.Vector3();
  private eyeTarget = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private camInit = false;

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  private hit = new THREE.Vector3();

  mount(el: HTMLElement): void {
    if (this.renderer) return; // idempotent
    this.el = el;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    el.appendChild(canvas);

    this.world = new World(this.scene);
    this.scene.add(this.world.group);
    this.players = new PlayerVisuals(this.scene);
    this.ball = new BallVisual(this.scene);
    this.effects = new Effects(this.scene);

    const resize = () => this.handleResize();
    this.resizeObs = new ResizeObserver(resize);
    this.resizeObs.observe(el);
    resize();
  }

  render(view: ViewState, dt: number): void {
    if (!this.renderer || !this.world || !this.players || !this.ball || !this.effects) return;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.1); // tab-switch guard: don't fast-forward animations
    this.t += dt;

    // catch DPR changes (dragging between monitors / browser zoom) — the
    // ResizeObserver misses those when the CSS size is unchanged
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.renderer.getPixelRatio() !== dpr) this.handleResize();

    this.world.update(dt);
    this.players.sync(view, dt, this.t);
    this.ball.update(view.ball, dt);

    // ball trail while it's really moving
    const bs = Math.hypot(view.ball.vel.x, view.ball.vel.y, view.ball.vel.z);
    if (!view.ball.held && bs > 8 && Math.random() < dt * 45) {
      this.effects.trailDot(view.ball.pos);
    }

    this.effects.setLanding(view.phase === 'rally' ? view.landing : null, view.localTeam);
    this.effects.setAim(view.aim);
    this.effects.update(dt);

    this.updateCamera(view, dt);
    this.renderer.render(this.scene, this.camera);
  }

  onEvent(ev: GameEvent, view: ViewState): void {
    if (!this.effects || !this.world) return;
    const at = ev.pos ?? this.playerPos(ev.playerId, view) ?? view.ball.pos;

    switch (ev.kind) {
      case 'hit': {
        const local = ev.playerId === view.localId;
        switch (ev.hitType) {
          case 'spike':
            this.effects.spark(at, 0xfff1b8, 16, 6);
            this.effects.shake(local ? 0.2 : 0.14);
            break;
          case 'serve':
            this.effects.spark(at, 0xffffff, 8, 3.5);
            this.effects.shake(0.06);
            break;
          case 'attack':
            this.effects.spark(at, 0xffe9a8, 10, 4);
            this.effects.shake(0.08);
            break;
          default: // pass
            this.effects.spark(at, 0xffffff, 6, 2.5);
            break;
        }
        break;
      }
      case 'block': {
        const p = this.playerPos(ev.playerId, view);
        const team = view.players.find((pl) => pl.id === ev.playerId)?.team;
        this.effects.spark(at, team !== undefined ? TEAM_COLORS[team] : 0xffffff, 14, 5);
        this.effects.shake(0.12);
        if (p) this.effects.sandPuff({ x: p.x, y: 0.1, z: p.z }, 6);
        break;
      }
      case 'net':
        this.world.netImpulse(0.8);
        this.effects.shake(0.05);
        break;
      case 'netcord':
        this.world.netImpulse(1.4);
        this.effects.spark(at, 0xffffff, 8, 3);
        this.effects.shake(0.08);
        break;
      case 'land':
        this.effects.sandPuff(at, 20);
        this.effects.shake(0.12);
        break;
      case 'score':
        if (ev.team !== undefined) {
          const sideSign = ev.team === 0 ? -1 : 1;
          this.effects.confetti(
            { x: sideSign * 4, y: 3.2, z: 0 },
            TEAM_COLORS[ev.team],
            100,
          );
        }
        this.effects.shake(0.05);
        break;
      case 'matchOver':
        if (ev.team !== undefined) this.effects.confettiShow(ev.team);
        break;
      case 'denied': {
        const p = this.playerPos(ev.playerId, view);
        if (p) this.effects.spark({ x: p.x, y: p.y + 1.4, z: p.z }, 0xff5964, 6, 2);
        break;
      }
      case 'phase':
        break; // UI layer narrates phases; nothing spatial to do
    }
  }

  setBallSkin(skin: string): void {
    this.ball?.setSkin(skin);
  }

  aimRaycast(clientX: number, clientY: number): { x: number; z: number } | null {
    if (!this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const p = this.raycaster.ray.intersectPlane(this.groundPlane, this.hit);
    if (!p) return null;
    return { x: p.x, z: p.z };
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.players?.dispose();
    this.ball?.dispose();
    this.effects?.dispose();
    this.world?.dispose();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.el = null;
    this.camInit = false;
  }

  // ── internals ──────────────────────────────────────────────

  private playerPos(id: string | undefined, view: ViewState): Vec3 | null {
    if (!id) return null;
    const p = view.players.find((pl) => pl.id === id);
    return p ? p.pos : null;
  }

  private updateCamera(view: ViewState, dt: number): void {
    // camera lives behind the local team's baseline, panning gently with the ball
    const sideSign = view.localTeam === 0 ? -1 : 1;
    const bz = THREE.MathUtils.clamp(view.ball.pos.z, -6, 6);
    this.eyeTarget.set(sideSign * 15.6, 7.5, bz * 0.32);
    this.lookTarget.set(sideSign * 0.6, 1.35, bz * 0.5);

    if (!this.camInit) {
      this.eye.copy(this.eyeTarget);
      this.look.copy(this.lookTarget);
      this.camInit = true;
    } else {
      const k = 1 - Math.exp(-3.5 * dt);
      this.eye.lerp(this.eyeTarget, k);
      this.look.lerp(this.lookTarget, k);
    }

    this.camera.position.copy(this.eye);
    this.effects?.applyShake(this.camera.position);
    this.camera.lookAt(this.look);
  }

  private handleResize(): void {
    if (!this.renderer || !this.el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr);
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects?.setViewport(h * dpr);
  }
}
