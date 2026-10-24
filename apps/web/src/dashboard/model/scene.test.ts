/** Scene replay: customer flow, walking, slot progress, helping, counts, messy delivery. */
import { describe, expect, it } from 'vitest';
import { simulate } from '../../sync/mock/scenario';
import { normalizeRun } from './normalize';
import { sceneAt } from './scene';
import { decisionsAt } from './decisions';
import { buildLanes } from './lanes';
import type { SyncEvent } from '../../sync/contract';

const run = normalizeRun(simulate('sync', { seed: 5 }));

describe('sceneAt', () => {
  it('starts with staff at home, idle slots and an empty shop', () => {
    const s = sceneAt(run, -1);
    expect(s.customers).toEqual([]);
    expect(s.slots.every((x) => x.state === 'idle')).toBe(true);
    expect(s.agents.map((a) => [a.x, a.y])).toEqual(
      run.layout.agents.map((a) => [a.startX, a.startY]),
    );
  });

  it('follows one customer through line → ordering → waiting → ready → leaving', () => {
    const job = run.jobs[3];
    const at = (type: string, task: string) =>
      run.events.find(
        (e) => e.type === type && e.taskId === `${job.id}.${task}`,
      )!.t;
    const stage = (t: number) =>
      sceneAt(run, t).customers.find((c) => c.id === job.id)?.stage;
    const arrived = run.events.find(
      (e) => e.type === 'job.arrived' && e.jobId === job.id,
    )!.t;
    expect(stage(arrived)).toBe('line');
    expect(stage(at('task.started', 'order'))).toBe('ordering');
    expect(stage(at('task.finished', 'order'))).toBe('waiting');
    expect(stage(at('task.started', 'handoff'))).toBe('ready');
    expect(stage(at('task.finished', 'handoff'))).toBe('leaving');
    expect(stage(at('task.finished', 'handoff') + 10)).toBeUndefined();
  });

  it('walks a customer from the register to the waiting area instead of jumping', () => {
    const job = run.jobs[3];
    const done = run.events.find(
      (e) => e.type === 'task.finished' && e.taskId === `${job.id}.order`,
    )!;
    const register = run.layout.resources.find(
      (r) => r.id === done.resourceId,
    )!;
    const x = (t: number) =>
      sceneAt(run, t).customers.find((c) => c.id === job.id)!.x;
    const waitingZone = run.layout.zones.find((z) => z.kind === 'waiting')!;
    expect(x(done.t)).toBeCloseTo(register.x);
    const mid = x(done.t + 1);
    expect(mid).toBeGreaterThan(register.x);
    expect(mid).toBeLessThan(waitingZone.x);
    expect(x(done.t + 10)).toBeGreaterThanOrEqual(waitingZone.x);
  });

  it('shows a busy slot with progress and a working agent', () => {
    const start = run.events.find(
      (e) => e.type === 'task.started' && e.data?.duration,
    )!;
    const s = sceneAt(run, start.t + start.data!.duration! / 2);
    const slot = s.slots.find((x) => x.id === start.resourceId)!;
    expect(slot.state).toBe('busy');
    expect(slot.progress).toBeCloseTo(0.5);
    expect(s.agents.find((a) => a.id === start.agentId)?.state).toBe('working');
  });

  it('flags helping when a worker does a task outside its role', () => {
    const help = run.decisions.find((d) => d.crossRole)!;
    const started = run.events.find(
      (e) => e.type === 'task.started' && e.taskId === help.taskId,
    )!;
    expect(
      sceneAt(run, started.t).agents.find((a) => a.id === help.agentId)
        ?.helping,
    ).toBe(true);
  });

  it('counts done and late from delivered rows at the end', () => {
    const s = sceneAt(run, run.run.simTime);
    expect(s.done).toBe(
      run.events.filter((e) => e.type === 'job.completed').length,
    );
    expect(s.late).toBe(
      run.events.filter((e) => e.type === 'job.completed' && !e.data?.onTime)
        .length,
    );
  });

  it('is unaffected by duplicated, reordered delivery', () => {
    const messy = {
      ...run,
      events: [...run.events, ...run.events].reverse(),
      decisions: [...run.decisions].reverse(),
    };
    for (const t of [30, 120, 250])
      expect(sceneAt(normalizeRun(messy), t)).toEqual(sceneAt(run, t));
  });
});

