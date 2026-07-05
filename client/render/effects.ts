// Fire-and-forget presentation effects: a pooled point-particle system
// (sand puffs, hit sparks, confetti, ball trail), the landing ring, the aim
// reticle, and camera shake. Everything is driven by update(dt) — no timers.

import * as THREE from 'three';
import { COURT_HALF_LEN, COURT_HALF_WID } from '../../shared/constants';
import type { TeamId, Vec3 } from '../../shared/types';
import { CONFETTI_COLORS, TEAM_COLORS } from './colors';

const MAX_PARTICLES = 1024;

interface EmitOpts {
  pos: Vec3;
  vel: Vec3;
  color: number;
  size: number;
  life: number;
  gravity?: number;
  drag?: number;
}

export class Effects {
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private points: THREE.Points;

  private positions = new Float32Array(MAX_PARTICLES * 3);
  private colors = new Float32Array(MAX_PARTICLES * 3);
  private sizes = new Float32Array(MAX_PARTICLES);
  private alphas = new Float32Array(MAX_PARTICLES);
  private velocities = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private gravity = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private cursor = 0;

  private landingRing: THREE.Mesh;
  private aimRing: THREE.Mesh;
  private aimDot: THREE.Mesh;

  private shakeMag = 0;
  private t = 0;
  private pending: Array<{ at: number; fn: () => void }> = [];
  private tmpColor = new THREE.Color();

  constructor(parent: THREE.Object3D) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float ps = aSize * uScale / max(0.1, -mv.z);
          gl_PointSize = min(ps, 72.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float m = smoothstep(0.5, 0.3, length(d));
          float a = vAlpha * m;
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    parent.add(this.points);

    // ── landing ring ──
    this.landingRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.position.y = 0.02;
    this.landingRing.visible = false;
    this.landingRing.renderOrder = 5;
    parent.add(this.landingRing);

    // ── aim reticle ──
    const aimMat = new THREE.MeshBasicMaterial({
      color: 0x4dd7ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.aimRing = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 32), aimMat);
    this.aimRing.rotation.x = -Math.PI / 2;
    this.aimRing.position.y = 0.022;
    this.aimRing.visible = false;
    this.aimRing.renderOrder = 6;
    parent.add(this.aimRing);
    this.aimDot = new THREE.Mesh(new THREE.CircleGeometry(0.07, 16), aimMat);
    this.aimDot.rotation.x = -Math.PI / 2;
    this.aimDot.position.y = 0.022;
    this.aimDot.visible = false;
    this.aimDot.renderOrder = 6;
    parent.add(this.aimDot);
  }

  /** Called on resize: drawing-buffer height in device pixels drives point sizing. */
  setViewport(deviceHeight: number): void {
    this.mat.uniforms.uScale.value = deviceHeight * 0.9;
  }

  // ── per-frame ───────────────────────────────────────────────

