import type {
  Agent,
  BenchmarkSummary,
  Candidate,
  Decision,
  Complexity,
  Job,
  OrderItem,
  Policy,
  Resource,
  ResourceType,
  RunData,
  Score,
  SyncEvent,
  Task,
} from '../contract';
import { MENU } from '../menu';
import {
  buildLayout,
  SAMPLE_T,
  SCENARIO_T,
  WALK_IN,
  type StaffCounts,
} from '../shopLayout';

// Re-exported so existing callers (tests, feeder) keep one import site.
export { MENU, buildLayout };

/**
 * Sample coffee-shop scenario for the mock backend (docs/SCENARIO.md).
 *
 * Plays the SYNC layer's role only so the dashboard has contract-shaped rows
 * to show: it generates customers and their task DAGs, runs a small
 * time-stepped simulation, and records events, decisions and a score.
 * The dispatch rules below are placeholders, not the SYNC optimizer; every
 * number they produce is sample data and must never be presented as a result.
 */

/** Knobs for one generated scenario. Same options + seed → identical output. */
export interface ScenarioOptions {
  /** Random seed; Baseline and SYNC use the same seed so they see the same customers. */
  seed: number;
  /** 'morning' front-loads arrivals (rush); anything else spaces them evenly. */
  scenario?: string;
  /**
   * Seconds between arrivals during the morning rush (default 6). Lower it
   * to load the floor harder (design/MOCK_AND_TEST_DESIGN.md §3.4); values
   * that are not a positive number fall back to the default.
   */
  rushGap?: number;
  /** Number of customers (orders); default 24. */
  customers?: number;
  /** Fixed horizon T in simulated seconds, used by objective (20). */
  T?: number;
  /** Headcount per role (1–2). The cleaner is always 1. */
  staff?: StaffCounts;
}

/**
 * Sample duration model in seconds (docs/SCENARIO.md §5). More and harder
 * items lengthen both taking the order and making the drinks. The real
 * coefficients are the SYNC team's to define.
 */
export const DURATION_MODEL = {
  orderBase: 4,
  orderPerItem: 2.5,
  orderExtra: { simple: 0, medium: 1.5, complex: 3.5 } satisfies Record<
    Complexity,
    number
  >,
  makeBase: { simple: 7, medium: 11, complex: 16 } satisfies Record<
    Complexity,
    number
  >,
  handoffBase: 4,
  handoffPerItem: 0.5,
  clean: 7,
  /** ± fraction of random variation per task. */
  jitter: 0.15,
};

/**
 * Seconds a cashier needs to take an order: grows with the number of items
 * and with each item's difficulty. `k` is the random jitter multiplier.
 */
export function orderTime(items: OrderItem[], k = 1) {
  const m = DURATION_MODEL;
  return (
    k *
    (m.orderBase +
      m.orderPerItem * items.length +
      items.reduce((s, i) => s + m.orderExtra[i.complexity], 0))
  );
}

/** Seconds a barista needs for one drink, by difficulty. One make task per drink. */
export function makeTime(item: OrderItem, k = 1) {
  return k * DURATION_MODEL.makeBase[item.complexity];
}

/** Human label for an order, e.g. "Latte ×2 + Black coffee". */
function orderLabel(items: OrderItem[]) {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(' + ');
}

/** Staff walking speed, grid units per second. */
const WALK_SPEED = 2;
/** A task done outside the agent's primary role ("helping") takes this much longer. */
const HELP_FACTOR = 1.25;
/** Simulation step in seconds. Event times are multiples of this (except arrivals). */
const DT = 0.25;
/** Role that normally does each kind of work (for decision explanations). */
const PRIMARY: Record<ResourceType, string> = {
  register: 'Cashier',
  bar: 'Barista',
  pickup: 'Server',
  clean: 'Cleaner',
};
/** Short noun for each kind of work in decision titles ("c27 drink: …"). */
const SHORT_WORK: Record<ResourceType, string> = {
  register: 'order',
  bar: 'drink',
  pickup: 'hand-off',
  clean: 'clean-up',
};
/** SYNC sample only: send a server to pickup when the drinks finish within this many seconds. */
const PREPOSITION_WINDOW = 6;
/**
 * Arrival rate relative to the first sample (rush 14 s, later 17 s, 24
 * customers over 420 s). Raising it brings more customers, more often.
 */
