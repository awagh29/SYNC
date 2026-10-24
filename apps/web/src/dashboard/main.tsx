import React from 'react';
import { createRoot } from 'react-dom/client';
import type { SyncSource } from '../sync/source';
import { MockSyncSource, type MockFaults } from '../sync/mock/MockSyncSource';
import { SpacetimeSyncSource } from '../sync/live/SpacetimeSyncSource';
import { Dashboard } from './Dashboard';
import './dashboard.css';

/**
 * Composition root: the only module that knows which adapter backs the
 * dashboard. ?source=mock|live (default VITE_SYNC_SOURCE, then mock),
 * ?delivery=replay|stream, ?seed=N, ?fault=shuffle,duplicate,disconnect,fail.
 */
function createSource(params: URLSearchParams): SyncSource {
  const kind =
    params.get('source') ?? import.meta.env.VITE_SYNC_SOURCE ?? 'mock';
  if (kind === 'live') return new SpacetimeSyncSource();
  const faults = new Set(
    (params.get('fault') ?? '').split(',').filter(Boolean),
  );
  const fault: MockFaults = {
    shuffle: faults.has('shuffle'),
    duplicate: faults.has('duplicate'),
    failConnect: faults.has('fail'),
    disconnectAt: faults.has('disconnect') ? 120 : undefined,
  };
  return new MockSyncSource({
    seed: Number(params.get('seed') ?? 5),
    delivery: params.get('delivery') === 'stream' ? 'stream' : 'replay',
    faults: fault,
    latencyMs: 300,
  });
}

const source = createSource(new URLSearchParams(location.search));
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dashboard source={source} />
  </React.StrictMode>,
);
