import type { BenchmarkSummary, Score } from '../../sync/contract';

/**
 * "How each run is scored" card (Figma Dashboard › Scorecard): one row per
 * term of objective (20) with a Baseline bar and a SYNC bar, a one-line
 * summary, the seed comparison and the formula as a footnote. Values are
 * shown exactly as delivered; the UI only sizes bars and words the summary.
 */

/** Both policies in display order: Baseline first, SYNC second (same as the shop cards). */
const SERIES = [
  { key: 'baseline', label: 'Baseline' },
  { key: 'sync', label: 'SYNC' },
] as const;
type Series = (typeof SERIES)[number]['key'];

/** One scored term: `value` sizes the bar (null = not measured), `text` is shown beside it. */
interface Term {
  sign: '+' | '−';
  label: string;
  hint: string;
  value: (s: Score) => number | null;
  text: (s: Score) => string;
  /** Upper end of the bar scale for this term. */
  scale: (both: Score[]) => number;
}

const TERMS: Term[] = [
  {
    sign: '+',
    label: 'Orders done in time window',
    hint: 'more is better · counts toward the score',
    value: (s) => s.completedInT,
    text: (s) => `${s.completedInT} of ${s.totalJobs}`,
    scale: (both) => Math.max(1, ...both.map((s) => s.totalJobs)),
  },
  {
    sign: '−',
    label: 'Late orders',
    hint: 'fewer is better · penalty',
    value: (s) => s.lateCount,
    text: (s) => `${s.lateCount}`,
    scale: (both) => Math.max(1, ...both.map((s) => s.totalJobs)),
  },
  {
    sign: '−',
    label: 'Planning time',
    hint: 'lower is better · optimizer overhead',
    value: (s) => s.planningMs,
    text: (s) => `${s.planningMs} ms total`,
    // Leave headroom so the longer bar does not fill the whole track.
    scale: (both) => Math.max(0.1, ...both.map((s) => s.planningMs)) * 1.15,
  },
  {
    sign: '−',
    label: 'Execution cost',
    hint: 'lower is better · model / tool / compute',
    value: (s) => s.execCost,
    text: (s) => `${s.execCost}`,
    scale: (both) => Math.max(1, ...both.map((s) => s.execCost ?? 0)) * 1.15,
  },
];

/** "3 more orders", "12 fewer customers late", "1.6 ms more planning time". */
function summary(baseline: Score, sync: Score) {
  const round = (v: number) => Math.round(v * 10) / 10;
  const diff = (n: number, more: string, fewer: string, unit: string) =>
    n === 0
      ? `the same ${unit}`
      : `${round(Math.abs(n))} ${n > 0 ? more : fewer} ${unit}`;
  const orders = sync.completedInT - baseline.completedInT;
  const late = sync.lateCount - baseline.lateCount;
  const planning = sync.planningMs - baseline.planningMs;
  return (
    `SYNC finished ${diff(orders, 'more', 'fewer', 'orders')} in ${sync.T} s ` +
    `and left ${diff(late, 'more', 'fewer', 'customers late')}, ` +
    `for ${diff(planning, 'more', 'less', 'ms planning time')}.`
  );
}

export function Scorecard({
  sync,
  baseline,
  benchmark,
}: {
  sync?: Score;
  baseline?: Score;
  benchmark?: BenchmarkSummary;
}) {
  const scores: Partial<Record<Series, Score>> = { baseline, sync };
  const present = [baseline, sync].filter((s): s is Score => !!s);
  const T = sync?.T ?? baseline?.T;
  return (
    <section className="scorecard" aria-label="Scorecard">
      <header>
        <div>
          <h2>How each run is scored</h2>
          <p className="lede">
            Within the first {T ?? '—'} s: finish more orders, keep fewer
            customers late, spend less on planning and execution.
          </p>
        </div>
        <ul className="legend" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className={`series-${s.key}`}>
              <span className="swatch" aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      </header>

      <div className="terms">
        {TERMS.map((term) => {
          const measured = present.some((s) => term.value(s) !== null);
          return (
            <div className="term" key={term.label}>
              <span className="sign" aria-hidden>
                {term.sign}
              </span>
              <div className="name">
                <strong>{term.label}</strong>
                <small>{term.hint}</small>
              </div>
              {measured ? (
                <div className="bars">
                  {SERIES.map(({ key, label }) => {
                    const s = scores[key];
                    const v = s ? term.value(s) : null;
                    const k =
                      v === null ? 0 : Math.min(1, v / term.scale(present));
                    return (
                      <div className={`bar series-${key}`} key={key}>
                        <span
                          className="track"
                          role="img"
                          aria-label={`${label}: ${s ? term.text(s) : '—'}`}
                        >
                          <span
                            className="fill"
                            style={{ width: `${k * 100}%` }}
                          />
                        </span>
                        <span className="value">
                          {s && v !== null ? term.text(s) : '—'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="not-measured">Not measured</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="summary">
        <p>
          {baseline && sync
            ? summary(baseline, sync)
            : 'Waiting for both runs…'}
        </p>
        <span>
          {benchmark
            ? `${benchmark.seeds} seeds: ${benchmark.meanDiff >= 0 ? '+' : ''}${benchmark.meanDiff.toFixed(2)} orders (± ${benchmark.ci95.toFixed(2)})`
            : 'Seed comparison pending…'}
        </span>
      </div>
      <p className="formula">
        Objective (20): maximize Σ v_i · 1{'{'}f_i ≤ T and success{'}'} −
        β·P_deadline − γ·C_exec − δ·C_coord
      </p>
    </section>
  );
}