  update(dt: number): void {
    this.t += dt;

    // scheduled one-shots (confetti barrage)
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.t >= this.pending[i].at) {
        const { fn } = this.pending[i];
        this.pending.splice(i, 1);
        fn();
      }
    }

    // particles
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      const i3 = i * 3;
      this.velocities[i3 + 1] -= this.gravity[i] * dt;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.velocities[i3] *= d;
      this.velocities[i3 + 1] *= d;
      this.velocities[i3 + 2] *= d;
      this.positions[i3] += this.velocities[i3] * dt;
      this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;
      if (this.positions[i3 + 1] < 0.02) {
        this.positions[i3 + 1] = 0.02;
        this.velocities[i3 + 1] = 0;
        this.velocities[i3] *= 0.85;
        this.velocities[i3 + 2] *= 0.85;
      }
      const frac = this.life[i] / this.maxLife[i];
      this.alphas[i] = Math.min(1, frac * 2.2);
    }
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('aAlpha').needsUpdate = true;
    this.geo.getAttribute('aColor').needsUpdate = true;
    this.geo.getAttribute('aSize').needsUpdate = true;

    // rings pulse
    if (this.landingRing.visible) {
      this.landingRing.scale.setScalar(1 + 0.13 * Math.sin(this.t * 7));
    }
    if (this.aimRing.visible) {
      this.aimRing.scale.setScalar(1 + 0.1 * Math.sin(this.t * 5));
    }

    // shake decay
    this.shakeMag *= Math.exp(-4.5 * dt);
    if (this.shakeMag < 0.001) this.shakeMag = 0;
  }

  /** Random camera offset for the current frame. */
  applyShake(out: THREE.Vector3): void {
    if (this.shakeMag <= 0) return;
    out.x += (Math.random() - 0.5) * this.shakeMag * 0.6;
    out.y += (Math.random() - 0.5) * this.shakeMag * 0.45;
    out.z += (Math.random() - 0.5) * this.shakeMag * 0.6;
  }

  shake(m: number): void {
    this.shakeMag = Math.min(0.6, this.shakeMag + m);
  }

  // ── indicators ─────────────────────────────────────────────

  setLanding(landing: Vec3 | null, localTeam: TeamId): void {
    if (!landing) {
      this.landingRing.visible = false;
      return;
    }
    this.landingRing.visible = true;
    this.landingRing.position.set(landing.x, 0.02, landing.z);
    const inCourt =
      Math.abs(landing.x) <= COURT_HALF_LEN && Math.abs(landing.z) <= COURT_HALF_WID;
    const mySide = localTeam === 0 ? -1 : 1;
    const mat = this.landingRing.material as THREE.MeshBasicMaterial;
    if (!inCourt) mat.color.setHex(0x9aa4ad); // dropping out
    else if (Math.sign(landing.x) === mySide) mat.color.setHex(0xff4d4d); // danger: our sand
    else mat.color.setHex(0xffd54d); // landing on theirs
  }

  setAim(aim: Vec3 | null): void {
    const on = !!aim;
    this.aimRing.visible = on;
    this.aimDot.visible = on;
    if (aim) {
      this.aimRing.position.set(aim.x, 0.022, aim.z);
      this.aimDot.position.set(aim.x, 0.022, aim.z);
    }
  }

  // ── bursts ─────────────────────────────────────────────────

  sandPuff(pos: Vec3, n = 16): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.5 + Math.random() * 2.5;
      this.emit({
        pos: { x: pos.x, y: Math.max(0.05, Math.min(pos.y, 0.4)), z: pos.z },
        vel: { x: Math.cos(a) * r, y: 1.5 + Math.random() * 2.5, z: Math.sin(a) * r },
        color: Math.random() < 0.5 ? 0xdec08e : 0xc9a771,
        size: 0.09 + Math.random() * 0.07,
        life: 0.4 + Math.random() * 0.3,
        gravity: 9,
        drag: 1.5,
      });
    }
  }

  spark(pos: Vec3, color: number, n = 10, speed = 4): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.3) * Math.PI;
      const s = speed * (0.5 + Math.random() * 0.7);
      this.emit({
        pos,
        vel: {
          x: Math.cos(a) * Math.cos(b) * s,
          y: Math.sin(b) * s + 1,
          z: Math.sin(a) * Math.cos(b) * s,
        },
        color: Math.random() < 0.35 ? 0xffffff : color,
        size: 0.06 + Math.random() * 0.05,
        life: 0.25 + Math.random() * 0.2,
        gravity: 6,
        drag: 2,
      });
    }
  }

  confetti(pos: Vec3, teamColor: number | null, n = 90): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1 + Math.random() * 3.5;
      const palette = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const useTeam = teamColor !== null && Math.random() < 0.45;
      this.emit({
        pos,
        vel: { x: Math.cos(a) * r, y: 3.5 + Math.random() * 4.5, z: Math.sin(a) * r },
        color: useTeam ? teamColor : palette,
        size: 0.12 + Math.random() * 0.1,
        life: 1.2 + Math.random() * 0.8,
        gravity: 4.5,
        drag: 0.9,
      });
    }
  }

  /** Winner-side celebration: several confetti bursts over ~2.5 s. */
  confettiShow(team: TeamId): void {
    const sideSign = team === 0 ? -1 : 1;
    const color = TEAM_COLORS[team];
    for (let i = 0; i < 6; i++) {
      const at = this.t + i * 0.45;
      this.pending.push({
        at,
        fn: () =>
          this.confetti(
            {
              x: sideSign * (2 + Math.random() * 5),
              y: 3 + Math.random() * 2.5,
              z: (Math.random() - 0.5) * 6,
            },
            color,
            70,
          ),
      });
    }
  }

  /** Faint trail dot at the ball's position (called by the renderer when it's fast). */
  trailDot(pos: Vec3): void {
    this.emit({
      pos,
      vel: { x: 0, y: 0, z: 0 },
      color: 0xffffff,
      size: 0.1,
      life: 0.22,
      gravity: 0,
      drag: 0,
    });
  }

  private emit(o: EmitOpts): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    const i3 = i * 3;
    this.positions[i3] = o.pos.x;
    this.positions[i3 + 1] = o.pos.y;
    this.positions[i3 + 2] = o.pos.z;
    this.velocities[i3] = o.vel.x;
    this.velocities[i3 + 1] = o.vel.y;
    this.velocities[i3 + 2] = o.vel.z;
    this.tmpColor.setHex(o.color);
    this.colors[i3] = this.tmpColor.r;
    this.colors[i3 + 1] = this.tmpColor.g;
    this.colors[i3 + 2] = this.tmpColor.b;
    this.sizes[i] = o.size;
    this.alphas[i] = 1;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.gravity[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.landingRing.geometry.dispose();
    (this.landingRing.material as THREE.Material).dispose();
    this.aimRing.geometry.dispose();
    (this.aimRing.material as THREE.Material).dispose();
    this.aimDot.geometry.dispose();
  }
}
