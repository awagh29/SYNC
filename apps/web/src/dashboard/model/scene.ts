/**
 * Scene model: turns delivered rows into what the floor shows at time t.
 * Pure function of (run data, t), so scrubbing, rewinding and speed changes
 * are always exact. No React, no Phaser, no scoring or scheduling logic.
 */
import type {
  ResourceType,
  Role,
  RunData,
  SyncEvent,
  Zone,
} from '../../sync/contract';
import {
  buildLanes,
  pathLength,
  pointAt,
  subPath,
  viaRow,
  type Lanes,
  type Point,
  type WaitingSpot,
} from './lanes';

/** What the floor draws at one instant. Positions are grid units. */
/** One slot as drawn: idle, busy (with progress) or claimed (shown "Reserved"). */
export interface SlotView {
  id: string;
  label: string;
  type: ResourceType;
  x: number;
  y: number;
  state: 'idle' | 'busy' | 'claimed';
  /** 0–1 while busy; null when the end time is not known yet. */
  progress: number | null;
  /** Sub line while busy, e.g. "c26 · make" (order id · kind of work). */
  taskLabel?: string;
}
/** One staff member as drawn. `helping` = working outside the primary role. */
export interface AgentView {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  state: 'idle' | 'moving' | 'waiting' | 'working';
  helping: boolean;
  /** 0–1 progress of the task being worked on (drawn as the ring); null otherwise. */
  progress: number | null;
}
/** Where a customer is in the flow: line → ordering → waiting → ready → leaving. */
export type CustomerStage =
  'line' | 'ordering' | 'waiting' | 'ready' | 'leaving';
/** One customer token as drawn. `late` = past their deadline (provisional rule). */
export interface CustomerView {
  id: string;
  label: string;
  stage: CustomerStage;
  late: boolean;
  x: number;
  y: number;
  /** True while walking between places; drawn above standing customers. */
  walking: boolean;
}
/** Full floor state at one instant; also feeds the shop card's Done / Late. */
export interface Scene {
  t: number;
  zones: Zone[];
  /** Lane geometry, for drawing the floor guides, wall, doors and spots. */
  lanes: Lanes;
  /** True while the order line is long enough to use the bottom row (rope shown). */
  queueFolded: boolean;
  slots: SlotView[];
  agents: AgentView[];
  customers: CustomerView[];
  done: number;
  late: number;
}

/** Short word for each kind of work, shown under a busy slot. */
const WORK: Record<ResourceType, string> = {
  register: 'order',
  bar: 'make',
  pickup: 'hand-off',
  clean: 'clean',
};

/** Customer walking speed, grid units per second. */
const CUSTOMER_SPEED = 3.5;

/** Where a walk along `route` that started at `start` is at time t. */
function walkAt(route: Point[], start: number, t: number) {
  const len = pathLength(route);
  const d = Math.max(0, (t - start) * CUSTOMER_SPEED);
  return {
    ...pointAt(route, Math.min(d, len)),
    walking: d < len,
    done: d >= len,
  };
}

/**
 * Replays events up to t. The only computation the dashboard does: it never
 * scores or decides, it only turns delivered rows into positions and states.
 * Expects events from normalizeRun (time ordered).
 */
