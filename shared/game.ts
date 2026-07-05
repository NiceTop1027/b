// Authoritative game simulation. The server owns one GameSim per room and
// steps it at TICK_RATE; clients receive snapshots of `state`. Pure logic —
// no sockets, no timers, no randomness (bots inject their own aim noise).

import {
  BALL_R,
  BLOCK_HANDS_Y,
  BLOCK_NET_DIST,
  BLOCK_RADIUS,
  BOT_SERVE_DELAY,
  CHEST_Y,
  COURT_HALF_LEN,
  COURT_HALF_WID,
  HIT_COOLDOWN,
  MAX_TOUCHES,
  NET_TOP,
  OVER_PAUSE,
  PASS_APEX_BONUS,
  POINT_PAUSE,
  SCORE_CAP,
  SERVE_TIMEOUT,
  SERVE_X,
  SPIKE_MIN_BALL_Y,
  TICK_DT,
  WIN_BY,
  WIN_SCORE,
} from './constants';
import {
  canReach,
  clamp,
  clampAim,
  serveHandPos,
  solveArc,
  solveArcOverNet,
  solveSpike,
  stepBall,
  stepPlayer,
  v3,
} from './physics';
import type {
  BallState,
  GameEvent,
  GameState,
  HitType,
  InputFrame,
  PlayerState,
  TeamId,
  Vec3,
} from './types';

export interface SimPlayerDef {
  id: string;
  name: string;
  team: TeamId;
  isBot: boolean;
}

const EMPTY_INPUT: InputFrame = {
  seq: 0,
  mx: 0,
  mz: 0,
  jump: false,
  pass: false,
  attack: false,
  ax: 0,
  az: 0,
};

export class GameSim {
  state: GameState;
  /** events emitted by the most recent step(); caller drains them */
  events: GameEvent[] = [];

  private inputs = new Map<string, InputFrame>();
  private prevInputs = new Map<string, InputFrame>();
  /** rising-edge latches so a press+release coalesced between two ticks still fires once */
  private pendingPress = new Map<string, { attack: boolean; pass: boolean; jump: boolean }>();
  private serveIdx: [number, number] = [0, 0];

  constructor(defs: SimPlayerDef[]) {
    const players: PlayerState[] = defs.map((d) => ({
      id: d.id,
      name: d.name,
      team: d.team,
      isBot: d.isBot,
      pos: v3(),
      vel: v3(),
      onGround: true,
      hitCooldown: 0,
      lastHitType: null,
      lastHitTick: -1000,
    }));

    this.state = {
      tick: 0,
      phase: 'serve',
      phaseT: 0,
      players,
      ball: {
        pos: v3(0, 3, 0),
        vel: v3(),
        held: true,
        lastToucherId: null,
        blockExempt: false,
        touches: 0,
        side: -1,
      },
      score: [0, 0],
      servingTeam: 0,
      serverId: null,
      message: '',
    };

    this.setupServe(0);
  }

  /**
   * Latest wins for continuous fields (movement/aim), but rising edges of the
   * one-shot buttons (attack/pass/jump) are latched. On a jittery connection a
   * whole tap — press frames plus the release frame — can arrive in one burst
   * between two sim ticks; without the latch only the trailing release survives
   * and the swing silently never happens. TCP + the stale-seq guard guarantee
   * every frame is observed in order, so every rising edge is caught.
   */
  setInput(playerId: string, f: InputFrame): void {
    const cur = this.inputs.get(playerId);
    if (cur && f.seq <= cur.seq) return; // ignore stale/duplicate
    const ref = cur ?? this.prevInputs.get(playerId);
    if (f.attack || f.pass || f.jump) {
      const latch = this.pendingPress.get(playerId) ?? {
        attack: false,
        pass: false,
        jump: false,
      };
      if (f.attack && !ref?.attack) latch.attack = true;
      if (f.pass && !ref?.pass) latch.pass = true;
      if (f.jump && !ref?.jump) latch.jump = true;
      this.pendingPress.set(playerId, latch);
    }
    this.inputs.set(playerId, f);
  }

