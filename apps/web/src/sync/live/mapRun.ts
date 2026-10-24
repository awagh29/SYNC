import type {
  Agent,
  Decision,
  Job,
  Layout,
  Policy,
  ResourceType,
  Role,
  RunData,
  Score,
  SyncEvent,
  Task,
  TimedScore,
} from '../contract';
import { parseCartKey } from '../menu';
import { buildLayout, ROLE_NAME, ROLE_TYPE, SCENARIO_T } from '../shopLayout';

/**
 * Pure mapping from SpacetimeDB `ui_*` view rows to the dashboard contract
 * (LIVE_SPACETIMEDB_DESIGN.md §4). No connection here, so it is unit-tested
 * with plain objects; SpacetimeSyncSource feeds it the subscribed rows.
 *
 * Engine terms → contract terms:
 *   cart (cartKey "c7:latte+mocha") → Job (customer c7)
 *   order (one drink)              → Job.items entry
 *   task (capture_order, …)        → Task, type from the worker role
 *   worker ("cashier 2")           → Agent cashier2, fixed at its own slot
 *   decision                       → Decision (assign; no candidates)
 * The engine has no move or lease rows; staff stay at their slot, so no
 * agent.move or lease events are produced.
 */

/** Subset of `ui_runs` the mapping reads. Field names match @sync/bindings. */
export interface RunRow {
  id: bigint;
  name: string;
  seed: number;
  tick: number;
  status: string;
}
export interface OrderRow {
  id: bigint;
  runId: bigint;
  cartKey: string;
  recipe: string;
  arrivalTick: number;
  deadlineTick: number;
  deliveredTick?: number;
}
export interface TaskRow {
  id: bigint;
  runId: bigint;
  orderId: bigint;
  kind: string;
  role: string;
  workerId?: bigint;
  startedTick?: number;
  finishedTick?: number;
  finishAtTick?: number;
  durationTicks: number;
}
export interface WorkerRow {
  id: bigint;
  runId: bigint;
  label: string;
  role: string;
}
export interface DecisionRow {
  runId: bigint;
  sequence: bigint;
  tick: number;
  taskId: bigint;
  workerId: bigint;
  score: number;
  reasonCodes: string[];
  snapshotVersion: bigint;
}
export interface MetricsRow {
  runId: bigint;
  reportedCoordinatorMs: number;
  coordinatorSampleCount: number;
}

/** Every row of one run. */
export interface RunRows {
  run: RunRow;
  orders: OrderRow[];
  tasks: TaskRow[];
  workers: WorkerRow[];
  decisions: DecisionRow[];
  metrics?: MetricsRow;
}

/** Horizon T of objective (20) in ticks (1 tick = 1 scenario second). */
export const LIVE_T = SCENARIO_T;

/** Engine task kinds → short labels shown in decision rows and details. */
const TASK_LABEL: Record<string, string> = {
  capture_order: 'Take order',
  take_payment: 'Payment',
  prepare_coffee: 'Brew coffee',
  prepare_milk: 'Steam milk',
  assemble_drink: 'Make drink',
  pick_up_drink: 'Pick up',
  deliver_order: 'Hand to customer',
  collect_tray: 'Collect tray',
  clean_tray: 'Clean tray',
  return_tray: 'Return tray',
};

const isRole = (r: string): r is Role => r in ROLE_TYPE;

/** Engine tasks made once per drink; the others are once per order. */
const DRINK_TASKS = new Set(['prepare_coffee', 'prepare_milk', 'assemble_drink']);

/** "Latte ×2 + Black coffee" from the drink names. */
function orderLabel(names: string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' + ');
}

/**
 * Staff from `ui_workers`: "cashier 2" becomes agent cashier2 standing at
 * the second register for the whole run (the engine does not move workers).
 */
function liveLayout(workers: WorkerRow[]) {
  const base = buildLayout();
  const slotOf = new Map<string, { agentId: string; resourceId: string }>();
  const agents: Agent[] = [];
  for (const w of [...workers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const role = w.role;
    if (!isRole(role)) continue;
    const index = Number(w.label.match(/(\d+)\s*$/)?.[1] ?? 1) - 1;
    const slots = base.resources.filter((r) => r.type === ROLE_TYPE[role]);
    const slot = slots[Math.min(index, slots.length - 1)];
    const id = `${w.role}${index + 1}`;
    agents.push({
      id,
      name: `${ROLE_NAME[role]} ${index + 1}`,
      role: role,
      primaryTypes: [ROLE_TYPE[role]],
      startX: slot.standX ?? slot.x,
      startY: slot.standY ?? slot.y,
    });
    slotOf.set(String(w.id), { agentId: id, resourceId: slot.id });
  }
  const layout: Layout = { ...base, agents };
  return { layout, slotOf };
}

/** Objective (20) terms at time t, per customer (all drinks received = done). */
function scoreAt(
  data: Pick<RunData, 'jobs' | 'events' | 'run'>,
  t: number,
  planningMs: number | null,
): Score {
  const T = data.run.objective.T;
  const done = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'job.completed' && e.t <= t) done.set(e.jobId!, e.t);
  let completedInT = 0,
    lateCount = 0;
  for (const job of data.jobs) {
    if (job.arrival > t) continue;
    const f = done.get(job.id);
    if (f !== undefined && f <= T) completedInT += job.value;
    // Late: served after the deadline, or still waiting with it already past.
    if (
      (f !== undefined && f > job.deadline) ||
      (f === undefined && job.deadline < Math.min(t, T))
    )
      lateCount++;
  }
  return {
    runId: data.run.runId,
    T,
    completedInT,
    totalJobs: data.jobs.filter((j) => j.arrival <= t).length,
    lateCount,
    planningMs,
    execCost: null,
  };
}

