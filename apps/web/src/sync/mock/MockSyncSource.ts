/**
 * Mock adapter for the SyncSource port. Stands in for the SYNC backend until
 * the real adapter (../live) exists. Generates both runs from the sample
 * scenario and delivers them either all at once (replay) or row by row as
 * simulated time passes (stream, like a live subscription).
 *
 * Imports the port and contract only; the dashboard never imports this file
 * (enforced by boundary.test.ts). Only dashboard/main.tsx constructs it.
 */
import type { Policy, RunData } from '../contract';
import type {
  SimSpeed,
  SyncCommands,
  SyncSnapshot,
  SyncSource,
} from '../source';
import { benchmark, scoreAt, simulate, type ScenarioOptions } from './scenario';

/**
 * Delivery faults (not machine failures): exercise how the dashboard copes
 * with rows that arrive out of order, twice, or not at all. Off by default.
 */
export interface MockFaults {
  /** Deliver events out of order. */
  shuffle?: boolean;
  /** Deliver every event twice. */
  duplicate?: boolean;
  /** Drop the connection at this simulated second (stream only). */
  disconnectAt?: number;
  /** Never become ready. */
  failConnect?: boolean;
}

/** Scenario options plus how the mock delivers data. */
export interface MockOptions extends ScenarioOptions {
  /** 'replay' (default): finished runs at once. 'stream': rows appear over time. */
  delivery?: 'replay' | 'stream';
  faults?: MockFaults;
  /** Wall-clock ms between stream ticks. */
  tickMs?: number;
  /** Simulated seconds per tick at speed 1. */
  secondsPerTick?: number;
  /** Wall-clock ms before the first data arrives. */
  latencyMs?: number;
}

/** Both policies always run on the same seed, side by side. */
const POLICIES: Policy[] = ['baseline', 'sync'];

export class MockSyncSource implements SyncSource {
  readonly origin = 'sample' as const;
  readonly delivery: 'replay' | 'stream';
  readonly commands?: SyncCommands;
  /** Latest snapshot; replaced (never mutated) so React sees each change. */
  private snapshot: SyncSnapshot = { status: { kind: 'connecting' }, runs: {} };
  private listeners = new Set<() => void>();
  /** Pending timeouts, cleared on disconnect. */
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** Complete generated runs; stream mode reveals them gradually. */
  private full?: Record<Policy, RunData>;
  /** Stream mode: simulated seconds revealed so far. */
  private clock = 0;
  private paused = false;
  private speed: SimSpeed = 1;

  constructor(private options: MockOptions) {
    this.delivery = options.delivery ?? 'replay';
    // UI → SYNC commands only exist for live-style delivery (INTERFACE.md §3).
    if (this.delivery === 'stream')
      this.commands = {
        setPaused: async (paused) => {
          this.paused = paused;
        },
        setSpeed: async (speed) => {
          this.speed = speed;
        },
      };
  }

  /** Starts (or restarts) delivery. Safe to call twice (React StrictMode does). */
  connect() {
    this.disconnect();
    this.set({ status: { kind: 'connecting' }, runs: {} });
    if (this.options.faults?.failConnect) return;
    this.later(() => {
      this.full = {
        baseline: simulate('baseline', this.options),
        sync: simulate('sync', this.options),
      };
      if (this.delivery === 'replay') this.publish(Infinity);
      else this.startStream();
      // Seed comparison is slower; deliver it after the runs are on screen.
      this.later(() => {
        this.set({ ...this.snapshot, benchmark: benchmark(this.options) });
      }, 0);
    }, this.options.latencyMs ?? 0);
  }

  /** Stops all pending deliveries. */
  disconnect() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.clock = 0;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Advances the simulated clock on a wall-clock timer and republishes each tick. */
  private startStream() {
    const tickMs = this.options.tickMs ?? 250;
    const step = this.options.secondsPerTick ?? 1;
    const end = Math.max(...POLICIES.map((p) => this.full![p].run.simTime));
    const tick = () => {
      if (!this.paused)
        this.clock = Math.min(end, this.clock + step * this.speed);
      // Fault injection: simulate the connection dropping mid-run.
      const cut = this.options.faults?.disconnectAt;
      if (cut !== undefined && this.clock >= cut) {
        this.set({
          ...this.snapshot,
          status: {
            kind: 'disconnected',
            reason: 'Mock fault: connection dropped',
          },
        });
        return;
      }
      this.publish(this.clock);
      if (this.clock < end) this.later(tick, tickMs);
    };
    this.publish(0);
    this.later(tick, tickMs);
  }

  /**
   * Reveal every row with time ≤ t, the way a live subscription would.
   * t = Infinity publishes the finished runs (replay).
   */
  private publish(t: number) {
    const runs: SyncSnapshot['runs'] = {};
    for (const policy of POLICIES) {
      const full = this.full![policy];
      const done = t >= full.run.simTime;
      const revealed = new Set(
        full.decisions.filter((d) => d.t <= t).map((d) => d.id),
      );
      const data: RunData = {
        run: {
          ...full.run,
          status: done ? 'finished' : 'running',
          simTime: done ? full.run.simTime : t,
        },
        layout: full.layout,
        jobs: full.jobs.filter((j) => j.arrival <= t),
        tasks: full.tasks.filter(
          (task) => full.jobs.find((j) => j.id === task.jobId)!.arrival <= t,
        ),
        events: this.applyFaults(full.events.filter((e) => e.t <= t)),
        // Hide follow-up links that point at decisions not made yet.
        decisions: full.decisions
          .filter((d) => revealed.has(d.id))
          .map((d) =>
            d.followUpId && !revealed.has(d.followUpId)
              ? { ...d, followUpId: undefined }
              : d,
          ),
      };
      // Final score when done; otherwise the score so far (planning time pro rata).
      // Like a live subscription, only the history up to now has arrived.
      data.scoreTimeline = full.scoreTimeline?.filter((s) => s.t <= t);
      data.score = done
        ? full.score
        : scoreAt(
            data,
            t,
            (full.score!.planningMs * data.decisions.length) /
              Math.max(1, full.decisions.length),
          );
      runs[policy] = data;
    }
    this.set({ ...this.snapshot, status: { kind: 'ready' }, runs });
  }

  /** Applies the configured delivery faults to an event list (no-op by default). */
  private applyFaults(events: RunData['events']) {
    const faults = this.options.faults ?? {};
    let out = faults.duplicate ? events.flatMap((e) => [e, { ...e }]) : events;
    if (faults.shuffle)
      out = [...out].sort(
        // Deterministic pseudo-shuffle so fault tests are repeatable.
        (a, b) => ((a.seq * 7919) % 101) - ((b.seq * 7919) % 101),
      );
    return out;
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }

  /** Replaces the snapshot and notifies subscribers. */
  private set(next: SyncSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }
}
