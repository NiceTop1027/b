import type { GameEvent, GameState, InputFrame, RosterEntry, TeamId } from './types';

// ── Client → Server ─────────────────────────────────────────
export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'quick' } // quick-match into any open public room (creates one if none)
  | { t: 'create' } // private room, returns a join code
  | { t: 'join'; code: string }
  | { t: 'team'; team: TeamId } // request team switch while in lobby
  | { t: 'ready'; ready: boolean }
  | { t: 'start' } // begin now, filling empty slots with bots (any player may)
  | { t: 'input'; f: InputFrame }
  | { t: 'leave' }
  | { t: 'ping'; ts: number };

// ── Server → Client ─────────────────────────────────────────
export type ServerMsg =
  | { t: 'welcome'; id: string }
  | {
      t: 'room';
      code: string;
      isPublic: boolean;
      roster: RosterEntry[];
      inMatch: boolean;
    }
  | { t: 'start'; state: GameState; you: string }
  | {
      t: 'snap';
      state: GameState;
      /** last input seq the server has applied, per human player — for reconciliation */
      acks: Record<string, number>;
      events: GameEvent[];
      /** server wall-clock ms at send time, for interpolation clock sync */
      st: number;
    }
  | { t: 'pong'; ts: number; st: number }
  | { t: 'left'; id: string } // someone left mid-match (replaced by bot)
  | { t: 'error'; msg: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decodeClient(data: unknown): ClientMsg | null {
  return safeParse(data) as ClientMsg | null;
}

export function decodeServer(data: unknown): ServerMsg | null {
  return safeParse(data) as ServerMsg | null;
}

function safeParse(data: unknown): unknown {
  try {
    const s =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : String(data);
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && typeof obj.t === 'string') return obj;
    return null;
  } catch {
    return null;
  }
}
