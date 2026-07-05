// Network client: WebSocket transport, clock sync, client-side prediction of
// the local player, reconciliation against server acks, and snapshot
// interpolation/extrapolation for remote entities. buildView() is the single
// output the presentation layer consumes.

import { INTERP_DELAY_MS, TICK_DT, TICK_RATE } from '../shared/constants';
import { predictLanding, serveHandPos, stepBall, stepPlayer, v3 } from '../shared/physics';
import { decodeServer, encode } from '../shared/protocol';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type {
  BallState,
  GameEvent,
  GameState,
  InputFrame,
  PlayerState,
  RosterEntry,
  TeamId,
  Vec3,
} from '../shared/types';
import type { ViewBall, ViewPlayer, ViewState } from './contracts';

export interface RoomInfo {
  code: string;
  isPublic: boolean;
  roster: RosterEntry[];
  inMatch: boolean;
}

interface Snap {
  state: GameState;
  st: number; // server wall-clock ms at send time
}

const TICK_MS = 1000 / TICK_RATE;
const MAX_EXTRAPOLATE_MS = 200;
const SMOOTH_DECAY = 10; // exponential decay rate of the correction offset, 1/s
const SMOOTH_SNAP_DIST = 2.5; // corrections larger than this are real teleports
const PENDING_CAP = 240; // ~4s of unacked inputs before we start dropping
const LANDING_REFRESH_MS = 120;

function emptyFrame(seq: number): InputFrame {
  return { seq, mx: 0, mz: 0, jump: false, pass: false, attack: false, ax: 0, az: 0 };
}

