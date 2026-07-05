// Player visuals: stylized capsule athletes with procedural swing animation
// driven entirely by ViewPlayer (lastHitType + lastHitAge) — no netcode here.

import * as THREE from 'three';
import { PLAYER_HEIGHT } from '../../shared/constants';
import type { ViewPlayer, ViewState } from '../contracts';
import { TEAM_COLORS } from './colors';

const SWING_DUR = 0.38;

export class PlayerVisuals {
  private map = new Map<string, PlayerVisual>();

  constructor(private parent: THREE.Object3D) {}

  sync(view: ViewState, dt: number, t: number): void {
    const seen = new Set<string>();
    for (const vp of view.players) {
      seen.add(vp.id);
      let vis = this.map.get(vp.id);
      if (!vis) {
        vis = new PlayerVisual(vp);
        this.parent.add(vis.group);
        this.map.set(vp.id, vis);
      }
      vis.update(vp, dt, t);
    }
    for (const [id, vis] of this.map) {
      if (!seen.has(id)) {
        this.parent.remove(vis.group);
        vis.dispose();
        this.map.delete(id);
      }
    }
  }

  dispose(): void {
    for (const [, vis] of this.map) {
      this.parent.remove(vis.group);
      vis.dispose();
    }
    this.map.clear();
  }
}

class PlayerVisual {
  readonly group = new THREE.Group();

  private body: THREE.Mesh;
  private bodyMat: THREE.MeshStandardMaterial;
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private localRing: THREE.Mesh | null = null;
  private nameSprite: THREE.Sprite;
  private nameCanvas: HTMLCanvasElement;
  private nameTex: THREE.CanvasTexture;
  private lastNameKey = '';

  private yaw = 0;
  private wasOnGround = true;
  private squashT = 1; // elapsed since landing; > SQUASH_DUR means done
  private phase = Math.random() * Math.PI * 2; // idle sway offset

