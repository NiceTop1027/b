// All DOM UI: title, lobby, HUD, match-over / disconnect overlays, toasts.
// Pure presentation — main.ts wires the hooks to the network layer.

import { MAX_PLAYERS_PER_TEAM, SCORE_CAP, WIN_BY, WIN_SCORE } from '../shared/constants';
import type { GameEvent, GameState, Phase, TeamId } from '../shared/types';
import type { ViewState } from './contracts';
import type { RoomInfo } from './net';

const TEAM_NAMES: [string, string] = ['파랑', '코랄'];
const NICK_KEY = 'balltball:nick';
const MUTE_KEY = 'balltball:muted';
const RANDOM_NICKS = [
  '무명의강타자',
  '바닷가의전설',
  '석양의스파이커',
  '모래폭풍블로커',
  '파도타는세터',
  '코코넛스매셔',
  '일몰의리베로',
  '해변의수호자',
];
const HOWTO = '이동 WASD · 점프 Space · 공격 좌클릭 · 토스 우클릭 · 마우스로 조준';

export interface UIHooks {
  onQuick(name: string): void;
  onCreate(name: string): void;
  onJoin(name: string, code: string): void;
  onTeamChange(): void;
  onReadyToggle(ready: boolean): void;
  onStartNow(): void;
  onLeaveRoom(): void;
  onLeaveMatch(): void;
  onMute(muted: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'btn ' + cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// localStorage can throw on the property access itself (Chrome "block all
// cookies", old Safari private mode) — guard every touch so the app still boots.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked — persistence off, session state still lives in memory */
  }
}

/** Team that wins the match with its next point, or null. */
function matchPointTeam(score: [number, number]): TeamId | null {
  for (const t of [0, 1] as const) {
    const a = score[t] + 1;
    const b = score[t === 0 ? 1 : 0];
    if ((a >= WIN_SCORE && a - b >= WIN_BY) || a >= SCORE_CAP) return t;
  }
  return null;
}

export class UI {
  private hooks: UIHooks;

  private titleEl: HTMLElement;
  private nickInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private titleButtons: HTMLButtonElement[] = [];

  private lobbyEl: HTMLElement;
  private roomCodeEl: HTMLElement;
  private roomVisEl: HTMLElement;
  private teamLists: [HTMLElement, HTMLElement];
  private readyBtn: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private myReady = false;

  private hudEl: HTMLElement;
  private scoreEls: [HTMLElement, HTMLElement];
  private serveDots: [HTMLElement, HTMLElement];
  private mpBadge: HTMLElement;
  private announceEl: HTMLElement;
  private announceSubEl: HTMLElement;
  private pingEl: HTMLElement;
  private muteBtn: HTMLButtonElement;
  private menuMuteBtn: HTMLButtonElement;

  private menuEl: HTMLElement;
  private helpEl: HTMLElement;

  private overEl: HTMLElement;
  private overTitleEl: HTMLElement;
  private overScoreEl: HTMLElement;
  private overCountEl: HTMLElement;

  private discEl: HTMLElement;
  private toastsEl: HTMLElement;

  private hudActive = false;
  private disconnected = false;
  private muted: boolean;
  private announceTimer = 0;
  private subTimer = 0;
  private rematchTimer = 0;
  private lastPhase: Phase | null = null;
  private lastServerId: string | null = null;
  private lastScore: [number, number] = [-1, -1];
  private lastMpTeam: TeamId | null = null;
  private lastPingAt = 0;
  private lastOverCount = -1;
  private lastToastAt = new Map<string, number>();

