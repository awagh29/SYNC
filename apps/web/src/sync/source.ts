import type { BenchmarkSummary, Policy, RunData } from './contract';

/**
 * The single boundary between the dashboard and whatever produces SYNC data.
 * The dashboard only sees this port; mock and live adapters implement it.
 * Shaped for React's useSyncExternalStore.
 */

/** 'sample' shows the Sample data banner; 'live' means real SYNC output. */
export type DataOrigin = 'sample' | 'live';

/** Connection state shown in the top bar and as empty/error states. */
export type SourceStatus =
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'disconnected'; reason: string };

/** Everything the source has delivered so far. Immutable: a new object per change. */
export interface SyncSnapshot {
  status: SourceStatus;
  /** One run per policy; missing until it arrives. */
  runs: Partial<Record<Policy, RunData>>;
  /** Paired-seed comparison; may arrive after the runs. */
  benchmark?: BenchmarkSummary;
}

/** UI → SYNC commands. Live delivery only (INTERFACE.md §3). */
export interface SyncCommands {
  setPaused(paused: boolean): Promise<void>;
  setSpeed(speed: SimSpeed): Promise<void>;
}

/** Playback / simulation speeds offered in the timeline. */
export const simSpeeds = [0.5, 1, 2, 4, 8] as const;
export type SimSpeed = (typeof simSpeeds)[number];

/** Implemented by MockSyncSource now and SpacetimeSyncSource later. */
export interface SyncSource {
  readonly origin: DataOrigin;
  /** 'replay': whole runs arrive at once. 'stream': rows arrive as simulated time passes. */
  readonly delivery: 'replay' | 'stream';
  /** Present only when the source accepts commands (live / stream). */
  readonly commands?: SyncCommands;
  /** Begin receiving data. Called when the dashboard mounts. */
  connect(): void;
  /** Stop receiving data. Called when the dashboard unmounts. */
  disconnect(): void;
  /** Current snapshot; must return the same object until something changes. */
  getSnapshot(): SyncSnapshot;
  /** Register a change listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}
