/**
 * Floor lanes: the invisible paths customers and staff walk on
 * (design/FIGMA_GUIDE.md "손님 동선"). Derived from the layout's zones and
 * slots, so the backend only sends areas and the UI decides how people walk.
 * Every path is made of horizontal and vertical segments only — no diagonals.
 * Lanes are never drawn; only people walking on them are.
 * Pure geometry, grid units, no React or Phaser.
 */
import type { Layout, Zone } from '../../sync/contract';

export type Point = { x: number; y: number };

/** A pickup waiting spot and how its holder gets out without pushing past anyone. */
export interface WaitingSpot extends Point {
  /** Aisle this spot opens onto; undefined = front row, steps straight up to the counter lane. */
  aisleY?: number;
}

export interface Lanes {
  /** y where customers stand at a register or pickup counter. */
  standY: number;
  /** Customer lane running in front of all counters. */
  counterY: number;
  /** x of the queue head (between the registers). */
  headX: number;
  /**
   * Order line from the head back to the tail, theme-park style: the top row
   * runs from the head away from the entrance, U-turns, and the bottom row
   * comes back toward the entrance, so the tail is always next to the door.
   */
  queuePath: Point[];
  /** Length of the top row (head → U-turn); a line that fits here is "short". */
  topRowLength: number;
  /** Entrance door point; newcomers walk up from here onto the bottom lane. */
  door: Point;
  /** y of the top and bottom queue rows. */
  topRowY: number;
  bottomRowY: number;
  /** Distance between two people in the order line. */
  spacing: number;
  /** Line longer than this (people) folds into the second row; rope shown then. */
  foldAfter: number;
  /** Rope between the two queue rows (open at the U-turn end). */
  rope: [Point, Point];
  /** Fixed pickup waiting spots, in the order they are handed out. */
  waitingSpots: WaitingSpot[];
  /** Spur from the counter lane down to the waiting aisles. */
  spurX: number;
  /** Exit lane x and the front wall y. */
  exitX: number;
  wallY: number;
  /** Door openings in the front wall: [x1, x2]. */
  doorIn: [number, number];
  doorOut: [number, number];
  /** Staff walk along this y between the bar row and the counter row. */
  staffAisleY: number;
}

/** Waiting spots per row: 5 normally, 6 when more than 10 people wait. */
const NARROW_ROW = 5;
const WIDE_ROW = 6;
/** Gap between people in the order line, grid units. */
const QUEUE_SPACING = 0.6;

const zoneOf = (layout: Layout, kind: Zone['kind']) =>
  layout.zones.find((z) => z.kind === kind);

/**
 * Builds the lane network for a run. `waitingCapacity` is the most people that
 * ever wait for pickup at once: up to 10 fits the 5 × 2 grid, up to 12 adds a
 * sixth column, more adds rows (and the front wall, so the board, moves down).
 */