  constructor(root: HTMLElement, hooks: UIHooks) {
    this.hooks = hooks;
    this.muted = storageGet(MUTE_KEY) === '1';

    // ── title ──────────────────────────────────────────────
    this.titleEl = el('div', 'screen title-screen');
    const tCard = el('div', 'card title-card');
    tCard.appendChild(el('h1', 'logo', 'BALLTBALL 🏐'));
    tCard.appendChild(
      el('p', 'tagline', '석양이 지는 해변, 짜릿한 한 판 — 온라인 3D 비치발리볼'),
    );

    const nickField = el('div', 'field');
    nickField.appendChild(el('label', 'field-label', '닉네임'));
    this.nickInput = el('input', 'text-input nick-input');
    this.nickInput.maxLength = 12;
    this.nickInput.spellcheck = false;
    this.nickInput.value =
      storageGet(NICK_KEY) ??
      RANDOM_NICKS[Math.floor(Math.random() * RANDOM_NICKS.length)];
    this.nickInput.addEventListener('input', () => {
      storageSet(NICK_KEY, this.nickInput.value.trim());
    });
    nickField.appendChild(this.nickInput);
    tCard.appendChild(nickField);

    const quickBtn = btn('primary big', '빠른 대전', () => hooks.onQuick(this.getName()));
    const createBtn = btn('big', '방 만들기', () => hooks.onCreate(this.getName()));
    const row1 = el('div', 'btn-row');
    row1.appendChild(quickBtn);
    row1.appendChild(createBtn);
    tCard.appendChild(row1);

    const joinRow = el('div', 'join-row');
    this.codeInput = el('input', 'text-input code-input');
    this.codeInput.placeholder = '초대 코드';
    this.codeInput.maxLength = 8;
    this.codeInput.spellcheck = false;
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
    const joinBtn = btn('', '코드로 참가', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (!code) {
        this.toast('초대 코드를 입력하세요');
        return;
      }
      hooks.onJoin(this.getName(), code);
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });
    joinRow.appendChild(this.codeInput);
    joinRow.appendChild(joinBtn);
    tCard.appendChild(joinRow);

    tCard.appendChild(el('p', 'howto', HOWTO));
    this.titleEl.appendChild(tCard);
    this.titleButtons = [quickBtn, createBtn, joinBtn];

    // ── lobby ──────────────────────────────────────────────
    this.lobbyEl = el('div', 'screen lobby-screen');
    const lCard = el('div', 'card lobby-card');

    const head = el('div', 'room-head');
    head.appendChild(el('div', 'room-code-label', '방 코드'));
    const codeRow = el('div', 'room-code-row');
    this.roomCodeEl = el('div', 'room-code', '····');
    this.copyBtn = btn('small', '복사', () => this.copyCode());
    codeRow.appendChild(this.roomCodeEl);
    codeRow.appendChild(this.copyBtn);
    head.appendChild(codeRow);
    this.roomVisEl = el('div', 'room-vis', '');
    head.appendChild(this.roomVisEl);
    lCard.appendChild(head);

    const teams = el('div', 'teams');
    const cols: HTMLElement[] = [];
    for (const t of [0, 1] as const) {
      const col = el('div', `team-col t${t}`);
      const h = el('h3', 'team-title');
      h.appendChild(el('span', `team-swatch t${t}`));
      h.appendChild(document.createTextNode(`${TEAM_NAMES[t]} 팀`));
      col.appendChild(h);
      const list = el('div', 'team-list');
      col.appendChild(list);
      teams.appendChild(col);
      cols.push(list);
    }
    this.teamLists = [cols[0], cols[1]];
    lCard.appendChild(teams);

    lCard.appendChild(el('p', 'lobby-hint', '모든 플레이어가 준비되면 시작합니다'));

    const lRow = el('div', 'btn-row');
    lRow.appendChild(btn('', '팀 변경', () => hooks.onTeamChange()));
    this.readyBtn = btn('primary', '준비 완료', () => hooks.onReadyToggle(!this.myReady));
    lRow.appendChild(this.readyBtn);
    lRow.appendChild(btn('', '봇 채우고 바로 시작', () => hooks.onStartNow()));
    lCard.appendChild(lRow);

    const lRow2 = el('div', 'btn-row');
    lRow2.appendChild(btn('ghost', '나가기', () => hooks.onLeaveRoom()));
    lCard.appendChild(lRow2);

    this.lobbyEl.appendChild(lCard);

    // ── HUD ────────────────────────────────────────────────
    this.hudEl = el('div', 'hud');