describe('decisionsAt', () => {
  it('lists decisions made so far, newest first, with filter counts', () => {
    const { list, counts } = decisionsAt(run.decisions, 100, 'all');
    expect(list.every((d) => d.t <= 100)).toBe(true);
    expect(list[0].t).toBeGreaterThanOrEqual(list.at(-1)!.t);
    expect(counts.all).toBe(counts.assign + counts.wait);
    expect(
      decisionsAt(run.decisions, 100, 'helping').list.every((d) => d.crossRole),
    ).toBe(true);
  });
});

describe('lanes and waiting spots (design/FIGMA_GUIDE.md "손님 동선")', () => {
  const lanes = buildLanes(run.layout);
  const times = Array.from({ length: 900 }, (_, i) => i * 0.5);
  const scenes = times.map((t) => sceneAt(run, t));
  const onSegment = (
    p: { x: number; y: number },
    path: { x: number; y: number }[],
  ) =>
    path.some((a, i) => {
      const b = path[i + 1];
      if (!b) return false;
      const within = (v: number, u: number, w: number) =>
        v >= Math.min(u, w) - 1e-6 && v <= Math.max(u, w) + 1e-6;
      return (
        (Math.abs(a.y - b.y) < 1e-6 &&
          Math.abs(p.y - a.y) < 1e-6 &&
          within(p.x, a.x, b.x)) ||
        (Math.abs(a.x - b.x) < 1e-6 &&
          Math.abs(p.x - a.x) < 1e-6 &&
          within(p.y, a.y, b.y))
      );
    });

  it('keeps everyone standing in line on the queue lane', () => {
    for (const s of scenes)
      for (const c of s.customers.filter(
        (c) => c.stage === 'line' && !c.walking,
      ))
        expect(onSegment(c, lanes.queuePath)).toBe(true);
  });

  it('never moves customers or staff diagonally', () => {
    const fine = Array.from({ length: 9000 }, (_, i) => i * 0.05);
    let prev = sceneAt(run, 0);
    for (const t of fine.slice(1)) {
      const next = sceneAt(run, t);
      for (const list of ['customers', 'agents'] as const)
        for (const a of next[list]) {
          const b = (prev[list] as { id: string; x: number; y: number }[]).find(
            (x) => x.id === a.id,
          );
          if (!b) continue;
          const dx = Math.abs(a.x - b.x),
            dy = Math.abs(a.y - b.y);
          // In 0.05 s a walker (3.5 grid/s) covers 0.175 and may turn one corner, so
          // the smaller axis stays under half of that; a diagonal moves both a lot.
          expect(Math.min(dx, dy)).toBeLessThan(0.09);
        }
      prev = next;
    }
  });

  it('gives each waiting customer one spot of their own and keeps them on it', () => {
    const spotKey = (c: { x: number; y: number }) =>
      `${c.x.toFixed(3)},${c.y.toFixed(3)}`;
    const spots = new Set(lanes.waitingSpots.map(spotKey));
    const held = new Map<string, string>();
    for (const s of scenes) {
      const seated = s.customers.filter(
        (c) => c.stage === 'waiting' && !c.walking,
      );
      const keys = seated.map(spotKey);
      expect(new Set(keys).size).toBe(keys.length);
      for (const c of seated) {
        expect(spots.has(spotKey(c))).toBe(true);
        const before = held.get(c.id);
        if (before) expect(spotKey(c)).toBe(before);
        held.set(c.id, spotKey(c));
      }
    }
  });

  it('shuffles the line forward one spot, walking, when the head leaves', () => {
    const leave = run.events.find(
      (e) =>
        e.type === 'task.started' &&
        e.taskId?.endsWith('.order') &&
        sceneAt(run, e.t - 0.01).customers.filter((c) => c.stage === 'line')
          .length >= 2,
    )!;
    const behind = sceneAt(run, leave.t - 0.01).customers.filter(
      (c) => c.stage === 'line' && c.id !== leave.jobId,
    );
    const next = behind[0];
    const dist = (t: number) => {
      const c = sceneAt(run, t).customers.find((x) => x.id === next.id)!;
      return Math.abs(c.x - lanes.headX) + Math.abs(c.y - lanes.queuePath[0].y);
    };
    const before = dist(leave.t - 0.01);
    const during = dist(leave.t + 0.1);
    const after = dist(leave.t + 2);
    expect(during).toBeLessThan(before);
    expect(after).toBeLessThan(during + 1e-9);
  });

  it('lets orders finish out of arrival order (pickup is not a queue)', () => {
    const served = run.events
      .filter((e) => e.type === 'job.completed')
      .map((e) => e.jobId!);
    const arrived = run.jobs
      .map((j) => j.id)
      .filter((id) => served.includes(id));
    expect(served).not.toEqual(arrived);
  });
});

