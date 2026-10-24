/** Scorecard at the playhead: picks SYNC's score snapshot for time t, never computes one. */
import { expect, it } from 'vitest';
import { simulate } from '../../sync/mock/scenario';
import { scoreAt } from './scoreAt';

const run = simulate('sync', { seed: 5 });

it('follows the playhead through the delivered score history', () => {
  const early = scoreAt(run, 30)!;
  const late = scoreAt(run, run.run.simTime)!;
  expect(early.completedInT).toBeLessThan(late.completedInT);
  expect(early.totalJobs).toBeLessThan(late.totalJobs);
  expect(late).toMatchObject({
    completedInT: run.score!.completedInT,
    lateCount: run.score!.lateCount,
  });
  // Monotone in t for orders done.
  let prev = -1;
  for (let t = 0; t <= run.run.simTime; t += 10) {
    const s = scoreAt(run, t)!;
    expect(s.completedInT).toBeGreaterThanOrEqual(prev);
    prev = s.completedInT;
  }
});

it('falls back to the run score when no history was sent', () => {
  expect(scoreAt({ ...run, scoreTimeline: undefined }, 30)).toBe(run.score);
});
