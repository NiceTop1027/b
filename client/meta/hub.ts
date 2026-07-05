// The meta-game hub: splash → home/match/shop/mission/roster/settings, layered
// over the live 3D showcase. Everything here is presentation + local state; the
// "경기" actions hand off to the real online flow via MetaHooks.

import { attachRipple, clear, formatCompact, h, tweenNumber } from './dom';
import { icon, iconEl, type IconName } from './icons';
import { drawBallSwatch, drawPortrait } from './portrait';
import { POSITION_LABEL, ROSTER, type Player } from './rosterdata';
import {
  MISSION_DEFS,
  store,
  type BallSkin,
  type MenuTheme,
  type SaveData,
} from './store';

export interface MetaHooks {
  /** quick match / create private room / create+auto-start with bots */
  play(mode: 'quick' | 'create' | 'practice'): void;
  join(code: string): void;
}

type TabName = 'home' | 'match' | 'shop' | 'mission' | 'roster' | 'settings';

interface Screen {
  el: HTMLElement;
  enter(): void;
}

const TABS: Array<{ name: TabName; label: string; icon: IconName }> = [
  { name: 'home', label: '홈', icon: 'home' },
  { name: 'match', label: '경기', icon: 'match' },
  { name: 'shop', label: '상점', icon: 'shop' },
  { name: 'mission', label: '미션', icon: 'mission' },
  { name: 'roster', label: '선수 관리', icon: 'roster' },
  { name: 'settings', label: '설정', icon: 'settings' },
];

const BALL_SKINS: Array<{ id: BallSkin; name: string; price: number; desc: string }> = [
  { id: 'classic', name: '클래식', price: 0, desc: '기본 화이트·오렌지 패널' },
  { id: 'sunset', name: '선셋', price: 3500, desc: '노을빛 마젠타 패널' },
  { id: 'neon', name: '네온', price: 5000, desc: '야간 코트용 형광' },
  { id: 'mono', name: '모노', price: 4200, desc: '차분한 모노톤' },
];

const THEMES: Array<{ id: MenuTheme; name: string }> = [
  { id: 'dusk', name: '더스크' },
  { id: 'noir', name: '느와르' },
  { id: 'ember', name: '엠버' },
];

export class Hub {
  readonly root: HTMLElement;
  private hooks: MetaHooks;
  private topbar: HTMLElement;
  private screenHost: HTMLElement;
  private tabEls = new Map<TabName, HTMLElement>();
  private screens = new Map<TabName, Screen>();
  private current: TabName = 'home';

  private coinEl!: HTMLElement;
  private ticketEl!: HTMLElement;
  private gemEl!: HTMLElement;
  private cur = { coins: 0, tickets: 0, gems: 0 };
  private missionDot!: HTMLElement;
  private toastHost: HTMLElement;
  private onBallSkinChange: ((s: BallSkin) => void) | null = null;

  constructor(root: HTMLElement, hooks: MetaHooks) {
    this.root = root;
    this.hooks = hooks;
    root.id = 'meta';

    this.topbar = this.buildTopbar();
    this.screenHost = h('div', 'screen-host');
    this.toastHost = h('div', 'meta-toasts');
    root.append(this.topbar, this.screenHost, this.toastHost);

    // build screens
    this.register('home', this.buildHome());
    this.register('match', this.buildMatch());
    this.register('shop', this.buildShop());
    this.register('mission', this.buildMission());
    this.register('roster', this.buildRoster());
    this.register('settings', this.buildSettings());

    document.documentElement.setAttribute('data-theme', store.state.theme);
    store.subscribe((s) => this.onStore(s));
    this.syncCurrency(store.state, false);
    this.syncMissionDot(store.state);
  }

  /** allow main.ts to react to equipped ball skin changes (apply in-match). */
  setBallSkinListener(fn: (s: BallSkin) => void): void {
    this.onBallSkinChange = fn;
  }

  show(tab: TabName = 'home'): void {
    this.root.classList.add('show');
    this.goTab(tab);
  }
  hide(): void {
    this.root.classList.remove('show');
  }

