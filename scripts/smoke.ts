// End-to-end smoke test. Boots the real server in-process, connects two real
// websocket clients, plays a 2v2 (2 humans + 2 bots) and asserts the match
// actually progresses: snapshots stream, hits happen, points get scored.
// Exit 0 on PASS, 1 on any failure. Global watchdog: 90s.

import WebSocket from 'ws';
import { startServer } from '../server/index';
import { decodeServer, encode, type ClientMsg, type ServerMsg } from '../shared/protocol';

const PORT = 3199;
const URL = `ws://localhost:${PORT}/ws`;

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type WelcomeMsg = Extract<ServerMsg, { t: 'welcome' }>;
type StartMsg = Extract<ServerMsg, { t: 'start' }>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

class TestClient {
  history: ServerMsg[] = [];
  onMsg: ((m: ServerMsg) => void) | null = null;
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];

  private constructor(
    readonly label: string,
    readonly ws: WebSocket,
  ) {}

  static async connect(label: string): Promise<TestClient> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const ws = new WebSocket(URL);
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
        const c = new TestClient(label, ws);
        ws.on('message', (data) => {
          const m = decodeServer(data.toString());
          if (!m) return;
          c.history.push(m);
          c.onMsg?.(m);
          c.waiters = c.waiters.filter((w) => {
            if (!w.pred(m)) return true;
            w.resolve(m);
            return false;
          });
        });
        return c;
      } catch {
        await sleep(150);
      }
    }
    fail(`${label}: 서버에 접속하지 못했습니다`);
  }

  send(m: ClientMsg): void {
    this.ws.send(encode(m));
  }

  waitFor(desc: string, pred: (m: ServerMsg) => boolean, timeoutMs = 8000): Promise<ServerMsg> {
    const already = this.history.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: '${desc}' 대기 시간 초과 (${timeoutMs}ms)`)),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
}

/** Plausible human input at ~30Hz: random-walk movement + occasional attack presses. */
function driveInputs(c: TestClient, team: 0 | 1): NodeJS.Timeout {
  let seq = 1;
  let mx = 0;
  let mz = 0;
  let hold = 0;
  const oppSign = team === 0 ? 1 : -1;
  return setInterval(() => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    mx = clampN(mx + (Math.random() - 0.5) * 0.7, -1, 1);
    mz = clampN(mz + (Math.random() - 0.5) * 0.7, -1, 1);
    let attack = false;
    if (hold > 0) {
      attack = true;
      hold--;
    } else if (Math.random() < 0.08) {
      hold = 3;
    }
    c.send({
      t: 'input',
      f: {
        seq: seq++,
        mx,
        mz,
        jump: Math.random() < 0.04,
        pass: false,
        attack,
        ax: oppSign * (2 + Math.random() * 4.5), // in-court aim on the opponent side
        az: (Math.random() - 0.5) * 6,
      },
    });
  }, 33);
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => fail('전체 타임아웃(90초) 초과'), 90_000);

  console.log('BALLTBALL smoke test');
  const server = startServer(PORT);

  // ── connect + hello ─────────────────────────────────────
  const A = await TestClient.connect('A');
  const B = await TestClient.connect('B');

  A.send({ t: 'hello', name: '테스터A' });
  const idA = ((await A.waitFor('welcome', (m) => m.t === 'welcome')) as WelcomeMsg).id;
  B.send({ t: 'hello', name: '테스터B' });
  const idB = ((await B.waitFor('welcome', (m) => m.t === 'welcome')) as WelcomeMsg).id;
  ok(`hello/welcome (A=${idA}, B=${idB})`);

  A.send({ t: 'ping', ts: 12345 });
  await A.waitFor('pong', (m) => m.t === 'pong' && m.ts === 12345);
  ok('ping → pong');

  // ── quick match: both must land in the same public room ─
  A.send({ t: 'quick' });
  const roomA = (await A.waitFor('room', (m) => m.t === 'room')) as RoomMsg;
  if (!roomA.roster.some((r) => r.id === idA)) fail('A가 방 로스터에 없음');

  B.send({ t: 'quick' });
  const roomB = (await B.waitFor(
    'room(2명)',
    (m) => m.t === 'room' && m.roster.length === 2,
  )) as RoomMsg;
  if (roomB.code !== roomA.code) fail(`A(${roomA.code})와 B(${roomB.code})가 다른 방에 배정됨`);
  if (!roomB.roster.some((r) => r.id === idA) || !roomB.roster.some((r) => r.id === idB)) {
    fail('로스터에 두 플레이어가 모두 없음');
  }
  await A.waitFor('room 갱신(2명)', (m) => m.t === 'room' && m.roster.length === 2);
  ok(`퀵매치: 같은 공개 방 ${roomA.code}, 로스터 2명`);

  // ── team switch ─────────────────────────────────────────
  A.send({ t: 'team', team: 1 });
  await A.waitFor(
    '팀 변경 반영',
    (m) => m.t === 'room' && m.roster.some((r) => r.id === idA && r.team === 1),
  );
  ok('A 팀 변경(team 1) 로스터 반영');

  // ── match progress tracking (installed before ready) ────
  let snapCount = 0;
  let lastTick = -1;
  let monotonic = true;
  let sawHit = false;
  let sawScore = false;
  let scoreChanged = false;
  let lastAckA = 0;
  A.onMsg = (m) => {
    if (m.t !== 'snap') return;
    snapCount++;
    if (m.state.tick <= lastTick) monotonic = false;
    lastTick = m.state.tick;
    if (m.state.score[0] !== 0 || m.state.score[1] !== 0) scoreChanged = true;
    if (typeof m.acks[idA] === 'number') lastAckA = m.acks[idA];
    for (const ev of m.events) {
      if (ev.kind === 'hit') sawHit = true;
      if (ev.kind === 'score') sawScore = true;
    }
  };

  // ── ready → start with bots filling to 2v2 ──────────────
  A.send({ t: 'ready', ready: true });
  B.send({ t: 'ready', ready: true });
  const startA = (await A.waitFor('start', (m) => m.t === 'start')) as StartMsg;
  await B.waitFor('start', (m) => m.t === 'start');
  const players = startA.state.players;
  if (players.length !== 4) fail(`시작 인원이 4명이 아님 (${players.length})`);
  const botCount = players.filter((p) => p.isBot).length;
  if (botCount !== 2) fail(`봇이 2명이 아님 (${botCount})`);
  const team0 = players.filter((p) => p.team === 0).length;
  if (team0 !== 2) fail(`팀 밸런스 붕괴 (team0=${team0})`);
  if (startA.you !== idA) fail(`start.you가 A의 id가 아님 (${startA.you})`);
  ok(`경기 시작: 4명(봇 ${botCount}) 2:2 구성, you=${startA.you}`);

  // ── drive inputs, wait for the game to actually happen ──
  const drivers = [driveInputs(A, 1), driveInputs(B, 1)]; // both humans ended on team 1
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (snapCount > 60 && sawHit && sawScore && scoreChanged) break;
    await sleep(250);
  }
  for (const d of drivers) clearInterval(d);

  if (!monotonic) fail('스냅샷 tick이 단조 증가하지 않음');
  if (snapCount <= 60) fail(`스냅샷 수신 부족 (${snapCount}개)`);
  if (!sawHit) fail("60초 안에 'hit' 이벤트가 없음");
  if (!sawScore) fail("60초 안에 'score' 이벤트가 없음");
  if (!scoreChanged) fail('점수가 [0,0]에서 변하지 않음');
  if (lastAckA <= 0) fail('A의 입력 ack(seq)가 스냅샷에 반영되지 않음');
  ok(`스냅샷 ${snapCount}개 수신, tick 단조 증가 (마지막 tick=${lastTick})`);
  ok(`hit/score 이벤트 및 점수 변화 확인, A 입력 ack=${lastAckA}`);

  // ── clients drop; the server must survive ───────────────
  A.ws.close();
  B.ws.close();
  await sleep(400);
  const C = await TestClient.connect('C');
  C.send({ t: 'hello', name: '생존확인' });
  await C.waitFor('welcome', (m) => m.t === 'welcome', 5000);
  ok('두 클라이언트 종료 후에도 서버가 새 접속을 처리함');
  C.ws.close();

  await server.close();
  clearTimeout(watchdog);
  console.log('PASS: 로비 → 퀵매치 → 팀 변경 → 시작(봇 충원) → 랠리/득점 → 정리까지 전부 정상');
  process.exit(0);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
