// Static beach world: sky, sun, sea, sand, court lines, net, dunes, palms.
// Owns the net-wobble animation (impulsed by net/netcord events).

import * as THREE from 'three';
import { COURT_HALF_LEN, COURT_HALF_WID, NET_HALF_WIDTH, NET_TOP } from '../../shared/constants';
import {
  FOG_COLOR,
  LINE_COLOR,
  SAND_COLOR,
  SAND_COURT_COLOR,
  SAND_DARK,
  SEA_COLOR,
  SKY_BOTTOM,
  SKY_TOP,
} from './colors';

export class World {
  readonly group = new THREE.Group();

  private netGroup = new THREE.Group();
  private netWobble = 0;
  private t = 0;
  private skyTex: THREE.CanvasTexture;
  private netTex: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    // ── sky & fog ──
    this.skyTex = makeSkyTexture();
    scene.background = this.skyTex;
    scene.fog = new THREE.Fog(FOG_COLOR, 55, 170);

    // ── lights ──
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0xd9c39a, 0.9);
    this.group.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(12, 20, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -16;
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0004;
    this.group.add(sun);
    this.group.add(sun.target);

    // ── sea (huge plane below the sand) ──
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshStandardMaterial({ color: SEA_COLOR, roughness: 0.4, metalness: 0.1 }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.18;
    this.group.add(sea);

    // ── sand island ──
    const sand = new THREE.Mesh(
      new THREE.CircleGeometry(36, 48),
      new THREE.MeshStandardMaterial({ color: SAND_COLOR, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.receiveShadow = true;
    this.group.add(sand);

    // slightly lighter, raked in-court panel
    const court = new THREE.Mesh(
      new THREE.PlaneGeometry((COURT_HALF_LEN + 0.6) * 2, (COURT_HALF_WID + 0.6) * 2),
      new THREE.MeshStandardMaterial({ color: SAND_COURT_COLOR, roughness: 1 }),
    );
    court.rotation.x = -Math.PI / 2;
    court.position.y = 0.005;
    court.receiveShadow = true;
    this.group.add(court);

    // ── court boundary lines ──
    const lineMat = new THREE.MeshBasicMaterial({ color: LINE_COLOR });
    const lw = 0.09;
    const addLine = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
      m.position.set(x, 0.012, z);
      this.group.add(m);
    };
    addLine(COURT_HALF_LEN * 2 + lw, lw, 0, COURT_HALF_WID); // sidelines
    addLine(COURT_HALF_LEN * 2 + lw, lw, 0, -COURT_HALF_WID);
    addLine(lw, COURT_HALF_WID * 2 + lw, COURT_HALF_LEN, 0); // baselines
    addLine(lw, COURT_HALF_WID * 2 + lw, -COURT_HALF_LEN, 0);

    // ── net ── (posts at the physical net edge so visuals and collision agree)
    const postZ = NET_HALF_WIDTH;
    const netW = postZ * 2;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x50708c, roughness: 0.5 });
    for (const zs of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, NET_TOP + 0.12, 10), postMat);
      post.position.set(0, (NET_TOP + 0.12) / 2, zs * postZ);
      post.castShadow = true;
      this.group.add(post);
    }

    this.netTex = makeNetTexture();
    const netBody = new THREE.Mesh(
      new THREE.PlaneGeometry(netW, 1.0),
      new THREE.MeshBasicMaterial({
        map: this.netTex,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    netBody.rotation.y = Math.PI / 2;
    netBody.position.y = NET_TOP - 0.55;
    this.netGroup.add(netBody);

    const tapeMat = new THREE.MeshStandardMaterial({ color: 0xf6f6ee, roughness: 0.7 });
    const tapeTop = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, netW), tapeMat);
    tapeTop.position.y = NET_TOP - 0.05; // top edge exactly at NET_TOP
    tapeTop.castShadow = true;
    this.netGroup.add(tapeTop);

    const tapeBot = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, netW), tapeMat);
    tapeBot.position.y = NET_TOP - 1.05;
    this.netGroup.add(tapeBot);

    this.group.add(this.netGroup);

    // ── set dressing: dunes & palms (all outside the playable area) ──
    const duneMat = new THREE.MeshStandardMaterial({ color: SAND_DARK, roughness: 1 });
    const dunes: Array<[number, number, number, number]> = [
      // x, z, radius, squashY
      [0, -27, 9, 1.6],
      [-20, -18, 7, 1.3],
      [22, 16, 8, 1.4],
      [-18, 21, 6, 1.1],
    ];
    for (const [x, z, r, h] of dunes) {
      const dune = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), duneMat);
      dune.scale.set(1, h / r, 0.7);
      dune.position.set(x, -0.4, z);
      this.group.add(dune);
    }

    this.group.add(makePalm(-14, 9, 0.9));
    this.group.add(makePalm(13.5, -9.5, 1.05));
  }

  /** Kick the net; it jiggles and settles. */
  netImpulse(strength: number): void {
    this.netWobble = Math.min(1.8, this.netWobble + strength);
  }

  update(dt: number): void {
    this.t += dt;
    this.netWobble *= Math.exp(-5 * dt);
    if (this.netWobble < 0.001) this.netWobble = 0;
    this.netGroup.position.x = Math.sin(this.t * 40) * this.netWobble * 0.055;
  }

  dispose(): void {
    this.skyTex.dispose();
    this.netTex.dispose();
  }
}

// ── texture / prop builders ─────────────────────────────────

function makeSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, SKY_TOP);
  grad.addColorStop(0.62, SKY_BOTTOM);
  grad.addColorStop(1, SKY_BOTTOM);
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeNetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(238,243,250,0.9)';
  g.lineWidth = 1.6;
  for (let x = 0; x <= c.width; x += 8) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, c.height);
    g.stroke();
  }
  for (let y = 0; y <= c.height; y += 8) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(c.width, y);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePalm(x: number, z: number, scale: number): THREE.Group {
  const palm = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6238, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x3d9b4f,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });

  // gently curved trunk from 3 tilted segments
  let px = 0;
  let py = 0;
  let tilt = 0.06;
  for (let i = 0; i < 3; i++) {
    const h = 1.5;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.13 - i * 0.025, 0.16 - i * 0.025, h, 8), trunkMat);
    seg.position.set(px, py + h / 2, 0);
    seg.rotation.z = tilt * (i + 1);
    seg.castShadow = true;
    palm.add(seg);
    px -= Math.sin(tilt * (i + 1)) * h;
    py += Math.cos(tilt * (i + 1)) * h;
    tilt += 0.07;
  }

  // fronds: stretched, drooping planes fanned around the crown
  for (let i = 0; i < 7; i++) {
    const frond = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.55, 4, 1), leafMat);
    const pos = frond.geometry.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      const fx = pos.getX(v);
      pos.setY(v, pos.getY(v) * (1 - Math.abs(fx) / 1.6) - fx * fx * 0.16); // taper + droop
    }
    pos.needsUpdate = true;
    frond.geometry.computeVertexNormals();
    const holder = new THREE.Group();
    holder.position.set(px, py, 0);
    frond.position.set(1.15, 0.1, 0);
    holder.add(frond);
    holder.rotation.y = (i / 7) * Math.PI * 2;
    holder.rotation.z = -0.25 - (i % 3) * 0.12;
    palm.add(holder);
  }

  palm.position.set(x, 0, z);
  palm.scale.setScalar(scale);
  palm.rotation.y = x * 1.7; // arbitrary but deterministic variety
  return palm;
}
