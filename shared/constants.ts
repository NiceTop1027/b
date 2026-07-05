// All gameplay tuning lives here. Both server and client import these —
// they MUST stay identical on both sides for prediction to work.

// ── Simulation ──────────────────────────────────────────────
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30; // snapshots per second sent to clients
export const INTERP_DELAY_MS = 100; // client renders remote entities this far in the past

// ── Court (beach volleyball, arcade-scaled) ─────────────────
// x: along court length. Team 0 owns x<0, team 1 owns x>0. Net plane at x=0.
// y: up. z: court width.
export const COURT_HALF_LEN = 8; // baseline at |x| = 8
export const COURT_HALF_WID = 4; // sideline at |z| = 4
export const BOUNDS_PAD = 3; // players may roam this far outside the lines
export const NET_TOP = 2.3; // top of net (m)
export const NET_HALF_WIDTH = COURT_HALF_WID + 0.8; // net body extends this far in z (matches the rendered net)
export const NET_KEEPOUT = 0.4; // players can't get closer to the net plane than this
export const NET_CORD_BAND = 0.14; // hits within this of the tape "cord pop"
export const SERVE_X = COURT_HALF_LEN + 1.0; // server stands here (|x|)

// ── Players ─────────────────────────────────────────────────
export const PLAYER_SPEED = 7.0; // m/s
export const PLAYER_ACCEL_GROUND = 60;
export const PLAYER_ACCEL_AIR = 14;
export const PLAYER_GRAVITY = -30;
export const JUMP_VEL = 8.8; // apex ≈ 1.29 m
export const PLAYER_RADIUS = 0.42; // for rendering / soft collision
export const PLAYER_HEIGHT = 1.85;

// ── Ball ────────────────────────────────────────────────────
export const BALL_R = 0.24;
export const BALL_GRAVITY = -14; // floatier than real for arcade feel
export const BALL_DRAG = 0.06; // per-second linear drag
export const BALL_REST = 0.55; // floor restitution (visual bounces after the rally ends)

// ── Hitting ─────────────────────────────────────────────────
export const HIT_RADIUS = 2.0; // sphere around chest that can reach the ball
export const CHEST_Y = 1.3; // hit sphere center height above player pos
export const HIT_COOLDOWN = 0.4; // s between touches by one player
export const SPIKE_SPEED = 19; // m/s
export const SPIKE_MIN_BALL_Y = NET_TOP - 0.2; // ball must be this high to spike
export const PASS_APEX_BONUS = 1.9; // how high above start a pass arcs
export const ATTACK_CLEARANCE = 0.35; // required height over the net tape
export const AIM_OUT_MARGIN = 1.6; // aim may target this far outside the court (risk/reward)
export const BLOCK_HANDS_Y = 2.15; // hands center above player pos when blocking
export const BLOCK_RADIUS = 0.62;
export const BLOCK_NET_DIST = 1.5; // must be this close to the net to block

// ── Rules ───────────────────────────────────────────────────
export const MAX_TOUCHES = 3; // per side
export const WIN_SCORE = 15;
export const WIN_BY = 2;
export const SCORE_CAP = 21;
export const POINT_PAUSE = 2.6; // s of celebration between rallies
export const OVER_PAUSE = 10; // s before auto-rematch
export const SERVE_TIMEOUT = 12; // s before a stalling server auto-serves
export const BOT_SERVE_DELAY = 1.4; // s a bot waits before serving

// ── Rooms ───────────────────────────────────────────────────
export const MAX_PLAYERS_PER_TEAM = 2;
export const MAX_PLAYERS = MAX_PLAYERS_PER_TEAM * 2;
