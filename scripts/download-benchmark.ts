/** Optional browser/UI fallback. Pass your ALREADY-SUBSCRIBED authorized rows.
 * Usage in an existing button handler:
 * downloadSyncBenchmark(metricsRows, runRows);
 * Then: node scripts/export-benchmark.mjs --input sync-benchmark-export.json --document docs/SYNC_Complete_Formulation_and_Solution.tex
 */
import type { Infer } from 'spacetimedb';
import type metricsRow from '../packages/bindings/src/ui_metrics_table';
import type runRow from '../packages/bindings/src/ui_runs_table';

export function downloadSyncBenchmark(
  metrics: Iterable<Infer<typeof metricsRow>>,
  runs: Iterable<Infer<typeof runRow>> = [],
): void {
  const metricRows = Array.from(metrics);
  const runRows = Array.from(runs);
  const names = new Map(runRows.map((r) => [r.id, r.name]));
  console.table(
    metricRows.map((r) => ({
      run: r.runId.toString(),
      name: names.get(r.runId),
      tick: r.tick,
      terminalValue: r.reward,
      objective: r.netReward,
      'delivered / unfinished (items)': `${r.deliveredOrders} / ${r.unfinishedOrders}`,
      deadlineViolations: r.deliveredOrders - r.onTimeOrders + r.lateOpenOrders,
      apiCostUSD: `${r.reportedAnthropicCostMicrousd / 1000000n}.${(r.reportedAnthropicCostMicrousd % 1000000n).toString().padStart(6, '0')}`,
      reportedCoordinatorMs: r.reportedCoordinatorMs,
      invariantViolations: 'unavailable',
    })),
  );
  console.info(
    'Planning time is reported coordinator time, not total optimizer time. Rows are separate snapshots; select run IDs for the comparison.',
  );
  const text = JSON.stringify(
    { metrics: metricRows, runs: runRows },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sync-benchmark-export.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