  /** Replace a leaver with a bot (same id keeps state continuity). */
  markBot(playerId: string, botName: string): void {
    const p = this.state.players.find((pl) => pl.id === playerId);
    if (p) {
      p.isBot = true;
      p.name = botName;
    }
  }

  step(): void {
    this.events = [];
    const s = this.state;
    s.tick++;

    // players always move (celebration phases included — running around is fun)
    for (const p of s.players) {
      let input = this.inputs.get(p.id) ?? EMPTY_INPUT;
      // consume a latched jump edge (release may have already overwritten the frame)
      const latch = this.pendingPress.get(p.id);
      if (latch?.jump && !input.jump) input = { ...input, jump: true };
      const serveLock = s.phase === 'serve' && p.id === s.serverId;
      stepPlayer(p, input, TICK_DT, { serveLock });
    }

    switch (s.phase) {
      case 'waiting':
        break;
      case 'serve':
        this.stepServe();
        break;
      case 'rally':
        this.stepRally();
        break;
      case 'point': {
        stepBall(s.ball, TICK_DT, true);
        s.phaseT -= TICK_DT;
        if (s.phaseT <= 0) this.setupServe(s.servingTeam);
        break;
      }
      case 'over': {
        stepBall(s.ball, TICK_DT, true);
        s.phaseT -= TICK_DT;
        if (s.phaseT <= 0) {
          s.score = [0, 0];
          this.serveIdx = [0, 0];
          s.message = '';
          this.setupServe(s.servingTeam);
        }
        break;
      }
    }

    // remember inputs for edge detection next tick; latches were consumed this tick
    for (const [id, f] of this.inputs) this.prevInputs.set(id, f);
    this.pendingPress.clear();
  }

  // ── serve ─────────────────────────────────────────────────

  private stepServe(): void {
    const s = this.state;
    s.phaseT += TICK_DT;
    const server = s.players.find((p) => p.id === s.serverId);
    if (!server) {
      // server left and wasn't replaced — hand the serve to a teammate
      this.setupServe(s.servingTeam);
      return;
    }

    // ball rides in the server's hand (shared formula so the client renders it there too)
    s.ball.pos = serveHandPos(server.pos, server.team);
    s.ball.vel = v3();

    const wantsAttack = this.edge(server.id, 'attack');
    const wantsPass = this.edge(server.id, 'pass');
    const timedOut = s.phaseT > SERVE_TIMEOUT;
    const botReady = server.isBot && s.phaseT > BOT_SERVE_DELAY && this.actionHeld(server.id);

    if (wantsAttack || wantsPass || timedOut || botReady) {
      const input = this.inputs.get(server.id) ?? EMPTY_INPUT;
      const aim = clampAim(input.ax, input.az, server.team);
      // no aim yet (ax=az=0 clamps oddly for team 1) → default deep middle
      if (input.ax === 0 && input.az === 0) {
        aim.x = (server.team === 0 ? 1 : -1) * COURT_HALF_LEN * 0.62;
        aim.z = 0;
      }
      const lob = wantsPass || timedOut;
      const from = { ...s.ball.pos };
      s.ball.vel = lob
        ? solveArcOverNet(from, aim, Math.max(6.2, from.y + 2))
        : solveArcOverNet(from, aim, Math.max(NET_TOP + 1.6, from.y + 1.1));
      s.ball.held = false;
      s.ball.lastToucherId = server.id;
      s.ball.blockExempt = false;
      s.ball.touches = 0; // the serve itself doesn't count as a team touch
      s.ball.side = server.team === 0 ? -1 : 1;
      server.hitCooldown = HIT_COOLDOWN;
      server.lastHitType = 'serve';
      server.lastHitTick = s.tick;
      s.phase = 'rally';
      s.message = '';
      this.emit({ kind: 'hit', hitType: 'serve', playerId: server.id, pos: { ...from } });
      this.emit({ kind: 'phase', phase: 'rally' });
    }
  }

