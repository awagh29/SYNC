import { DbConnection } from '@sync/bindings';
import { env } from '../../lib/env';
import type { Policy } from '../contract';
import type { ScenarioOption, SyncSnapshot, SyncSource } from '../source';
import { mapRun, type DecisionRow, type RunRow, type RunRows } from './mapRun';
import { LOADS, parseRunName } from './scenarioNames';

/**
 * Read-only SpacetimeDB adapter: subscribes to the `ui_*` views and turns the
 * rows into contract RunData (LIVE_SPACETIMEDB_DESIGN.md §4). It never writes
 * to the database; runs are created and stepped elsewhere (scripts/feed-scenario.ts).
 *
 * Runs pair up into scenarios by name ("Mid-2 · Baseline" + "Mid-2 · SYNC",
 * see scenarioNames.ts). Modes:
 *   live   — every scenario in the database; follows the newest one until the
 *            user picks another, and shows it as rows change.
 *   stored — finished scenarios only, replayed from the start.
 */
export type SpacetimeMode = 'live' | 'stored';

/** Views this adapter reads. */
const QUERIES = [
  'SELECT * FROM ui_runs',
  'SELECT * FROM ui_orders',
  'SELECT * FROM ui_tasks',
  'SELECT * FROM ui_workers',
  'SELECT * FROM ui_decisions',
  'SELECT * FROM ui_metrics',
];
/** localStorage key for this browser's identity token (one per server + database). */
const TOKEN_KEY = `sync-token:${env.VITE_SPACETIMEDB_URI}:${env.VITE_SPACETIMEDB_DATABASE}`;
/** Rebuild at most this often (ms); one engine tick changes many rows. */
const REBUILD_MS = 150;
/**
 * An unfinished scenario whose tick has not moved for this long (ms) has lost
 * its driver (feeder stopped): it is shown as stopped and can be rerun. The
 * engine can take several seconds for one busy tick, so this is generous;
 * otherwise a slow tick flips the run to stopped and back (controls flicker).
 */
const STALL_MS = 20000;

/** Reads a stored token; storage can be unavailable (private mode). */
function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Without storage the next visit gets a new identity; nothing else breaks.
  }
}

/** A Baseline/SYNC pair of runs that share a scenario id. */
interface Scenario {
  id: string;
  load: string;
  n: number;
  runs: Partial<Record<Policy, RunRow>>;
}

/** Groups runs by scenario id; runs with other names are ignored. */
export function scenariosOf(runs: RunRow[], completedOnly = false): Scenario[] {
  const byId = new Map<string, Scenario>();
  for (const run of runs) {
    const p = parseRunName(run.name);
    if (!p) continue;
    const groupKey = `${p.scenario}:${p.batch ?? 'legacy'}`;
    const s = byId.get(groupKey) ?? {
      id: p.scenario,
      load: p.load,
      n: p.n,
      runs: {},
    };
    // Keep the newest run if a name repeats.
    const old = s.runs[p.policy];
    if (!old || old.id < run.id) s.runs[p.policy] = run;
    byId.set(groupKey, s);
  }
  const latest = new Map<string, Scenario>();
  for (const s of byId.values()) {
    if (completedOnly && !done(s)) continue;
    const old = latest.get(s.id);
    if (!old || newestId(s) > newestId(old)) latest.set(s.id, s);
  }
  return [...latest.values()].sort(
    (a, b) =>
      LOADS.indexOf(a.load as never) - LOADS.indexOf(b.load as never) ||
      a.n - b.n,
  );
}

const done = (s: Scenario) =>
  s.runs.baseline?.status === 'completed' &&
  s.runs.sync?.status === 'completed';
/** Highest run id in a scenario: the most recently created one. */
const newestId = (s: Scenario) =>
  [s.runs.baseline?.id ?? 0n, s.runs.sync?.id ?? 0n].reduce((a, b) =>
    a > b ? a : b,
  );

