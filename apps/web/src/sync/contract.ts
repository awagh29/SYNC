/**
 * SYNC → Dashboard data contract (INTERFACE.md v0.1).
 * Pure types only. Both the mock and the real backend adapter produce these
 * shapes; the dashboard consumes nothing else.
 */
export type Policy = 'baseline' | 'sync';
export type ResourceType = 'register' | 'bar' | 'pickup' | 'clean';
export type Role = 'cashier' | 'barista' | 'server' | 'cleaner';
export type ZoneKind = 'entrance' | 'queue' | 'waiting' | 'exit' | 'staff';

/** One simulation run of one policy (header info). */
export interface Run {
  runId: string;
  scenario: string;
  seed: number;
  policy: Policy;
  /** Objective (20): orders done within horizon T; weights optional. */
  objective: {
    id: 'fixed_horizon';
    T: number;
    beta?: number;
    gamma?: number;
    delta?: number;
  };
  status: 'running' | 'finished';
  /** Current (running) or final (finished) simulated time in seconds. */
  simTime: number;
}

/** A work slot (Register 1, Bar 2, ...). Grid units; the UI converts to pixels. */
export interface Resource {
  id: string;
  type: ResourceType;
  label: string;
  x: number;
  y: number;
  /** Where staff stand to work this slot. */
  standX?: number;
  standY?: number;
}

/** Floor area used for drawing and customer animation (entrance, line, ...). */
export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A staff member. Several agents may share a role (named "Cashier 1/2"). */
export interface Agent {
  id: string;
  name: string;
  role: Role;
  /** Slot types this agent normally works; anything else counts as helping. */
  primaryTypes: ResourceType[];
  startX: number;
  startY: number;
}

/** Fixed for the whole run; sent once. */
export interface Layout {
  resources: Resource[];
  zones: Zone[];
  agents: Agent[];
}

export type Complexity = 'simple' | 'medium' | 'complex';

/** One item in a customer's order. */
export interface OrderItem {
  name: string;
  complexity: Complexity;
}

/** One customer order. Finishes when its hand off (serviceTaskId) ends. */
export interface Job {
  id: string;
  label: string;
  arrival: number;
  deadline: number;
  /** v_i in objective (20); 1 by default. */
  value: number;
  /** More and harder items take longer to order and to make. */
  items: OrderItem[];
  serviceTaskId: string;
  taskIds: string[];
}

/** One node of an order's task DAG (take order, make drink, hand off, clean up). */
export interface Task {
  id: string;
  jobId: string;
  label: string;
  type: ResourceType;
  /** Task DAG: starts only after every dep has finished. */
  deps: string[];
  /** Which Job.items entry a make task produces. */
  itemIndex?: number;
}

export type EventType =
  | 'job.arrived'
  | 'task.assigned'
  | 'agent.move'
  | 'agent.wait'
  | 'task.started'
  | 'task.finished'
  | 'lease.claimed'
  | 'lease.released'
  | 'job.completed';

/** Payload of agent.move: walk from (fromX, fromY) to (toX, toY) in eta seconds. */
export interface MoveData {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  eta: number;
}

/**
 * A state change at simulated time t. The dashboard replays these to draw
 * the floor at any moment; seq gives a total order for duplicates/ties.
 */
export interface SyncEvent {
  seq: number;
  t: number;
  type: EventType;
  jobId?: string;
  taskId?: string;
  agentId?: string;
  resourceId?: string;
  decisionId?: string;
  data?: Partial<MoveData> & { duration?: number; onTime?: boolean };
}

/** An agent/slot option SYNC considered for a decision. */
export interface Candidate {
  agentId: string;
  resourceId: string;
  estFinish: number;
  /** Seconds until this agent could start (0 = idle now). Optional. */
  startIn?: number;
  chosen: boolean;
  note?: string;
}

/** A scheduling decision shown in the history panel. */
export interface Decision {
  id: string;
  t: number;
  /** assign: give the task to an agent now. wait: hold it for a better agent. */
  kind: 'assign' | 'wait';
  jobId: string;
  taskId: string;
  taskLabel: string;
  agentId?: string;
  resourceId?: string;
  /** True when the agent works outside its primary role ("Helping"). */
  crossRole: boolean;
  /** One human-readable sentence written by SYNC (the detail title). */
  summary: string;
  /** Optional longer reason written by SYNC, shown under the title. */
  detail?: string;
  candidates: Candidate[];
  /** For a wait: the later assign decision that resolved it. */
  followUpId?: string;
  /** Result of transactional admission against a versioned snapshot. */
  admission?: {
    status: 'admitted' | 'rejected';
    resourceId?: string;
    snapshotVersion: number;
    reason?: string;
  };
}

/** Objective (20) terms for one run, computed by SYNC. The UI only displays them. */
export interface Score {
  runId: string;
  T: number;
  completedInT: number;
  totalJobs: number;
  lateCount: number;
  planningMs: number;
  /** null = not measured (shown as "Not measured"). */
  execCost: number | null;
  objectiveValue?: number;
}

/** A score snapshot at simulated time t. */
export interface TimedScore extends Score {
  t: number;
}

/** Paired-seed comparison of the two policies (one line under the scorecard). */
export interface BenchmarkSummary {
  scenario: string;
  T: number;
  seeds: number;
  metric: 'completedInT';
  baselineMean: number;
  syncMean: number;
  meanDiff: number;
  ci95: number;
  perSeed?: Array<{ seed: number; baseline: number; sync: number }>;
}

/** Everything the dashboard knows about one run. */
export interface RunData {
  run: Run;
  layout: Layout;
  jobs: Job[];
  tasks: Task[];
  events: SyncEvent[];
  decisions: Decision[];
  /** Current (running) or final (finished) score. */
  score?: Score;
  /**
   * Score as it stood at each moment (time ordered), so replay can show the
   * scorecard at the playhead. Optional; without it the UI shows `score`.
   */
  scoreTimeline?: TimedScore[];
}
