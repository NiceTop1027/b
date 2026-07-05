// Bot AI. Called once per sim tick; returns the InputFrame the sim consumes.
// Design goals: plays like a person (reaction delay, committed decisions,
// gaussian aim error, occasional bad calls) and scales with `difficulty`
// from beatable (0.5) to sharp (1.0).

import {
  BOT_SERVE_DELAY,
  COURT_HALF_LEN,
  COURT_HALF_WID,
  MAX_TOUCHES,
  NET_TOP,
  SPIKE_MIN_BALL_Y,
  TICK_RATE,
} from '../shared/constants';
import { canReach, clamp, predictLanding } from '../shared/physics';
import type { GameState, InputFrame, PlayerState, Vec3 } from '../shared/types';

interface P2 {
  x: number;
  z: number;
}

/** Standard normal via Box-Muller — used for human-like aim scatter. */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Bot {
  private seq: number;
  private readonly sigma: number; // aim error stddev (m)
  private readonly reactDelay: number; // ticks before responding to a new ball situation
  private readonly blunder: number; // odds of a suboptimal choice

  // button lifecycle: hold a few ticks, release, refractory before next press
  private holdKey: 'attack' | 'pass' | null = null;
  private holdTicks = 0;
  private refractory = 0;

  private react = 0;
  private lastToucher: string | null | undefined = undefined;
  private lastSide: -1 | 1 | 0 = 0;
  private lastPhase = '';
  private serveExtra = 0; // per-serve random hesitation on top of BOT_SERVE_DELAY

  private aim: P2 = { x: 0, z: 0 };
  private aimTicks = 0;
  private base: P2 | null = null;
  private baseTicks = 0;

  constructor(
    private readonly playerId: string,
    difficulty = 0.5 + Math.random() * 0.5,
    startSeq = 1,
  ) {
    this.seq = startSeq;
    const n = clamp((difficulty - 0.5) * 2, 0, 1);
    this.sigma = 1.5 - 1.1 * n; // 1.5m → 0.4m
    this.reactDelay = Math.round((0.3 - 0.22 * n) * TICK_RATE); // 300ms → 80ms
    this.blunder = 0.1 - 0.05 * n; // 10% → 5%
  }

  update(state: GameState): InputFrame {
    const out: InputFrame = {
      seq: this.seq++,
      mx: 0,
      mz: 0,
      jump: false,
      pass: false,
      attack: false,
      ax: this.aim.x,
      az: this.aim.z,
    };
    const me = state.players.find((p) => p.id === this.playerId);
    if (!me) return out;

    if (this.refractory > 0) this.refractory--;
    if (this.aimTicks > 0) this.aimTicks--;
    if (this.baseTicks > 0) this.baseTicks--;

    // reaction delay restarts whenever the ball situation changes
    const ball = state.ball;
    if (ball.lastToucherId !== this.lastToucher || ball.side !== this.lastSide) {
      this.lastToucher = ball.lastToucherId;
      this.lastSide = ball.side;
      this.react = this.reactDelay;
    } else if (this.react > 0) {
      this.react--;
    }

    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase;
      this.holdKey = null;
      this.holdTicks = 0;
      this.refractory = 0;
      this.aimTicks = 0;
      this.base = null;
      this.baseTicks = 0;
      this.serveExtra = Math.random() * 0.6;
    }

    switch (state.phase) {
      case 'serve':
        this.doServe(state, me, out);
        break;
      case 'rally':
        this.doRally(state, me, out);
        break;
      default:
        // point/over/waiting: drift back home
        this.moveTo(out, me, this.basePos(state, me));
        break;
    }

    if (this.holdTicks > 0) {
      this.holdTicks--;
      if (this.holdKey === 'attack') out.attack = true;
      else if (this.holdKey === 'pass') out.pass = true;
      if (this.holdTicks === 0) {
        this.holdKey = null;
        this.refractory = 5 + Math.floor(Math.random() * 4);
      }
    }
    out.ax = this.aim.x;
    out.az = this.aim.z;
    return out;
  }

  // ── serve ─────────────────────────────────────────────────

  private doServe(state: GameState, me: PlayerState, out: InputFrame): void {
    if (state.serverId === me.id) {
      if (this.aimTicks <= 0) this.pickAim(state, me, true);
      // the sim consumes a *held* action button for bot serves once the delay passes
      if (state.phaseT >= BOT_SERVE_DELAY + this.serveExtra) out.attack = true;
      return;
    }
    this.moveTo(out, me, this.basePos(state, me));
  }

  // ── rally ─────────────────────────────────────────────────

  private doRally(state: GameState, me: PlayerState, out: InputFrame): void {
    const ball = state.ball;
    const mySide: -1 | 1 = me.team === 0 ? -1 : 1;
    const mates = state.players.filter((p) => p.team === me.team);
    const hasMate = mates.length > 1;

    const landing = predictLanding(ball);
    const incoming = landing !== null && landing.pos.x * mySide >= 0;

    // movement: receive > block > base position
    let target: P2 | null = null;
    let blocking = false;
    if (incoming && landing && this.receiverId(mates, landing.pos) === me.id) {
      if (this.react <= 0) {
        const nearLim = mySide < 0 ? -0.55 : 0.55;
        const farLim = mySide * (COURT_HALF_LEN + 1);
        target = {
          x: clamp(
            landing.pos.x + mySide * 0.1,
            Math.min(nearLim, farLim),
            Math.max(nearLim, farLim),
          ),
          z: clamp(landing.pos.z, -COURT_HALF_WID - 1, COURT_HALF_WID + 1),
        };
      }
    } else {
      const threat = this.spikeThreat(state, me);
      if (threat) {
        blocking = true;
        target = { x: mySide * 0.58, z: clamp(threat.pos.z, -COURT_HALF_WID, COURT_HALF_WID) };
      }
    }
    if (!target) target = this.basePos(state, me);
    this.moveTo(out, me, target);

    // block jump: ball coming over high while we're at the net mirroring the spiker
    if (blocking && me.onGround) {
      const towardUs = mySide < 0 ? ball.vel.x < 0 : ball.vel.x > 0;
      if (towardUs && ball.pos.y > NET_TOP - 0.2 && Math.abs(ball.pos.x) < 2.2) {
        out.jump = true;
      }
    }

    const consecutive = ball.lastToucherId === me.id && !ball.blockExempt && hasMate;
    const mayTouch =
      !ball.held &&
      ball.side === mySide &&
      me.hitCooldown <= 0 &&
      !consecutive &&
      ball.touches < MAX_TOUCHES &&
      this.react <= 0;

    // rise to meet a high ball near the net → jump-spike
    if (mayTouch && me.onGround && !blocking) {
      const hd = Math.hypot(ball.pos.x - me.pos.x, ball.pos.z - me.pos.z);
      if (
        ball.pos.y > SPIKE_MIN_BALL_Y + 0.25 &&
        ball.vel.y < 0.5 &&
        hd < 1.1 &&
        Math.abs(ball.pos.x) < 4.5
      ) {
        out.jump = true;
      }
    }

    // touch decision
    if (mayTouch && this.holdTicks <= 0 && this.refractory <= 0 && canReach(me, ball)) {
      const spikeable = !me.onGround && ball.pos.y > SPIKE_MIN_BALL_Y;
      let key: 'attack' | 'pass';
      if (ball.touches >= MAX_TOUCHES - 1) key = 'attack'; // last allowed touch must cross
      else if (spikeable) key = 'attack';
      else if (hasMate && ball.touches < 2) key = Math.random() < this.blunder ? 'attack' : 'pass';
      else key = 'attack';

      if (key === 'attack' && this.aimTicks <= 0) this.pickAim(state, me, false);
      this.holdKey = key;
      this.holdTicks = 3 + Math.floor(Math.random() * 3);
    }
  }

  /** Closest teammate to the landing point receives; ties break by id so two bots never both chase. */
  private receiverId(mates: PlayerState[], landing: Vec3): string {
    let best = mates[0];
    let bestD = Math.hypot(best.pos.x - landing.x, best.pos.z - landing.z);
    for (let i = 1; i < mates.length; i++) {
      const p = mates[i];
      const d = Math.hypot(p.pos.x - landing.x, p.pos.z - landing.z);
      if (d < bestD - 0.02 || (d < bestD + 0.02 && p.id < best.id)) {
        best = p;
        bestD = Math.min(d, bestD);
      }
    }
    return best.id;
  }

  /** An opponent is airborne near the net with a high ball on their side → spike incoming. */
  private spikeThreat(state: GameState, me: PlayerState): PlayerState | null {
    const ball = state.ball;
    const mySide: -1 | 1 = me.team === 0 ? -1 : 1;
    if (ball.held || ball.side === mySide) return null;
    if (ball.pos.y < NET_TOP - 0.3 || Math.abs(ball.pos.x) > 3) return null;
    for (const p of state.players) {
      if (p.team === me.team || p.onGround) continue;
      if (Math.abs(p.pos.x) < 3) return p;
    }
    return null;
  }

  /** Default court position, committed ~0.25-0.5s so movement never jitters. */
  private basePos(state: GameState, me: PlayerState): P2 {
    if (this.base && this.baseTicks > 0) return this.base;
    const mySide: -1 | 1 = me.team === 0 ? -1 : 1;
    const mates = state.players.filter((p) => p.team === me.team);
    const slot = Math.max(
      0,
      mates.findIndex((p) => p.id === me.id),
    );
    const zHalf = mates.length > 1 ? (slot === 0 ? -2 : 2) : 0;
    const ball = state.ball;
    const attacking = state.phase === 'rally' && !ball.held && ball.side === mySide;
    this.base = attacking
      ? // teammate is playing the ball — crowd the net for the next set/spike
        { x: mySide * 1.5, z: clamp(ball.pos.z * 0.35 + zHalf * 0.65, -3, 3) }
      : // defensive split, each covering one z-half
        { x: mySide * COURT_HALF_LEN * 0.55, z: zHalf };
    this.baseTicks = 15 + Math.floor(Math.random() * 15);
    return this.base;
  }

  private moveTo(out: InputFrame, me: PlayerState, t: P2): void {
    const dx = t.x - me.pos.x;
    const dz = t.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.12) return;
    const s = d < 0.55 ? d / 0.55 : 1; // ease in so we don't orbit the target
    out.mx = (dx / d) * s;
    out.mz = (dz / d) * s;
  }

  /** Choose an in-court aim: mostly where the defense isn't, sometimes random, always noisy. */
  private pickAim(state: GameState, me: PlayerState, serve: boolean): void {
    const opp: -1 | 1 = me.team === 0 ? 1 : -1;
    const L = COURT_HALF_LEN;
    const W = COURT_HALF_WID;
    const deep: P2[] = [
      { x: opp * (L - 1.1), z: -(W - 0.8) },
      { x: opp * (L - 1.1), z: W - 0.8 },
      { x: opp * (L - 0.9), z: 0 },
    ];
    const tricky: P2[] = [
      { x: opp * (L - 2.8), z: -(W - 0.55) },
      { x: opp * (L - 2.8), z: W - 0.55 },
      { x: opp * 2.3, z: Math.random() < 0.5 ? -1.7 : 1.7 }, // drop shot
    ];
    const pool = serve ? deep : deep.concat(tricky);
    const defenders = state.players.filter((p) => p.team !== me.team);

    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (Math.random() >= 0.35 && defenders.length > 0) {
      let bestGap = -1;
      for (const c of pool) {
        let gap = Infinity;
        for (const d of defenders) {
          gap = Math.min(gap, Math.hypot(d.pos.x - c.x, d.pos.z - c.z));
        }
        if (gap > bestGap) {
          bestGap = gap;
          pick = c;
        }
      }
    }

    const nearX = opp * 1.1;
    const farX = opp * (L - 0.2);
    this.aim = {
      x: clamp(pick.x + gauss() * this.sigma, Math.min(nearX, farX), Math.max(nearX, farX)),
      z: clamp(pick.z + gauss() * this.sigma, -(W - 0.15), W - 0.15),
    };
    // serves keep their aim for the whole phase; rally aims commit a few hundred ms
    this.aimTicks = serve ? 100000 : 24 + Math.floor(Math.random() * 18);
  }
}
