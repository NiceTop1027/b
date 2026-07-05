// Persistent meta-game state (local only — no economy server). Currency,
// cosmetics, mission progress, attendance streak, roster favourite. Kept small
// and versioned so a schema bump won't crash an old save.

export type BallSkin = 'classic' | 'sunset' | 'neon' | 'mono';
export type MenuTheme = 'dusk' | 'noir' | 'ember';

export interface MissionDef {
  id: string;
  label: string;
  goal: number;
  reward: number; // coins
  kind: 'play' | 'win' | 'servePoint' | 'spike' | 'rally';
}

export interface MissionState {
  progress: number;
  claimed: boolean;
}

export interface SaveData {
  v: number;
  nick: string;
  coins: number;
  tickets: number;
  gems: number;
  muted: boolean;
  ballSkin: BallSkin;
  theme: MenuTheme;
  ownedSkins: BallSkin[];
  favouritePlayer: string;
  teamName: string;
  // daily
  day: string; // yyyy-mm-dd of the current mission set
  attendanceClaimed: boolean;
  streak: number;
  missions: Record<string, MissionState>;
  // lifetime stats
  wins: number;
  played: number;
}

export const MISSION_DEFS: MissionDef[] = [
  { id: 'play1', label: '경기 1회 플레이', goal: 1, reward: 800, kind: 'play' },
  { id: 'win1', label: '경기 1회 승리', goal: 1, reward: 1500, kind: 'win' },
  { id: 'serve3', label: '서브 득점 3회', goal: 3, reward: 1000, kind: 'servePoint' },
  { id: 'spike5', label: '스파이크 5회 성공', goal: 5, reward: 1000, kind: 'spike' },
  { id: 'rally20', label: '랠리 20회 주고받기', goal: 20, reward: 1200, kind: 'rally' },
];

const KEY = 'balltball:save';
const CUR_V = 1;

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

function today(): string {
  // local date; showcase/menus never run headless where Date is blocked
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function fresh(): SaveData {
  const missions: Record<string, MissionState> = {};
  for (const m of MISSION_DEFS) missions[m.id] = { progress: 0, claimed: false };
  return {
    v: CUR_V,
    nick: RANDOM_NICKS[Math.floor(Math.random() * RANDOM_NICKS.length)],
    coins: 12_400,
    tickets: 48,
    gems: 12,
    muted: false,
    ballSkin: 'classic',
    theme: 'dusk',
    ownedSkins: ['classic'],
    favouritePlayer: 'raul',
    teamName: '해변 클럽',
    day: today(),
    attendanceClaimed: false,
    streak: 0,
    missions,
    wins: 0,
    played: 0,
  };
}

function read(): SaveData {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fresh();
    const data = JSON.parse(raw) as Partial<SaveData>;
    if (!data || data.v !== CUR_V) return migrate(data);
    return normalize(data as SaveData);
  } catch {
    return fresh();
  }
}

function migrate(_old: Partial<SaveData>): SaveData {
  // v0/unknown → start clean but keep an old nickname if present
  const base = fresh();
  const legacyNick = (() => {
    try {
      return window.localStorage.getItem('balltball:nick');
    } catch {
      return null;
    }
  })();
  if (legacyNick) base.nick = legacyNick;
  return base;
}

function normalize(d: SaveData): SaveData {
  const base = fresh();
  const out: SaveData = { ...base, ...d, missions: { ...base.missions, ...(d.missions ?? {}) } };
  // ensure every defined mission exists
  for (const m of MISSION_DEFS) if (!out.missions[m.id]) out.missions[m.id] = { progress: 0, claimed: false };
  if (!out.ownedSkins.includes('classic')) out.ownedSkins.push('classic');
  return out;
}

export type StoreListener = (s: SaveData) => void;

class Store {
  private data: SaveData;
  private listeners = new Set<StoreListener>();

  constructor() {
    this.data = read();
    this.rolloverDay();
  }

  get state(): Readonly<SaveData> {
    return this.data;
  }

  subscribe(fn: StoreListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.data);
  }

  private persist(): void {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked — session-only */
    }
  }

  private commit(): void {
    this.persist();
    this.emit();
  }

  /** Reset daily missions + attendance at local midnight rollover. */
  private rolloverDay(): void {
    const now = today();
    if (this.data.day !== now) {
      this.data.day = now;
      this.data.attendanceClaimed = false;
      for (const m of MISSION_DEFS) this.data.missions[m.id] = { progress: 0, claimed: false };
      this.persist();
    }
  }

  // ── mutations ─────────────────────────────────────────────

  setNick(nick: string): void {
    this.data.nick = nick.trim().slice(0, 12) || this.data.nick;
    this.commit();
  }

  setMuted(m: boolean): void {
    this.data.muted = m;
    this.commit();
  }

  addCoins(n: number): void {
    this.data.coins = Math.max(0, this.data.coins + n);
    this.commit();
  }

  spendCoins(n: number): boolean {
    if (this.data.coins < n) return false;
    this.data.coins -= n;
    this.commit();
    return true;
  }

  setTheme(theme: MenuTheme): void {
    this.data.theme = theme;
    this.commit();
  }

  setBallSkin(skin: BallSkin): void {
    if (!this.data.ownedSkins.includes(skin)) return;
    this.data.ballSkin = skin;
    this.commit();
  }

  buySkin(skin: BallSkin, price: number): boolean {
    if (this.data.ownedSkins.includes(skin)) return true;
    if (!this.spendCoinsSilent(price)) return false;
    this.data.ownedSkins.push(skin);
    this.data.ballSkin = skin;
    this.commit();
    return true;
  }

  private spendCoinsSilent(n: number): boolean {
    if (this.data.coins < n) return false;
    this.data.coins -= n;
    return true;
  }

  setFavourite(id: string): void {
    this.data.favouritePlayer = id;
    this.commit();
  }

  setTeamName(name: string): void {
    this.data.teamName = name.trim().slice(0, 14) || this.data.teamName;
    this.commit();
  }

  /** Claim attendance; returns reward gems or 0 if already claimed. */
  claimAttendance(): number {
    if (this.data.attendanceClaimed) return 0;
    this.data.attendanceClaimed = true;
    this.data.streak += 1;
    const gems = 3;
    this.data.gems += gems;
    this.data.coins += 500;
    this.commit();
    return gems;
  }

  // ── mission tracking (fed by real match events) ───────────

  bumpMission(kind: MissionDef['kind'], amount = 1): void {
    let changed = false;
    for (const def of MISSION_DEFS) {
      if (def.kind !== kind) continue;
      const st = this.data.missions[def.id];
      if (st.claimed || st.progress >= def.goal) continue;
      st.progress = Math.min(def.goal, st.progress + amount);
      changed = true;
    }
    if (changed) this.commit();
  }

  recordMatch(won: boolean): void {
    this.data.played += 1;
    if (won) this.data.wins += 1;
    this.bumpMission('play', 1);
    if (won) this.bumpMission('win', 1);
    // commit already fired inside bumpMission; ensure stats persist too
    this.commit();
  }

  claimMission(id: string): number {
    const def = MISSION_DEFS.find((m) => m.id === id);
    const st = this.data.missions[id];
    if (!def || !st || st.claimed || st.progress < def.goal) return 0;
    st.claimed = true;
    this.data.coins += def.reward;
    this.commit();
    return def.reward;
  }
}

export const store = new Store();
