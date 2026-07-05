// Bootstrap. Flow: splash → meta hub (over the live 3D showcase) → lobby → match.
// The hub owns home/shop/mission/roster; ui.ts owns lobby + in-match HUD.

import './meta/theme.css';
import './meta/screens.css';
import type { GameEvent, GameState } from '../shared/types';
import { createAudio } from './audio';
import type { IRenderer, ViewState } from './contracts';
import { InputManager } from './input';
import { NetClient } from './net';
import { createRenderer } from './render/index';
import { createShowcase } from './render/showcase';
import { UI } from './ui';
import { Hub, Splash } from './meta/hub';
import { store } from './meta/store';

const gameEl = document.getElementById('game');
const uiEl = document.getElementById('ui');
const showcaseEl = document.getElementById('showcase');
const metaEl = document.getElementById('meta');
if (!gameEl || !uiEl || !showcaseEl || !metaEl) {
  throw new Error('required root elements missing from index.html');
}

const audio = createAudio();
const net = new NetClient();
const input = new InputManager();
const showcase = createShowcase();
showcase.mount(showcaseEl);

let renderer: IRenderer | null = null;
let inMatch = false;
let rafId = 0;
let lastFrameAt = 0;
let joining = false;
let pendingAutoStart = false; // practice: skip lobby, start with bots on first 'room'
let matchRecorded = false;
let pendingServeByLocal = false;

// ── audio unlock on the first genuine user gesture ──────────
let unlocked = false;
const unlockOnce = (): void => {
  if (unlocked) return;
  unlocked = true;
  audio.unlock();
  window.removeEventListener('pointerdown', unlockOnce, true);
  window.removeEventListener('keydown', unlockOnce, true);
};
window.addEventListener('pointerdown', unlockOnce, true);
window.addEventListener('keydown', unlockOnce, true);

// ── ui.ts (lobby + HUD + overlays; the hub replaces its title) ──
const ui = new UI(uiEl, {
  onQuick: () => enter(() => net.quick()),
  onCreate: () => enter(() => net.create()),
  onJoin: (_name, code) => enter(() => net.join(code)),
  onTeamChange: () => {
    const me = lastRoster.find((r) => r.id === net.myId);
    net.setTeam(me && me.team === 0 ? 1 : 0);
  },
  onReadyToggle: (ready) => net.setReady(ready),
  onStartNow: () => net.start(),
  onLeaveRoom: () => {
    net.leave();
    returnToHub();
  },
  onLeaveMatch: () => {
    net.leave();
    endMatchLocal();
    returnToHub();
  },
  onMute: (muted) => {
    audio.setMuted(muted);
    store.setMuted(muted);
  },
});
ui.hideAll();
audio.setMuted(store.state.muted);

let lastRoster: { id: string; team: 0 | 1 }[] = [];

// ── meta hub ─────────────────────────────────────────────────
const hub = new Hub(metaEl, {
  play: (mode) => {
    pendingAutoStart = mode === 'practice';
    enter(mode === 'quick' ? () => net.quick() : () => net.create());
  },
  join: (code) => {
    pendingAutoStart = false;
    enter(() => net.join(code));
  },
});
hub.setBallSkinListener((skin) => renderer?.setBallSkin(skin));

// ── splash ───────────────────────────────────────────────────
const splash = new Splash(() => hub.show('home'));
document.body.appendChild(splash.el);
splash.show();

function hubVisible(): boolean {
  return metaEl!.classList.contains('show');
}

/** Connect (idempotent, re-hellos the current nick) then run the lobby action. */
async function enter(action: () => void): Promise<void> {
  if (joining) return;
  joining = true;
  try {
    await net.connect(store.state.nick);
    action();
  } catch {
    joining = false;
    hub.toast('서버에 접속할 수 없어요. 잠시 후 다시 시도해 주세요.', 'bad');
  }
}

function returnToHub(): void {
  ui.hideAll();
  showcase.setActive(true);
  hub.show('home');
}

// ── network callbacks ────────────────────────────────────────
net.setInputSampler((seq) => input.sample(seq));
net.setAimSource(() => (inMatch ? input.getAim() : null));

net.onRoom = (room) => {
  joining = false;
  lastRoster = room.roster.map((r) => ({ id: r.id, team: r.team }));
  if (inMatch) {
    if (!room.inMatch) {
      net.endMatch();
      endMatchLocal();
      returnToHub();
    }
    return;
  }
  if (pendingAutoStart) {
    pendingAutoStart = false;
    net.start();
    return;
  }
  // enter the lobby (hub hidden, showcase stays as the backdrop)
  hub.hide();
  showcase.setActive(true);
  ui.updateRoom(room, net.myId);
  ui.showLobby();
};

net.onStart = (state) => startMatch(state);

net.onLeft = () => ui.toast('플레이어가 나가서 봇으로 교체되었습니다');

net.onError = (msg) => {
  joining = false;
  if (hubVisible()) hub.toast(msg, 'bad');
  else ui.toast(msg);
};

net.onClose = () => {
  joining = false;
  endMatchLocal();
  ui.showDisconnect();
};

// ── match lifecycle ──────────────────────────────────────────
function startMatch(_state: GameState): void {
  if (inMatch) endMatchLocal();
  inMatch = true;
  matchRecorded = false;
  pendingServeByLocal = false;
  hub.hide();
  showcase.setActive(false); // the match renderer owns the GPU now

  renderer = createRenderer();
  renderer.mount(gameEl as HTMLElement);
  renderer.setBallSkin(store.state.ballSkin);
  input.setRaycaster((x, y) => (renderer ? renderer.aimRaycast(x, y) : null));
  input.setLocalTeam(net.localTeam);
  input.setEnabled(true);
  audio.setAmbient(true);
  ui.showHUD();
  lastFrameAt = performance.now();
  rafId = requestAnimationFrame(frame);
}

function frame(now: number): void {
  if (!inMatch) return;
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
  lastFrameAt = now;

  const view = net.buildView();
  const state = net.getState();
  if (!view || !state || !renderer) return;

  renderer.render(view, dt);
  for (const ev of net.drainEvents()) {
    renderer.onEvent(ev, view);
    audio.playEvent(ev);
    ui.handleEvent(ev, view);
    trackMission(ev, view);
  }
  ui.updateHUD(view, state, net.getRtt());
}

/** Feed real match events into daily mission progress + lifetime record. */
function trackMission(ev: GameEvent, view: ViewState): void {
  if (ev.kind === 'hit') {
    store.bumpMission('rally', 1);
    if (ev.playerId === view.localId && ev.hitType === 'spike') store.bumpMission('spike', 1);
    if (ev.playerId === view.localId && ev.hitType === 'serve') pendingServeByLocal = true;
  } else if (ev.kind === 'score') {
    if (pendingServeByLocal && ev.team === view.localTeam) store.bumpMission('servePoint', 1);
    pendingServeByLocal = false;
  } else if (ev.kind === 'matchOver') {
    if (!matchRecorded) {
      matchRecorded = true;
      store.recordMatch(ev.team === view.localTeam);
    }
  }
}

/** Tear down everything match-related on this side (renderer recreated per match). */
function endMatchLocal(): void {
  if (!inMatch) return;
  inMatch = false;
  cancelAnimationFrame(rafId);
  input.setEnabled(false);
  input.setRaycaster(null);
  audio.setAmbient(false);
  ui.hideHUD();
  if (renderer) {
    try {
      renderer.dispose();
    } catch {
      /* renderer teardown must never take the app down */
    }
    renderer = null;
  }
  (gameEl as HTMLElement).textContent = '';
}
