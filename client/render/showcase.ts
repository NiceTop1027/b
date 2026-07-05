// Living menu backdrop: a self-contained golden-hour scene where a full team
// warms up with a looping rally (approach → jump-spike → dig → toss). It reuses
// the real World/PlayerVisuals/BallVisual so the menu and the match share one
// art direction — this is what keeps the front-end from reading as flat UI.

import * as THREE from 'three';
import type { HitType, TeamId, Vec3 } from '../../shared/types';
import type { ViewBall, ViewPlayer, ViewState } from '../contracts';
import { BallVisual } from './ball';
import { PlayerVisuals } from './players';
import { World } from './world';

export interface Showcase {
  mount(el: HTMLElement): void;
  /** pause/resume the render loop (e.g. while a match owns the GPU) */
  setActive(on: boolean): void;
  dispose(): void;
}

export function createShowcase(): Showcase {
  return new ShowcaseImpl();
}

const LOOP = 3.6; // seconds per rally cycle
const NEAR: TeamId = 0;
const FAR: TeamId = 1;

// key touch moments in the loop, in seconds
const T_SPIKE = 0.0; // near spiker contacts (also the loop seam)
const T_DIG = 1.6; // far digger contacts

// contact points
const P_SPIKE: Vec3 = { x: -1.0, y: 2.55, z: -0.6 };
const P_DIG: Vec3 = { x: 5.2, y: 1.0, z: 0.9 };
const P_TOSS_APEX = 3.4; // apex height of the dig→spiker arc

function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Parabolic arc between two points passing through `apexY`. */
function arc(from: Vec3, to: Vec3, apexY: number, u: number): Vec3 {
  const t = Math.min(1, Math.max(0, u));
  // height: quadratic that starts at from.y, ends at to.y, bulges to ~apexY
  const base = lerp(from.y, to.y, t);
  const bulge = 4 * (apexY - Math.max(from.y, to.y)) * t * (1 - t);
  return { x: lerp(from.x, to.x, t), y: base + Math.max(0, bulge), z: lerp(from.z, to.z, t) };
}

interface Actor {
  id: string;
  team: TeamId;
  base: Vec3; // resting position
}

class ShowcaseImpl implements Showcase {
  private el: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
  private world: World | null = null;
  private players: PlayerVisuals | null = null;
  private ball: BallVisual | null = null;
  private resizeObs: ResizeObserver | null = null;
  private raf = 0;
  private active = false;
  private last = 0;
  private t = 0; // wall time for animation phases
  private eye = new THREE.Vector3(-13.4, 6.6, 2.4);
  private look = new THREE.Vector3(0, 1.5, 0);

  private actors: Actor[] = [
    { id: 'sc-spiker', team: NEAR, base: { x: -5.6, y: 0, z: -1.4 } },
    { id: 'sc-setter', team: NEAR, base: { x: -2.4, y: 0, z: 2.2 } },
    { id: 'sc-digger', team: FAR, base: { x: 5.2, y: 0, z: 0.9 } },
    { id: 'sc-oppo', team: FAR, base: { x: 2.6, y: 0, z: -2.4 } },
  ];