function fin(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeFrame(f: InputFrame): InputFrame {
  f.mx = Math.max(-1, Math.min(1, fin(f.mx)));
  f.mz = Math.max(-1, Math.min(1, fin(f.mz)));
  f.ax = fin(f.ax);
  f.az = fin(f.az);
  return f;
}

function clonePlayer(p: PlayerState): PlayerState {
  return { ...p, pos: { ...p.pos }, vel: { ...p.vel } };
}

function cloneBall(b: BallState): BallState {
  return { ...b, pos: { ...b.pos }, vel: { ...b.vel } };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return v3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
}

function finiteV(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

export class NetClient {
  // ── callbacks wired by main.ts ────────────────────────────
  onRoom: ((room: RoomInfo) => void) | null = null;
  onStart: ((state: GameState) => void) | null = null;
  onLeft: ((id: string) => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  /** unexpected socket close (after a successful connect) */
  onClose: (() => void) | null = null;

  myId = '';
  localTeam: TeamId = 0;
  inMatch = false;

  private ws: WebSocket | null = null;
  private welcomed = false;
  private connecting: Promise<void> | null = null;
  /** true once we've asked to be in a room; gates stale room/start/left pushes after leaving */
  private wantRoom = false;

  // clock sync
  private rtt = 80;
  private rttInit = false;
  private clockOffset = 0; // snapTimelineNow ≈ Date.now() + clockOffset
  private offsetInit = false;
  private pingTimer: number | null = null;

  // match state
  private snaps: Snap[] = [];
  private newestTick = -1;
  private eventQueue: GameEvent[] = [];
  private predicted: PlayerState | null = null;
  private smooth: Vec3 = v3(); // render offset that hides reconciliation pops
  private pending: InputFrame[] = [];
  private seq = 0; // monotonic across the whole session
  private tickTimer: number | null = null;
  private tickCarry = 0;
  private lastTickAt = 0;
  private sampler: ((seq: number) => InputFrame) | null = null;
  private aimSource: (() => Vec3 | null) | null = null;
  private landingCache: Vec3 | null = null;
  private landingAt = 0;
  private lastBuildAt = 0;

  /** input.ts provides the per-tick InputFrame through this. */
  setInputSampler(fn: (seq: number) => InputFrame): void {
    this.sampler = fn;
  }

  /** input.ts provides the current aim point (court space) through this. */
  setAimSource(fn: () => Vec3 | null): void {
    this.aimSource = fn;
  }

  get connected(): boolean {
    return this.welcomed && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  getRtt(): number {
    return Math.round(this.rtt);
  }

  /** Newest raw server state — UI reads phaseT/message from here. */
  getState(): GameState | null {
    const s = this.snaps[this.snaps.length - 1];
    return s ? s.state : null;
  }

  // ── connection ────────────────────────────────────────────

  connect(name: string): Promise<void> {
    if (this.connected) {
      // the socket survives leaving a room, so a nickname edited back on the
      // title screen must be re-announced. The server accepts a re-hello rename
      // while roomless (and ignores it in a room); the extra 'welcome' is
      // handled idempotently, and ordering guarantees it lands before the
      // quick/create/join that enter() sends next.
      this.send({ t: 'hello', name });
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;

    const url =
      (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';

    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.connecting = null;
        reject(e instanceof Error ? e : new Error('socket'));
        return;
      }
      this.ws = ws;

      ws.onopen = () => this.send({ t: 'hello', name });

      ws.onmessage = (ev) => {
        const msg = decodeServer(ev.data);
        if (!msg) return;
        if (msg.t === 'welcome') {
          this.myId = msg.id;
          this.welcomed = true;
          this.startPing();
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.handle(msg);
      };

      ws.onclose = () => {
        const wasWelcomed = this.welcomed;
        this.welcomed = false;
        this.wantRoom = false;
        this.connecting = null;
        this.stopPing();
        this.endMatch();
        if (!settled) {
          settled = true;
          reject(new Error('connect failed'));
          return;
        }
        if (wasWelcomed) this.onClose?.();
      };
      // errors always surface through onclose
      ws.onerror = () => {};
    });
    return this.connecting;
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  quick(): void {
    this.wantRoom = true;
    this.send({ t: 'quick' });
  }
  create(): void {
    this.wantRoom = true;
    this.send({ t: 'create' });
  }
  join(code: string): void {
    this.wantRoom = true;
    this.send({ t: 'join', code });
  }
  setTeam(team: TeamId): void {
    this.send({ t: 'team', team });
  }
  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }
  start(): void {
    this.send({ t: 'start' });
  }
  leave(): void {
    this.wantRoom = false;
    this.send({ t: 'leave' });
    this.endMatch();
  }

  // ── message handling ──────────────────────────────────────

  private handle(msg: ServerMsg): void {
    // Drop room/match pushes that race a leave: after we've left, a 'start' or
    // 'room' still in flight would otherwise strand us in a phantom match or a
    // stale lobby. ('snap' is already gated by inMatch, which never flips true
    // once its 'start' is dropped.)
    if (!this.wantRoom && (msg.t === 'room' || msg.t === 'start' || msg.t === 'left')) return;
    switch (msg.t) {
      case 'room':
        this.onRoom?.({
          code: msg.code,
          isPublic: msg.isPublic,
          roster: msg.roster,
          inMatch: msg.inMatch,
        });
        break;
      case 'start':
        this.beginMatch(msg.state, msg.you);
        break;
      case 'snap':
        this.onSnap(msg.state, msg.acks, msg.events, msg.st);
        break;
      case 'pong': {
        const sample = Date.now() - msg.ts;
        if (Number.isFinite(sample) && sample >= 0) {
          this.rtt = this.rttInit ? this.rtt * 0.8 + sample * 0.2 : sample;
          this.rttInit = true;
        }
        this.refineClock(msg.st, 0.2);
        break;
      }
      case 'left':
        this.onLeft?.(msg.id);
        break;
      case 'error':
        this.onError?.(msg.msg);
        break;
      default:
        break;
    }
  }

  private refineClock(st: number, alpha: number): void {
    if (!Number.isFinite(st)) return;
    // Anchor to the snapshot SEND-TIME timeline, not absolute server present:
    // the newest snapshot we can hold is already one-way-delay old, so mapping
    // client time onto (server clock − owd) keeps renderTime a genuine
    // INTERP_DELAY_MS behind the newest data at any RTT. (Adding rtt/2 here made
    // the jitter buffer vanish for high-latency players — exactly who needs it.)
    const sample = st - Date.now();
    this.clockOffset = this.offsetInit
      ? this.clockOffset * (1 - alpha) + sample * alpha
      : sample;
    this.offsetInit = true;
  }

  /** "Now" on the snapshot send-time timeline — what st a snapshot arriving this instant would carry. */
  private serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.send({ t: 'ping', ts: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── match lifecycle ───────────────────────────────────────

  private beginMatch(state: GameState, you: string): void {
    if (you) this.myId = you;
    this.inMatch = true;
    // the start state has no send timestamp — approximate with our clock estimate
    this.snaps = [{ state, st: this.serverNow() }];
    this.newestTick = state.tick;
    this.eventQueue = [];
    this.pending = [];
    this.smooth = v3();
    this.landingCache = null;
    this.landingAt = 0;
    this.lastBuildAt = 0;
    const me = state.players.find((p) => p.id === this.myId);
    this.localTeam = me ? me.team : 0;
    this.predicted = me ? clonePlayer(me) : null;
    this.startTicking();
    this.onStart?.(state);
  }

  /** Tear down match state (leave, room reverted to lobby, disconnect). */
  endMatch(): void {
    this.inMatch = false;
    this.stopTicking();
    this.snaps = [];
    this.newestTick = -1;
    this.eventQueue = [];
    this.pending = [];
    this.predicted = null;
    this.smooth = v3();
    this.landingCache = null;
    this.lastBuildAt = 0;
  }

  // ── fixed 60Hz input tick ─────────────────────────────────

  private startTicking(): void {
    this.stopTicking();
    this.lastTickAt = performance.now();
    this.tickCarry = 0;
    this.tickTimer = window.setInterval(() => this.pump(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Drift-corrected accumulator: run however many 60Hz ticks real time owes us. */
  private pump(): void {
    const now = performance.now();
    this.tickCarry += now - this.lastTickAt;
    this.lastTickAt = now;
    if (this.tickCarry > TICK_MS * 8) this.tickCarry = TICK_MS; // hidden tab — don't burst
    while (this.tickCarry >= TICK_MS) {
      this.tickCarry -= TICK_MS;
      this.doTick();
    }
  }

  private doTick(): void {
    if (!this.inMatch || !this.connected) return;
    const seq = ++this.seq;
    const f = sanitizeFrame(this.sampler ? this.sampler(seq) : emptyFrame(seq));
    f.seq = seq;
    this.send({ t: 'input', f });
    this.pending.push(f);
    if (this.pending.length > PENDING_CAP) this.pending.shift();

    if (this.predicted) {
      stepPlayer(this.predicted, f, TICK_DT, this.serveLockOpts());
    }
  }

  /** Same lock rule the server applies: pre-serve, the server player is pinned. */
  private serveLockOpts(): { serveLock?: boolean } {
    const s = this.getState();
    return s && s.phase === 'serve' && s.serverId === this.myId ? { serveLock: true } : {};
  }

  // ── snapshots ─────────────────────────────────────────────

  private onSnap(
    state: GameState,
    acks: Record<string, number>,
    events: GameEvent[],
    st: number,
  ): void {
    if (!this.inMatch) return;
    if (state.tick <= this.newestTick) return; // out-of-order / duplicate
    this.newestTick = state.tick;

    this.refineClock(st, 0.05);

    this.snaps.push({ state, st });
    if (this.snaps.length > 60) this.snaps.splice(0, this.snaps.length - 60);

    if (events && events.length) {
      for (const ev of events) this.eventQueue.push(ev);
      if (this.eventQueue.length > 200)
        this.eventQueue.splice(0, this.eventQueue.length - 200);
    }

    this.reconcile(state, acks);
  }

  private reconcile(state: GameState, acks: Record<string, number> | undefined): void {
    const me = state.players.find((p) => p.id === this.myId);
    if (!me) return;
    this.localTeam = me.team;

    const ack = acks ? acks[this.myId] : undefined;
    if (typeof ack === 'number') {
      while (this.pending.length > 0 && this.pending[0].seq <= ack) this.pending.shift();
    }

    // where the player is currently drawn (prediction + smoothing offset)
    const old = this.predicted
      ? v3(
          this.predicted.pos.x + this.smooth.x,
          this.predicted.pos.y + this.smooth.y,
          this.predicted.pos.z + this.smooth.z,
        )
      : null;

    // authoritative state + replay of everything the server hasn't applied yet
    const next = clonePlayer(me);
    const opts =
      state.phase === 'serve' && state.serverId === this.myId ? { serveLock: true } : {};
    for (const f of this.pending) stepPlayer(next, f, TICK_DT, opts);

    if (old && finiteV(next.pos)) {
      this.smooth = v3(old.x - next.pos.x, old.y - next.pos.y, old.z - next.pos.z);
      const m = Math.hypot(this.smooth.x, this.smooth.y, this.smooth.z);
      // big jumps are intentional teleports (serve reset) — snap, don't glide
      if (!Number.isFinite(m) || m > SMOOTH_SNAP_DIST) this.smooth = v3();
    }
    this.predicted = next;
  }

  /** Events accumulated since the last drain (exactly-once delivery). */
  drainEvents(): GameEvent[] {
    if (this.eventQueue.length === 0) return this.eventQueue;
    // Drop events older than ~1s so a backgrounded tab (rAF paused, snapshots
    // still arriving) doesn't replay a minute of stacked whistles/confetti on
    // return. Events from the last second still play, matching render latency.
    const cutoff = this.newestTick - TICK_RATE;
    const fresh = this.eventQueue.filter((ev) => ev.tick >= cutoff);
    this.eventQueue = [];
    return fresh;
  }

  // ── view assembly ─────────────────────────────────────────

  buildView(): ViewState | null {
    const newest = this.snaps[this.snaps.length - 1];
    if (!newest || !this.inMatch) return null;
    const ns = newest.state;

    const now = performance.now();
    const dt = this.lastBuildAt > 0 ? Math.min(0.1, (now - this.lastBuildAt) / 1000) : 0;
    this.lastBuildAt = now;

    // decay the reconciliation smoothing offset
    const k = Math.exp(-SMOOTH_DECAY * dt);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.z *= k;

    // pick bracketing snapshots around renderTime
    const renderTime = this.serverNow() - INTERP_DELAY_MS;
    let j = -1;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].st <= renderTime) {
        j = i;
        break;
      }
    }
    let s0: Snap;
    let s1: Snap;
    let alpha = 0;
    let extraMs = 0;
    if (j === -1) {
      s0 = s1 = this.snaps[0]; // renderTime older than the whole buffer
    } else if (j >= this.snaps.length - 1) {
      s0 = s1 = newest; // past the newest — hold players, extrapolate the ball
      extraMs = Math.min(Math.max(0, renderTime - newest.st), MAX_EXTRAPOLATE_MS);
    } else {
      s0 = this.snaps[j];
      s1 = this.snaps[j + 1];
      const span = s1.st - s0.st;
      alpha = span > 0 ? Math.min(1, Math.max(0, (renderTime - s0.st) / span)) : 0;
    }

    let ball = this.buildBall(ns, s0, s1, alpha, extraMs);
    const players = this.buildPlayers(ns, s0, s1, alpha);

    // During my own serve the ball is pinned to my hand every server tick, but
    // my player is predicted at present time while the ball would interpolate
    // ~100ms+ in the past — so a strafing server would see the ball trail their
    // hand. Re-pin it to the drawn local position instead.
    if (ns.phase === 'serve' && ns.ball.held && ns.serverId === this.myId) {
      const me = players.find((p) => p.isLocal);
      if (me && finiteV(me.pos)) {
        ball = { pos: serveHandPos(me.pos, this.localTeam), vel: v3(), held: true };
      }
    }

    // landing prediction — rally only, refreshed at most every ~120ms
    let landing: Vec3 | null = null;
    if (ns.phase === 'rally' && !ball.held) {
      if (now - this.landingAt > LANDING_REFRESH_MS) {
        this.landingAt = now;
        const lb: BallState = {
          pos: { ...ball.pos },
          vel: { ...ball.vel },
          held: false,
          lastToucherId: null,
          blockExempt: false,
          touches: 0,
          side: ball.pos.x < 0 ? -1 : 1,
        };
        const hit = predictLanding(lb);
        this.landingCache = hit && finiteV(hit.pos) ? hit.pos : null;
      }
      landing = this.landingCache;
    } else {
      this.landingCache = null;
    }

    const aim = this.aimSource ? this.aimSource() : null;

    return {
      phase: ns.phase,
      players,
      ball,
      score: [ns.score[0], ns.score[1]],
      servingTeam: ns.servingTeam,
      serverId: ns.serverId,
      localTeam: this.localTeam,
      localId: this.myId,
      landing,
      aim: aim && finiteV(aim) ? aim : null,
    };
  }

  private buildBall(ns: GameState, s0: Snap, s1: Snap, alpha: number, extraMs: number): ViewBall {
    const nb = ns.ball;
    if (extraMs > 0 && !nb.held) {
      // past the newest snapshot: run the shared sim forward (capped)
      const b = cloneBall(nb);
      const bouncy = ns.phase === 'point' || ns.phase === 'over';
      let remain = extraMs / 1000;
      while (remain > 1e-4) {
        const h = Math.min(TICK_DT, remain);
        stepBall(b, h, bouncy);
        remain -= h;
      }
      if (finiteV(b.pos) && finiteV(b.vel)) {
        return { pos: { ...b.pos }, vel: { ...b.vel }, held: false };
      }
      return { pos: { ...nb.pos }, vel: { ...nb.vel }, held: nb.held };
    }
    const b0 = s0.state.ball;
    const b1 = s1.state.ball;
    const pos = lerpV(b0.pos, b1.pos, alpha);
    const vel = lerpV(b0.vel, b1.vel, alpha);
    if (!finiteV(pos) || !finiteV(vel)) {
      return { pos: { ...nb.pos }, vel: { ...nb.vel }, held: nb.held };
    }
    return { pos, vel, held: b1.held };
  }

  private buildPlayers(ns: GameState, s0: Snap, s1: Snap, alpha: number): ViewPlayer[] {
    const out: ViewPlayer[] = [];
    for (const p of ns.players) {
      const isLocal = p.id === this.myId;
      let pos: Vec3;
      let vel: Vec3;
      let onGround: boolean;
      if (isLocal && this.predicted && finiteV(this.predicted.pos)) {
        pos = v3(
          this.predicted.pos.x + this.smooth.x,
          Math.max(0, this.predicted.pos.y + this.smooth.y),
          this.predicted.pos.z + this.smooth.z,
        );
        vel = { ...this.predicted.vel };
        onGround = this.predicted.onGround;
      } else {
        const p0 = s0.state.players.find((pl) => pl.id === p.id) ?? p;
        const p1 = s1.state.players.find((pl) => pl.id === p.id) ?? p0;
        pos = lerpV(p0.pos, p1.pos, alpha);
        vel = lerpV(p0.vel, p1.vel, alpha);
        onGround = p1.onGround;
        if (!finiteV(pos)) {
          pos = { ...p.pos };
          vel = { ...p.vel };
          onGround = p.onGround;
        }
      }
      out.push({
        id: p.id,
        name: p.name,
        team: p.team,
        isBot: p.isBot,
        isLocal,
        pos,
        vel,
        onGround,
        lastHitType: p.lastHitType,
        lastHitAge: Math.max(0, (ns.tick - p.lastHitTick) * TICK_DT),
      });
    }
    return out;
  }
}