/** Builds the contract view of one engine run. */
export function mapRun(
  rows: RunRows,
  policy: Policy,
  T = LIVE_T,
  /** Scenario id shown as the run's scenario, e.g. "Mid-2". */
  scenario = 'Live run',
): RunData {
  const { layout, slotOf } = liveLayout(rows.workers);
  const resourceType = new Map(layout.resources.map((r) => [r.id, r.type]));
  const agentName = new Map(layout.agents.map((a) => [a.id, a.name]));

  // Customers: orders grouped by cart, drinks in enqueue (id) order.
  const carts = new Map<string, OrderRow[]>();
  for (const o of [...rows.orders].sort((a, b) => (a.id < b.id ? -1 : 1)))
    carts.set(o.cartKey, [...(carts.get(o.cartKey) ?? []), o]);
  const jobs: Job[] = [];
  /** order id → [customer id, drink index, drink count]. */
  const orderInfo = new Map<string, [string, number, number]>();
  for (const [key, orders] of carts) {
    const { customerId, items } = parseCartKey(key);
    orders.forEach((o, k) =>
      orderInfo.set(String(o.id), [customerId, k, orders.length]),
    );
    // The customer walks in from the door when their orders first exist in
    // the database. (Dating the arrival earlier would make a live customer
    // show up already in line, the walk-in having happened before the rows.)
    const arrival = Math.min(...orders.map((o) => o.arrivalTick));
    jobs.push({
      id: customerId,
      // Drinks come from the cart key (any number per engine order); without
      // one, fall back to one recipe per order.
      label: orderLabel(
        items.length >= orders.length
          ? items.map((i) => i.name)
          : orders.map((o) => o.recipe),
      ),
      arrival,
      deadline: Math.min(...orders.map((o) => o.deadlineTick)),
      value: 1,
      items:
        items.length >= orders.length
          ? items
          : orders.map((o) => ({ name: o.recipe, complexity: 'medium' })),
      serviceTaskId: '',
      taskIds: [],
    });
  }
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // Tasks: ids "c7.capture_order.2" keep the customer first (scene reads it).
  // An engine order holds one drink (older runs) or several: drink tasks
  // (coffee, milk, assembly) are numbered by drink within the customer, the
  // rest by order, so ids never collide in either shape.
  const tasks: Task[] = [];
  const taskId = new Map<string, string>();
  const taskRows = [...rows.tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
  /** Drinks per engine order = its coffee tasks (one per drink). */
  const drinksOf = new Map<string, number>();
  for (const r of taskRows)
    if (r.kind === 'prepare_coffee')
      drinksOf.set(String(r.orderId), (drinksOf.get(String(r.orderId)) ?? 0) + 1);
  /** Drinks in the customer's earlier orders, and drinks per customer. */
  const drinksBefore = new Map<string, number>();
  const drinksTotal = new Map<string, number>();
  for (const [, orders] of carts)
    for (const o of orders) {
      const customerId = orderInfo.get(String(o.id))![0];
      const sofar = drinksTotal.get(customerId) ?? 0;
      drinksBefore.set(String(o.id), sofar);
      drinksTotal.set(customerId, sofar + Math.max(1, drinksOf.get(String(o.id)) ?? 1));
    }
  /** Current drink while walking an order's tasks in creation order. */
  const drinkAt = new Map<string, number>();
  for (const r of taskRows) {
    const info = orderInfo.get(String(r.orderId));
    if (!info || !isRole(r.role)) continue;
    const [customerId, k, count] = info;
    const key = String(r.orderId);
    if (r.kind === 'prepare_coffee') drinkAt.set(key, (drinkAt.get(key) ?? -1) + 1);
    const perDrink = DRINK_TASKS.has(r.kind);
    const drink = (drinksBefore.get(key) ?? 0) + Math.max(0, drinkAt.get(key) ?? 0);
    const total = drinksTotal.get(customerId) ?? count;
    const single = (drinksOf.get(key) ?? 1) <= 1;
    const id = perDrink
      ? `${customerId}.${r.kind}.${drink + 1}`
      : `${customerId}.${r.kind}.${k + 1}`;
    // Drink tasks name their drink; order tasks only when the order is one drink.
    const n = perDrink ? drink : single ? (drinksBefore.get(key) ?? 0) : undefined;
    const label =
      (TASK_LABEL[r.kind] ?? r.kind) +
      (n !== undefined && total > 1 ? ` (${n + 1}/${total})` : '');
    tasks.push({
      id,
      jobId: customerId,
      label,
      type: ROLE_TYPE[r.role],
      deps: [],
      ...(n === undefined ? {} : { itemIndex: n }),
    });
    taskId.set(String(r.id), id);
    const job = jobById.get(customerId)!;
    job.taskIds.push(id);
    if (r.kind === 'deliver_order') job.serviceTaskId = id;
  }

  // Events from task timestamps. Same-tick order: arrivals, finishes and
  // completions before new work starts, so a slot freed at t can be reused at t.
  const PRIORITY: Record<SyncEvent['type'], number> = {
    'job.arrived': 0,
    'task.finished': 1,
    'lease.released': 1,
    'job.completed': 2,
    'task.assigned': 3,
    'lease.claimed': 3,
    'agent.move': 3,
    'agent.wait': 3,
    'task.started': 4,
  };
  const raw: Omit<SyncEvent, 'seq'>[] = [];
  for (const job of jobs)
    raw.push({ t: job.arrival, type: 'job.arrived', jobId: job.id });
  for (const r of taskRows) {
    const id = taskId.get(String(r.id));
    const where = r.workerId !== undefined ? slotOf.get(String(r.workerId)) : undefined;
    if (!id || r.startedTick === undefined || !where) continue;
    const base = { taskId: id, agentId: where.agentId, resourceId: where.resourceId };
    raw.push({ t: r.startedTick, type: 'task.assigned', ...base });
    raw.push({
      t: r.startedTick,
      type: 'task.started',
      ...base,
      data: { duration: (r.finishAtTick ?? r.startedTick + r.durationTicks) - r.startedTick },
    });
    if (r.finishedTick !== undefined)
      raw.push({ t: r.finishedTick, type: 'task.finished', ...base });
  }
  // A customer is done when every drink has been delivered (one hand-off per customer).
  for (const [key, orders] of carts) {
    if (orders.some((o) => o.deliveredTick === undefined)) continue;
    const { customerId } = parseCartKey(key);
    const job = jobById.get(customerId)!;
    const t = Math.max(...orders.map((o) => o.deliveredTick!));
    raw.push({
      t,
      type: 'job.completed',
      jobId: customerId,
      data: { onTime: t <= job.deadline },
    });
  }
  const events: SyncEvent[] = raw
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        a.e.t - b.e.t ||
        PRIORITY[a.e.type] - PRIORITY[b.e.type] ||
        a.i - b.i,
    )
    .map(({ e }, i) => ({ seq: i + 1, ...e }));

  // Decisions: the engine records assignments only, with a score and reason codes.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const decisions: Decision[] = [];
  for (const d of rows.decisions) {
    const id = taskId.get(String(d.taskId));
    const where = slotOf.get(String(d.workerId));
    const task = id ? taskById.get(id) : undefined;
    if (!task || !where) continue;
    const slotLabel =
      layout.resources.find((r) => r.id === where.resourceId)?.label ?? where.resourceId;
    const primary: ResourceType | undefined = resourceType.get(where.resourceId);
    decisions.push({
      id: `d${d.sequence}`,
      t: d.tick,
      kind: 'assign',
      jobId: task.jobId,
      taskId: task.id,
      taskLabel: task.label,
      agentId: where.agentId,
      resourceId: where.resourceId,
      crossRole: primary !== undefined && primary !== task.type,
      summary: `${task.jobId} ${task.label} → ${agentName.get(where.agentId)} @ ${slotLabel}`,
      detail: `score ${d.score.toFixed(2)} · reasons: ${d.reasonCodes.join(', ')}`,
      candidates: [],
      admission: {
        status: 'admitted',
        resourceId: where.resourceId,
        snapshotVersion: Number(d.snapshotVersion),
      },
    });
  }

  const now = rows.run.tick;
  const data: RunData = {
    run: {
      runId: `run-${rows.run.id}`,
      scenario,
      seed: rows.run.seed,
      policy,
      objective: { id: 'fixed_horizon', T },
      status: rows.run.status === 'completed' ? 'finished' : 'running',
      simTime: now,
    },
    layout,
    jobs,
    tasks,
    events,
    decisions,
  };
  // Coordinator time is reported by an external service; deterministic runs have none.
  const planningMs =
    rows.metrics && rows.metrics.coordinatorSampleCount > 0
      ? Math.round(rows.metrics.reportedCoordinatorMs * 10) / 10
      : null;
  data.scoreTimeline = [];
  for (let s = 0; s <= now; s++)
    data.scoreTimeline.push({ t: s, ...scoreAt(data, s, planningMs) } as TimedScore);
  data.score = scoreAt(data, now, planningMs);
  return data;
}