  toast(msg: string, kind: 'ok' | 'gold' | 'bad' = 'ok'): void {
    const t = h('div', `meta-toast ${kind}`, [
      iconEl(kind === 'bad' ? 'flame' : kind === 'gold' ? 'coin' : 'check', 16),
      h('span', {}, msg),
    ]);
    this.toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 350);
    }, 2600);
  }

  private register(name: TabName, screen: Screen): void {
    this.screens.set(name, screen);
    this.screenHost.appendChild(screen.el);
  }

  goTab(name: TabName): void {
    this.current = name;
    for (const [n, el] of this.tabEls) el.classList.toggle('on', n === name);
    for (const [n, s] of this.screens) {
      const on = n === name;
      s.el.classList.toggle('active', on);
      if (on) s.enter();
    }
  }

  // ── top bar ───────────────────────────────────────────────

  private buildTopbar(): HTMLElement {
    const brand = h('div', 'brand', [
      h('span', { class: 'b-main', text: 'BALLTBALL' }),
      h('span', { class: 'b-sub', text: 'CROSS' }),
    ]);

    const chip = (cls: string, ic: IconName): [HTMLElement, HTMLElement] => {
      const val = h('span', { class: 'c-val', text: '0' });
      const el = h('div', `chip ${cls}`, [
        iconEl(ic, 18),
        val,
        h('span', { class: 'c-plus', html: icon('plus', 12), onclick: () => this.pulseStore() }),
      ]);
      return [el, val];
    };
    const [coinChip, coinVal] = chip('coin', 'coin');
    const [ticketChip, ticketVal] = chip('ticket', 'ticket');
    const [gemChip, gemVal] = chip('gem', 'gem');
    this.coinEl = coinVal;
    this.ticketEl = ticketVal;
    this.gemEl = gemVal;

    const nav = h('nav', 'nav');
    for (const t of TABS) {
      if (t.name === 'settings') continue; // settings sits on the right
      const tab = h('div', { class: 'nav-tab', onclick: () => this.goTab(t.name) }, [
        iconEl(t.icon, 19),
        h('span', {}, t.label),
      ]);
      if (t.name === 'mission') {
        this.missionDot = h('span', 'badge-dot');
        this.missionDot.style.display = 'none';
        tab.appendChild(this.missionDot);
      }
      this.tabEls.set(t.name, tab);
      nav.appendChild(tab);
    }

    const settingsBtn = h('button', { class: 'iconbtn', title: '설정', onclick: () => this.goTab('settings') }, [
      iconEl('settings', 20),
    ]);
    this.tabEls.set('settings', settingsBtn);

    return h('header', 'topbar', [
      brand,
      h('div', 'currency-row', [coinChip, ticketChip, gemChip]),
      h('div', 'spacer'),
      nav,
      h('div', 'spacer'),
      settingsBtn,
    ]);
  }

  private pulseStore(): void {
    this.goTab('shop');
    this.toast('상점에서 재화를 획득하세요');
  }

  private onStore(s: SaveData): void {
    this.syncCurrency(s, true);
    this.syncMissionDot(s);
    document.documentElement.setAttribute('data-theme', s.theme);
  }

  private syncCurrency(s: SaveData, animate: boolean): void {
    const set = (el: HTMLElement, from: number, to: number): void => {
      if (animate && from !== to) tweenNumber(el, from, to, 650, formatCompact);
      else el.textContent = formatCompact(to);
    };
    set(this.coinEl, this.cur.coins, s.coins);
    set(this.ticketEl, this.cur.tickets, s.tickets);
    set(this.gemEl, this.cur.gems, s.gems);
    this.cur = { coins: s.coins, tickets: s.tickets, gems: s.gems };
  }

  private syncMissionDot(s: SaveData): void {
    const claimable = MISSION_DEFS.some((d) => {
      const st = s.missions[d.id];
      return st && !st.claimed && st.progress >= d.goal;
    });
    const attend = !s.attendanceClaimed;
    if (this.missionDot) this.missionDot.style.display = claimable || attend ? 'block' : 'none';
  }

  // ── HOME ──────────────────────────────────────────────────

  private buildHome(): Screen {
    const el = h('div', 'meta-screen home-screen');

    // attendance banner
    const attendCard = h('div', 'panel home-attend');
    // mission summary
    const missionCard = h('div', 'panel home-missum');
    const leftCol = h('div', 'home-left stagger', [attendCard, missionCard]);

    // play CTA
    const playPanel = h('div', 'panel home-play');

    // tip ticker
    const tip = h('div', 'home-tip');

    el.append(leftCol, playPanel, tip);

    const TIPS = [
      '점프 정점에서 좌클릭하면 강력한 스파이크가 나갑니다.',
      '네트 앞에서 점프하면 상대 스파이크를 블로킹할 수 있어요.',
      '우클릭 토스로 팀원에게 공을 연결하세요.',
      '한 팀은 최대 3번까지 공을 터치할 수 있습니다.',
      '깊은 코너를 노리면 리시브가 어려워집니다.',
    ];

    const render = (): void => {
      const s = store.state;
      // attendance
      clear(attendCard);
      if (s.attendanceClaimed) {
        attendCard.append(
          h('div', 'ha-head', [iconEl('check', 18), h('span', {}, '오늘 출석 완료')]),
          h('div', 'ha-sub', `${s.streak}일 연속 출석 중`),
        );
        attendCard.classList.remove('glow');
      } else {
        attendCard.append(
          h('div', 'ha-head', [iconEl('flame', 18), h('span', {}, '출석 체크')]),
          h('div', 'ha-sub', '접속 보상 · 젬 3 + 코인 500'),
          (() => {
            const b = h('button', { class: 'btn2 gold', onclick: () => {
              const g = store.claimAttendance();
              if (g) this.toast(`출석 완료! 젬 +${g} · 코인 +500`, 'gold');
              render();
            } }, [iconEl('gem', 18), h('span', {}, '받기')]);
            attachRipple(b);
            return b;
          })(),
        );
        attendCard.classList.add('glow');
      }

      // mission summary
      clear(missionCard);
      const total = MISSION_DEFS.length;
      const done = MISSION_DEFS.filter((d) => s.missions[d.id]?.progress >= d.goal).length;
      missionCard.append(
        h('div', 'ha-head', [iconEl('mission', 18), h('span', {}, '일일 미션')]),
        h('div', 'ha-sub', `${done} / ${total} 완료`),
        (() => {
          const bar = h('div', 'bar', [h('i', { style: `width:${(done / total) * 100}%` })]);
          return bar;
        })(),
        (() => {
          const b = h('button', { class: 'btn2 ghost sm', onclick: () => this.goTab('mission') }, [
            h('span', {}, '미션 보기'),
            iconEl('chevron', 16),
          ]);
          return b;
        })(),
      );

      // play panel
      clear(playPanel);
      const fav = ROSTER.find((p) => p.id === s.favouritePlayer) ?? ROSTER[0];
      const port = drawPortrait(fav, 92);
      port.className = 'hp-portrait';
      const winRate = s.played ? Math.round((s.wins / s.played) * 100) : 0;
      playPanel.append(
        h('div', 'hp-team', [
          port,
          h('div', 'hp-teaminfo', [
            h('div', 'hp-teamname', s.teamName),
            h('div', 'hp-record', `${s.played}전 ${s.wins}승 · 승률 ${winRate}%`),
            h('div', 'hp-fav', [h('span', 'grade ' + fav.grade.toLowerCase(), fav.grade), h('span', {}, `${fav.name} · ${fav.pos}`)]),
          ]),
        ]),
        (() => {
          const b = h('button', { class: 'btn2 primary big', onclick: () => this.goTab('match') }, [
            iconEl('volley', 22),
            h('span', {}, '경기 시작'),
          ]);
          attachRipple(b);
          return b;
        })(),
      );

      // tip
      const t = TIPS[Math.floor(s.played + s.streak) % TIPS.length];
      clear(tip);
      tip.append(h('span', 'tip-k', 'TIP'), h('span', 'tip-v', t));
    };

    return {
      el,
      enter: () => render(),
    };
  }

  // ── MATCH ─────────────────────────────────────────────────

  private buildMatch(): Screen {
    const el = h('div', 'meta-screen');
    const grid = h('div', 'card-grid modes stagger');

    const modeCard = (
      title: string,
      desc: string,
      tag: string,
      ic: IconName,
      artStyle: string,
      onClick: () => void,
    ): HTMLElement => {
      const card = h('div', 'gcard', [
        h('div', { class: 'g-art', style: artStyle }, [h('div', { class: 'g-ico', html: icon(ic, 28) })]),
        h('div', 'g-body', [
          h('div', 'g-title', title),
          h('div', 'g-desc', desc),
          h('span', 'g-tag', tag),
        ]),
      ]);
      card.addEventListener('click', onClick);
      attachRipple(card);
      return card;
    };

    const codeInput = h('input', {
      class: 'code-field',
      placeholder: '초대 코드',
      maxlength: 8,
      spellcheck: false,
    }) as HTMLInputElement;
    codeInput.addEventListener('input', () => (codeInput.value = codeInput.value.toUpperCase()));
    codeInput.addEventListener('click', (e) => e.stopPropagation());

    const joinCard = h('div', 'gcard', [
      h('div', { class: 'g-art', style: 'background:linear-gradient(135deg,#3a2b5c,#7b3ff2)' }, [
        h('div', { class: 'g-ico', html: icon('code', 28) }),
      ]),
      h('div', 'g-body', [
        h('div', 'g-title', '코드로 참가'),
        h('div', 'g-desc', '친구가 만든 방 코드를 입력해 함께 플레이'),
        h('div', 'join-row2', [
          codeInput,
          (() => {
            const b = h('button', { class: 'btn2 gold sm', onclick: (e: Event) => {
              e.stopPropagation();
              const code = codeInput.value.trim().toUpperCase();
              if (!code) return this.toast('초대 코드를 입력하세요', 'bad');
              this.hooks.join(code);
            } }, [h('span', {}, '참가')]);
            return b;
          })(),
        ]),
      ]),
    ]);

    grid.append(
      modeCard(
        '빠른 대전',
        '전 세계 플레이어와 즉시 매칭. 빈 자리는 AI가 채웁니다.',
        '온라인 · 2 vs 2',
        'bolt',
        'background:linear-gradient(135deg,#b5470f,#ff8a3d)',
        () => this.hooks.play('quick'),
      ),
      modeCard(
        '방 만들기',
        '비공개 방을 열고 코드를 친구에게 공유하세요.',
        '친선전',
        'users',
        'background:linear-gradient(135deg,#0f5f6b,#2fb6c4)',
        () => this.hooks.play('create'),
      ),
      joinCard,
      modeCard(
        '봇 연습',
        '봇 팀을 상대로 바로 시작해 조작을 익혀보세요.',
        '싱글 · 연습',
        'trophy',
        'background:linear-gradient(135deg,#3a3f1a,#a6b83d)',
        () => this.hooks.play('practice'),
      ),
    );

    el.append(
      h('header', 'sub-head', [h('h2', 'sub-title', '경기 모드'), h('p', 'sub-note', '원하는 방식으로 코트에 입장하세요')]),
      h('div', 'content', [grid]),
    );
    return { el, enter: () => {} };
  }

  // ── SHOP ──────────────────────────────────────────────────

  private buildShop(): Screen {
    const el = h('div', 'meta-screen');
    const content = h('div', 'content');

    const render = (): void => {
      clear(content);
      const s = store.state;

      // ball skins
      const skinGrid = h('div', 'shop-grid stagger');
      for (const sk of BALL_SKINS) {
        const owned = s.ownedSkins.includes(sk.id);
        const equipped = s.ballSkin === sk.id;
        const swatch = drawBallSwatch(sk.id, 72);
        swatch.className = 'shop-swatch';
        const cta = h('button', { class: 'btn2 ' + (equipped ? 'ghost' : owned ? 'primary' : 'gold') + ' sm' }, [
          equipped
            ? h('span', {}, '장착됨')
            : owned
              ? h('span', {}, '장착')
              : h('span', {}, [iconEl('coin', 15), ` ${formatCompact(sk.price)}`]),
        ]);
        (cta as HTMLButtonElement).disabled = equipped;
        cta.addEventListener('click', () => {
          if (owned) {
            store.setBallSkin(sk.id);
            this.onBallSkinChange?.(sk.id);
            this.toast(`${sk.name} 볼 장착`);
          } else {
            if (store.buySkin(sk.id, sk.price)) {
              this.onBallSkinChange?.(sk.id);
              this.toast(`${sk.name} 볼 구매 & 장착!`, 'gold');
            } else this.toast('코인이 부족해요', 'bad');
          }
          render();
        });
        const card = h('div', 'panel shop-card', [
          swatch,
          h('div', 'sc-name', sk.name),
          h('div', 'sc-desc', sk.desc),
          cta,
        ]);
        if (equipped) card.classList.add('equipped');
        skinGrid.appendChild(card);
      }

      // themes
      const themeRow = h('div', 'theme-row');
      for (const th of THEMES) {
        const on = s.theme === th.id;
        const chip = h('button', { class: 'theme-chip' + (on ? ' on' : ''), 'data-theme-preview': th.id }, [
          h('span', 'tc-swatch'),
          h('span', {}, th.name),
        ]);
        chip.addEventListener('click', () => {
          store.setTheme(th.id);
          this.toast(`${th.name} 테마 적용`);
          render();
        });
        themeRow.appendChild(chip);
      }

      content.append(
        h('div', 'section-title', [iconEl('shop', 18), h('span', {}, '볼 스킨'), h('span', 'rule')]),
        skinGrid,
        h('div', 'section-title', [iconEl('settings', 18), h('span', {}, '메뉴 테마'), h('span', 'rule')]),
        themeRow,
      );
    };

    el.append(
      h('header', 'sub-head', [h('h2', 'sub-title', '상점'), h('p', 'sub-note', '코인으로 볼 스킨과 테마를 잠금 해제하세요')]),
      content,
    );
    return { el, enter: () => render() };
  }

  // ── MISSION ───────────────────────────────────────────────

  private buildMission(): Screen {
    const el = h('div', 'meta-screen');
    const content = h('div', 'content');

    const render = (): void => {
      clear(content);
      const s = store.state;

      // daily points bar
      const claimedCount = MISSION_DEFS.filter((d) => s.missions[d.id]?.claimed).length;
      const dailyPct = (claimedCount / MISSION_DEFS.length) * 100;
      const header = h('div', 'panel daily-head', [
        h('div', {}, [
          h('div', 'dh-title', '오늘의 미션'),
          h('div', 'dh-sub', `보상을 수령한 미션 ${claimedCount} / ${MISSION_DEFS.length}`),
        ]),
        h('div', 'dh-bar', [h('div', 'bar', [h('i', { style: `width:${dailyPct}%` })])]),
      ]);

      const list = h('div', 'mission-list stagger');
      for (const d of MISSION_DEFS) {
        const st = s.missions[d.id];
        const complete = st.progress >= d.goal;
        const row = h('div', 'panel mission-row' + (st.claimed ? ' done' : ''), [
          h('div', { class: 'mr-ico', html: icon(complete ? 'check' : 'mission', 20) }),
          h('div', 'mr-body', [
            h('div', 'mr-label', d.label),
            h('div', 'mr-prog', [
              h('div', 'bar', [h('i', { style: `width:${Math.min(100, (st.progress / d.goal) * 100)}%` })]),
              h('span', 'mr-count', `${Math.min(st.progress, d.goal)}/${d.goal}`),
            ]),
          ]),
          h('div', 'mr-reward', [iconEl('coin', 16), h('span', {}, formatCompact(d.reward))]),
          (() => {
            const b = h('button', {
              class: 'btn2 ' + (st.claimed ? 'ghost' : complete ? 'gold' : 'ghost') + ' sm',
            }, [h('span', {}, st.claimed ? '완료' : '수령')]) as HTMLButtonElement;
            b.disabled = st.claimed || !complete;
            b.addEventListener('click', () => {
              const r = store.claimMission(d.id);
              if (r) this.toast(`미션 보상 코인 +${formatCompact(r)}`, 'gold');
              render();
            });
            return b;
          })(),
        ]);
        list.appendChild(row);
      }

      content.append(header, list);
    };

    el.append(
      h('header', 'sub-head', [h('h2', 'sub-title', '미션'), h('p', 'sub-note', '매일 자정에 초기화됩니다')]),
      content,
    );
    return { el, enter: () => render() };
  }

  // ── ROSTER ────────────────────────────────────────────────

  private buildRoster(): Screen {
    const el = h('div', 'meta-screen');
    const content = h('div', 'content');

    const stat = (label: string, v: number): HTMLElement =>
      h('div', 'pstat', [
        h('span', 'ps-k', label),
        h('div', 'bar sm', [h('i', { style: `width:${v}%` })]),
      ]);

    const render = (): void => {
      clear(content);
      const s = store.state;
      const grid = h('div', 'roster-grid stagger');
      for (const p of ROSTER) {
        const port = drawPortrait(p, 120);
        port.className = 'rp-portrait';
        const card = h('div', 'panel rcard' + (p.id === s.favouritePlayer ? ' fav' : ''), [
          h('div', 'rc-top', [
            port,
            h('span', 'grade ' + p.grade.toLowerCase(), p.grade),
            h('span', 'rc-pos', p.pos),
          ]),
          h('div', 'rc-name', p.name),
          h('div', 'rc-tag', p.tag),
          h('div', 'rc-stats', [stat('공격', p.power), stat('서브', p.serve), stat('블록', p.block)]),
          (() => {
            const isFav = p.id === s.favouritePlayer;
            const b = h('button', { class: 'btn2 ' + (isFav ? 'ghost' : 'primary') + ' sm' }, [
              h('span', {}, isFav ? '대표 선수' : '대표로 설정'),
            ]) as HTMLButtonElement;
            b.disabled = isFav;
            b.addEventListener('click', () => {
              store.setFavourite(p.id);
              this.toast(`${p.name} 선수를 대표로 설정`);
              render();
            });
            return b;
          })(),
        ]);
        grid.appendChild(card);
      }
      content.append(
        h('div', 'section-title', [iconEl('roster', 18), h('span', {}, `보유 선수 ${ROSTER.length}명`), h('span', 'rule')]),
        grid,
      );
    };

    el.append(
      h('header', 'sub-head', [h('h2', 'sub-title', '선수 관리'), h('p', 'sub-note', '대표 선수는 홈 화면에 표시됩니다')]),
      content,
    );
    return { el, enter: () => render() };
  }

  // ── SETTINGS ──────────────────────────────────────────────

  private buildSettings(): Screen {
    const el = h('div', 'meta-screen');
    const content = h('div', 'content');

    const render = (): void => {
      clear(content);
      const s = store.state;

      const nick = h('input', {
        class: 'code-field wide',
        maxlength: 12,
        spellcheck: false,
        value: s.nick,
      }) as HTMLInputElement;
      nick.addEventListener('change', () => {
        store.setNick(nick.value);
        this.toast('닉네임이 저장되었습니다');
      });

      const teamName = h('input', {
        class: 'code-field wide',
        maxlength: 14,
        spellcheck: false,
        value: s.teamName,
      }) as HTMLInputElement;
      teamName.addEventListener('change', () => {
        store.setTeamName(teamName.value);
        this.toast('팀 이름이 저장되었습니다');
      });

      const muteToggle = h('div', { class: 'toggle' + (s.muted ? ' on' : '') }, [h('i')]);
      muteToggle.addEventListener('click', () => {
        store.setMuted(!store.state.muted);
        render();
      });

      const row = (label: string, control: HTMLElement, note = ''): HTMLElement =>
        h('div', 'set-row', [
          h('div', 'set-label', [h('span', {}, label), note ? h('span', 'set-note', note) : h('span')]),
          control,
        ]);

      const controls = h('div', 'panel controls-card', [
        h('div', 'cc-title', '조작법'),
        ...([
          ['이동', 'W A S D · 방향키'],
          ['점프', 'Space'],
          ['공격 · 스파이크', '좌클릭 · J · Z'],
          ['토스 · 리시브', '우클릭 · K · X'],
          ['조준', '마우스 이동'],
          ['메뉴', 'ESC'],
        ] as const).map(([k, v]) => h('div', 'cc-row', [h('span', 'cc-k', k), h('span', 'cc-v', v)])),
      ]);

      content.append(
        h('div', 'panel set-card', [
          row('닉네임', nick, '다음 접속부터 반영'),
          row('팀 이름', teamName),
          row('효과음 음소거', muteToggle),
        ]),
        controls,
        h('div', 'set-version', 'BALLTBALL CROSS · build 1.0'),
      );
    };

    el.append(
      h('header', 'sub-head', [h('h2', 'sub-title', '설정'), h('p', 'sub-note', '프로필과 조작을 관리하세요')]),
      content,
    );
    return { el, enter: () => render() };
  }
}

// ── splash ──────────────────────────────────────────────────

export class Splash {
  readonly el: HTMLElement;
  private onStart: () => void;
  private armed = false;

  constructor(onStart: () => void) {
    this.onStart = onStart;
    this.el = h('div', 'splash', [
      h('div', 'splash-vignette'),
      h('div', 'splash-center', [
        h('div', 'splash-logo', [
          h('span', 'sl-main', 'BALLTBALL'),
          h('span', 'sl-cross', 'CROSS'),
        ]),
        h('div', 'splash-tag', '온라인 3D 비치발리볼'),
        h('div', 'splash-press', '아무 키나 눌러 시작'),
      ]),
    ]);
    this.el.addEventListener('pointerdown', () => this.fire());
  }

  private key = (): void => this.fire();

  show(): void {
    this.el.classList.add('show');
    this.armed = true;
    window.addEventListener('keydown', this.key);
  }

  private fire(): void {
    if (!this.armed) return;
    this.armed = false;
    window.removeEventListener('keydown', this.key);
    this.el.classList.add('leaving');
    setTimeout(() => {
      this.el.classList.remove('show', 'leaving');
      this.onStart();
    }, 480);
  }
}