    const sb = el('div', 'scoreboard');
    const mk = (t: TeamId): [HTMLElement, HTMLElement, HTMLElement] => {
      const wrap = el('div', `sb-team t${t}`);
      const dot = el('span', 'serve-dot');
      const name = el('span', 'sb-name', TEAM_NAMES[t]);
      const score = el('span', 'sb-score', '0');
      if (t === 0) {
        wrap.appendChild(dot);
        wrap.appendChild(name);
        wrap.appendChild(score);
      } else {
        wrap.appendChild(score);
        wrap.appendChild(name);
        wrap.appendChild(dot);
      }
      return [wrap, dot, score];
    };
    const [w0, d0, s0] = mk(0);
    const [w1, d1, s1] = mk(1);
    sb.appendChild(w0);
    sb.appendChild(el('span', 'sb-colon', ':'));
    sb.appendChild(w1);
    this.scoreEls = [s0, s1];
    this.serveDots = [d0, d1];
    this.hudEl.appendChild(sb);

    this.mpBadge = el('div', 'mp-badge', '매치 포인트!');
    this.hudEl.appendChild(this.mpBadge);

    this.announceEl = el('div', 'announce');
    this.announceSubEl = el('div', 'announce-sub');
    this.hudEl.appendChild(this.announceEl);
    this.hudEl.appendChild(this.announceSubEl);

    const corner = el('div', 'hud-corner');
    this.muteBtn = btn('icon', this.muted ? '🔇' : '🔈', () => this.toggleMute());
    corner.appendChild(this.muteBtn);
    corner.appendChild(btn('icon', '☰', () => this.toggleMenu()));
    this.hudEl.appendChild(corner);

    this.pingEl = el('div', 'ping', '핑 --');
    this.hudEl.appendChild(this.pingEl);

    // ── ESC menu ───────────────────────────────────────────
    this.menuEl = el('div', 'overlay menu-overlay');
    const mCard = el('div', 'card menu-card');
    mCard.appendChild(el('h2', 'menu-title', '메뉴'));
    mCard.appendChild(btn('wide', '계속하기', () => this.toggleMenu(false)));
    this.menuMuteBtn = btn('wide', this.muted ? '음소거 해제' : '음소거', () =>
      this.toggleMute(),
    );
    mCard.appendChild(this.menuMuteBtn);
    mCard.appendChild(
      btn('wide', '조작법', () => {
        this.toggleMenu(false);
        this.helpEl.classList.add('show');
      }),
    );
    mCard.appendChild(
      btn('wide danger', '나가기', () => {
        this.toggleMenu(false);
        this.hooks.onLeaveMatch();
      }),
    );
    mCard.appendChild(el('p', 'menu-hint', 'ESC 키로 열고 닫기'));
    this.menuEl.appendChild(mCard);

    // ── controls help ──────────────────────────────────────
    this.helpEl = el('div', 'overlay help-overlay');
    const hCard = el('div', 'card help-card');
    hCard.appendChild(el('h2', 'menu-title', '조작법'));
    const rows: [string, string][] = [
      ['이동', 'W A S D / 방향키'],
      ['점프', 'Space'],
      ['공격 · 스파이크', '좌클릭 / J / Z'],
      ['토스 · 로브', '우클릭 / K / X'],
      ['조준', '마우스 이동'],
      ['서브', '좌클릭: 강서브 · 우클릭: 로브'],
    ];
    const table = el('div', 'help-table');
    for (const [k, v] of rows) {
      const r = el('div', 'help-row');
      r.appendChild(el('span', 'help-k', k));
      r.appendChild(el('span', 'help-v', v));
      table.appendChild(r);
    }
    hCard.appendChild(table);
    hCard.appendChild(btn('wide', '닫기', () => this.helpEl.classList.remove('show')));
    this.helpEl.appendChild(hCard);

    // ── match over ─────────────────────────────────────────
    this.overEl = el('div', 'overlay over-overlay');
    const oCard = el('div', 'card over-card');
    this.overTitleEl = el('h1', 'over-title', '');
    this.overScoreEl = el('div', 'over-score', '');
    this.overCountEl = el('div', 'over-count', '');
    oCard.appendChild(this.overTitleEl);
    oCard.appendChild(this.overScoreEl);
    oCard.appendChild(this.overCountEl);
    oCard.appendChild(btn('wide', '로비로', () => this.hooks.onLeaveMatch()));
    this.overEl.appendChild(oCard);