const ARRIVAL_RATE = 1;
/**
 * The same customers squeezed into the scenario length: arrival times scale
 * by SCENARIO_T / SAMPLE_T (180 / 420 ≈ 0.43), so the shop gets busier.
 */
const TIME_SCALE = SCENARIO_T / SAMPLE_T;
/** Customers per run by default (24 × ARRIVAL_RATE, rounded). */
export const DEFAULT_CUSTOMERS = Math.round(24 * ARRIVAL_RATE);
/** Default seconds between arrivals during the morning rush (ScenarioOptions.rushGap). */
export const DEFAULT_RUSH_GAP =
  Math.round(((14 * TIME_SCALE) / ARRIVAL_RATE) * 100) / 100;
/** Seconds between arrivals after the rush. */
const CALM_GAP = Math.round(((17 * TIME_SCALE) / ARRIVAL_RATE) * 100) / 100;

/** Small deterministic PRNG (LCG) so a seed always reproduces the same run. */
export function rng(seed: number) {
  let n = seed >>> 0 || 1;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}

/** Simulation-only task state. Only the public Task fields leave this module. */
interface SimTask extends Task {
  /** Base duration for the primary role (helping multiplies it). */
  duration: number;
  /** The order's deadline; clean tasks have none (Infinity). */
  deadline: number;
  /**
   * blocked → ready (deps done) → assigned (agent walking) → running → done.
   * reserved = a Wait decision holds it for a specific busy agent.
   */
  state: 'blocked' | 'ready' | 'reserved' | 'assigned' | 'running' | 'done';
  /** When it became ready; Baseline serves ready tasks in this order (FIFO). */
  readyAt: number;
  agentId?: string;
  resourceId?: string;
  endAt?: number;
  /** Actual duration once started (after any helping slowdown). */
  workDuration?: number;
  /** The Wait decision that reserved this task, if any. */
  waitDecision?: Decision;
}
/** Simulation-only agent state. */
interface SimAgent extends Agent {
  /** Position after the current move completes (moves are instantaneous here; the UI interpolates). */
  x: number;
  y: number;
  /** Task the agent is walking to or working on. */
  task?: SimTask;
  /** Time the agent reaches its slot. */
  arriveAt: number;
}

/**
 * Runs one policy over the generated customers and returns everything the
 * dashboard needs for that run (contract RunData).
 *
 * baseline: FIFO over ready tasks, primary role only.
 * sync (sample): earliest deadline first, may use helpers, may Wait for a
 * busy primary agent that would still finish sooner, and pre-positions servers.
 */
