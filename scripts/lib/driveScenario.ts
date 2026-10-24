import { randomUUID } from 'node:crypto';
import { Identity } from 'spacetimedb';
import type { DbConnection } from '../../packages/bindings/src';
import type { ScenarioCustomer } from '../../apps/web/src/sync/scenarioCatalog';
import { cartKeyFor, menuByName } from '../../apps/web/src/sync/menu';
import { runName, type Load } from '../../apps/web/src/sync/live/scenarioNames';

/**
 * Plays a scenario into the SpacetimeDB engine (LIVE_SPACETIMEDB_DESIGN.md §3).
 * Used by scripts/feed-scenario.ts; the dashboard itself never writes.
 *
 * Creates two deterministic runs with the same customers — "Baseline" on fcfs
 * and "SYNC" on primal_dual — and owns their clock: both runs stay paused and
 * are stepped one tick (= one scenario second) at a time, so every customer
 * reaches both shops at exactly the same tick. Each drink is one engine order;
 * a customer's drinks share a cart key ("c7:latte+black_coffee").
 */

export type { ScenarioCustomer };

export interface DriveOptions {
  seed: number;
  /** Scenario id parts: runs are named "{load}-{n} · Baseline/SYNC". */
  load: Load;
  n: number;
  customers: ScenarioCustomer[];
  /** Serving trays per run (enough not to be a bottleneck). */
  trays?: number;
  /**
   * Global clock: wall-clock ms per tick (one scenario second). Tick n is due
   * at start + n × tickMs; a late tick is caught up at once, so time never
   * drifts. Default 2000 (the engine needs ~1.2 s per tick, more when busy).
   */
  tickMs?: number;
  /** Called once with the global clock (start epoch ms, ms per tick) for viewers. */
  onClock?(clock: { startedAt: number; tickMs: number }): void;
  /** Identities (hex) granted viewer access to the new runs. */
  viewers?: string[];
  /** Stops stepping (runs stay paused where they are). */
  signal?: AbortSignal;
  /** Called once both runs exist. */
  onRuns?(ids: { baseline: bigint; sync: bigint }): void;
  log?(line: string): void;
}

/** Customer deadline: 90 s after walking in (the dashboard's arrival + 90 rule). */
const DEADLINE_FROM_DOOR = 90;
/** Runs one identity may own (engine `create_run` limit). */
const OWNER_RUN_LIMIT = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `read` returns a value from the client cache. */
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const end = Date.now() + 15000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Runs the scenario to completion (or until aborted). `conn` must already be
 * subscribed to `ui_runs`. Returns the two run ids.
 */