export function buildLanes(layout: Layout, waitingCapacity = 10): Lanes {
  const registers = layout.resources.filter((r) => r.type === 'register');
  const counters = layout.resources.filter(
    (r) => r.type === 'register' || r.type === 'pickup',
  );
  const counterRow = Math.max(...counters.map((r) => r.y), 0);
  const standY = counterRow + 0.9;
  const counterY = standY + 0.4;
  const headX = registers.length
    ? registers.reduce((s, r) => s + r.x, 0) / registers.length
    : 1;

  const queue = zoneOf(layout, 'queue');
  const waiting = zoneOf(layout, 'waiting');
  const entrance = zoneOf(layout, 'entrance');
  const exit = zoneOf(layout, 'exit');

  // Queue snake: top row from the head to the U-turn (right edge of the queue
  // zone), bottom row back to the door side (left edge).
  const qx = queue?.x ?? 0.5;
  const qy = queue?.y ?? counterY + 0.3;
  const qw = queue?.w ?? 6;
  const qh = queue?.h ?? 1.2;
  const row1 = qy + 0.2;
  const row2 = qy + qh - 0.2;
  const doorX = entrance ? entrance.x + entrance.w / 2 : qx;
  const turnX = qx + qw;
  const queuePath: Point[] = [
    { x: headX, y: row1 },
    { x: turnX, y: row1 },
    { x: turnX, y: row2 },
    { x: doorX, y: row2 },
  ];
  const topRowLength = turnX - headX;
  // People who fit on the top row; more than this folds onto the bottom row.
  const foldAfter = Math.floor(topRowLength / QUEUE_SPACING) + 1;

  // Waiting spots: rows in pairs around an aisle; only row 1 has no aisle (it
  // faces the counter lane). Extra rows push the front wall down.
  const wx = waiting?.x ?? turnX + 1.2;
  const wy = waiting?.y ?? counterY + 0.2;
  const ww = waiting?.w ?? 3.2;
  const wh = waiting?.h ?? 1.6;
  const firstRow = wy + 0.27;
  const rowGap = wh - 0.54; // front row → back row of one pair
  const step = (ww - 0.56) / (NARROW_ROW - 1);
  const perRow = waitingCapacity > 2 * NARROW_ROW ? WIDE_ROW : NARROW_ROW;
  const rows = Math.max(2, Math.ceil(waitingCapacity / perRow));
  const waitingSpots: WaitingSpot[] = [];
  const rowY: number[] = [];
  for (let r = 0; r < rows; r++) {
    const pair = Math.floor(r / 2);
    const pairTop = firstRow + pair * (rowGap + 0.7);
    rowY.push(r % 2 === 0 ? pairTop : pairTop + rowGap);
  }
  for (let r = 0; r < rows; r++) {
    const pair = Math.floor(r / 2);
    const pairTop = firstRow + pair * (rowGap + 0.7);
    const aisleY = pairTop + rowGap / 2;
    for (let i = 0; i < perRow; i++)
      waitingSpots.push({
        x: wx + 0.28 + i * step,
        y: rowY[r],
        aisleY: r === 0 ? undefined : aisleY,
      });
  }
  const spurX = wx - 0.18;

  // Front wall: the entrance zone's bottom, or lower if extra rows need room.
  const baseWall = entrance ? entrance.y + entrance.h : qy + qh + 0.6;
  const wallY = Math.max(baseWall, rowY[rows - 1] + 0.57);
  const exitX = exit ? exit.x + exit.w / 2 : wx + ww + 0.8;
  const doorSpan = (z: Zone | undefined, x: number): [number, number] =>
    z ? [z.x, z.x + z.w] : [x - 0.4, x + 0.4];

  const bar = layout.resources.find((r) => r.type === 'bar');
  const staffAisleY =
    ((bar?.standY ?? 2.5) + (registers[0]?.standY ?? 3.05)) / 2;

  return {
    standY,
    counterY,
    headX,
    queuePath,
    topRowLength,
    door: { x: doorX, y: wallY },
    topRowY: row1,
    bottomRowY: row2,
    spacing: QUEUE_SPACING,
    foldAfter,
    // Open at the U-turn end (right).
    rope: [
      { x: doorX, y: row1 + (row2 - row1) * 0.66 },
      { x: turnX - 0.43, y: row1 + (row2 - row1) * 0.66 },
    ],
    waitingSpots,
    spurX,
    exitX,
    wallY,
    doorIn: doorSpan(entrance, doorX),
    doorOut: doorSpan(exit, exitX),
    staffAisleY,
  };
}

/** Total length of an orthogonal polyline. */
export function pathLength(path: Point[]) {
  let len = 0;
  for (let i = 1; i < path.length; i++)
    len +=
      Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
  return len;
}

/** Point at distance d along a polyline (clamped to its ends). */
export function pointAt(path: Point[], d: number): Point {
  if (d <= 0 || path.length < 2) return { ...path[0] };
  let left = d;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (left <= seg) {
      const k = seg ? left / seg : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    left -= seg;
  }
  return { ...path[path.length - 1] };
}

/** The part of a polyline between distances from and to (either direction). */
export function subPath(path: Point[], from: number, to: number): Point[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: Point[] = [pointAt(path, lo)];
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    walked +=
      Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    if (walked > lo && walked < hi) out.push(path[i]);
  }
  out.push(pointAt(path, hi));
  return from <= to ? out : out.reverse();
}

/** Orthogonal route between two points via a corridor at y = viaY. */
export function viaRow(from: Point, to: Point, viaY: number): Point[] {
  return [from, { x: from.x, y: viaY }, { x: to.x, y: viaY }, to];
}
