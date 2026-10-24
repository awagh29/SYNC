/** Mock adapter delivery: replay, stream with commands, and injected delivery faults. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSyncSource } from './MockSyncSource';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MockSyncSource', () => {
  it('replay: delivers both finished runs at once, then the seed comparison', () => {
    const source = new MockSyncSource({ seed: 5 });
    const seen: string[] = [];
    source.subscribe(() => seen.push(source.getSnapshot().status.kind));
    source.connect();
    expect(source.getSnapshot().status.kind).toBe('connecting');
    vi.advanceTimersByTime(0);
    const snap = source.getSnapshot();
    expect(snap.status.kind).toBe('ready');
    expect(snap.runs.sync?.run.status).toBe('finished');
    expect(snap.runs.baseline?.run.policy).toBe('baseline');
    vi.advanceTimersByTime(1);
    expect(source.getSnapshot().benchmark?.seeds).toBe(20);
    expect(source.commands).toBeUndefined();
  });

  it('stream: reveals rows as simulated time passes and obeys commands', async () => {
    const source = new MockSyncSource({
      seed: 5,
      delivery: 'stream',
      tickMs: 100,
      secondsPerTick: 10,
    });
    source.connect();
    vi.advanceTimersByTime(0);
    expect(source.getSnapshot().runs.sync?.run.simTime).toBe(0);
    vi.advanceTimersByTime(300);
    const run = source.getSnapshot().runs.sync!;
    expect(run.run.status).toBe('running');
    expect(run.run.simTime).toBe(30);
    expect(run.events.every((e) => e.t <= 30)).toBe(true);
    expect(
      run.decisions.every(
        (d) =>
          !d.followUpId || run.decisions.some((x) => x.id === d.followUpId),
      ),
    ).toBe(true);
    await source.commands!.setPaused(true);
    vi.advanceTimersByTime(500);
    expect(source.getSnapshot().runs.sync!.run.simTime).toBe(30);
    await source.commands!.setPaused(false);
    await source.commands!.setSpeed(2);
    vi.advanceTimersByTime(100);
    expect(source.getSnapshot().runs.sync!.run.simTime).toBe(50);
    source.disconnect();
  });

  it('delivery faults: duplicate and shuffle rows, drop or refuse the connection', () => {
    const dup = new MockSyncSource({
      seed: 5,
      faults: { duplicate: true, shuffle: true },
    });
    dup.connect();
    vi.advanceTimersByTime(0);
    const clean = new MockSyncSource({ seed: 5 });
    clean.connect();
    vi.advanceTimersByTime(0);
    const a = dup.getSnapshot().runs.sync!.events;
    const b = clean.getSnapshot().runs.sync!.events;
    expect(a.length).toBe(b.length * 2);
    expect(a.slice(0, 20).map((e) => e.seq)).not.toEqual(
      b.slice(0, 20).map((e) => e.seq),
    );

    const drop = new MockSyncSource({
      seed: 5,
      delivery: 'stream',
      tickMs: 100,
      secondsPerTick: 10,
      faults: { disconnectAt: 40 },
    });
    drop.connect();
    vi.advanceTimersByTime(1000);
    expect(drop.getSnapshot().status.kind).toBe('disconnected');

    const fail = new MockSyncSource({ seed: 5, faults: { failConnect: true } });
    fail.connect();
    vi.advanceTimersByTime(1000);
    expect(fail.getSnapshot().status.kind).toBe('connecting');
  });
});