  // ── rally ─────────────────────────────────────────────────

  private stepRally(): void {
    const s = this.state;

    // deliberate hits (edge-triggered). At most one player connects per tick:
    // if two teammates press together, the one whose chest is nearest the ball
    // wins, so a single contact can't double-count touches or fire two swings.
    const bp = s.ball.pos;
    const pressers = s.players
      .map((p) => {
        const want: 'attack' | 'pass' | null = this.edge(p.id, 'attack')
          ? 'attack'
          : this.edge(p.id, 'pass')
            ? 'pass'
            : null;
        if (!want) return null;
        const dx = bp.x - p.pos.x;
        const dy = bp.y - (p.pos.y + CHEST_Y);
        const dz = bp.z - p.pos.z;
        return { p, want, d2: dx * dx + dy * dy + dz * dz };
      })
      .filter((x): x is { p: PlayerState; want: 'attack' | 'pass'; d2: number } => x !== null)
      .sort((a, b) => a.d2 - b.d2);
    for (const pr of pressers) {
      if (this.tryHit(pr.p, pr.want)) break;
    }

    // airborne blocks (continuous, not edge)
    this.tryBlocks();

    const flags = stepBall(s.ball, TICK_DT, false);
    if (flags.net || flags.cord) {
      this.emit({ kind: flags.cord ? 'netcord' : 'net', pos: { ...s.ball.pos } });
    }
    if (flags.crossed) {
      s.ball.touches = 0;
      s.ball.blockExempt = false;
      // lastToucherId intentionally kept — needed for out-of-bounds attribution
    }
    if (flags.floor) this.resolveLanding();
  }

  /** Returns true if a hit was actually applied (so the caller stops after one). */
  private tryHit(p: PlayerState, want: 'attack' | 'pass'): boolean {
    const s = this.state;
    const b = s.ball;
    if (p.hitCooldown > 0) return false;
    if (!canReach(p, b)) return false;

    const ballSide: -1 | 1 = b.pos.x < 0 ? -1 : 1;
    const mySide = p.team === 0 ? -1 : 1;
    if (ballSide !== mySide) return false; // can't reach across the net

    const teamSize = s.players.filter((pl) => pl.team === p.team).length;
    const consecutive = b.lastToucherId === p.id && !b.blockExempt;
    if (consecutive && teamSize > 1) {
      if (!p.isBot) this.emit({ kind: 'denied', playerId: p.id, reason: 'consecutive' });
      return false;
    }
    if (b.touches >= MAX_TOUCHES) {
      if (!p.isBot) this.emit({ kind: 'denied', playerId: p.id, reason: 'touches' });
      return false;
    }

    const input = this.inputs.get(p.id) ?? EMPTY_INPUT;
    let hitType: HitType;

    if (want === 'pass') {
      hitType = 'pass';
      const target = this.passTarget(p);
      b.vel = solveArc({ ...b.pos }, target, b.pos.y + PASS_APEX_BONUS);
    } else if (!p.onGround && b.pos.y > SPIKE_MIN_BALL_Y) {
      hitType = 'spike';
      const aim = clampAim(input.ax, input.az, p.team);
      if (input.ax === 0 && input.az === 0) this.defaultAim(aim, p.team);
      b.vel = solveSpike({ ...b.pos }, aim);
    } else {
      hitType = 'attack';
      const aim = clampAim(input.ax, input.az, p.team);
      if (input.ax === 0 && input.az === 0) this.defaultAim(aim, p.team);
      b.vel = solveArcOverNet({ ...b.pos }, aim, Math.max(b.pos.y + 1.0, NET_TOP + 1.2));
    }

    b.touches += 1;
    b.lastToucherId = p.id;
    b.blockExempt = false;
    p.hitCooldown = HIT_COOLDOWN;
    p.lastHitType = hitType;
    p.lastHitTick = s.tick;
    this.emit({ kind: 'hit', hitType, playerId: p.id, pos: { ...b.pos } });
    return true;
  }