describe('order line timing, folding and waiting capacity', () => {
  it('has the customer at the register soon after the cashier starts', () => {
    const lanes = buildLanes(run.layout);
    for (const e of run.events.filter(
      (e) => e.type === 'task.started' && e.taskId?.endsWith('.order'),
    )) {
      const reg = run.layout.resources.find((r) => r.id === e.resourceId)!;
      const c = sceneAt(run, e.t + 1.5).customers.find(
        (x) => x.id === e.jobId,
      )!;
      expect(Math.abs(c.x - reg.x) + Math.abs(c.y - lanes.standY)).toBeLessThan(
        1e-6,
      );
    }
  });

  // A crowd: 14 customers arrive a second apart, one register serves every 10 s.
  const crowd = (() => {
    const base = simulate('baseline', { seed: 1, customers: 14 });
    const events: SyncEvent[] = [];
    let seq = 0;
    const jobs = base.jobs.map((j, i) => ({ ...j, arrival: i }));
    jobs.forEach((j, i) =>
      events.push({ seq: ++seq, t: i, type: 'job.arrived', jobId: j.id }),
    );
    jobs.forEach((j, i) => {
      const start = 20 + i * 10;
      events.push({
        seq: ++seq,
        t: start,
        type: 'task.started',
        jobId: j.id,
        taskId: `${j.id}.order`,
        resourceId: 'reg1',
        agentId: 'cashier',
      });
      events.push({
        seq: ++seq,
        t: start + 8,
        type: 'task.finished',
        jobId: j.id,
        taskId: `${j.id}.order`,
        resourceId: 'reg1',
        agentId: 'cashier',
      });
    });
    return normalizeRun({ ...base, jobs, events, decisions: [] });
  })();

  it('folds a long line behind the rope with the tail at the entrance', () => {
    const lanes = buildLanes(crowd.layout);
    const s = sceneAt(crowd, 19);
    expect(s.queueFolded).toBe(true);
    const tail = s.customers.find((c) => c.id === crowd.jobs[13].id)!;
    expect(tail.y).toBeCloseTo(lanes.bottomRowY);
    // Between the entrance and the tail the bottom lane is empty, so a
    // newcomer joins from the door end without passing anyone.
    const others = s.customers.filter(
      (c) => c.stage === 'line' && c.id !== tail.id,
    );
    expect(
      others.every((c) => c.y < lanes.bottomRowY - 1e-6 || c.x > tail.x),
    ).toBe(true);
    expect(sceneAt(crowd, 135).queueFolded).toBe(false);
  });

  it('never makes people in line squeeze past each other', () => {
    for (let t = 0; t <= 160; t += 0.25) {
      const line = sceneAt(crowd, t).customers.filter(
        (c) => c.stage === 'line',
      );
      for (let i = 0; i < line.length; i++)
        for (let j = i + 1; j < line.length; j++)
          expect(
            Math.hypot(line[i].x - line[j].x, line[i].y - line[j].y),
          ).toBeGreaterThan(0.4);
    }
  });

  it('widens to 6 columns above 10 waiting, then adds rows and a taller board', () => {
    const ten = buildLanes(run.layout, 10);
    const twelve = buildLanes(run.layout, 12);
    const fifteen = buildLanes(run.layout, 15);
    expect(ten.waitingSpots).toHaveLength(10);
    expect(twelve.waitingSpots).toHaveLength(12);
    expect(twelve.wallY).toBeCloseTo(ten.wallY);
    expect(fifteen.waitingSpots.length).toBeGreaterThanOrEqual(15);
    expect(fifteen.wallY).toBeGreaterThan(ten.wallY);
    // Every spot but the front row opens onto an aisle.
    const rows = [...new Set(fifteen.waitingSpots.map((s) => s.y))].sort(
      (a, b) => a - b,
    );
    for (const s of fifteen.waitingSpots)
      expect(s.aisleY === undefined).toBe(s.y === rows[0]);
  });
});
