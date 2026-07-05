// Ball visual: striped beach volleyball with velocity-driven spin and a
// contact-shadow blob on the sand (gameplay aid: exact ground point).

import * as THREE from 'three';
import { BALL_R } from '../../shared/constants';
import type { ViewBall } from '../contracts';

// Panel palettes per cosmetic skin: [base, panelA, panelB, seam].
const SKINS: Record<string, [string, string, string, string]> = {
  classic: ['#f8f6ef', '#ffd23f', '#2f8fde', 'rgba(60,50,30,0.25)'],
  sunset: ['#fff1e6', '#ff4d8d', '#ffb14d', 'rgba(90,30,50,0.22)'],
  neon: ['#12161f', '#39f0c4', '#7cf03a', 'rgba(0,0,0,0.5)'],
  mono: ['#f4f4f4', '#2a2f3a', '#c9ccd4', 'rgba(20,20,26,0.3)'],
};

export class BallVisual {
  readonly group = new THREE.Group();

  private mesh: THREE.Mesh;
  private blob: THREE.Mesh;
  private tex: THREE.CanvasTexture;
  private mat: THREE.MeshStandardMaterial;
  private skin = 'classic';
  private axis = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    this.tex = makeBallTexture(this.skin);
    this.mat = new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.55 });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 24, 18), this.mat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    this.blob = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.15, 24),
      new THREE.MeshBasicMaterial({
        color: 0x33240f,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    parent.add(this.group);
    parent.add(this.blob);
  }

  /** Swap the cosmetic panel skin (regenerates the canvas texture). */
  setSkin(skin: string): void {
    if (skin === this.skin || !SKINS[skin]) return;
    this.skin = skin;
    const next = makeBallTexture(skin);
    this.mat.map = next;
    this.mat.needsUpdate = true;
    this.tex.dispose();
    this.tex = next;
  }

  update(ball: ViewBall, dt: number): void {
    this.group.position.set(ball.pos.x, ball.pos.y, ball.pos.z);

    // spin around the axis perpendicular to travel
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
    if (!ball.held && speed > 0.2) {
      this.axis.set(ball.vel.z, 0, -ball.vel.x);
      if (this.axis.lengthSq() < 1e-6) this.axis.set(1, 0, 0);
      this.axis.normalize();
      this.mesh.rotateOnWorldAxis(this.axis, (speed / BALL_R) * 0.35 * dt);
    }

    // contact shadow under the ball
    this.blob.position.set(ball.pos.x, 0.011, ball.pos.z);
    const h = Math.max(0, ball.pos.y - BALL_R);
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.3 * Math.max(0.15, 1 - h / 9);
    this.blob.scale.setScalar(1 + h * 0.06);
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
  }
}

function makeBallTexture(skin: string): THREE.CanvasTexture {
  const [base, a, b, seam] = SKINS[skin] ?? SKINS.classic;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  // panels: base / A / base / B, repeated
  const bands = [base, a, base, b];
  const w = 256 / 8;
  for (let i = 0; i < 8; i++) {
    g.fillStyle = bands[i % 4];
    g.fillRect(i * w, 0, w, 128);
  }
  g.strokeStyle = seam;
  g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    g.beginPath();
    g.moveTo(i * w, 0);
    g.lineTo(i * w, 128);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
