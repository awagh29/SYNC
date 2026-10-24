import type { SyncSnapshot, SyncSource } from '../source';

/**
 * Real-backend adapter slot. Replaces MockSyncSource without dashboard changes.
 *
 * To implement: subscribe to the SpacetimeDB tables through @sync/bindings and
 * map rows onto the contract in ../contract.ts. The current module tables
 * (run, task, worker, resource, decision, executionEvent) do not yet carry
 * what the contract needs:
 *   - resource.type and grid coordinates, zones
 *   - worker.role / primaryTypes
 *   - jobs (customers) with arrival, deadline and task ids
 *   - decision kind, crossRole, summary, candidates, admission
 *   - agent.move / agent.wait events
 *   - score and benchmark_summary rows
 * Until they do, this adapter reports itself as disconnected instead of
 * inventing values.
 */
export class SpacetimeSyncSource implements SyncSource {
  readonly origin = 'live' as const;
  readonly delivery = 'stream' as const;
  private snapshot: SyncSnapshot = {
    status: {
      kind: 'disconnected',
      reason:
        'Live adapter not implemented: backend tables do not yet provide the dashboard contract (see INTERFACE.md).',
    },
    runs: {},
  };

  connect() {}
  disconnect() {}
  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
}