export class SpacetimeSyncSource implements SyncSource {
  readonly origin = 'live' as const;
  readonly label: string;
  readonly delivery: 'replay' | 'stream';
  readonly clockNote?: string;
  private snapshot: SyncSnapshot = { status: { kind: 'connecting' }, runs: {} };
  private listeners = new Set<() => void>();
  private conn?: DbConnection;
  private timer?: ReturnType<typeof setTimeout>;
  /** Bumped per connect / disconnect; callbacks of older connections are ignored. */
  private generation = 0;
  /** Scenario picked in the dropdown; undefined = newest. */
  private picked?: string;
  /**
   * Newest run id per scenario seen so far; a scenario that gets newer runs
   * (just started or rerun) is followed in live mode.
   */
  private known?: Map<string, bigint>;
  /** Last tick seen per scenario and when it last moved (stall detection). */
  private progress = new Map<string, { tick: number; at: number }>();
  /** True once the first subscribed rows were read (later scenarios are new). */
  private loaded = false;
  /** Live: periodic re-check so a stalled scenario turns 'stopped' without new rows. */
  private stallTimer?: ReturnType<typeof setInterval>;
  /**
   * Every decision seen per run. `ui_decisions` keeps only the newest 200,
   * so older ones are remembered here to keep the full history on screen.
   */
  private decisions = new Map<string, Map<string, DecisionRow>>();

  constructor(private readonly mode: SpacetimeMode = 'live') {
    this.delivery = mode === 'stored' ? 'replay' : 'stream';
    this.label = mode === 'stored' ? 'SpacetimeDB · saved run' : 'SpacetimeDB';
    // Live time moves with the database, not with the dashboard's playback.
    this.clockNote = mode === 'live' ? 'Following SpacetimeDB' : undefined;
  }

  connect() {
    this.disconnect();
    const generation = this.generation;
    const current = () => this.generation === generation;
    this.set({ status: { kind: 'connecting' }, runs: {} });
    if (this.mode === 'live')
      this.stallTimer = setInterval(() => current() && this.schedule(), STALL_MS / 2);
    this.conn = DbConnection.builder()
      .withUri(env.VITE_SPACETIMEDB_URI)
      .withDatabaseName(env.VITE_SPACETIMEDB_DATABASE)
      .withToken(loadToken())
      .onConnect((conn, _identity, token) => {
        if (!current()) return;
        saveToken(token);
        conn
          .subscriptionBuilder()
          .onApplied(() => current() && this.rebuild())
          .onError(
            () =>
              current() &&
              this.set({
                ...this.snapshot,
                status: {
                  kind: 'disconnected',
                  reason:
                    'Database schema/subscription mismatch. Publish the current SYNC module, regenerate bindings, then retry.',
                },
              }),
          )
          .subscribe(QUERIES);
        // Any row change schedules one rebuild.
        const db = conn.db;
        for (const table of [
          db.uiRuns,
          db.uiOrders,
          db.uiTasks,
          db.uiWorkers,
          db.uiDecisions,
          db.uiMetrics,
        ] as Array<{
          onInsert(cb: () => void): void;
          onDelete(cb: () => void): void;
        }>) {
          table.onInsert(() => current() && this.schedule());
          table.onDelete(() => current() && this.schedule());
        }
      })
      .onConnectError(
        (_ctx, error) =>
          current() &&
          this.set({
            ...this.snapshot,
            status: {
              kind: 'disconnected',
              reason: `Cannot reach SpacetimeDB at ${env.VITE_SPACETIMEDB_URI} (${error.message}). Check the configured server and publish the current SYNC module.`,
            },
          }),
      )
      .onDisconnect(
        () =>
          current() &&
          this.set({
            ...this.snapshot,
            status: {
              kind: 'disconnected',
              reason:
                'Lost the connection to SpacetimeDB. The last tick stays on screen.',
            },
          }),
      )
      .build();
  }

