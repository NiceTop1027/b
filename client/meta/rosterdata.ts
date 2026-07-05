// Original roster (no third-party characters). Each has a position, grade and a
// two-color kit used to draw a procedural portrait — no external art needed.

export type Position = 'WS' | 'MB' | 'S' | 'OP' | 'L';
export type Grade = 'SP' | 'S' | 'A' | 'B';

export interface Player {
  id: string;
  name: string;
  pos: Position;
  grade: Grade;
  power: number; // 0-100
  serve: number;
  block: number;
  colors: [string, string]; // kit gradient
  tag: string; // short flavor
}

export const POSITION_LABEL: Record<Position, string> = {
  WS: '윙 스파이커',
  MB: '미들 블로커',
  S: '세터',
  OP: '아포짓',
  L: '리베로',
};

export const ROSTER: Player[] = [
  { id: 'raul', name: '라울', pos: 'WS', grade: 'SP', power: 96, serve: 88, block: 74, colors: ['#ffd34d', '#ff7a1a'], tag: '에이스 아웃사이드' },
  { id: 'sera', name: '문세라', pos: 'S', grade: 'S', power: 70, serve: 82, block: 66, colors: ['#7fd4ff', '#2f7dff'], tag: '천재 토스마스터' },
  { id: 'hanbyul', name: '이한별', pos: 'MB', grade: 'S', power: 84, serve: 72, block: 95, colors: ['#c79bff', '#7b3ff2'], tag: '철벽 미들블로커' },
  { id: 'taepung', name: '강태풍', pos: 'OP', grade: 'SP', power: 98, serve: 91, block: 80, colors: ['#ff8a3d', '#e23b2e'], tag: '폭풍의 라이트' },
  { id: 'isabel', name: '이사벨', pos: 'WS', grade: 'S', power: 88, serve: 85, block: 70, colors: ['#a6f0d0', '#12b48a'], tag: '냉정한 저격수' },
  { id: 'jino', name: '서지노', pos: 'L', grade: 'A', power: 44, serve: 60, block: 40, colors: ['#ffd0a6', '#c98a4a'], tag: '수비의 달인' },
  { id: 'claire', name: '클레르', pos: 'MB', grade: 'A', power: 80, serve: 68, block: 88, colors: ['#ff9bb0', '#e2356b'], tag: '높이의 지배자' },
  { id: 'noa', name: '한노아', pos: 'S', grade: 'B', power: 58, serve: 70, block: 55, colors: ['#b6c6ff', '#5a78ff'], tag: '침착한 사령탑' },
  { id: 'yeonseop', name: '이연섭', pos: 'WS', grade: 'S', power: 90, serve: 79, block: 72, colors: ['#d9dee8', '#8792a6'], tag: '좌완 강타자' },
];