  /** Pass goes to the teammate (lead them slightly), or to a self-set spot near the net when solo. */
  private passTarget(p: PlayerState): Vec3 {
    const s = this.state;
    const mate = s.players.find((pl) => pl.team === p.team && pl.id !== p.id);
    if (mate) {
      return v3(
        clamp(mate.pos.x + mate.vel.x * 0.35, ...this.sideRangeX(p.team)),
        1.9, // arrive around chest height
        clamp(mate.pos.z + mate.vel.z * 0.35, -COURT_HALF_WID, COURT_HALF_WID),
      );
    }
    const sideSign = p.team === 0 ? -1 : 1;
    return v3(sideSign * 1.6, 2.2, clamp(p.pos.z, -2.5, 2.5));
  }

  private sideRangeX(team: TeamId): [number, number] {
    return team === 0 ? [-COURT_HALF_LEN, -0.9] : [0.9, COURT_HALF_LEN];
  }

  private defaultAim(aim: Vec3, team: TeamId): void {
    aim.x = (team === 0 ? 1 : -1) * COURT_HALF_LEN * 0.6;
    aim.z = 0;
  }

  private tryBlocks(): void {
    const s = this.state;
    const b = s.ball;
    if (b.held) return;
    const lastToucher = s.players.find((pl) => pl.id === b.lastToucherId);
    for (const p of s.players) {
      if (p.onGround || p.hitCooldown > 0) continue;
      // a block is against the OPPONENT's ball — never "block" your own team's
      // ball (e.g. a rebound off the net body), which would illegally reset the
      // team's touch count and revive a dead rally
      if (lastToucher && lastToucher.team === p.team) continue;
      if (Math.abs(p.pos.x) > BLOCK_NET_DIST) continue;
      const hx = p.pos.x;
      const hy = p.pos.y + BLOCK_HANDS_Y;
      const hz = p.pos.z;
      const dx = b.pos.x - hx;
      const dy = b.pos.y - hy;
      const dz = b.pos.z - hz;
      const rr = (BLOCK_RADIUS + BALL_R) ** 2;
      if (dx * dx + dy * dy + dz * dz > rr) continue;
      // ball must be moving toward the blocker's side
      const towardMe = p.team === 0 ? b.vel.x < 0 : b.vel.x > 0;
      if (!towardMe) continue;

      b.vel.x = -b.vel.x * 0.6;
      b.vel.y = Math.max(1.2, Math.abs(b.vel.y) * 0.2);
      b.vel.z = b.vel.z * 0.7 + (b.pos.z - hz) * 4; // deflect off the hands
      b.lastToucherId = p.id;
      b.blockExempt = true;
      // a block that keeps the ball on the blocker's side counts as touch 1;
      // never let a block DECREASE the count (defense-in-depth vs touch reset)
      const mySide = p.team === 0 ? -1 : 1;
      b.touches = Math.max(b.touches, b.side === mySide ? 1 : 0);
      p.hitCooldown = HIT_COOLDOWN * 0.75;
      p.lastHitType = 'block';
      p.lastHitTick = s.tick;
      this.emit({ kind: 'block', playerId: p.id, pos: { ...b.pos } });
      break;
    }
  }

  // ── scoring ───────────────────────────────────────────────