    // ── disconnect ─────────────────────────────────────────
    this.discEl = el('div', 'overlay disc-overlay');
    const dCard = el('div', 'card disc-card');
    dCard.appendChild(el('h1', 'over-title', '연결이 끊어졌습니다'));
    dCard.appendChild(el('p', 'disc-sub', '서버와의 연결이 종료되었어요.'));
    dCard.appendChild(btn('primary wide', '다시 접속', () => location.reload()));
    this.discEl.appendChild(dCard);

    this.toastsEl = el('div', 'toasts');

    root.appendChild(this.titleEl);
    root.appendChild(this.lobbyEl);
    root.appendChild(this.hudEl);
    root.appendChild(this.overEl);
    root.appendChild(this.menuEl);
    root.appendChild(this.helpEl);
    root.appendChild(this.discEl);
    root.appendChild(this.toastsEl);

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.hudActive || this.disconnected) return;
      if (this.helpEl.classList.contains('show')) {
        this.helpEl.classList.remove('show');
        return;
      }
      this.toggleMenu();
    });

    this.showTitle();
  }

  // ── shared ────────────────────────────────────────────────

  isMuted(): boolean {
    return this.muted;
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    storageSet(MUTE_KEY, this.muted ? '1' : '0');
    this.muteBtn.textContent = this.muted ? '🔇' : '🔈';
    this.menuMuteBtn.textContent = this.muted ? '음소거 해제' : '음소거';
    this.hooks.onMute(this.muted);
  }

  private getName(): string {
    const v = this.nickInput.value.trim();
    if (v) return v;
    const rnd = RANDOM_NICKS[Math.floor(Math.random() * RANDOM_NICKS.length)];
    this.nickInput.value = rnd;
    return rnd;
  }

  private hideAllScreens(): void {
    this.titleEl.classList.remove('show');
    this.lobbyEl.classList.remove('show');
    this.hudEl.classList.remove('show');
    this.overEl.classList.remove('show');
    this.menuEl.classList.remove('show');
    this.helpEl.classList.remove('show');
  }

  showTitle(): void {
    if (this.disconnected) return;
    this.hideAllScreens();
    this.hudActive = false;
    this.titleEl.classList.add('show');
  }

  /** Hide every ui.ts screen/overlay (the meta hub owns the home now). */
  hideAll(): void {
    this.hideAllScreens();
    this.hudActive = false;
    this.clearAnnounce();
  }

  setTitleBusy(busy: boolean): void {
    for (const b of this.titleButtons) b.disabled = busy;
    this.titleEl.classList.toggle('busy', busy);
  }

  // ── lobby ─────────────────────────────────────────────────

  showLobby(): void {
    if (this.disconnected) return;
    this.hideAllScreens();
    this.hudActive = false;
    this.lobbyEl.classList.add('show');
  }

  updateRoom(room: RoomInfo, myId: string): void {
    this.roomCodeEl.textContent = room.code;
    this.roomVisEl.textContent = room.isPublic ? '공개 방 · 빠른 대전으로 입장 가능' : '비공개 방 · 코드로만 입장';

    for (const t of [0, 1] as const) {
      const list = this.teamLists[t];
      list.textContent = '';
      const members = room.roster.filter((r) => r.team === t);
      for (const r of members) {
        const chip = el('div', 'player-chip' + (r.id === myId ? ' me' : ''));
        chip.appendChild(el('span', 'chip-name', r.name + (r.isBot ? ' 🤖' : '')));
        if (r.id === myId) chip.appendChild(el('span', 'chip-you', '나'));
        if (r.ready) chip.appendChild(el('span', 'chip-ready', '✅'));
        list.appendChild(chip);
      }
      for (let i = members.length; i < MAX_PLAYERS_PER_TEAM; i++) {
        list.appendChild(el('div', 'player-chip empty', '빈 자리'));
      }
    }

    const me = room.roster.find((r) => r.id === myId);
    this.myReady = !!me && me.ready;
    this.readyBtn.textContent = this.myReady ? '준비 취소' : '준비 완료';
    this.readyBtn.classList.toggle('primary', !this.myReady);
  }

  private copyCode(): void {
    const code = this.roomCodeEl.textContent ?? '';
    const done = () => {
      this.copyBtn.textContent = '복사됨!';
      window.setTimeout(() => (this.copyBtn.textContent = '복사'), 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, () => this.toast('복사에 실패했어요'));
    } else {
      // ancient fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        this.toast('복사에 실패했어요');
      }
      ta.remove();
    }
  }

  // ── HUD ───────────────────────────────────────────────────

  showHUD(): void {
    if (this.disconnected) return;
    this.hideAllScreens();
    this.hudActive = true;
    this.hudEl.classList.add('show');
    this.lastPhase = null;
    this.lastServerId = null;
    this.lastScore = [-1, -1];
    this.lastMpTeam = null;
    this.lastOverCount = -1;
    this.clearAnnounce();
  }

  hideHUD(): void {
    this.hudActive = false;
    this.hudEl.classList.remove('show');
    this.overEl.classList.remove('show');
    this.menuEl.classList.remove('show');
    this.helpEl.classList.remove('show');
    this.clearAnnounce();
  }

  private toggleMenu(force?: boolean): void {
    const show = force ?? !this.menuEl.classList.contains('show');
    this.menuEl.classList.toggle('show', show);
  }

  /** Called every animation frame with the fresh view + raw server state. */
  updateHUD(view: ViewState, state: GameState, rttMs: number): void {
    if (!this.hudActive) return;

    // score
    if (view.score[0] !== this.lastScore[0] || view.score[1] !== this.lastScore[1]) {
      for (const t of [0, 1] as const) {
        if (view.score[t] !== this.lastScore[t]) {
          this.scoreEls[t].textContent = String(view.score[t]);
          this.scoreEls[t].classList.remove('bump');
          void this.scoreEls[t].offsetWidth;
          this.scoreEls[t].classList.add('bump');
        }
      }
      this.lastScore = [view.score[0], view.score[1]];
    }

    // serve indicator
    this.serveDots[0].classList.toggle('on', view.servingTeam === 0);
    this.serveDots[1].classList.toggle('on', view.servingTeam === 1);

    // match point badge
    const mp = view.phase === 'over' ? null : matchPointTeam(view.score);
    if (mp !== this.lastMpTeam) {
      this.lastMpTeam = mp;
      this.mpBadge.classList.toggle('show', mp !== null);
      if (mp !== null) {
        this.mpBadge.classList.toggle('t0', mp === 0);
        this.mpBadge.classList.toggle('t1', mp === 1);
      }
    }

    // phase transitions
    if (state.phase !== this.lastPhase) {
      const prev = this.lastPhase;
      this.lastPhase = state.phase;
      switch (state.phase) {
        case 'serve':
          if (prev === 'over') {
            this.overEl.classList.remove('show');
            this.announce('리매치!', 'good');
            // Re-arm the phase detector instead of capturing stale view/state:
            // if still on serve when it fires, the next frame re-enters this
            // case with fresh args; if the rally already began, the guard makes
            // it a no-op so the serve hint can't pin itself over a live rally.
            window.clearTimeout(this.rematchTimer);
            this.rematchTimer = window.setTimeout(() => {
              if (this.hudActive && this.lastPhase === 'serve') this.lastPhase = null;
            }, 1200);
          } else {
            this.announceServe(view, state);
          }
          break;
        case 'rally':
          this.hideSub();
          break;
        case 'point':
          this.announcePoint(view, state);
          break;
        case 'over':
          this.showOver(view, state);
          break;
        case 'waiting':
          break;
      }
    } else if (state.phase === 'serve' && state.serverId !== this.lastServerId) {
      // server changed mid-serve (e.g. the server left)
      this.announceServe(view, state);
    }
    this.lastServerId = state.serverId;

    // rematch countdown (phaseT = seconds remaining in 'over')
    if (state.phase === 'over') {
      const n = Math.max(0, Math.ceil(state.phaseT));
      if (n !== this.lastOverCount) {
        this.lastOverCount = n;
        this.overCountEl.textContent = `리매치까지 ${n}초`;
      }
    }

    // ping (throttled)
    const now = performance.now();
    if (now - this.lastPingAt > 500) {
      this.lastPingAt = now;
      this.pingEl.textContent = `핑 ${rttMs}ms`;
      this.pingEl.className =
        'ping ' + (rttMs < 60 ? 'good' : rttMs < 120 ? 'ok' : 'bad');
    }
  }

  /** GameEvents drained by main.ts — only toasts live here (visuals/sound elsewhere). */
  handleEvent(ev: GameEvent, view: ViewState): void {
    if (ev.kind === 'denied' && ev.playerId === view.localId) {
      const key = 'denied:' + String(ev.reason);
      const now = performance.now();
      const last = this.lastToastAt.get(key) ?? -1e9;
      if (now - last < 1200) return;
      this.lastToastAt.set(key, now);
      this.toast(
        ev.reason === 'consecutive'
          ? '⚠ 같은 사람이 연속으로 터치할 수 없어요'
          : ev.reason === 'touches'
            ? '⚠ 한 팀 3터치 초과'
            : '⚠ 반칙이에요',
      );
    }
  }

  private announceServe(view: ViewState, state: GameState): void {
    const server = view.players.find((p) => p.id === state.serverId);
    this.announce(`서브: ${server ? server.name : '?'}`, `t${view.servingTeam}`);
    if (state.serverId === view.localId) {
      this.showSub('좌클릭: 강서브 · 우클릭: 로브', true);
    } else {
      this.hideSub();
    }
  }

  private announcePoint(view: ViewState, state: GameState): void {
    // state.message = 'point:<team>:<in|out>'
    const m = /^point:([01]):(in|out)$/.exec(state.message);
    if (!m) {
      this.announce('득점!');
      return;
    }
    const team = Number(m[1]) as TeamId;
    const mine = team === view.localTeam;
    this.announce(m[2] === 'in' ? '득점!' : '아웃!', mine ? 'good' : 'bad');
    this.showSub(`${TEAM_NAMES[team]} 팀 +1점`, false);
  }

  private showOver(view: ViewState, state: GameState): void {
    // state.message = 'matchover:<team>'
    const m = /^matchover:([01])$/.exec(state.message);
    const champ: TeamId = m
      ? (Number(m[1]) as TeamId)
      : view.score[0] > view.score[1]
        ? 0
        : 1;
    const won = champ === view.localTeam;
    this.overTitleEl.textContent = won ? '승리! 🏆' : '패배…';
    this.overTitleEl.className = 'over-title ' + (won ? 'win' : 'lose');
    this.overScoreEl.textContent = `${TEAM_NAMES[0]} ${view.score[0]} : ${view.score[1]} ${TEAM_NAMES[1]}`;
    this.lastOverCount = -1;
    this.overCountEl.textContent = '';
    this.menuEl.classList.remove('show');
    this.helpEl.classList.remove('show');
    this.overEl.classList.add('show');
    this.clearAnnounce();
  }

  private announce(text: string, cls = ''): void {
    const a = this.announceEl;
    a.textContent = text;
    a.className = 'announce show ' + cls;
    a.classList.remove('pop');
    void a.offsetWidth; // restart the pop animation
    a.classList.add('pop');
    window.clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => a.classList.remove('show'), 2200);
  }

  private showSub(text: string, sticky: boolean): void {
    this.announceSubEl.textContent = text;
    this.announceSubEl.classList.add('show');
    window.clearTimeout(this.subTimer);
    if (!sticky) {
      this.subTimer = window.setTimeout(
        () => this.announceSubEl.classList.remove('show'),
        2200,
      );
    }
  }

  private hideSub(): void {
    window.clearTimeout(this.subTimer);
    this.announceSubEl.classList.remove('show');
  }

  private clearAnnounce(): void {
    window.clearTimeout(this.announceTimer);
    window.clearTimeout(this.rematchTimer);
    this.announceEl.classList.remove('show');
    this.hideSub();
  }

  // ── overlays & toasts ─────────────────────────────────────

  showDisconnect(): void {
    this.disconnected = true;
    this.hideAllScreens();
    this.discEl.classList.add('show');
  }

  toast(text: string): void {
    const t = el('div', 'toast', text);
    this.toastsEl.appendChild(t);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstElementChild?.remove();
    void t.offsetWidth;
    t.classList.add('show');
    window.setTimeout(() => {
      t.classList.remove('show');
      window.setTimeout(() => t.remove(), 400);
    }, 3200);
  }
}