export function simulate(policy: Policy, options: ScenarioOptions): RunData {
  const {
    seed,
    scenario = 'morning',
    customers = DEFAULT_CUSTOMERS,
    T = SCENARIO_T,
  } = options;
  const rushGap =
    options.rushGap !== undefined &&
    Number.isFinite(options.rushGap) &&
    options.rushGap > 0
      ? options.rushGap
      : DEFAULT_RUSH_GAP;
  const random = rng(seed);
  const round = (v: number) => Math.round(v * 100) / 100;
  const layout = buildLayout(options.staff);

  // 1. Customers and their task DAGs (same seed → same customers for both policies).
  const jobs: Job[] = [];
  const tasks: SimTask[] = [];
  /** Random ± variation applied to each task duration. */
  const jitter = () => 1 + DURATION_MODEL.jitter * (2 * random() - 1);
  for (let i = 0; i < customers; i++) {
    const id = `c${i + 1}`;
    const rush = scenario === 'morning' && i < customers / 2;
    // Arrivals: tighter spacing during the morning rush, plus a little noise.
    const arrival = round(
      i * (rush ? rushGap : CALM_GAP) + random() * 4 * TIME_SCALE,
    );
    // Sample deadline rule. Provisional: ask the user before changing (late definition).
    const deadline = round(arrival + 90);
    // 1 item 55%, 2 items 30%, 3 items 15%.
    const r = random();
    const count = r < 0.55 ? 1 : r < 0.85 ? 2 : 3;
    const items = Array.from(
      { length: count },
      () => MENU[Math.floor(random() * MENU.length)],
    );
    /** Builds one task of this order; ids look like "c12.make2". */
    const task = (
      suffix: string,
      label: string,
      type: ResourceType,
      deps: string[],
      duration: number,
      itemIndex?: number,
    ): SimTask => ({
      id: `${id}.${suffix}`,
      jobId: id,
      label,
      type,
      deps,
      ...(itemIndex === undefined ? {} : { itemIndex }),
      duration: round(duration),
      deadline: type === 'clean' ? Infinity : deadline,
      state: 'blocked',
      readyAt: 0,
    });
    // DAG: order → make (one per drink, parallel) → hand off (after all makes) → clean.
    const order = task(
      'order',
      'Take order',
      'register',
      [],
      orderTime(items, jitter()),
    );
    const makes = items.map((item, k) =>
      task(
        `make${k + 1}`,
        count > 1
          ? `Make ${item.name.toLowerCase()} (${k + 1}/${count})`
          : `Make ${item.name.toLowerCase()}`,
        'bar',
        [order.id],
        makeTime(item, jitter()),
        k,
      ),
    );
    const handoff = task(
      'handoff',
      'Hand off',
      'pickup',
      makes.map((m) => m.id),
      (DURATION_MODEL.handoffBase +
        DURATION_MODEL.handoffPerItem * (count - 1)) *
        jitter(),
    );
    // Clean up only after the customer has taken the drinks (docs/SCENARIO.md §4).
    const clean = task(
      'clean',
      'Clean up',
      'clean',
      [handoff.id],
      DURATION_MODEL.clean * jitter(),
    );
    const all = [order, ...makes, handoff, clean];
    tasks.push(...all);
    jobs.push({
      id,
      label: orderLabel(items),
      arrival,
      deadline,
      value: 1,
      items,
      serviceTaskId: handoff.id,
      taskIds: all.map((t) => t.id),
    });
  }

  // 2. Simulation state and the rows we hand to the dashboard.
  const events: SyncEvent[] = [];
  const decisions: Decision[] = [];
  /** Appends an event with the next sequence number. */
  const emit = (e: Omit<SyncEvent, 'seq'>) =>
    events.push({ seq: events.length + 1, ...e, t: round(e.t) });
  const agents: SimAgent[] = layout.agents.map((a) => ({
    ...a,
    x: a.startX,
    y: a.startY,
    arriveAt: 0,
  }));
  // busyBy: task running on the slot. claimedBy: task holding a lease on it
  // (assigned and walking there, or reserved by a Wait decision).
  const slots = new Map(
    layout.resources.map((r) => [r.id, { ...r, busyBy: '', claimedBy: '' }]),
  );
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  /** Snapshot version stamped on each admission, mimicking versioned admission in the DB. */
  let version = 0;

  /** Walking time from the agent's position to the slot's stand point. */
  const travel = (a: SimAgent, r: Resource, fromX = a.x, fromY = a.y) =>
    Math.max(
      0.5,
      Math.hypot(r.standX! - fromX, r.standY! - fromY) / WALK_SPEED,
    );
  /** Baseline: primary role only. SYNC: anyone but the cleaner may help with non-clean tasks. */
  const canDo = (a: SimAgent, type: ResourceType) =>
    a.primaryTypes.includes(type) ||
    (policy === 'sync' && a.role !== 'cleaner' && type !== 'clean');
  /** Task duration for this agent, slower when helping. */
  const durationFor = (a: SimAgent, t: SimTask) =>
    round(
      a.primaryTypes.includes(t.type) ? t.duration : t.duration * HELP_FACTOR,
    );
  const slotLabel = (id: string) => slots.get(id)!.label;
  /** A slot of the right type that is not busy and not leased to another task. */
  const freeSlot = (t: SimTask) =>
    [...slots.values()].find(
      (s) =>
        s.type === t.type &&
        !s.busyBy &&
        (!s.claimedBy || s.claimedBy === t.id),
    );

  /**
   * Records an Assign decision and its events: lease the slot, assign the
   * task, and start the agent walking there. Work starts on arrival.
   */
  function assign(
    now: number,
    agent: SimAgent,
    task: SimTask,
    slotId: string,
    candidates: Candidate[],
  ) {
    const slot = slots.get(slotId)!;
    const crossRole = !agent.primaryTypes.includes(task.type);
    const job = jobById.get(task.jobId)!;
    const id = `d${decisions.length + 1}`;
    const waited = task.waitDecision;
    const summary =
      policy === 'baseline'
        ? `First in line: ${job.id} ${task.label.toLowerCase()} → ${agent.name} at ${slot.label}`
        : waited
          ? `${agent.name} is free: takes reserved ${slot.label} for ${job.id}`
          : crossRole
            ? `Helping: ${agent.name} covers ${job.id} ${task.label.toLowerCase()} at ${slot.label}`
            : `${agent.name} takes ${job.id} ${task.label.toLowerCase()} at ${slot.label} (earliest finish)`;
    const chosen = candidates.find((c) => c.chosen);
    const detail =
      policy === 'baseline'
        ? `First come, first served: the first ready task goes to the first free ${PRIMARY[task.type]}.`
        : waited
          ? `The ${agent.name} is free now and takes ${slot.label}, which was reserved for ${job.id}.`
          : crossRole
            ? `No ${PRIMARY[task.type]} is free soon, so the idle ${agent.name} covers it at ${slot.label}: slower, but it finishes first (${chosen?.estFinish}s).`
            : `${agent.name} can finish ${job.id} first at ${slot.label} (${chosen?.estFinish}s).`;
    const decision: Decision = {
      id,
      t: round(now),
      kind: 'assign',
      jobId: job.id,
      taskId: task.id,
      taskLabel: `${job.id} ${task.label.toLowerCase()}`,
      agentId: agent.id,
      resourceId: slotId,
      crossRole,
      summary,
      detail,
      candidates,
      admission: {
        status: 'admitted',
        resourceId: slotId,
        snapshotVersion: ++version,
      },
    };
    decisions.push(decision);
    // Link the earlier Wait decision to this assignment for the UI's follow-up link.
    if (waited) waited.followUpId = id;
    if (!slot.claimedBy)
      emit({
        t: now,
        type: 'lease.claimed',
        taskId: task.id,
        resourceId: slotId,
        agentId: agent.id,
        decisionId: id,
      });
    slot.claimedBy = task.id;
    task.state = 'assigned';
    task.agentId = agent.id;
    task.resourceId = slotId;
    agent.task = task;
    emit({
      t: now,
      type: 'task.assigned',
      jobId: job.id,
      taskId: task.id,
      agentId: agent.id,
      resourceId: slotId,
      decisionId: id,
    });
    const eta = round(travel(agent, slot));
    emit({
      t: now,
      type: 'agent.move',
      agentId: agent.id,
      resourceId: slotId,
      taskId: task.id,
      data: {
        fromX: round(agent.x),
        fromY: round(agent.y),
        toX: slot.standX!,
        toY: slot.standY!,
        eta,
      },
    });
    agent.x = slot.standX!;
    agent.y = slot.standY!;
    agent.arriveAt = now + eta;
  }

  /**
   * Every agent that could do the task, ranked by estimated finish time
   * (free time + walking + duration). Busy agents count from when they free up.
   * `promised` marks agents already reserved by another Wait.
   */
  function candidatesFor(now: number, task: SimTask, slotId: string) {
    const slot = slots.get(slotId)!;
    return agents
      .filter((a) => canDo(a, task.type))
      .map((a) => {
        const freeAt = a.task?.endAt ?? (a.task ? Infinity : now);
        const est = freeAt + travel(a, slot) + durationFor(a, task);
        const promised = tasks.some(
          (t) => t.state === 'reserved' && t.waitDecision!.agentId === a.id,
        );
        const startIn = round(Math.max(0, freeAt - now));
        return { agent: a, est: round(est), idle: !a.task, promised, startIn };
      })
      .filter((c) => Number.isFinite(c.est))
      .sort((a, b) => a.est - b.est);
  }

  // 3. Time-stepped loop. Runs past T so every customer is eventually served.
  const horizon = T + 240;
  for (let now = 0; now <= horizon; now = round(now + DT)) {
    // a. Finish tasks whose time is up; hand off completes the customer's order.
    for (const task of tasks) {
      if (task.state !== 'running' || task.endAt! > now) continue;
      task.state = 'done';
      const slot = slots.get(task.resourceId!)!;
      slot.busyBy = '';
      slot.claimedBy = '';
      emit({
        t: now,
        type: 'task.finished',
        jobId: task.jobId,
        taskId: task.id,
        agentId: task.agentId,
        resourceId: slot.id,
        data: { duration: task.workDuration },
      });
      emit({
        t: now,
        type: 'lease.released',
        taskId: task.id,
        resourceId: slot.id,
      });
      agents.find((a) => a.id === task.agentId)!.task = undefined;
      if (task.type === 'pickup') {
        const job = jobById.get(task.jobId)!;
        emit({
          t: now,
          type: 'job.completed',
          jobId: job.id,
          data: { onTime: now <= job.deadline },
        });
      }
    }
    // b. Customers arriving during this step.
    for (const job of jobs) {
      if (job.arrival > now || job.arrival <= now - DT) continue;
      emit({ t: job.arrival, type: 'job.arrived', jobId: job.id });
    }
    // c. Unblock tasks whose dependencies are all done (DAG rule).
    for (const task of tasks) {
      if (task.state !== 'blocked') continue;
      const job = jobById.get(task.jobId)!;
      if (job.arrival > now) continue;
      // Taking the order waits until the customer has walked up to the counter.
      if (task.type === 'register' && job.arrival + WALK_IN > now) continue;
      if (task.deps.every((d) => byId.get(d)!.state === 'done')) {
        task.state = 'ready';
        task.readyAt = now;
      }
    }
    // d. Agents reaching their slot start work once dependencies allow;
    //    otherwise they wait there (a pre-positioned server waiting for drinks).
    for (const agent of agents) {
      const task = agent.task;
      if (!task || task.state !== 'assigned' || agent.arriveAt > now) continue;
      const ready = task.deps.every((d) => byId.get(d)!.state === 'done');
      if (!ready) {
        if (
          !events.some((e) => e.type === 'agent.wait' && e.taskId === task.id)
        )
          emit({
            t: now,
            type: 'agent.wait',
            agentId: agent.id,
            taskId: task.id,
            resourceId: task.resourceId,
          });
        continue;
      }
      const duration = durationFor(agent, task);
      task.state = 'running';
      task.endAt = now + duration;
      task.workDuration = duration;
      slots.get(task.resourceId!)!.busyBy = task.id;
      emit({
        t: now,
        type: 'task.started',
        jobId: task.jobId,
        taskId: task.id,
        agentId: agent.id,
        resourceId: task.resourceId,
        data: { duration },
      });
    }

    // e. Reserved tasks go to the agent they waited for, as soon as it is free.
    for (const task of tasks) {
      if (task.state !== 'reserved') continue;
      const agent = agents.find((a) => a.id === task.waitDecision!.agentId)!;
      if (agent.task) continue;
      const slotId = task.waitDecision!.resourceId!;
      const options = candidatesFor(now, task, slotId).slice(0, 3);
      assign(
        now,
        agent,
        task,
        slotId,
        options.map((c) => ({
          agentId: c.agent.id,
          resourceId: slotId,
          estFinish: c.est,
          startIn: c.startIn,
          chosen: c.agent === agent,
        })),
      );
    }

    // f. Dispatch: ready tasks (plus SYNC's early hand-offs), in policy order.
    const pending = tasks.filter((t) => {
      if (t.state === 'ready') return true;
      // SYNC sample: send a server ahead when the drink is about to finish.
      if (policy !== 'sync' || t.state !== 'blocked' || t.type !== 'pickup')
        return false;
      const deps = t.deps.map((d) => byId.get(d)!);
      return (
        deps.some((d) => d.state === 'running') &&
        deps.every(
          (d) =>
            d.state === 'done' ||
            (d.state === 'running' && d.endAt! - now <= PREPOSITION_WINDOW),
        )
      );
    });
    pending.sort((a, b) =>
      policy === 'baseline'
        ? a.readyAt - b.readyAt || a.id.localeCompare(b.id)
        : a.deadline - b.deadline ||
          a.readyAt - b.readyAt ||
          a.id.localeCompare(b.id),
    );
    for (const task of pending) {
      const slot = freeSlot(task);
      if (!slot) continue;
      const ranked = candidatesFor(now, task, slot.id);
      const idle = ranked.filter((c) => c.idle);
      if (!idle.length) continue;
      const best = ranked[0];
      const top = ranked.slice(0, 3);
      // SYNC sample Wait rule: if a busy primary agent would still finish
      // sooner than any idle helper, reserve the slot for it instead.
      if (
        policy === 'sync' &&
        task.state === 'ready' &&
        !best.idle &&
        !best.promised &&
        best.est + 1 < idle[0].est
      ) {
        const job = jobById.get(task.jobId)!;
        const decision: Decision = {
          id: `d${decisions.length + 1}`,
          t: round(now),
          kind: 'wait',
          jobId: job.id,
          taskId: task.id,
          taskLabel: `${job.id} ${task.label.toLowerCase()}`,
          agentId: best.agent.id,
          resourceId: slot.id,
          crossRole: false,
          summary: `${job.id} ${SHORT_WORK[task.type]}: wait for the ${best.agent.name}`,
          detail: `${slotLabel(slot.id)} is free and the idle ${idle[0].agent.name} could start now, but ${idle[0].agent.primaryTypes.includes(task.type) ? 'would finish later' : 'works slower at this'}. The ${best.agent.name} is free in ${best.startIn} s and still finishes ${job.id} first.`,
          candidates: top.map((c) => ({
            agentId: c.agent.id,
            resourceId: slot.id,
            estFinish: c.est,
            startIn: c.startIn,
            chosen: c === best,
            note: c.idle
              ? canDo(c.agent, task.type) &&
                !c.agent.primaryTypes.includes(task.type)
                ? 'helping, slower'
                : undefined
              : c === best
                ? 'busy, finishes sooner'
                : 'busy',
          })),
          admission: {
            status: 'admitted',
            resourceId: slot.id,
            snapshotVersion: ++version,
            reason: `${slotLabel(slot.id)} reserved for ${best.agent.name}`,
          },
        };
        decisions.push(decision);
        slot.claimedBy = task.id;
        task.state = 'reserved';
        task.waitDecision = decision;
        emit({
          t: now,
          type: 'lease.claimed',
          taskId: task.id,
          resourceId: slot.id,
          agentId: best.agent.id,
          decisionId: decision.id,
        });
        continue;
      }
      // Otherwise assign now: Baseline takes the first idle primary agent,
      // SYNC the idle agent with the earliest estimated finish.
      const pick =
        policy === 'baseline'
          ? idle.find((c) => c.agent.primaryTypes.includes(task.type))
          : idle[0];
      if (!pick) continue;
      assign(
        now,
        pick.agent,
        task,
        slot.id,
        top.map((c) => ({
          agentId: c.agent.id,
          resourceId: slot.id,
          estFinish: c.est,
          startIn: c.startIn,
          chosen: c.agent === pick.agent,
          note: c.idle ? undefined : 'busy',
        })),
      );
    }
    if (tasks.every((t) => t.state === 'done')) break;
  }

  // 4. Package the run in contract shape (internal task fields stripped).
  const simTime = events.at(-1)?.t ?? 0;
  const runId = `${scenario}-s${seed}-${policy}`;
  const plain: Task[] = tasks.map(
    ({ id, jobId, label, type, deps, itemIndex }) => ({
      id,
      jobId,
      label,
      type,
      deps,
      ...(itemIndex === undefined ? {} : { itemIndex }),
    }),
  );
  const data: RunData = {
    run: {
      runId,
      scenario,
      seed,
      policy,
      objective: { id: 'fixed_horizon', T },
      status: 'finished',
      simTime,
    },
    layout,
    jobs,
    tasks: plain,
    events,
    decisions,
  };
  const perDecision = sampleDecisionCost(random);
  data.score = scoreAt(data, simTime, perDecision * decisions.length);
  // Score history once per simulated second, for replaying the scorecard.
  data.scoreTimeline = [];
  for (let s = 0; s <= Math.ceil(simTime); s++) {
    const made = decisions.filter((d) => d.t <= s).length;
    data.scoreTimeline.push({ t: s, ...scoreAt(data, s, perDecision * made) });
  }
  return data;
}

