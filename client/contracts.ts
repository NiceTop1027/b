// Contract between the client core (main/net/input/ui) and the presentation
// layer (render/*, audio). The core builds a ViewState every animation frame
// (already interpolated/predicted — presentation never touches netcode) and
// hands it to IRenderer.render(). Events stream in as they arrive.
//
// Implementations must export factories:
//   client/render/index.ts  →  export function createRenderer(): IRenderer
//   client/audio.ts         →  export function createAudio(): IAudio

import type { GameEvent, HitType, Phase, TeamId, Vec3 } from '../shared/types';

export interface ViewPlayer {
  id: string;
  name: string;
  team: TeamId;
  isBot: boolean;
  isLocal: boolean;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  /** last deliberate hit, for swing animations */
  lastHitType: HitType | null;
  /** seconds since that hit (derived from ticks) */
  lastHitAge: number;
}

export interface ViewBall {
  pos: Vec3;
  vel: Vec3;
  held: boolean;
}

export interface ViewState {
  phase: Phase;
  players: ViewPlayer[];
  ball: ViewBall;
  score: [number, number];
  servingTeam: TeamId;
  serverId: string | null;
  /** the local player's team — renderer keeps the camera behind this side */
  localTeam: TeamId;
  localId: string;
  /** where the ball is predicted to land (rally only), for the landing ring */
  landing: Vec3 | null;
  /** current aim point (court space) of the local player, for the aim reticle */
  aim: Vec3 | null;
}

export interface IRenderer {
  /** Create the WebGL canvas inside `el` and start listening for resizes. */
  mount(el: HTMLElement): void;
  /** Draw one frame. dt is real seconds since the previous frame. */
  render(view: ViewState, dt: number): void;
  /** Fire-and-forget visual effects (impacts, confetti, screen shake…). */
  onEvent(ev: GameEvent, view: ViewState): void;
  /**
   * Unproject a mouse position to the court plane (y=0), in court space.
   * The input layer uses this for aiming. Null if the ray misses.
   */
  aimRaycast(clientX: number, clientY: number): { x: number; z: number } | null;
  /** Apply a cosmetic ball skin ('classic' | 'sunset' | 'neon' | 'mono'). */
  setBallSkin(skin: string): void;
  dispose(): void;
}

export interface IAudio {
  /** Call once after a user gesture (browser autoplay policy). Safe to call twice. */
  unlock(): void;
  playEvent(ev: GameEvent): void;
  /** Ambient crowd/waves loop on/off (match vs lobby). */
  setAmbient(on: boolean): void;
  setMuted(muted: boolean): void;
}