export function sceneAt(
  data: RunData,
  t: number,
  lanes: Lanes = buildLanes(data.layout, peakWaiting(data)),
): Scene {
  const { layout } = data;
  const resources = new Map(layout.resources.map((r) => [r.id, r]));
  const taskType = new Map(data.tasks.map((task) => [task.id, task.type]));
  // Known finish times, for progress bars when task.started carries no duration.
  const finishedAt = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'task.finished' && e.taskId) finishedAt.set(e.taskId, e.t);

  // Mutable replay state, rebuilt from scratch on every call.
  const slots = new Map(
    layout.resources.map((r) => [
      r.id,
      { busy: undefined as SyncEvent | undefined, claimed: false },
    ]),
  );
  const agents = new Map(
    layout.agents.map((a) => [
      a.id,
      {
        move: undefined as SyncEvent | undefined,
        task: undefined as string | undefined,
        working: false,
        waiting: false,
      },
    ]),
  );
  /** Per customer: when each step of their visit happened (only steps up to t). */
  const customers = new Map<
    string,
    {
      arrived: number;
      stage: CustomerStage;
      orderStart?: number;
      register?: string;
      orderEnd?: number;
      spot?: number;
      handoffStart?: number;
      pickup?: string;
      completed?: number;
      onTime?: boolean;
    }
  >();
  // Pickup waiting spots: index → customer holding it. Assigned in event order,
  // so a customer keeps the same spot until called (orders finish out of order).
  const spotHolder: (string | undefined)[] = lanes.waitingSpots.map(
    () => undefined,
  );
  const jobOf = (e: SyncEvent) =>
    e.jobId ?? (e.taskId ? e.taskId.split('.')[0] : undefined);

  // Replay every event up to t (events are time ordered, so stop at the first later one).
  for (const e of data.events) {
    if (e.t > t) break;
    const agent = e.agentId ? agents.get(e.agentId) : undefined;
    const slot = e.resourceId ? slots.get(e.resourceId) : undefined;
    const type = e.taskId ? taskType.get(e.taskId) : undefined;
    const customer = customers.get(jobOf(e) ?? '');
    switch (e.type) {
      // Customer enters and joins the line.
      case 'job.arrived':
        customers.set(e.jobId!, { arrived: e.t, stage: 'line' });
        break;
      case 'task.assigned':
        if (agent) agent.task = e.taskId;
        break;
      case 'agent.move':
        if (agent) agent.move = e;
        break;
      // Agent reached its slot but the task's dependencies are not done yet.
      case 'agent.wait':
        if (agent) agent.waiting = true;
        break;
      // Work begins. Taking the order puts the customer at a register;
      // the hand off puts them at a pickup counter.
      case 'task.started':
        if (agent)
          Object.assign(agent, {
            working: true,
            waiting: false,
            task: e.taskId,
          });
        if (slot) slot.busy = e;
        if (customer && type === 'register')
          Object.assign(customer, {
            stage: 'ordering',
            orderStart: e.t,
            register: e.resourceId,
          });
        if (customer && type === 'pickup') {
          // Called: leave the waiting spot (free it for the next arrival).
          if (customer.spot !== undefined)
            spotHolder[customer.spot] = undefined;
          Object.assign(customer, {
            stage: 'ready',
            handoffStart: e.t,
            pickup: e.resourceId,
          });
        }
        break;
      // Work ends. After ordering, the customer moves to the waiting area.
      case 'task.finished':
        if (agent) Object.assign(agent, { working: false, task: undefined });
        if (slot) slot.busy = undefined;
        if (customer && type === 'register') {
          // Ordered: take the nearest free waiting spot and keep it.
          const free = spotHolder.findIndex((h) => h === undefined);
          if (free >= 0) spotHolder[free] = jobOf(e);
          Object.assign(customer, {
            stage: 'waiting',
            orderEnd: e.t,
            spot: free >= 0 ? free : undefined,
          });
        }
        break;
      // A lease without running work shows the slot as "Reserved".
      case 'lease.claimed':
        if (slot) slot.claimed = true;
        break;
      case 'lease.released':
        if (slot) slot.claimed = false;
        break;
      // Drinks handed over: the customer leaves (on time or late).
      case 'job.completed':
        if (customer)
          Object.assign(customer, {
            stage: 'leaving',
            completed: e.t,
            onTime: e.data?.onTime,
          });
        break;
    }
  }

  // Slots: busy beats claimed; progress = elapsed / expected duration.
  const slotViews: SlotView[] = layout.resources.map((r) => {
    const s = slots.get(r.id)!;
    let progress: number | null = null;
    if (s.busy) {
      const end =
        s.busy.data?.duration !== undefined
          ? s.busy.t + s.busy.data.duration
          : finishedAt.get(s.busy.taskId!);
      if (end !== undefined && end > s.busy.t)
        progress = Math.min(1, (t - s.busy.t) / (end - s.busy.t));
    }
    return {
      id: r.id,
      label: r.label,
      type: r.type,
      x: r.x,
      y: r.y,
      state: s.busy ? 'busy' : s.claimed ? 'claimed' : 'idle',
      progress,
      taskLabel: s.busy?.taskId
        ? `${s.busy.taskId.split('.')[0]} · ${WORK[r.type]}`
        : undefined,
    };
  });

  // Staff: walk along the staff aisle (vertical, horizontal, vertical) over the
  // move's eta; state priority working > waiting > moving > idle.
  const agentViews: AgentView[] = layout.agents.map((a) => {
    const s = agents.get(a.id)!;
    let pos: Point = { x: a.startX, y: a.startY };
    let moving = false;
    const m = s.move?.data;
    if (s.move && m) {
      const from = { x: m.fromX ?? a.startX, y: m.fromY ?? a.startY };
      const route = viaRow(from, { x: m.toX!, y: m.toY! }, lanes.staffAisleY);
      const k = m.eta ? Math.min(1, Math.max(0, (t - s.move.t) / m.eta)) : 1;
      pos = pointAt(route, k * pathLength(route));
      moving = k < 1;
    }
    const type = s.task ? taskType.get(s.task) : undefined;
    const slot = slotViews.find(
      (v) => v.state === 'busy' && slots.get(v.id)!.busy?.agentId === a.id,
    );
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      ...pos,
      state: s.working
        ? 'working'
        : s.waiting
          ? 'waiting'
          : moving
            ? 'moving'
            : 'idle',
      helping: type !== undefined && !a.primaryTypes.includes(type),
      progress: s.working ? (slot?.progress ?? null) : null,
    };
  });

  const jobs = new Map(data.jobs.map((j) => [j.id, j]));
  const counterAt = (id?: string): Point => ({
    x: resources.get(id ?? '')?.x ?? lanes.headX,
    y: lanes.standY,
  });
  const path = lanes.queuePath;
  const queueLen = pathLength(path);
  const stepTime = lanes.spacing / CUSTOMER_SPEED;
  // Customers in arrival order: the order line is first come, first served.
  const order = [...customers.entries()].sort(
    (a, b) => a[1].arrived - b[1].arrived,
  );

  /**
   * Place in line (0 = head) at time tau, theme-park shuffle: the place taken
   * on arrival, minus one spot — walked over stepTime — for everyone ahead who
   * has left the line since.
   */
  const placeAt = (index: number, tau: number) => {
    const c = order[index][1];
    const ahead = order.slice(0, index).map(([, d]) => d);
    let place = ahead.filter(
      (d) => (d.orderStart ?? Infinity) > c.arrived,
    ).length;
    const joined = place;
    for (const d of ahead) {
      const left = d.orderStart ?? Infinity;
      if (left > c.arrived && left <= tau)
        place -= Math.min(1, (tau - left) / stepTime);
    }
    return { place, joined };
  };

  /**
   * Where a customer in line is at time tau. Newcomers never squeeze past
   * anyone: with a short line they walk the empty bottom lane to just behind
   * the tail and step up; with a long line the tail is at the door, so they
   * walk in from the door end. Then they follow the shuffle along the lane.
   */
  const linePosition = (index: number, tau: number) => {
    const c = order[index][1];
    const { place, joined } = placeAt(index, tau);
    const dJoin = Math.min(queueLen, joined * lanes.spacing);
    const spot = pointAt(path, dJoin);
    const entry =
      dJoin <= lanes.topRowLength
        ? [
            lanes.door,
            { x: lanes.door.x, y: lanes.bottomRowY },
            { x: spot.x, y: lanes.bottomRowY },
            spot,
          ]
        : [lanes.door, ...subPath(path, queueLen, dJoin)];
    const entryLen = pathLength(entry);
    const walked = (tau - c.arrived) * CUSTOMER_SPEED;
    if (walked < entryLen)
      return {
        ...pointAt(entry, walked),
        d: undefined as number | undefined,
        rest: subPath(entry, walked, entryLen),
        dJoin,
      };
    const reached = c.arrived + entryLen / CUSTOMER_SPEED;
    const target = Math.min(queueLen, place * lanes.spacing);
    const d = Math.max(target, dJoin - (tau - reached) * CUSTOMER_SPEED);
    return { ...pointAt(path, d), d, rest: [] as Point[], dJoin };
  };

  // Routes between a register, a waiting spot and a pickup counter. Front-row
  // spots step straight onto the counter lane; other rows use their aisle.
  const toSpot = (from: Point, spot: WaitingSpot): Point[] =>
    spot.aisleY === undefined
      ? [
          from,
          { x: from.x, y: lanes.counterY },
          { x: spot.x, y: lanes.counterY },
          spot,
        ]
      : [
          from,
          { x: from.x, y: lanes.counterY },
          { x: lanes.spurX, y: lanes.counterY },
          { x: lanes.spurX, y: spot.aisleY },
          { x: spot.x, y: spot.aisleY },
          spot,
        ];
  const fromSpot = (spot: WaitingSpot, to: Point): Point[] =>
    [...toSpot(to, spot)].reverse();

  // Customers leaving a spot that shares an aisle go one at a time.
  const aisleFreeAt = new Map<number, number>();
  const aisleStart = new Map<string, number>();
  for (const [id, c] of [...order].sort(
    (a, b) => (a[1].handoffStart ?? Infinity) - (b[1].handoffStart ?? Infinity),
  )) {
    if (c.handoffStart === undefined || c.spot === undefined) continue;
    const spot = lanes.waitingSpots[c.spot];
    if (spot.aisleY === undefined) continue;
    const start = Math.max(
      c.handoffStart,
      aisleFreeAt.get(spot.aisleY) ?? -Infinity,
    );
    aisleStart.set(id, start);
    aisleFreeAt.set(
      spot.aisleY,
      start + (Math.abs(spot.x - lanes.spurX) + 0.6) / CUSTOMER_SPEED,
    );
  }

  let done = 0,
    late = 0,
    inLine = 0;
  const customerViews: CustomerView[] = [];
  order.forEach(([id, c], index) => {
    const job = jobs.get(id);
    const deadline = job?.deadline ?? Infinity;
    // Late: served after the deadline, or still in the shop past it.
    const isLate =
      c.completed !== undefined ? c.onTime === false : t > deadline;
    if (c.completed !== undefined) done++;
    if (isLate) late++;
    const spot = c.spot !== undefined ? lanes.waitingSpots[c.spot] : undefined;
    let p: { x: number; y: number; walking: boolean };
    if (c.stage === 'line') {
      // Standing in (or walking into) the line.
      inLine++;
      const now = linePosition(index, t);
      const before = linePosition(index, t - 0.05);
      p = {
        x: now.x,
        y: now.y,
        walking: Math.abs(now.x - before.x) + Math.abs(now.y - before.y) > 1e-6,
      };
    } else if (c.stage === 'ordering') {
      // From the place in line forward to the head, up to the counter lane, to the register.
      const at = linePosition(index, c.orderStart!);
      const reg = counterAt(c.register);
      const toHead =
        at.d !== undefined
          ? subPath(path, at.d, 0)
          : [...at.rest, ...subPath(path, at.dJoin, 0)];
      const route = [
        ...toHead,
        { x: lanes.headX, y: lanes.counterY },
        { x: reg.x, y: lanes.counterY },
        reg,
      ];
      p = walkAt(route, c.orderStart!, t);
    } else if (c.stage === 'waiting') {
      // From the register to the assigned spot, then stay there.
      const reg = counterAt(c.register);
      const route = spot
        ? toSpot(reg, spot)
        : [
            reg,
            { x: reg.x, y: lanes.counterY },
            { x: lanes.spurX, y: lanes.counterY },
          ];
      p = walkAt(route, c.orderEnd!, t);
    } else if (c.stage === 'ready') {
      // Called: leave the spot (waiting for a busy aisle) and go to pickup.
      const to = counterAt(c.pickup);
      const route = spot ? fromSpot(spot, to) : [counterAt(c.register), to];
      p = walkAt(route, aisleStart.get(id) ?? c.handoffStart!, t);
    } else {
      // Served: counter lane to the exit lane, then out through the door.
      const pick = counterAt(c.pickup);
      const route = [
        pick,
        { x: pick.x, y: lanes.counterY },
        { x: lanes.exitX, y: lanes.counterY },
        { x: lanes.exitX, y: lanes.wallY },
      ];
      const w = walkAt(route, c.completed!, t);
      if (w.done) return;
      p = w;
    }
    customerViews.push({
      id,
      label: job?.label ?? id,
      stage: c.stage,
      late: isLate,
      x: p.x,
      y: p.y,
      walking: p.walking,
    });
  });

  return {
    t,
    zones: layout.zones,
    lanes,
    queueFolded: inLine > lanes.foldAfter,
    slots: slotViews,
    agents: agentViews,
    customers: customerViews,
    done,
    late,
  };
}

/**
 * Most customers waiting for pickup at the same time in the delivered rows
 * (order taken, hand off not started). Sizes the waiting area: >10 adds a
 * sixth column, >12 adds rows and a taller board.
 */
export function peakWaiting(data: RunData) {
  let now = 0,
    peak = 0;
  const type = new Map(data.tasks.map((task) => [task.id, task.type]));
  for (const e of data.events) {
    const kind = e.taskId ? type.get(e.taskId) : undefined;
    if (e.type === 'task.finished' && kind === 'register') now++;
    if (e.type === 'task.started' && kind === 'pickup') now--;
    peak = Math.max(peak, now);
  }
  return peak;
}