export async function driveScenario(conn: DbConnection, o: DriveOptions) {
  const { seed, signal, log = () => {} } = o;
  const batch = randomUUID();
  const runs = [
    { name: runName(o.load, o.n, 'baseline', batch), policy: 'fcfs' },
    { name: runName(o.load, o.n, 'sync', batch), policy: 'primal_dual' },
  ] as const;
  // The engine allows 10 runs per owner and only reports a generic error when
  // the limit is hit, so check first. Runs this identity controls = owned runs.
  const owned = [...conn.db.uiRuns.iter()].filter((r) => r.canControl).length;
  if (owned + runs.length > OWNER_RUN_LIMIT)
    throw new Error(
      `this browser identity already owns ${owned} of the engine's ${OWNER_RUN_LIMIT} runs, so a new Baseline/SYNC pair cannot be created. Use Sample mode to replay saved runs.`,
    );
  const drinks = o.customers.reduce((n, c) => n + c.items.length, 0);
  if (!drinks || drinks > 100)
    throw new Error('Scenario must contain 1–100 drinks per shop.');
  if (
    o.customers.some(
      (c) =>
        !Number.isFinite(c.arrival) ||
        c.arrival < 0 ||
        !c.items.length ||
        c.items.some((i) => !menuByName(i.name)),
    )
  )
    throw new Error('Invalid scenario customer or menu item.');
  if (new Set(o.customers.map((c) => c.id)).size !== o.customers.length)
    throw new Error('Duplicate scenario customer id.');
  const ids: bigint[] = [];
  for (const r of runs) {
    if (signal?.aborted) return;
    const before = new Set([...conn.db.uiRuns.iter()].map((x) => x.id));
    await conn.reducers.createRun({
      name: r.name,
      seed,
      trayCount: o.trays ?? 12,
      mode: 'deterministic',
      budgetMicrousd: undefined,
    });
    const run = await until(
      () =>
        [...conn.db.uiRuns.iter()].find(
          (x) => !before.has(x.id) && x.name === r.name,
        ),
      `run "${r.name}"`,
    );
    // Policy and viewer grants go out together (the engine is slow per call).
    await Promise.all([
      conn.reducers.setPolicy({
        runId: run.id,
        configJson: JSON.stringify({ policy: r.policy }),
      }),
      ...(o.viewers ?? []).map((hex) =>
        conn.reducers.grantMember({
          runId: run.id,
          identity: Identity.fromString(hex),
          permission: 'viewer',
          enabled: true,
        }),
      ),
    ]);
    ids.push(run.id);
    log(`run ${run.id}: ${r.name}`);
  }
  o.onRuns?.({ baseline: ids[0], sync: ids[1] });

  // A customer's orders enter the engine the moment they walk in (the
  // dashboard dates the arrival by that tick). The schedule is shifted so
  // the first customer walks in at tick 0: the shop is busy from the start.
  const first = Math.min(...o.customers.map((c) => c.arrival));
  const arrivals = o.customers.map((c) => ({
    ...c,
    tick: Math.round(c.arrival - first),
  }));
  const lastArrival = Math.max(...arrivals.map((c) => c.tick));
  const status = (id: bigint) =>
    [...conn.db.uiRuns.iter()].find((r) => r.id === id);
  let closed = false;
  // Tick timing, per phase in ms, to see where the clock gets uneven.
  const timing = new TickTiming();
  // The global clock all viewers follow: tick n is due at startedAt + n × tickMs.
  // It starts once the first tick is written (see the loop), so the shop is
  // already moving when viewers start following it.
  const tickMs = o.tickMs ?? 2000;
  let startedAt = 0;
  for (let tick = 0; !signal?.aborted; tick++) {
    timing.begin();
    // Send this tick's orders in one go (calls keep their order on the
    // connection) so a busy tick does not stall the clock for the dashboard.
    const sends: Promise<void>[] = [];
    for (const c of arrivals.filter((c) => c.tick === tick))
      for (const runId of ids)
        for (const [k, item] of c.items.entries()) {
          const entry = menuByName(item.name);
          if (!entry) throw new Error(`No engine recipe for "${item.name}"`);
          sends.push(
            conn.reducers.enqueueOrder({
              runId,
              externalKey: `${c.id}-${k + 1}`,
              cartKey: cartKeyFor(c.id, c.items),
              recipe: entry.recipe,
              deadlineInTicks: DEADLINE_FROM_DOOR,
              value: 1,
              priority: 0,
              // The customer leaves with the drinks at once; the tray is free right away.
              customerUseTicks: 0,
            }),
          );
        }
    await Promise.all(sends);
    timing.mark('enqueue');
    if (!closed && tick >= lastArrival) {
      for (const runId of ids) await conn.reducers.closeArrivals({ runId });
      closed = true;
    }
    const open = ids.filter((id) => status(id)?.status !== 'completed');
    if (!open.length) break;
    // Step both runs together, then wait until each has moved a tick.
    await Promise.all(open.map((runId) => conn.reducers.stepRun({ runId })));
    timing.mark('step');
    await until(
      () =>
        open.every((id) => {
          const r = status(id);
          return r && (r.status === 'completed' || r.tick >= tick + 1);
        })
          ? true
          : undefined,
      'scenario tick',
    );
    timing.mark('confirm');
    if (tick === 0) {
      // Tick 1 is in the database: call it "now" on the global clock.
      startedAt = Date.now() - tickMs;
      o.onClock?.({ startedAt, tickMs });
      // Viewers read it from this line too (the dev server forwards it).
      log(`clock ${startedAt} ${tickMs}`);
    }
    if (tick > lastArrival + 10000)
      throw new Error(
        'Scenario stalled: inspect resource availability, budget, and task states.',
      );
    if (tick % 30 === 0)
      log(
        `tick ${tick}: ${ids.map((id) => `${id}=${status(id)?.status}`).join(' ')}`,
      );
    // How late this tick finished against the global clock (0 = on time).
    timing.note('behind', Math.max(0, Date.now() - (startedAt + (tick + 1) * tickMs)));
    // Wait for the next tick's due time on the global clock; when behind
    // (the engine was slow), go on at once and catch up.
    await sleep(Math.max(0, startedAt + (tick + 1) * tickMs - Date.now()));
    timing.mark('sleep');
    timing.end();
    if (tick > 0 && tick % 60 === 0) log(timing.summary(`ticks ${tick - 59}-${tick}`));
  }
  log(timing.summary('all ticks'));
  return { baseline: ids[0], sync: ids[1] };
}

/** Per-phase durations of each tick, summarised as p50 / p95 / max (ms). */
class TickTiming {
  private window: Record<string, number>[] = [];
  private all: Record<string, number>[] = [];
  private row: Record<string, number> = {};
  private at = 0;
  private start = 0;
  begin() {
    this.at = this.start = performance.now();
    this.row = {};
  }
  note(name: string, value: number) {
    this.row[name] = value;
  }
  mark(phase: string) {
    const now = performance.now();
    this.row[phase] = (this.row[phase] ?? 0) + (now - this.at);
    this.at = now;
  }
  end() {
    this.row.tick = performance.now() - this.start;
    this.window.push(this.row);
    this.all.push(this.row);
  }
  summary(label: string) {
    const rows = label === 'all ticks' ? this.all : this.window;
    this.window = [];
    const stat = (k: string) => {
      const v = rows.map((r) => r[k] ?? 0).sort((a, b) => a - b);
      const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
      return `${k} ${q(0.5).toFixed(0)}/${q(0.95).toFixed(0)}/${(v.at(-1) ?? 0).toFixed(0)}`;
    };
    return `timing ${label} (p50/p95/max ms): ${['tick', 'enqueue', 'step', 'confirm', 'sleep', 'behind'].map(stat).join(' · ')}`;
  }
}
