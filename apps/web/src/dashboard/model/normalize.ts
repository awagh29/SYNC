/**
 * Input hygiene between the port and the scene model: de-duplicate,
 * order, and sanity-check delivered rows so a messy delivery (out of order,
 * repeated) draws exactly the same scene as a clean one.
 */
import type { Decision, RunData, SyncEvent } from '../../sync/contract';

/** Numeric part of an id ("d12" → 12) for a stable tie-break. */
const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/** One copy per seq / id, in time order, whatever order rows arrived in. */
export function normalizeRun(data: RunData): RunData {
  const events = new Map<number, SyncEvent>();
  for (const e of data.events) events.set(e.seq, e);
  const decisions = new Map<string, Decision>();
  for (const d of data.decisions) decisions.set(d.id, d);
  return {
    ...data,
    events: [...events.values()].sort((a, b) => a.t - b.t || a.seq - b.seq),
    decisions: [...decisions.values()].sort(
      (a, b) => a.t - b.t || num(a.id) - num(b.id),
    ),
  };
}

/** Referential checks against the contract. Empty means usable. */
export function checkRun(data: RunData): string[] {
  const issues: string[] = [];
  const agents = new Set(data.layout.agents.map((a) => a.id));
  const resources = new Set(data.layout.resources.map((r) => r.id));
  const jobs = new Set(data.jobs.map((j) => j.id));
  const tasks = new Set(data.tasks.map((t) => t.id));
  const ref = (
    kind: string,
    id: string | undefined,
    known: Set<string>,
    where: string,
  ) => {
    if (id !== undefined && !known.has(id))
      issues.push(`${where}: unknown ${kind} "${id}"`);
  };
  for (const e of data.events) {
    const where = `event ${e.seq} (${e.type})`;
    ref('agent', e.agentId, agents, where);
    ref('resource', e.resourceId, resources, where);
    ref('job', e.jobId, jobs, where);
    ref('task', e.taskId, tasks, where);
    if (
      e.type === 'agent.move' &&
      [e.data?.toX, e.data?.toY, e.data?.eta].some((v) => typeof v !== 'number')
    )
      issues.push(`${where}: missing move coordinates`);
  }
  for (const task of data.tasks)
    for (const dep of task.deps)
      ref('task', dep, tasks, `task ${task.id} dependency`);
  for (const d of data.decisions) {
    const where = `decision ${d.id}`;
    ref('agent', d.agentId, agents, where);
    ref('resource', d.resourceId, resources, where);
    ref('task', d.taskId, tasks, where);
  }
  return issues.slice(0, 20);
}
