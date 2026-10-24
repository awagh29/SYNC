/** Decision history helpers for the Decisions panel (filtering and counting only). */
import type { Decision } from '../../sync/contract';

/** Filter chips in the panel; Helping = cross-role decisions. */
export type DecisionFilter = 'all' | 'assign' | 'wait' | 'helping';

export const filterLabels: Record<DecisionFilter, string> = {
  all: 'All',
  assign: 'Assign',
  wait: 'Wait',
  helping: 'Helping',
};

/** Predicate per filter. */
const matches: Record<DecisionFilter, (d: Decision) => boolean> = {
  all: () => true,
  assign: (d) => d.kind === 'assign',
  wait: (d) => d.kind === 'wait',
  helping: (d) => d.crossRole,
};

/** Decisions made by time t, newest first, plus per-filter counts. */
export function decisionsAt(
  decisions: Decision[],
  t: number,
  filter: DecisionFilter,
) {
  const made = decisions.filter((d) => d.t <= t);
  const counts = Object.fromEntries(
    (Object.keys(matches) as DecisionFilter[]).map((f) => [
      f,
      made.filter(matches[f]).length,
    ]),
  ) as Record<DecisionFilter, number>;
  return { list: made.filter(matches[filter]).reverse(), counts };
}
