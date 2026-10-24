/**
 * Scorecard values at the playhead. Picks SYNC's latest score snapshot at or
 * before t from the delivered timeline — selection only, no scoring here.
 * Falls back to the run's current/final score when no timeline was sent.
 */
import type { RunData, Score } from '../../sync/contract';

export function scoreAt(data: RunData, t: number): Score | undefined {
  const timeline = data.scoreTimeline;
  if (!timeline?.length) return data.score;
  let pick: Score | undefined;
  for (const s of timeline) {
    if (s.t > t) break;
    pick = s;
  }
  return pick ?? timeline[0];
}
