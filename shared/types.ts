export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type TeamId = 0 | 1;

/** waiting: lobby/not started · serve: ball held by server · rally: live ball
 *  point: post-rally celebration · over: match finished, rematch countdown */
export type Phase = 'waiting' | 'serve' | 'rally' | 'point' | 'over';

export type HitType = 'pass' | 'attack' | 'spike' | 'serve' | 'block';

/** One frame of player intent, sampled at tick rate on the client. */
export interface InputFrame {
  seq: number;
  mx: number; // move dir x, [-1,1], already normalized with mz
  mz: number;
  jump: boolean;
  pass: boolean; // held-state; the sim edge-detects
  attack: boolean;
  ax: number; // aim point in court space (x,z)
  az: number;
}

export interface PlayerState {
  id: string;
  name: string;
  team: TeamId;
  isBot: boolean;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  hitCooldown: number;
  /** last hit for animation; lastHitTick lets clients age it */
  lastHitType: HitType | null;
  lastHitTick: number;
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** true while the server player is holding the ball pre-serve */
  held: boolean;
  lastToucherId: string | null;
  /** blocker may legally touch again right after their own block */
  blockExempt: boolean;
  /** touches consumed on the current side */
  touches: number;
  /** which half the ball is over: -1 → team 0 side, 1 → team 1 side */
  side: -1 | 1;
}

export interface GameState {
  tick: number;
  phase: Phase;
  /** seconds remaining in timed phases (point/over), or seconds elapsed in serve */
  phaseT: number;
  players: PlayerState[];
  ball: BallState;
  score: [number, number];
  servingTeam: TeamId;
  serverId: string | null;
  message: string;
}

export type ScoreReason = 'in' | 'out' | 'net-serve';

export interface GameEvent {
  kind:
    | 'hit' // any deliberate touch (hitType distinguishes)
    | 'block'
    | 'net' // ball hit the net body
    | 'netcord' // ball popped off the tape
    | 'land' // ball touched the floor
    | 'score'
    | 'matchOver'
    | 'denied' // an illegal touch was suppressed (consecutive/too many)
    | 'phase'; // phase transition, for UI cues
  tick: number;
  pos?: Vec3;
  playerId?: string;
  team?: TeamId; // for score/matchOver: the team that benefited
  hitType?: HitType;
  reason?: ScoreReason | string;
  phase?: Phase;
}

/** Lobby roster entry shown before/inside a room. */
export interface RosterEntry {
  id: string;
  name: string;
  team: TeamId;
  isBot: boolean;
  ready: boolean;
}
