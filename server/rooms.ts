// Lobby + room lifecycle + authoritative match loop. One Lobby per process;
// each Room owns a GameSim while a match runs. All client payloads passing
// through here are already size/rate-limited by index.ts and are re-validated
// field-by-field before touching state (see sanitize.ts).

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { MAX_PLAYERS, MAX_PLAYERS_PER_TEAM, TICK_DT } from '../shared/constants';
import { GameSim, type SimPlayerDef } from '../shared/game';
import { encode, type ClientMsg, type ServerMsg } from '../shared/protocol';
import type { GameEvent, RosterEntry, TeamId } from '../shared/types';
import { Bot } from './bot';
import { cleanName, finiteOr, sanitizeInput } from './sanitize';

// unambiguous alphabet: no I/O/0/1 lookalikes
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = [
  '봇-철수',
  '봇-영희',
  '봇-네트',
  '봇-스파이크',
  '봇-토스왕',
  '봇-모래알',
  '봇-갈매기',
  '봇-파도',
];

/** Maximum sim steps a single pump may run to catch up after a stall. */
const MAX_CATCHUP_STEPS = 4;
/** A match with no human input for this long is abandoned — reaped to free the loop. */
const IDLE_MATCH_MS = 120_000;
const REAP_INTERVAL_MS = 15_000;

export interface ClientConn {
  ws: WebSocket;
  id: string;
  name: string;
  greeted: boolean;
  room: Room | null;
  team: TeamId;
  ready: boolean;
}

class Room {
  members: ClientConn[] = [];
  inMatch = false;
  destroyed = false;
  sim: GameSim | null = null;
  bots = new Map<string, Bot>();
  /** last applied InputFrame.seq per human player id */
  acks = new Map<string, number>();
  /** sim events buffered between snapshots */
  events: GameEvent[] = [];
  loop: NodeJS.Timeout | null = null;
  accum = 0;
  lastNow = 0;
  lastHumanInputAt = 0; // wall-clock ms of the last accepted human input frame
  usedBotNames = new Set<string>();
  subCount = 0; // how many leavers have been replaced by 봇-대타

  constructor(
    readonly code: string,
    readonly isPublic: boolean,
  ) {}
}

export class Lobby {
  private rooms = new Map<string, Room>();
  private guestSeq = 0;
  private reaper: NodeJS.Timeout;

  constructor() {
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
  }

