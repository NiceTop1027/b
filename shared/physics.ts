// Pure, deterministic physics shared by the authoritative server sim and the
// client (prediction of the local player, smoothing of the ball). No state,
// no randomness, no Date — everything is (input, dt) → mutation + flags.

import {
  BALL_DRAG,
  BALL_GRAVITY,
  BALL_R,
  BALL_REST,
  BOUNDS_PAD,
  CHEST_Y,
  COURT_HALF_LEN,
  COURT_HALF_WID,
  HIT_RADIUS,
  JUMP_VEL,
  NET_CORD_BAND,
  NET_HALF_WIDTH,
  NET_KEEPOUT,
  NET_TOP,
  PLAYER_ACCEL_AIR,
  PLAYER_ACCEL_GROUND,
  PLAYER_GRAVITY,
  PLAYER_SPEED,
  SERVE_X,
  ATTACK_CLEARANCE,
  AIM_OUT_MARGIN,
  SPIKE_SPEED,
} from './constants';
import type { BallState, InputFrame, PlayerState, TeamId, Vec3 } from './types';

/** Where the ball sits in the server player's hand before a serve. Single
 *  source of truth so the server sim and the client's serve render agree. */
export function serveHandPos(pos: Vec3, team: TeamId): Vec3 {
  return v3(pos.x + (team === 0 ? 0.45 : -0.45), pos.y + CHEST_Y + 0.35, pos.z);
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function moveToward(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

// ── Player ──────────────────────────────────────────────────

export interface StepPlayerOpts {
  /** lock the player to their baseline (they are the server, pre-serve) */
  serveLock?: boolean;
}

/**
 * Advances one player by dt. Identical on server and client — the client
 * replays unacked inputs through this for prediction.
 */
export function stepPlayer(
  p: PlayerState,
  input: InputFrame,
  dt: number,
  opts: StepPlayerOpts = {},
): void {
  // horizontal control
  let mx = input.mx;
  let mz = input.mz;
  const mLen = Math.hypot(mx, mz);
  if (mLen > 1) {
    mx /= mLen;
    mz /= mLen;
  }
  const accel = p.onGround ? PLAYER_ACCEL_GROUND : PLAYER_ACCEL_AIR;
  p.vel.x = moveToward(p.vel.x, mx * PLAYER_SPEED, accel * dt);
  p.vel.z = moveToward(p.vel.z, mz * PLAYER_SPEED, accel * dt);

  // jump + gravity
  if (input.jump && p.onGround) {
    p.vel.y = JUMP_VEL;
    p.onGround = false;
  }
  if (!p.onGround) p.vel.y += PLAYER_GRAVITY * dt;

  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;

  if (p.pos.y <= 0) {
    p.pos.y = 0;
    p.vel.y = 0;
    p.onGround = true;
  }

  // court bounds — each team confined to its half, small roam margin outside
  const sideSign = p.team === 0 ? -1 : 1;
  if (opts.serveLock) {
    p.pos.x = sideSign * SERVE_X;
    p.vel.x = 0;
    p.pos.z = clamp(p.pos.z, -COURT_HALF_WID + 0.5, COURT_HALF_WID - 0.5);
  } else {
    const minX = p.team === 0 ? -COURT_HALF_LEN - BOUNDS_PAD : NET_KEEPOUT;
    const maxX = p.team === 0 ? -NET_KEEPOUT : COURT_HALF_LEN + BOUNDS_PAD;
    if (p.pos.x < minX) {
      p.pos.x = minX;
      if (p.vel.x < 0) p.vel.x = 0;
    }
    if (p.pos.x > maxX) {
      p.pos.x = maxX;
      if (p.vel.x > 0) p.vel.x = 0;
    }
    const zLim = COURT_HALF_WID + BOUNDS_PAD;
    if (p.pos.z < -zLim) {
      p.pos.z = -zLim;
      if (p.vel.z < 0) p.vel.z = 0;
    }
    if (p.pos.z > zLim) {
      p.pos.z = zLim;
      if (p.vel.z > 0) p.vel.z = 0;
    }
  }

  if (p.hitCooldown > 0) p.hitCooldown = Math.max(0, p.hitCooldown - dt);
}

// ── Ball ────────────────────────────────────────────────────

export interface BallStepFlags {
  /** ball touched the floor this step (pos is the landing point) */
  floor: boolean;
  /** ball bounced off the net body */
  net: boolean;
  /** ball clipped the tape and popped */
  cord: boolean;
  /** ball crossed the net plane cleanly (side changed) */
  crossed: boolean;
}

/**
 * Advances the ball by dt. `bouncy` makes the floor elastic (celebration
 * phases); during a rally the floor ends the point so the caller checks
 * `flags.floor` and takes over.
 */
export function stepBall(b: BallState, dt: number, bouncy = false): BallStepFlags {
  const flags: BallStepFlags = { floor: false, net: false, cord: false, crossed: false };
  if (b.held) return flags;

  b.vel.y += BALL_GRAVITY * dt;
  const drag = Math.max(0, 1 - BALL_DRAG * dt);
  b.vel.x *= drag;
  b.vel.y *= drag;
  b.vel.z *= drag;

  const px = b.pos.x;
  const py = b.pos.y;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.pos.z += b.vel.z * dt;

  // net plane at x = 0, solid below the tape — but only within the net's z extent
  const crossedPlane = (px < 0 && b.pos.x >= 0) || (px > 0 && b.pos.x <= 0);
  if (crossedPlane) {
    const tCross = px / (px - b.pos.x); // fraction of the step where x hits 0
    const yAt = b.pos.y - b.vel.y * dt * (1 - tCross);
    const zAt = b.pos.z - b.vel.z * dt * (1 - tCross);
    const origSide = px < 0 ? -1 : 1;
    const overNetSpan = Math.abs(zAt) <= NET_HALF_WIDTH + BALL_R;
    if (overNetSpan && yAt - BALL_R < NET_TOP) {
      if (yAt > NET_TOP - NET_CORD_BAND) {
        // tape clip: kill speed, pop up, fall nearly straight down
        b.pos.x = origSide * 0.06;
        b.vel.x *= 0.18;
        b.vel.y = Math.max(2.2, Math.abs(b.vel.y) * 0.25);
        b.vel.z *= 0.6;
        flags.cord = true;
      } else {
        // body of the net: bounce back, heavily damped
        b.pos.x = origSide * 0.08;
        b.vel.x = -b.vel.x * 0.35;
        b.vel.y *= 0.55;
        b.vel.z *= 0.75;
        flags.net = true;
      }
    } else {
      // cleared the tape, or passed outside the posts → clean crossing
      flags.crossed = true;
    }
  }

  if (b.pos.y <= BALL_R) {
    // Back-interpolate to the true floor-contact point so in/out line calls
    // use where the ball actually landed, not the full-step overshoot (up to
    // ~0.3 m at spike speed). Same idea as tCross for the net plane. Skip when
    // a resting/rolling ball (py === BALL_R in bouncy phases) would be frozen,
    // and when a net/cord bounce already rewrote pos/vel this step.
    if (py > BALL_R && b.pos.y < py && !flags.net && !flags.cord) {
      const tFloor = (py - BALL_R) / (py - b.pos.y); // step fraction where y hits BALL_R, in (0,1]
      const back = dt * (1 - tFloor);
      b.pos.x -= b.vel.x * back;
      b.pos.z -= b.vel.z * back;
    }
    b.pos.y = BALL_R;
    if (bouncy) {
      if (b.vel.y < 0) b.vel.y = -b.vel.y * BALL_REST;
      if (Math.abs(b.vel.y) < 0.8) b.vel.y = 0;
      b.vel.x *= 0.92;
      b.vel.z *= 0.92;
    }
    flags.floor = true;
  }

  const newSide: -1 | 1 = b.pos.x < 0 ? -1 : 1;
  if (newSide !== b.side) b.side = newSide;

  return flags;
}

/** Can this player's hit-sphere reach the ball right now? */
export function canReach(p: PlayerState, b: BallState): boolean {
  const dx = b.pos.x - p.pos.x;
  const dy = b.pos.y - (p.pos.y + CHEST_Y);
  const dz = b.pos.z - p.pos.z;
  return dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS;
}

// ── Arcs & hits ─────────────────────────────────────────────

const G = -BALL_GRAVITY; // positive magnitude

/**
 * Ballistic velocity from `from` to land at `to` (y component of `to` is the
 * arrival height), passing through the given apex. Drag is ignored in the
 * solve — arcs land slightly short of the pin, which reads as natural.
 */
export function solveArc(from: Vec3, to: Vec3, apex: number): Vec3 {
  const a = Math.max(apex, from.y + 0.35, to.y + 0.35);
  const vy = Math.sqrt(2 * G * (a - from.y));
  const t = vy / G + Math.sqrt((2 * (a - to.y)) / G);
  return v3((to.x - from.x) / t, vy, (to.z - from.z) / t);
}

/** Height of an ideal (drag-free) arc when it crosses the net plane x=0, or null if it never does. */
function netCrossingY(from: Vec3, vel: Vec3): number | null {
  if (Math.sign(vel.x) === 0) return null;
  const t = -from.x / vel.x;
  if (t <= 0) return null;
  return from.y + vel.y * t - 0.5 * G * t * t;
}

const NEED_CLEAR_Y = NET_TOP + BALL_R + ATTACK_CLEARANCE;

/**
 * Raise the (drag-free) apex until the ideal arc clears the tape. The crossing
 * height is monotonic in apex, so bisection converges reliably where the old
 * fixed 5×(+0.7) bump could exhaust its budget short of the net (near-net
 * targets from deep positions cross at ~92% of flight, where extra apex barely
 * lifts the crossing).
 */
function apexClearingNet(from: Vec3, to: Vec3, minApex: number): Vec3 {
  let lo = Math.max(minApex, from.y + 0.35, to.y + 0.35);
  let velLo = solveArc(from, to, lo);
  const yLo = netCrossingY(from, velLo);
  if (yLo === null || yLo >= NEED_CLEAR_Y) return velLo;

  let hi = lo;
  let velHi = velLo;
  let bounded = false;
  for (let i = 0; i < 14; i++) {
    hi += Math.max(1, hi - from.y);
    velHi = solveArc(from, to, hi);
    const yHi = netCrossingY(from, velHi);
    if (yHi === null || yHi >= NEED_CLEAR_Y) {
      bounded = true;
      break;
    }
  }
  if (!bounded) return velHi; // can't be cleared within reason; best effort

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const velMid = solveArc(from, to, mid);
    const yMid = netCrossingY(from, velMid);
    if (yMid === null || yMid >= NEED_CLEAR_Y) {
      hi = mid;
      velHi = velMid;
    } else {
      lo = mid;
    }
  }
  return velHi;
}

/** Drag-included rollout: does the shot actually clear the net before it nets/floors? */
function crossesNetCleanly(from: Vec3, vel: Vec3): boolean {
  const b: BallState = {
    pos: { ...from },
    vel: { ...vel },
    held: false,
    lastToucherId: null,
    blockExempt: false,
    touches: 0,
    side: from.x < 0 ? -1 : 1,
  };
  const dt = 1 / 120;
  for (let t = 0; t < 4; t += dt) {
    const flags = stepBall(b, dt, false);
    if (flags.crossed) return true;
    if (flags.net || flags.cord || flags.floor) return false;
  }
  return false;
}

/**
 * solveArc that clears the net tape, validated against the real drag physics.
 * If the drag-included trajectory still fails to clear, the aim is pushed
 * deeper into the opponent court (preserving z) and re-solved — so a drop shot
 * lands a little longer instead of faulting into the net.
 */
export function solveArcOverNet(from: Vec3, to: Vec3, apex: number): Vec3 {
  const maxDepth = (from.x < 0 ? 1 : -1) * COURT_HALF_LEN * 0.72; // deepest we'll retarget to
  const target: Vec3 = { x: to.x, y: to.y, z: to.z };
  let vel = apexClearingNet(from, target, apex);
  // A near-net target from deep court crosses at ~92% of flight, where drag
  // eats the ideal clearance. If the drag-included rollout fails, move the aim
  // geometrically toward mid-opponent-court (crossing earlier in flight, well
  // above the tape) — the shot lands a little deeper instead of netting.
  for (let i = 0; i < 8; i++) {
    if (crossesNetCleanly(from, vel)) break;
    target.x += (maxDepth - target.x) * 0.5;
    vel = apexClearingNet(from, target, apex);
  }
  return vel;
}

/** Clamp an aim point into the opponent half (+ a little out-margin for risk). */
export function clampAim(ax: number, az: number, attackerTeam: 0 | 1): Vec3 {
  const minX = attackerTeam === 0 ? 0.8 : -(COURT_HALF_LEN + AIM_OUT_MARGIN);
  const maxX = attackerTeam === 0 ? COURT_HALF_LEN + AIM_OUT_MARGIN : -0.8;
  return v3(
    clamp(ax, minX, maxX),
    0,
    clamp(az, -(COURT_HALF_WID + AIM_OUT_MARGIN), COURT_HALF_WID + AIM_OUT_MARGIN),
  );
}

/**
 * Spike: a hard, mostly-straight shot from the ball's position to the target.
 * Tilts the line up just enough to clear the tape when needed.
 */
export function solveSpike(from: Vec3, to: Vec3): Vec3 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz) || 0.001;
  let dy = to.y - from.y;

  for (let i = 0; i < 6; i++) {
    const len = Math.hypot(horiz, dy);
    const vel = v3(
      (dx / len) * SPIKE_SPEED,
      (dy / len) * SPIKE_SPEED,
      (dz / len) * SPIKE_SPEED,
    );
    const y = netCrossingY(from, vel);
    if (y === null || y >= NET_TOP + BALL_R + 0.05) return vel;
    dy += 0.35 * (i + 1) * 0.5 + 0.2; // tilt up and retry
  }
  // give up on a laser — loft it instead
  return solveArcOverNet(from, to, from.y + 1.2);
}

/**
 * Predict where the ball will land (rally rules: net bounces included,
 * floor stops it). Used by bots and the client's landing indicator.
 */
export function predictLanding(ball: BallState, maxT = 5): { pos: Vec3; t: number } | null {
  if (ball.held) return null;
  const b: BallState = {
    pos: { ...ball.pos },
    vel: { ...ball.vel },
    held: false,
    lastToucherId: null,
    blockExempt: false,
    touches: 0,
    side: ball.side,
  };
  const dt = 1 / 30;
  for (let t = 0; t < maxT; t += dt) {
    const flags = stepBall(b, dt, false);
    if (flags.floor) return { pos: { ...b.pos }, t };
  }
  return null;
}
