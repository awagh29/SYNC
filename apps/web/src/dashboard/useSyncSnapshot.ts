import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Policy, RunData } from '../sync/contract';
import type { SyncSource } from '../sync/source';
import { checkRun, normalizeRun } from './model/normalize';

/**
 * Subscribes to a SyncSource and returns normalized, checked runs.
 * The only place React touches the port: connect on mount, disconnect on
 * unmount, re-render when the snapshot object changes.
 */
export function useSyncSnapshot(source: SyncSource) {
  useEffect(() => {
    source.connect();
    return () => source.disconnect();
  }, [source]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return useMemo(() => {
    const runs: Partial<Record<Policy, RunData>> = {};
    // Contract problems are shown as a banner instead of crashing the screen.
    const issues: string[] = [];
    for (const policy of ['baseline', 'sync'] as Policy[]) {
      const data = snapshot.runs[policy];
      if (!data) continue;
      runs[policy] = normalizeRun(data);
      issues.push(...checkRun(runs[policy]).map((i) => `${policy}: ${i}`));
    }
    return {
      status: snapshot.status,
      benchmark: snapshot.benchmark,
      runs,
      issues,
    };
  }, [snapshot]);
}