  /** Destroy matches abandoned by all their humans (no input for IDLE_MATCH_MS). */
  private reap(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (!room.inMatch) continue;
      if (now - room.lastHumanInputAt <= IDLE_MATCH_MS) continue;
      const members = [...room.members];
      this.destroyRoom(room);
      for (const m of members) {
        m.room = null;
        this.send(m, { t: 'error', msg: '오랫동안 입력이 없어 경기가 종료되었어요.' });
        try {
          m.ws.close(1000, 'idle');
        } catch {
          /* already closing */
        }
      }
    }
  }

  connect(ws: WebSocket): ClientConn {
    return {
      ws,
      id: randomUUID().replace(/-/g, '').slice(0, 10),
      name: '',
      greeted: false,
      room: null,
      team: 0,
      ready: false,
    };
  }

  disconnect(client: ClientConn): void {
    this.removeFromRoom(client);
  }

  /** Stop every room loop; used on server shutdown. */
  shutdown(): void {
    clearInterval(this.reaper);
    for (const room of [...this.rooms.values()]) this.destroyRoom(room);
  }

  handle(client: ClientConn, msg: ClientMsg): void {
    switch (msg.t) {
      case 'ping':
        this.send(client, { t: 'pong', ts: finiteOr(msg.ts, 0), st: Date.now() });
        return;
      case 'hello':
        this.hello(client, msg.name);
        return;
      default:
        break;
    }
    if (!client.greeted) {
      this.send(client, { t: 'error', msg: '먼저 접속 인사(hello)가 필요해요.' });
      return;
    }
    switch (msg.t) {
      case 'quick':
        this.quick(client);
        break;
      case 'create':
        this.create(client);
        break;
      case 'join':
        this.join(client, msg.code);
        break;
      case 'team':
        this.switchTeam(client, msg.team);
        break;
      case 'ready':
        this.setReady(client, !!msg.ready);
        break;
      case 'start':
        if (client.room && !client.room.inMatch) this.startMatch(client.room);
        break;
      case 'input':
        this.input(client, msg.f);
        break;
      case 'leave':
        this.removeFromRoom(client);
        break;
    }
  }

  // ── lobby ops ─────────────────────────────────────────────

  private hello(client: ClientConn, rawName: unknown): void {
    // renaming while inside a room would desync the roster — keep it stable
    if (!client.room) {
      const name = cleanName(rawName);
      client.name = name || `게스트${++this.guestSeq}`;
    }
    client.greeted = true;
    this.send(client, { t: 'welcome', id: client.id });
  }

  private quick(client: ClientConn): void {
    if (client.room) {
      this.send(client, { t: 'error', msg: '이미 방에 참가해 있어요.' });
      return;
    }
    let room: Room | null = null;
    // Map iterates in insertion order → oldest open public room wins
    for (const r of this.rooms.values()) {
      if (r.isPublic && !r.inMatch && r.members.length < MAX_PLAYERS) {
        room = r;
        break;
      }
    }
    if (!room) room = this.createRoom(true);
    this.joinRoom(client, room);
  }

  private create(client: ClientConn): void {
    if (client.room) {
      this.send(client, { t: 'error', msg: '이미 방에 참가해 있어요.' });
      return;
    }
    this.joinRoom(client, this.createRoom(false));
  }

  private join(client: ClientConn, rawCode: unknown): void {
    if (client.room) {
      this.send(client, { t: 'error', msg: '이미 방에 참가해 있어요.' });
      return;
    }
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) {
      this.send(client, { t: 'error', msg: '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.' });
      return;
    }
    if (room.inMatch) {
      this.send(client, { t: 'error', msg: '이미 경기가 진행 중인 방이에요.' });
      return;
    }
    if (room.members.length >= MAX_PLAYERS) {
      this.send(client, { t: 'error', msg: '방이 가득 찼어요.' });
      return;
    }
    this.joinRoom(client, room);
  }

  private createRoom(isPublic: boolean): Room {
    let code = '';
    do {
      code = Array.from(
        { length: 5 },
        () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
      ).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, isPublic);
    this.rooms.set(code, room);
    return room;
  }

  private joinRoom(client: ClientConn, room: Room): void {
    const t0 = room.members.filter((m) => m.team === 0).length;
    const t1 = room.members.filter((m) => m.team === 1).length;
    client.team = t1 < t0 ? 1 : 0; // smaller team; tie → team 0
    client.ready = false;
    client.room = room;
    room.members.push(client);
    this.broadcastRoom(room);
  }

  private switchTeam(client: ClientConn, rawTeam: unknown): void {
    const room = client.room;
    if (!room || room.inMatch) return;
    if (rawTeam !== 0 && rawTeam !== 1) return;
    if (rawTeam === client.team) return;
    const humansThere = room.members.filter((m) => m.team === rawTeam).length;
    if (humansThere >= MAX_PLAYERS_PER_TEAM) {
      this.send(client, { t: 'error', msg: '그 팀에는 빈자리가 없어요.' });
      return;
    }
    client.team = rawTeam;
    this.broadcastRoom(room);
  }

  private setReady(client: ClientConn, ready: boolean): void {
    const room = client.room;
    if (!room || room.inMatch) return;
    client.ready = ready;
    this.broadcastRoom(room);
    this.maybeAutoStart(room);
  }

  private maybeAutoStart(room: Room): void {
    if (room.inMatch || room.members.length === 0) return;
    if (room.members.every((m) => m.ready)) this.startMatch(room);
  }

  // ── match lifecycle ───────────────────────────────────────

  private startMatch(room: Room): void {
    room.inMatch = true;
    const defs: SimPlayerDef[] = room.members.map((m) => ({
      id: m.id,
      name: m.name,
      team: m.team,
      isBot: false,
    }));
    for (const team of [0, 1] as const) {
      let count = defs.filter((d) => d.team === team).length;
      while (count < MAX_PLAYERS_PER_TEAM) {
        const id = `bot-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        defs.push({ id, name: this.botName(room), team, isBot: true });
        room.bots.set(id, new Bot(id, 0.55 + Math.random() * 0.35));
        count++;
      }
    }

    room.sim = new GameSim(defs);
    room.events = [];
    for (const m of room.members) {
      room.acks.set(m.id, 0);
      this.send(m, { t: 'start', state: room.sim.state, you: m.id });
    }

    room.accum = 0;
    room.lastNow = performance.now();
    room.lastHumanInputAt = Date.now();
    room.loop = setInterval(() => this.pump(room), 8);
    console.log(`[room ${room.code}] 경기 시작 (인원 ${room.members.length}, 봇 ${room.bots.size})`);
  }

  private botName(room: Room): string {
    for (const n of BOT_NAMES) {
      if (!room.usedBotNames.has(n)) {
        room.usedBotNames.add(n);
        return n;
      }
    }
    return `봇-${room.usedBotNames.size + 1}호`;
  }

  /** Fixed-timestep accumulator; snapshots go out every 2nd sim tick (30/s). */
  private pump(room: Room): void {
    const sim = room.sim;
    if (!sim) return;
    const now = performance.now();
    room.accum += (now - room.lastNow) / 1000;
    room.lastNow = now;
    try {
      let steps = 0;
      while (room.accum >= TICK_DT && steps < MAX_CATCHUP_STEPS) {
        room.accum -= TICK_DT;
        steps++;
        for (const [id, bot] of room.bots) sim.setInput(id, bot.update(sim.state));
        sim.step();
        if (sim.events.length > 0) room.events.push(...sim.events);
        if (sim.state.tick % 2 === 0) this.broadcastSnap(room, sim);
      }
      // stalled badly (debugger, VM pause): drop the backlog instead of spiraling
      if (room.accum > TICK_DT * MAX_CATCHUP_STEPS) room.accum = TICK_DT * MAX_CATCHUP_STEPS;
    } catch (err) {
      console.error(`[room ${room.code}] sim error`, err);
    }
  }

  private broadcastSnap(room: Room, sim: GameSim): void {
    const acks: Record<string, number> = {};
    for (const [id, seq] of room.acks) acks[id] = seq;
    // stringify exactly once per broadcast
    const payload = encode({
      t: 'snap',
      state: sim.state,
      acks,
      events: room.events,
      st: Date.now(),
    });
    room.events = [];
    for (const m of room.members) {
      if (m.ws.readyState === WebSocket.OPEN) m.ws.send(payload);
    }
  }

  private input(client: ClientConn, rawFrame: unknown): void {
    const room = client.room;
    if (!room || !room.inMatch || !room.sim) return;
    const f = sanitizeInput(rawFrame);
    if (!f) return;
    room.sim.setInput(client.id, f);
    room.lastHumanInputAt = Date.now();
    const prev = room.acks.get(client.id) ?? 0;
    if (f.seq > prev) room.acks.set(client.id, f.seq);
  }

  // ── leaving ───────────────────────────────────────────────

  private removeFromRoom(client: ClientConn): void {
    const room = client.room;
    if (!room) return;
    client.room = null;
    client.ready = false;
    const idx = room.members.indexOf(client);
    if (idx >= 0) room.members.splice(idx, 1);

    if (room.inMatch && room.sim) {
      room.subCount++;
      const name = room.subCount === 1 ? '봇-대타' : `봇-대타${room.subCount}`;
      room.sim.markBot(client.id, name);
      // seq must continue past the leaver's last input or the sim would drop
      // every frame the replacement bot produces as stale
      const resumeSeq = (room.acks.get(client.id) ?? 0) + 120;
      room.bots.set(client.id, new Bot(client.id, 0.6 + Math.random() * 0.3, resumeSeq));
      room.acks.delete(client.id);
      this.broadcast(room, { t: 'left', id: client.id });
      if (room.members.length === 0) this.destroyRoom(room);
    } else if (room.members.length === 0) {
      this.destroyRoom(room);
    } else {
      this.broadcastRoom(room);
      this.maybeAutoStart(room);
    }
  }

  private destroyRoom(room: Room): void {
    if (room.destroyed) return; // a socket close racing server shutdown may get here twice
    room.destroyed = true;
    if (room.loop) clearInterval(room.loop);
    room.loop = null;
    room.sim = null;
    room.bots.clear();
    this.rooms.delete(room.code);
    console.log(`[room ${room.code}] 방 종료`);
  }

  // ── messaging ─────────────────────────────────────────────

  private broadcastRoom(room: Room): void {
    const roster: RosterEntry[] = room.members.map((m) => ({
      id: m.id,
      name: m.name,
      team: m.team,
      isBot: false,
      ready: m.ready,
    }));
    this.broadcast(room, {
      t: 'room',
      code: room.code,
      isPublic: room.isPublic,
      roster,
      inMatch: room.inMatch,
    });
  }

  private broadcast(room: Room, msg: ServerMsg): void {
    const payload = encode(msg);
    for (const m of room.members) {
      if (m.ws.readyState === WebSocket.OPEN) m.ws.send(payload);
    }
  }

  private send(client: ClientConn, msg: ServerMsg): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(encode(msg));
  }
}
