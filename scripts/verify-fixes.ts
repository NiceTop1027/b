// Focused verification of the review fixes, exercising the shared sim/physics
// directly (no sockets). Exits 0 on pass, 1 on any failed assertion.

import {
  COURT_HALF_LEN,
  COURT_HALF_WID,
  NET_HALF_WIDTH,
  NET_TOP,
  BALL_R,
  SERVE_X,
} from '../shared/constants';
import {
  solveArcOverNet,
  stepBall,
  clampAim,
  v3,
} from '../shared/physics';
import { GameSim, type SimPlayerDef } from '../shared/game';
import { Bot } from '../server/bot';
import type { BallState } from '../shared/types';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name} ${detail}`);
    failed++;
  }
}

function freshBall(pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): BallState {
  return {
    pos: { ...pos },
    vel: { ...vel },
    held: false,
    lastToucherId: null,
    blockExempt: false,
    touches: 0,
    side: pos.x < 0 ? -1 : 1,
  };
}

// Roll a ball forward and report the first terminal event.
function rollout(b: BallState, maxT = 5): { event: 'crossed' | 'net' | 'cord' | 'floor' | 'none'; pos: { x: number; y: number; z: number } } {
  const dt = 1 / 120;
  for (let t = 0; t < maxT; t += dt) {
    const f = stepBall(b, dt, false);
    if (f.net) return { event: 'net', pos: { ...b.pos } };
    if (f.cord) return { event: 'cord', pos: { ...b.pos } };
    if (f.crossed) {
      // keep rolling to find where it lands after crossing
      for (let t2 = t; t2 < maxT; t2 += dt) {
        const f2 = stepBall(b, dt, false);
        if (f2.floor) return { event: 'crossed', pos: { ...b.pos } };
      }
      return { event: 'crossed', pos: { ...b.pos } };
    }
    if (f.floor) return { event: 'floor', pos: { ...b.pos } };
  }
  return { event: 'none', pos: { ...b.pos } };
}

console.log('BALLTBALL fix verification\n');

// ── #9: serves/attacks clear the net from deep positions across a sweep ──
console.log('[#9] 서브/공격 아크가 네트를 넘는지 (깊은 위치 → 근네트 목표 포함)');
{
  let netFaults = 0;
  let total = 0;
  for (let fx = -SERVE_X - 1; fx <= -1; fx += 0.7) {
    for (let aimX = 0.8; aimX <= COURT_HALF_LEN; aimX += 0.9) {
      for (const aimZ of [-3, 0, 3]) {
        total++;
        const from = v3(fx, 1.65, 0);
        const aim = clampAim(aimX, aimZ, 0);
        const vel = solveArcOverNet(from, aim, Math.max(NET_TOP + 1.6, from.y + 1.1));
        const r = rollout(freshBall(from, vel));
        if (r.event === 'net' || r.event === 'cord' || r.event === 'floor') netFaults++;
      }
    }
  }
  check(
    `team0 아크 ${total}개 중 네트/자기코트 낙하 0건`,
    netFaults === 0,
    `(실패 ${netFaults}건)`,
  );
  // mirror for team 1
  let netFaults1 = 0;
  let total1 = 0;
  for (let fx = 1; fx <= SERVE_X + 1; fx += 0.7) {
    for (let aimX = -0.8; aimX >= -COURT_HALF_LEN; aimX -= 0.9) {
      for (const aimZ of [-3, 0, 3]) {
        total1++;
        const from = v3(fx, 1.65, 0);
        const aim = clampAim(aimX, aimZ, 1);
        const vel = solveArcOverNet(from, aim, Math.max(NET_TOP + 1.6, from.y + 1.1));
        const r = rollout(freshBall(from, vel));
        if (r.event === 'net' || r.event === 'cord' || r.event === 'floor') netFaults1++;
      }
    }
  }
  check(`team1 아크 ${total1}개 중 실패 0건`, netFaults1 === 0, `(실패 ${netFaults1}건)`);
}

// ── #7: floor contact is back-interpolated (landing near true crossing) ──
console.log('\n[#7] 낙하 지점 백보간 — 빠른 대각 스파이크가 오버슈트 없이 판정');
{
  // ball descending fast and diagonally; without back-interp the recorded x
  // overshoots by up to ~0.3m. Fire one straight down-ish and compare the
  // landing x against the analytic crossing of y=BALL_R.
  const b = freshBall(v3(2, 2.0, 0), v3(6, -12, 4));
  // analytic: integrate finely without the clamp to find true floor x
  const fine = freshBall(v3(2, 2.0, 0), v3(6, -12, 4));
  let trueX = fine.pos.x;
  let trueZ = fine.pos.z;
  {
    const dt = 1 / 2000;
    for (let t = 0; t < 3; t += dt) {
      const ny = fine.pos.y + fine.vel.y * dt;
      if (ny <= BALL_R) {
        const frac = (fine.pos.y - BALL_R) / (fine.pos.y - ny);
        trueX = fine.pos.x + fine.vel.x * dt * frac;
        trueZ = fine.pos.z + fine.vel.z * dt * frac;
        break;
      }
      fine.vel.y += -14 * dt; // BALL_GRAVITY, drag ignored for the reference is fine at small dt
      // apply the same drag as stepBall for fairness
      const drag = Math.max(0, 1 - 0.06 * dt);
      fine.vel.x *= drag; fine.vel.y *= drag; fine.vel.z *= drag;
      fine.pos.x += fine.vel.x * dt;
      fine.pos.y += ny <= BALL_R ? 0 : fine.vel.y * dt;
      fine.pos.z += fine.vel.z * dt;
    }
  }
  let landed = { x: 0, z: 0 };
  {
    const dt = 1 / 60;
    for (let t = 0; t < 3; t += dt) {
      const f = stepBall(b, dt, false);
      if (f.floor) { landed = { x: b.pos.x, z: b.pos.z }; break; }
    }
  }
  const errX = Math.abs(landed.x - trueX);
  check(`60Hz 낙하 x 오차 < 0.08m (오차 ${errX.toFixed(3)}m)`, errX < 0.08, `landed=${landed.x.toFixed(3)} true=${trueX.toFixed(3)}`);
}

// ── #11: ball wide of the posts crosses cleanly (no phantom net) ──
console.log('\n[#11] 포스트 바깥으로 지나는 공은 네트에 안 맞고 넘어감');
{
  const zOutside = NET_HALF_WIDTH + BALL_R + 0.5;
  const b = freshBall(v3(-1, 1.0, zOutside), v3(6, 1, 0)); // low, crossing wide of the post
  const r = rollout(b);
  check(`포스트 밖(z=${zOutside.toFixed(1)}) 낮은 공이 net 판정 안 남`, r.event !== 'net' && r.event !== 'cord', `(event=${r.event})`);
  // control: same ball inside the net span at low height SHOULD hit the net
  const b2 = freshBall(v3(-1, 1.0, 0), v3(6, 1, 0));
  const r2 = rollout(b2);
  check('중앙 낮은 공은 여전히 net에 막힘 (대조군)', r2.event === 'net' || r2.event === 'cord', `(event=${r2.event})`);
}

// ── #6: a team cannot self-block its own netted ball to reset touches ──
console.log('\n[#6] 자기 팀 공을 블로킹으로 터치 리셋 불가');
{
  const defs: SimPlayerDef[] = [
    { id: 'a', name: 'A', team: 0, isBot: false },
    { id: 'b', name: 'B', team: 0, isBot: false },
    { id: 'c', name: 'C', team: 1, isBot: false },
    { id: 'd', name: 'D', team: 1, isBot: false },
  ];
  const sim = new GameSim(defs);
  // force into rally with team 0 having used 3 touches, ball rebounding off net toward team 0
  sim.state.phase = 'rally';
  sim.state.ball = freshBall(v3(-0.3, 1.4, 0), v3(-2, 0.5, 0));
  sim.state.ball.touches = 3;
  sim.state.ball.lastToucherId = 'a'; // team 0 last touched
  sim.state.ball.blockExempt = false;
  // put teammate B airborne at the net
  const B = sim.state.players.find((p) => p.id === 'b')!;
  B.pos = v3(-0.5, 1.2, 0);
  B.onGround = false;
  B.hitCooldown = 0;
  const touchesBefore = sim.state.ball.touches;
  sim.step();
  check(
    '자기 팀 리바운드는 블록으로 터치 리셋되지 않음',
    sim.state.ball.touches >= touchesBefore || sim.state.ball.lastToucherId === 'a',
    `(touches ${touchesBefore}→${sim.state.ball.touches}, last=${sim.state.ball.lastToucherId})`,
  );
}

// ── full 4-bot match integrity: no NaN, completes with a winner ──
console.log('\n[통합] 봇 4인 풀매치 — NaN 없이 승자까지 완주');
{
  const defs: SimPlayerDef[] = [
    { id: 'b0', name: '봇0', team: 0, isBot: true },
    { id: 'b1', name: '봇1', team: 0, isBot: true },
    { id: 'b2', name: '봇2', team: 1, isBot: true },
    { id: 'b3', name: '봇3', team: 1, isBot: true },
  ];
  const sim = new GameSim(defs);
  const bots = new Map(defs.map((d, i) => [d.id, new Bot(d.id, 0.7 + i * 0.05)]));
  let nan = false;
  let rallies = 0;
  let lastPhase = sim.state.phase;
  const maxTicks = 60 * 60 * 8; // 8 minutes of sim
  let t = 0;
  for (; t < maxTicks; t++) {
    for (const [id, bot] of bots) sim.setInput(id, bot.update(sim.state));
    sim.step();
    const b = sim.state.ball;
    if (![b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z].every(Number.isFinite)) { nan = true; break; }
    for (const p of sim.state.players) {
      if (![p.pos.x, p.pos.y, p.pos.z].every(Number.isFinite)) { nan = true; break; }
    }
    if (lastPhase !== 'rally' && sim.state.phase === 'rally') rallies++;
    lastPhase = sim.state.phase;
    if (sim.state.phase === 'over') break;
  }
  check('물리 상태 NaN 없음', !nan);
  check(`랠리가 다수 발생 (${rallies}회)`, rallies > 8, `(${rallies})`);
  check('매치가 종료(승자 결정)까지 도달', sim.state.phase === 'over', `(phase=${sim.state.phase}, score=${sim.state.score.join(':')} @${t}tick)`);
  const [s0, s1] = sim.state.score;
  check('점수가 정상 범위', s0 >= 0 && s1 >= 0 && Math.max(s0, s1) >= 15, `(${s0}:${s1})`);
}

console.log('');
if (failed === 0) {
  console.log('PASS: 모든 수정 검증 통과 ✅');
  process.exit(0);
} else {
  console.error(`FAIL: ${failed}개 검증 실패`);
  process.exit(1);
}