/** Placeholder planning time per decision (ms). Not measured. */
function sampleDecisionCost(random: () => number) {
  return 0.04 + random() * 0.03;
}

/**
 * Objective (20) terms from the rows revealed up to time t. Mock-side only:
 * on the real system SYNC computes the score and the dashboard just shows it.
 * completedInT: orders served by T. lateCount: served after their deadline,
 * or still unserved with the deadline already past (provisional definition).
 */
export function scoreAt(data: RunData, t: number, planningMs: number): Score {
  const T = data.run.objective.T;
  const done = new Map<string, number>();
  for (const e of data.events)
    if (e.type === 'job.completed' && e.t <= t) done.set(e.jobId!, e.t);
  let completedInT = 0,
    lateCount = 0;
  for (const job of data.jobs) {
    const f = done.get(job.id);
    if (f !== undefined && f <= T) completedInT += job.value;
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
    planningMs: Math.round(planningMs * 10) / 10,
    execCost: null,
  };
}

/**
 * Paired-seed comparison: run both policies on seeds 1..N and report the mean
 * difference in orders done within T with a 95% confidence interval.
 */
export function benchmark(
  options: Omit<ScenarioOptions, 'seed'>,
  seeds = 20,
): BenchmarkSummary {
  const perSeed = Array.from({ length: seeds }, (_, i) => {
    const seed = i + 1;
    return {
      seed,
      baseline: simulate('baseline', { ...options, seed }).score!.completedInT,
      sync: simulate('sync', { ...options, seed }).score!.completedInT,
    };
  });
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const diffs = perSeed.map((p) => p.sync - p.baseline);
  const d = mean(diffs);
  const sd = Math.sqrt(
    diffs.reduce((s, x) => s + (x - d) ** 2, 0) / Math.max(1, diffs.length - 1),
  );
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    scenario: options.scenario ?? 'morning',
    T: options.T ?? SCENARIO_T,
    seeds,
    metric: 'completedInT',
    baselineMean: r2(mean(perSeed.map((p) => p.baseline))),
    syncMean: r2(mean(perSeed.map((p) => p.sync))),
    meanDiff: r2(d),
    ci95: r2((1.96 * sd) / Math.sqrt(seeds)),
    perSeed,
  };
}