  mount(el: HTMLElement): void {
    if (this.renderer) return;
    this.el = el;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    const canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    el.appendChild(canvas);
    this.renderer = renderer;

    this.world = new World(this.scene);
    this.scene.add(this.world.group);
    this.players = new PlayerVisuals(this.scene);
    this.ball = new BallVisual(this.scene);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(el);
    this.resize();

    this.setActive(true);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private resize(): void {
    if (!this.renderer || !this.el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr);
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame = (now: number): void => {
    if (!this.active) return;
    this.raf = requestAnimationFrame(this.frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.05);
    this.t += dt;

    const view = this.compose();
    this.world?.update(dt);
    this.players?.sync(view, dt, this.t);
    this.ball?.update(view.ball, dt);
    this.updateCamera(dt, view.ball.pos);
    this.renderer?.render(this.scene, this.camera);
  };

  // ── choreography ──────────────────────────────────────────

  private compose(): ViewState {
    const lt = ((this.t % LOOP) + LOOP) % LOOP; // loop time
    const ballPos = this.ballAt(lt);
    const ballPrev = this.ballAt((lt - 1 / 60 + LOOP) % LOOP);
    const vel: Vec3 = {
      x: (ballPos.x - ballPrev.x) * 60,
      y: (ballPos.y - ballPrev.y) * 60,
      z: (ballPos.z - ballPrev.z) * 60,
    };

    const players: ViewPlayer[] = this.actors.map((a) => this.actorView(a, lt));
    const ball: ViewBall = { pos: ballPos, vel, held: false };

    return {
      phase: 'rally',
      players,
      ball,
      score: [0, 0],
      servingTeam: 0,
      serverId: null,
      localTeam: 0,
      localId: '',
      landing: null,
      aim: null,
    };
  }

  /** Ball path across the loop: spike (near→far), dig (far, pops up), toss arc back to spiker. */
  private ballAt(lt: number): Vec3 {
    if (lt < T_DIG) {
      // spike travelling to the digger — fast, low, slight drop
      const u = lt / T_DIG;
      return arc(P_SPIKE, P_DIG, 2.9, u);
    }
    // dig pops up, then a high toss arcs back to the spike contact point for the seam
    const u = (lt - T_DIG) / (LOOP - T_DIG);
    return arc(P_DIG, P_SPIKE, P_TOSS_APEX, u);
  }

  private actorView(a: Actor, lt: number): ViewPlayer {
    let pos: Vec3 = { ...a.base };
    let onGround = true;
    let lastHitType: HitType | null = null;
    let lastHitAge = 99;

    if (a.id === 'sc-spiker') {
      // approach in the last ~0.9s of the loop, jump, and contact at the seam
      const toContact = LOOP - lt; // time until the next spike (at loop end)
      const approach = 0.95;
      if (toContact < approach) {
        const k = smooth(1 - toContact / approach);
        pos.x = lerp(a.base.x, P_SPIKE.x, k);
        pos.z = lerp(a.base.z, P_SPIKE.z, k);
        pos.y = Math.max(0, jumpCurve(1 - toContact / approach) * P_SPIKE.y);
        onGround = pos.y < 0.05;
      } else if (lt < 0.42) {
        // just spiked: descend from the contact point and show the swing
        const p = lt / 0.42;
        pos.x = lerp(P_SPIKE.x, a.base.x, smooth(p));
        pos.z = lerp(P_SPIKE.z, a.base.z, smooth(p));
        pos.y = Math.max(0, P_SPIKE.y * (1 - jumpCurveDown(p)));
        onGround = pos.y < 0.05;
        lastHitType = 'spike';
        lastHitAge = lt;
      }
    } else if (a.id === 'sc-digger') {
      // slide under the incoming spike and dig it just before T_DIG
      const toDig = T_DIG - lt;
      if (toDig > 0 && toDig < 0.7) {
        const k = smooth(1 - toDig / 0.7);
        pos.x = lerp(a.base.x, P_DIG.x, k);
        pos.z = lerp(a.base.z, P_DIG.z, k);
        pos.y = 0.12 * Math.sin(k * Math.PI); // small crouch/hop
      } else if (lt >= T_DIG && lt < T_DIG + 0.42) {
        lastHitType = 'pass';
        lastHitAge = lt - T_DIG;
        const p = (lt - T_DIG) / 0.42;
        pos.x = lerp(P_DIG.x, a.base.x, smooth(p) * 0.5);
        pos.z = lerp(P_DIG.z, a.base.z, smooth(p) * 0.5);
      }
    } else if (a.id === 'sc-setter') {
      // drift toward the net as if ready to set, gentle idle otherwise
      const sway = Math.sin(this.t * 0.7 + 1.3) * 0.5;
      pos.x = a.base.x + sway * 0.4;
      pos.z = a.base.z + Math.cos(this.t * 0.6) * 0.3;
    } else {
      // opponent blocker: shadow the ball's z near the net
      const target = THREE.MathUtils.clamp(this.ballAt(lt).z, -3, 3);
      pos.z = lerp(a.base.z, target, 0.4) + Math.sin(this.t * 0.9) * 0.2;
    }

    const vel: Vec3 = { x: 0, y: 0, z: 0 };
    return {
      id: a.id,
      name: '',
      team: a.team,
      isBot: false,
      isLocal: false,
      pos,
      vel,
      onGround,
      lastHitType,
      lastHitAge,
    };
  }

  // ── camera ────────────────────────────────────────────────

  private updateCamera(dt: number, ballPos: Vec3): void {
    // slow cinematic push-in with a gentle azimuth drift; frames the near court
    const az = Math.sin(this.t * 0.09) * 0.5;
    const radius = 14.3 + Math.sin(this.t * 0.06) * 1.1;
    const targetEye = new THREE.Vector3(
      -Math.cos(az) * radius,
      6.5 + Math.sin(this.t * 0.11) * 0.5,
      Math.sin(az) * radius + 1.6,
    );
    const targetLook = new THREE.Vector3(
      lerp(0.2, ballPos.x, 0.14),
      lerp(1.5, ballPos.y, 0.12),
      lerp(0.4, ballPos.z, 0.14),
    );
    const k = 1 - Math.exp(-2.2 * dt);
    this.eye.lerp(targetEye, k);
    this.look.lerp(targetLook, k);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.look);
  }

  dispose(): void {
    this.setActive(false);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.players?.dispose();
    this.ball?.dispose();
    this.world?.dispose();
    this.scene.clear();
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.el = null;
  }
}

/** 0→1→0-ish rise used for the spiker's jump on approach (peaks near the end). */
function jumpCurve(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  // rise steeply, peak at ~0.85 of the approach so contact is near the apex
  return Math.sin(Math.min(1, c / 0.9) * Math.PI * 0.5) ** 1.4;
}

function jumpCurveDown(p: number): number {
  const c = Math.min(1, Math.max(0, p));
  return c * c;
}