  private resolveLanding(): void {
    const s = this.state;
    const { x, z } = s.ball.pos;
    const inCourt = Math.abs(x) <= COURT_HALF_LEN && Math.abs(z) <= COURT_HALF_WID;

    let winner: TeamId;
    let reason: 'in' | 'out';
    if (inCourt) {
      // landed in on side S → the team defending S loses the point
      const losingTeam: TeamId = x < 0 ? 0 : 1;
      winner = losingTeam === 0 ? 1 : 0;
      reason = 'in';
    } else {
      // out: whoever touched it last loses; untouched serve blames the server's team
      const toucher = s.players.find((p) => p.id === s.ball.lastToucherId);
      const losingTeam: TeamId = toucher ? toucher.team : s.servingTeam;
      winner = losingTeam === 0 ? 1 : 0;
      reason = 'out';
    }

    this.emit({ kind: 'land', pos: { ...s.ball.pos }, reason });
    this.awardPoint(winner, reason);
  }

  private awardPoint(winner: TeamId, reason: 'in' | 'out'): void {
    const s = this.state;
    s.score[winner]++;
    s.servingTeam = winner;
    this.emit({ kind: 'score', team: winner, reason, pos: { ...s.ball.pos } });

    const [a, b] = s.score;
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    const matchWon = (hi >= WIN_SCORE && hi - lo >= WIN_BY) || hi >= SCORE_CAP;

    if (matchWon) {
      const champ: TeamId = a > b ? 0 : 1;
      s.phase = 'over';
      s.phaseT = OVER_PAUSE;
      s.message = `matchover:${champ}`;
      this.emit({ kind: 'matchOver', team: champ });
      this.emit({ kind: 'phase', phase: 'over' });
    } else {
      s.phase = 'point';
      s.phaseT = POINT_PAUSE;
      s.message = `point:${winner}:${reason}`;
      this.emit({ kind: 'phase', phase: 'point' });
    }
  }

  // ── serve setup ───────────────────────────────────────────

  private setupServe(servingTeam: TeamId): void {
    const s = this.state;
    s.phase = 'serve';
    s.phaseT = 0;
    s.servingTeam = servingTeam;

    const teamPlayers = s.players.filter((p) => p.team === servingTeam);
    if (teamPlayers.length === 0) return; // degenerate; room will close anyway
    const idx = this.serveIdx[servingTeam] % teamPlayers.length;
    this.serveIdx[servingTeam]++;
    const server = teamPlayers[idx];
    s.serverId = server.id;

    // reset everyone to sensible rally positions
    for (const p of s.players) {
      const sideSign = p.team === 0 ? -1 : 1;
      const mates = s.players.filter((pl) => pl.team === p.team);
      const slot = mates.indexOf(p); // 0 or 1
      const zSlot = mates.length > 1 ? (slot === 0 ? -2 : 2) : 0;
      if (p.id === server.id) {
        p.pos = v3(sideSign * SERVE_X, 0, clamp(zSlot, -2, 2));
      } else {
        p.pos = v3(sideSign * COURT_HALF_LEN * 0.55, 0, zSlot);
      }
      p.vel = v3();
      p.onGround = true;
      p.hitCooldown = 0;
    }

    s.ball.held = true;
    s.ball.vel = v3();
    s.ball.lastToucherId = null;
    s.ball.blockExempt = false;
    s.ball.touches = 0;
    s.ball.side = servingTeam === 0 ? -1 : 1;
    this.emit({ kind: 'phase', phase: 'serve' });
  }

  // ── input helpers ─────────────────────────────────────────

  /** True on the tick where `key` transitions from released to pressed (latch-aware). */
  private edge(id: string, key: 'attack' | 'pass'): boolean {
    if (this.pendingPress.get(id)?.[key]) return true;
    const cur = this.inputs.get(id);
    if (!cur || !cur[key]) return false;
    const prev = this.prevInputs.get(id);
    return !prev || !prev[key];
  }

  private actionHeld(id: string): boolean {
    const cur = this.inputs.get(id);
    return !!cur && (cur.attack || cur.pass);
  }

  private emit(ev: Omit<GameEvent, 'tick'>): void {
    this.events.push({ ...ev, tick: this.state.tick });
  }
}
