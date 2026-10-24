/** Sample scenario invariants: determinism, contract shape, DAG order, no double-booking. */
import { describe, expect, it } from 'vitest';
import { MENU, makeTime, orderTime, simulate } from './scenario';
import { checkRun } from '../../dashboard/model/normalize';
import type { Policy } from '../contract';

describe.each<Policy>(['baseline', 'sync'])(
  'sample scenario (%s)',
  (policy) => {
    const run = simulate(policy, { seed: 5 });

    it('is deterministic per seed', () => {
      expect(simulate(policy, { seed: 5 })).toEqual(run);
      expect(simulate(policy, { seed: 6 }).events).not.toEqual(run.events);
    });

    it('satisfies the dashboard contract', () => {
      expect(checkRun(run)).toEqual([]);
      const seqs = run.events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(run.layout.resources.map((r) => r.label)).toEqual([
        'Register 1',
        'Register 2',
        'Bar 1',
        'Bar 2',
        'Pickup 1',
        'Pickup 2',
        'Clean 1',
      ]);
    });

    it('runs each order as a DAG: makes per drink, hand off after all, clean after hand off', () => {
      const finished = new Map(
        run.events
          .filter((e) => e.type === 'task.finished')
          .map((e) => [e.taskId!, e.t]),
      );
      const started = new Map(
        run.events
          .filter((e) => e.type === 'task.started')
          .map((e) => [e.taskId!, e.t]),
      );
      for (const task of run.tasks)
        for (const dep of task.deps)
          expect(started.get(task.id)!).toBeGreaterThanOrEqual(
            finished.get(dep)!,
          );
      for (const job of run.jobs) {
        const makes = run.tasks.filter(
          (t) => t.jobId === job.id && t.type === 'bar',
        );
        expect(makes.map((m) => m.itemIndex)).toEqual(
          job.items.map((_, i) => i),
        );
        const handoff = run.tasks.find((t) => t.id === job.serviceTaskId)!;
        expect(handoff.deps.sort()).toEqual(makes.map((m) => m.id).sort());
        const clean = run.tasks.find(
          (t) => t.jobId === job.id && t.type === 'clean',
        )!;
        expect(clean.deps).toEqual([handoff.id]);
        const served = run.events.find(
          (e) => e.type === 'job.completed' && e.jobId === job.id,
        )!.t;
        expect(started.get(clean.id)!).toBeGreaterThanOrEqual(served);
      }
    });

    it('never double-books a slot or a worker', () => {
      const slot = new Map<string, string>();
      const agent = new Map<string, string>();
      for (const e of run.events) {
        if (e.type === 'task.started') {
          expect(slot.get(e.resourceId!)).toBeUndefined();
          expect(agent.get(e.agentId!)).toBeUndefined();
          slot.set(e.resourceId!, e.taskId!);
          agent.set(e.agentId!, e.taskId!);
        }
        if (e.type === 'task.finished') {
          slot.delete(e.resourceId!);
          agent.delete(e.agentId!);
        }
      }
    });

    it('marks helping only outside primary types', () => {
      const tasks = new Map(run.tasks.map((t) => [t.id, t]));
      for (const d of run.decisions.filter((d) => d.kind === 'assign')) {
        const a = run.layout.agents.find((x) => x.id === d.agentId)!;
        expect(d.crossRole).toBe(
          !a.primaryTypes.includes(tasks.get(d.taskId)!.type),
        );
      }
      if (policy === 'baseline')
        expect(
          run.decisions.some((d) => d.crossRole || d.kind === 'wait'),
        ).toBe(false);
    });

    it('links every wait to the assignment that follows it', () => {
      for (const w of run.decisions.filter((d) => d.kind === 'wait')) {
        const next = run.decisions.find((d) => d.id === w.followUpId);
        expect(next?.kind).toBe('assign');
        expect(next?.taskId).toBe(w.taskId);
      }
    });
  },
);

it('respects headcount: up to two per role, one cleaner', () => {
  const run = simulate('sync', {
    seed: 1,
    staff: { cashier: 2, barista: 2, server: 2 },
  });
  expect(run.layout.agents.map((a) => a.name)).toEqual([
    'Cashier 1',
    'Cashier 2',
    'Barista 1',
    'Barista 2',
    'Server 1',
    'Server 2',
    'Cleaner',
  ]);
  expect(checkRun(run)).toEqual([]);
});

it('takes longer to order and to make with more and harder items', () => {
  const [tea, , latte, , , mocha] = MENU;
  expect(orderTime([tea, tea])).toBeGreaterThan(orderTime([tea]));
  expect(orderTime([mocha])).toBeGreaterThan(orderTime([latte]));
  expect(orderTime([latte])).toBeGreaterThan(orderTime([tea]));
  expect(makeTime(mocha)).toBeGreaterThan(makeTime(latte));
  expect(makeTime(latte)).toBeGreaterThan(makeTime(tea));
});

it('gives orders of one to three items with a readable label', () => {
  const run = simulate('baseline', { seed: 5 });
  for (const job of run.jobs) {
    expect(job.items.length).toBeGreaterThanOrEqual(1);
    expect(job.items.length).toBeLessThanOrEqual(3);
    for (const item of job.items) expect(job.label).toContain(item.name);
  }
  expect(run.jobs.some((j) => j.items.length > 1)).toBe(true);
});