  constructor(vp: ViewPlayer) {
    const teamColor = TEAM_COLORS[vp.team];
    this.bodyMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.75 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd9b0, roughness: 0.8 });

    // torso
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.75, 6, 14), this.bodyMat);
    this.body.position.y = 0.94;
    this.body.castShadow = true;
    this.group.add(this.body);

    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), skinMat);
    head.position.y = 1.62;
    head.castShadow = true;
    this.group.add(head);

    // visor/headband in team color for silhouette
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.215, 0.215, 0.07, 14), this.bodyMat);
    band.position.y = 1.68;
    this.group.add(band);

    // arms — pivot at the shoulder, capsule hangs down (-y)
    const armGeo = new THREE.CapsuleGeometry(0.085, 0.42, 4, 8);
    for (const [holder, sx] of [
      [this.armL, -1],
      [this.armR, 1],
    ] as Array<[THREE.Group, number]>) {
      const arm = new THREE.Mesh(armGeo, skinMat);
      arm.position.y = -0.28;
      arm.castShadow = true;
      holder.add(arm);
      holder.position.set(sx * 0.36, 1.38, 0);
      this.group.add(holder);
    }

    // local-player ring
    if (vp.isLocal) {
      this.localRing = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.62, 36),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        }),
      );
      this.localRing.rotation.x = -Math.PI / 2;
      this.localRing.position.y = 0.014;
      this.group.add(this.localRing);
    }

    // floating name
    this.nameCanvas = document.createElement('canvas');
    this.nameCanvas.width = 256;
    this.nameCanvas.height = 64;
    this.nameTex = new THREE.CanvasTexture(this.nameCanvas);
    this.nameTex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: this.nameTex, transparent: true, depthWrite: false });
    this.nameSprite = new THREE.Sprite(mat);
    this.nameSprite.scale.set(1.9, 0.475, 1);
    this.nameSprite.position.y = PLAYER_HEIGHT + 0.42;
    this.group.add(this.nameSprite);

    this.drawName(vp);
    this.yaw = vp.team === 0 ? Math.PI / 2 : -Math.PI / 2; // face the net
  }

  update(vp: ViewPlayer, dt: number, t: number): void {
    this.group.position.set(vp.pos.x, vp.pos.y, vp.pos.z);

    // team/bot/name can change mid-match (leaver replaced by a bot)
    const key = `${vp.name}|${vp.isBot}`;
    if (key !== this.lastNameKey) this.drawName(vp);
    this.bodyMat.color.setHex(TEAM_COLORS[vp.team]);

    // ── facing: movement direction, else square up to the net ──
    const speed = Math.hypot(vp.vel.x, vp.vel.z);
    let targetYaw: number;
    if (speed > 0.6) targetYaw = Math.atan2(vp.vel.x, vp.vel.z);
    else targetYaw = vp.team === 0 ? Math.PI / 2 : -Math.PI / 2;
    this.yaw = lerpAngle(this.yaw, targetYaw, 1 - Math.exp(-10 * dt));
    this.group.rotation.y = this.yaw;

    // ── landing squash / air stretch ──
    if (!this.wasOnGround && vp.onGround) this.squashT = 0;
    this.wasOnGround = vp.onGround;
    this.squashT += dt;
    let sy = 1;
    const SQUASH_DUR = 0.22;
    if (this.squashT < SQUASH_DUR) {
      const p = this.squashT / SQUASH_DUR;
      sy = 1 - 0.17 * Math.sin(Math.PI * p);
    } else if (!vp.onGround) {
      sy = 1.05;
    }
    this.body.scale.set(1 + (1 - sy) * 0.6, sy, 1 + (1 - sy) * 0.6);

    // ── arms ──
    const swinging = vp.lastHitType !== null && vp.lastHitAge >= 0 && vp.lastHitAge < SWING_DUR;
    if (swinging) {
      this.poseSwing(vp.lastHitType!, vp.lastHitAge / SWING_DUR);
    } else if (!vp.onGround) {
      // airborne, not swinging → arms up, ready to block
      this.armL.rotation.x = -2.6;
      this.armR.rotation.x = -2.6;
      this.armL.rotation.z = 0.25;
      this.armR.rotation.z = -0.25;
    } else if (speed > 1.2) {
      // run cycle
      const sw = Math.sin(t * 11 + this.phase) * 0.55 * Math.min(1, speed / 6);
      this.armL.rotation.x = sw;
      this.armR.rotation.x = -sw;
      this.armL.rotation.z = 0.1;
      this.armR.rotation.z = -0.1;
    } else {
      // idle sway
      const sw = Math.sin(t * 1.8 + this.phase) * 0.07;
      this.armL.rotation.x = sw;
      this.armR.rotation.x = -sw;
      this.armL.rotation.z = 0.12;
      this.armR.rotation.z = -0.12;
    }

    if (this.localRing) {
      const m = this.localRing.material as THREE.MeshBasicMaterial;
      m.opacity = 0.4 + 0.2 * Math.sin(t * 4);
      this.localRing.scale.setScalar(1 + 0.06 * Math.sin(t * 4));
      // ring stays flat on the sand even while the player jumps
      this.localRing.position.y = 0.014 - vp.pos.y;
    }
  }

  /** p in [0,1) through the swing. Rotation 0 = arm hanging; negative x = raise forward/up. */
  private poseSwing(hit: string, p: number): void {
    switch (hit) {
      case 'pass': {
        // two-arm bump: swing forward-down together and back
        const a = -1.15 * Math.sin(Math.PI * Math.min(1, p * 1.15));
        this.armL.rotation.x = a;
        this.armR.rotation.x = a;
        this.armL.rotation.z = 0.3;
        this.armR.rotation.z = -0.3;
        break;
      }
      case 'block': {
        this.armL.rotation.x = -2.95;
        this.armR.rotation.x = -2.95;
        this.armL.rotation.z = 0.12;
        this.armR.rotation.z = -0.12;
        break;
      }
      default: {
        // serve / attack / spike: right-arm windmill
        let a: number;
        if (p < 0.35) a = ease(p / 0.35) * -2.9; // wind up over the head
        else a = -2.9 + ease((p - 0.35) / 0.65) * 2.55; // snap through
        this.armR.rotation.x = a;
        this.armR.rotation.z = -0.15;
        this.armL.rotation.x = -0.5 * Math.sin(Math.PI * p);
        this.armL.rotation.z = 0.35;
        break;
      }
    }
  }

  private drawName(vp: ViewPlayer): void {
    this.lastNameKey = `${vp.name}|${vp.isBot}`;
    const g = this.nameCanvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 64);
    const label = vp.isBot ? `\u{1F916} ${vp.name}` : vp.name;
    let size = 30;
    g.font = `700 ${size}px system-ui, 'Segoe UI', sans-serif`;
    while (g.measureText(label).width > 236 && size > 14) {
      size -= 2;
      g.font = `700 ${size}px system-ui, 'Segoe UI', sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(20,26,34,0.7)';
    g.strokeText(label, 128, 34);
    g.fillStyle = vp.isBot ? '#cfd8dc' : '#ffffff';
    g.fillText(label, 128, 34);
    this.nameTex.needsUpdate = true;
  }

  dispose(): void {
    this.nameTex.dispose();
    (this.nameSprite.material as THREE.SpriteMaterial).dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
  }
}

function ease(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