  disconnect() {
    this.generation++;
    clearInterval(this.stallTimer);
    this.stallTimer = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    const conn = this.conn;
    this.conn = undefined;
    this.known = undefined;
    this.decisions.clear();
    conn?.disconnect();
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  selectScenario(id: string) {
    this.picked = id;
    this.rebuild();
  }

  private set(next: SyncSnapshot) {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  /** Coalesces bursts of row callbacks into one rebuild. */
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.rebuild();
    }, REBUILD_MS);
  }

  /** Reads the client cache and publishes a fresh snapshot. */
  private rebuild() {
    const conn = this.conn;
    if (!conn) return;
    const db = conn.db;
    const scenarios = scenariosOf(
      [...db.uiRuns.iter()] as RunRow[],
      this.mode === 'stored',
    );
    // Live: a scenario with newer runs than before was just (re)started; show it.
    if (this.mode === 'live') {
      const fresh = this.known
        ? scenarios.find((s) => newestId(s) > (this.known!.get(s.id) ?? 0n))
        : undefined;
      if (fresh) this.picked = fresh.id;
      this.known = new Map(scenarios.map((s) => [s.id, newestId(s)]));
    }
    // The picked scenario, else the newest one.
    const chosen =
      scenarios.find((s) => s.id === this.picked) ??
      [...scenarios].sort((a, b) => (newestId(a) < newestId(b) ? 1 : -1))[0];

    const visible = new Set([...db.uiRuns.iter()].map((r) => String(r.id)));
    for (const id of this.decisions.keys())
      if (!visible.has(id)) this.decisions.delete(id);
    const orders = [...db.uiOrders.iter()];
    const tasks = [...db.uiTasks.iter()];
    const workers = [...db.uiWorkers.iter()];
    const metrics = [...db.uiMetrics.iter()];
    for (const d of db.uiDecisions.iter()) {
      const key = String(d.runId);
      const seen = this.decisions.get(key) ?? new Map<string, DecisionRow>();
      seen.set(String(d.sequence), d);
      this.decisions.set(key, seen);
    }
    const rowsFor = (run: RunRow): RunRows => ({
      run,
      orders: orders.filter((o) => o.runId === run.id),
      tasks: tasks.filter((t) => t.runId === run.id),
      workers: workers.filter((w) => w.runId === run.id),
      decisions: [...(this.decisions.get(String(run.id))?.values() ?? [])],
      metrics: metrics.find((m) => m.runId === run.id),
    });
    // Running = its tick moved within STALL_MS. Unfinished scenarios already
    // in the database on first load count as stopped until their tick moves
    // (an old stopped run must not look alive); one that appears later was
    // just started, so it counts as running right away.
    const now = Date.now();
    const firstLoad = !this.loaded;
    const state = (s: Scenario) => {
      if (done(s)) return 'completed';
      const tick = (s.runs.sync ?? s.runs.baseline)!.tick;
      const seen = this.progress.get(s.id);
      if (!seen) this.progress.set(s.id, { tick, at: firstLoad ? 0 : now });
      else if (seen.tick !== tick) this.progress.set(s.id, { tick, at: now });
      return now - this.progress.get(s.id)!.at > STALL_MS ? 'stopped' : 'running';
    };
    const runs: SyncSnapshot['runs'] = {};
    // A stopped scenario no longer moves: show it like a finished one
    // (no live clock or Stop, normal replay controls).
    const stopped = chosen && state(chosen) === 'stopped';
    for (const p of ['baseline', 'sync'] as Policy[]) {
      const run = chosen?.runs[p];
      if (!run) continue;
      const data = mapRun(rowsFor(run), p, undefined, chosen.id);
      runs[p] = stopped ? { ...data, run: { ...data.run, status: 'finished' } } : data;
    }
    // Dropdown entries: "Mid-2" with its state and tick. Runs sit paused
    // between feeder steps, so an unfinished pair counts as running until its
    // tick stops moving (then stopped, and it can be rerun).
    const options: ScenarioOption[] = scenarios.map((s) => {
      const run = (s.runs.sync ?? s.runs.baseline)!;
      return {
        id: s.id,
        label: s.id,
        group: s.load,
        meta: `${state(s)} · tick ${run.tick}`,
      };
    });
    const identity = conn.identity?.toHexString() ?? '';
    const pair = chosen
      ? [chosen.runs.baseline, chosen.runs.sync]
          .filter(Boolean)
          .map((r) => `${r!.name} (run ${r!.id})`)
          .join(' vs ')
      : '';
    this.loaded = true;
    this.set({
      status: { kind: 'ready' },
      runs,
      scenarios: options,
      scenarioId: chosen?.id,
      viewer: identity || undefined,
      note: chosen
        ? `${this.mode === 'live' ? 'Subscribed to' : 'Saved result from'} ${env.VITE_SPACETIMEDB_DATABASE} · ${pair} · tick ${(chosen.runs.sync ?? chosen.runs.baseline)!.tick} · 1 tick = 1 s`
        : undefined,
      // Runs are private to their owner: the feeder must share them with this browser.
      emptyHint: chosen
        ? undefined
        : {
            message: `No ${this.mode === 'live' ? '' : 'finished '}scenarios visible to this dashboard (identity ${identity.slice(0, 12)}…). Start one from the scenario menu (top left) on the dev server, or run the feeder:`,
            command: `corepack pnpm feed --scenario Low-1 --db ${env.VITE_SPACETIMEDB_DATABASE} --viewer ${identity}`,
          },
    });
  }
}
