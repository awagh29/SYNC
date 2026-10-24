import type { Agent, Layout, Resource, ResourceType, Role } from './contract';

/**
 * Coffee-shop floor geometry shared by the mock and live adapters: the seven
 * work slots, customer zones and staff homes. It describes the shop, not any
 * scheduling result, so both data sources draw the same floor.
 */

/** Seconds a customer needs to walk from the door to the counter before ordering can start. */
export const WALK_IN = 2;

/**
 * Scenario length T in seconds (= engine ticks): the scoring window of
 * objective (20) and the span customers arrive in. 180 ticks at 2 s per tick
 * is about 6 minutes of wall time.
 */
export const SCENARIO_T = 180;
/** Length the first sample scenario was written for; arrivals scale by T / this. */
export const SAMPLE_T = 420;

/** Headcount per role (1–2). The cleaner is always 1. */
export type StaffCounts = Partial<Record<Exclude<Role, 'cleaner'>, 1 | 2>>;

/**
 * Slot id, type, label and centre in grid units. One grid unit = one 48 px
 * pixel-art tile; the floor is 17 × 10 tiles, matching Figma "Pixel floor ·
 * draft v1" (tile centres are column + 0.5).
 */
export const SLOT_POS: Array<[string, ResourceType, string, number, number]> =
  [
    ['reg1', 'register', 'Register 1', 2.5, 4.5],
    ['reg2', 'register', 'Register 2', 4.5, 4.5],
    ['bar1', 'bar', 'Bar 1', 5.5, 1.5],
    ['bar2', 'bar', 'Bar 2', 7.5, 1.5],
    ['pick1', 'pickup', 'Pickup 1', 11.5, 4.5],
    ['pick2', 'pickup', 'Pickup 2', 13.5, 4.5],
    ['clean1', 'clean', 'Clean 1', 14.5, 1.5],
  ];
/** Where staff stand to work a slot: behind the counter (front row) or at the bar (back row). */
export const STAND_Y: Record<ResourceType, number> = {
  register: 3.5,
  pickup: 3.5,
  bar: 2.5,
  clean: 2.5,
};
/** Each role's primary slot type. */
export const ROLE_TYPE: Record<Role, ResourceType> = {
  cashier: 'register',
  barista: 'bar',
  server: 'pickup',
  cleaner: 'clean',
};
export const ROLE_NAME: Record<Role, string> = {
  cashier: 'Cashier',
  barista: 'Barista',
  server: 'Server',
  cleaner: 'Cleaner',
};
/** Starting position per role, in grid units. */
export const HOME: Record<Role, [number, number]> = {
  cashier: [2.5, 3.5],
  barista: [5.5, 2.5],
  server: [11.5, 3.5],
  cleaner: [14.5, 2.5],
};

/**
 * Floor layout: 7 slots, zones for animation, and the staff for this
 * scenario. Same-role staff get numbered names and slightly offset homes.
 */
export function buildLayout(staff: StaffCounts = {}): Layout {
  const resources: Resource[] = SLOT_POS.map(([id, type, label, x, y]) => ({
    id,
    type,
    label,
    x,
    y,
    standX: x,
    standY: STAND_Y[type],
  }));
  const agents: Agent[] = [];
  for (const role of ['cashier', 'barista', 'server', 'cleaner'] as Role[]) {
    const count = role === 'cleaner' ? 1 : (staff[role] ?? 1);
    for (let i = 0; i < count; i++) {
      const [hx, hy] = HOME[role];
      agents.push({
        id: count > 1 ? `${role}${i + 1}` : role,
        name: count > 1 ? `${ROLE_NAME[role]} ${i + 1}` : ROLE_NAME[role],
        role,
        primaryTypes: [ROLE_TYPE[role]],
        startX: hx + (count > 1 ? (i ? 0.45 : -0.45) : 0),
        startY: hy,
      });
    }
  }
  return {
    resources,
    agents,
    zones: [
      {
        id: 'staff',
        kind: 'staff',
        label: 'Staff',
        x: 0,
        y: 0,
        w: 17,
        h: 5,
      },
      // Customer-side areas (docs/SCENARIO.md §2). The UI turns them into lanes:
      // doors in the front wall, a 2-row switchback queue, a 5 × 2 grid of
      // pickup waiting spots. Not drawn as boxes.
      {
        id: 'entrance',
        kind: 'entrance',
        label: 'Entrance',
        x: 1,
        y: 9,
        w: 1,
        h: 0.95,
      },
      {
        id: 'queue',
        kind: 'queue',
        label: 'Line',
        x: 1.5,
        y: 6.3,
        w: 8,
        h: 2.4,
      },
      {
        id: 'waiting',
        kind: 'waiting',
        label: 'Waiting',
        x: 11.22,
        y: 6.23,
        w: 4.56,
        h: 2.54,
      },
      {
        id: 'exit',
        kind: 'exit',
        label: 'Exit',
        x: 16,
        y: 9,
        w: 1,
        h: 0.95,
      },
    ],
  };
}
