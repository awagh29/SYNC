import { useMemo, useState } from 'react';
import type { Decision, Policy } from '../sync/contract';
import type { SyncSource } from '../sync/source';
import { DecisionsPanel } from './components/DecisionsPanel';
import { Scorecard } from './components/Scorecard';
import { ShopCard } from './components/ShopCard';
import { Timeline, type Marker } from './components/Timeline';
import { SampleBanner, TopBar } from './components/TopBar';
import type { DecisionFilter } from './model/decisions';
import { buildLanes } from './model/lanes';
import { scoreAt } from './model/scoreAt';
import { peakWaiting, sceneAt } from './model/scene';
import { usePlayback } from './usePlayback';
import { useSyncSnapshot } from './useSyncSnapshot';

/** The one-screen dashboard. Knows only the SyncSource port, never an adapter. */
export function Dashboard({ source }: { source: SyncSource }) {
  const { status, runs, benchmark, issues } = useSyncSnapshot(source);
  const { baseline, sync } = runs;
  const end = Math.max(baseline?.run.simTime ?? 0, sync?.run.simTime ?? 0);
  // Live = stream delivery that is still running; the playhead then follows it.
  const live =
    source.delivery === 'stream' &&
    [baseline, sync].some((r) => r?.run.status === 'running');
  const playback = usePlayback(end, live ? end : undefined);
  const [policy, setPolicy] = useState<Policy>('sync');
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [selected, setSelected] = useState<Decision>();

  const t = playback.t;
  // Both floors share one lane network sized for the busier run, so the two
  // cards keep the same board height (>10 waiting widens, >12 adds rows).
  const lanes = useMemo(() => {
    const layout = (sync ?? baseline)?.layout;
    if (!layout) return undefined;
    const capacity = Math.max(
      baseline ? peakWaiting(baseline) : 0,
      sync ? peakWaiting(sync) : 0,
      10,
    );
    return buildLanes(layout, capacity);
  }, [baseline, sync]);
  // Both floors are drawn at the same time t.
  const scenes = {
    baseline: baseline ? sceneAt(baseline, t, lanes) : null,
    sync: sync ? sceneAt(sync, t, lanes) : null,
  };
  const panelRun = runs[policy];
  // Outline the selected decision's agent, slot and customer on the panel's policy floor only.
  const highlight = (p: Policy) =>
    selected && p === policy
      ? {
          agentId: selected.agentId,
          resourceId: selected.resourceId,
          jobId: selected.jobId,
        }
      : {};
  // Timeline ticks: customer arrivals and the panel policy's Wait decisions.
  const markers = useMemo<Marker[]>(
    () => [
      ...(sync?.jobs ?? []).map((j) => ({
        t: j.arrival,
        kind: 'arrival' as const,
      })),
      ...(panelRun?.decisions ?? [])
        .filter((d) => d.kind === 'wait')
        .map((d) => ({ t: d.t, kind: 'wait' as const })),
    ],
    [sync, panelRun],
  );
  const runLabel = sync
    ? `${sync.run.scenario} · seed ${sync.run.seed}`
    : 'No run';

  return (
    <div className="dashboard">
      <TopBar run={runLabel} origin={source.origin} status={status} />
      {source.origin === 'sample' && <SampleBanner />}
      {status.kind === 'disconnected' && (
        <div className="state-banner critical" role="alert">
          {status.reason}
          <button onClick={() => source.connect()}>Retry</button>
        </div>
      )}
      {issues.length > 0 && (
        <details className="state-banner warning" role="alert">
          <summary>
            Data does not match the dashboard contract ({issues.length})
          </summary>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </details>
      )}
      {status.kind === 'connecting' ? (
        <main className="state-empty" aria-busy="true">
          Connecting to SYNC…
        </main>
      ) : !baseline && !sync ? (
        <main className="state-empty">No runs yet.</main>
      ) : (
        <main className="body">
          <div className="left">
            <div className="shops">
              <ShopCard
                policy="baseline"
                scene={scenes.baseline}
                highlight={highlight('baseline')}
              />
              <ShopCard
                policy="sync"
                scene={scenes.sync}
                highlight={highlight('sync')}
              />
            </div>
            <Scorecard
              sync={sync && scoreAt(sync, t)}
              baseline={baseline && scoreAt(baseline, t)}
              benchmark={benchmark}
            />
          </div>
          <DecisionsPanel
            policy={policy}
            onPolicy={(p) => {
              setPolicy(p);
              setSelected(undefined);
            }}
            decisions={panelRun?.decisions ?? []}
            agents={panelRun?.layout.agents ?? []}
            resources={panelRun?.layout.resources ?? []}
            t={t}
            filter={filter}
            onFilter={setFilter}
            selectedId={selected?.id}
            // Selecting a decision pauses playback and jumps to when it was made.
            onSelect={(d) => {
              setSelected(d);
              playback.pause();
              playback.seek(d.t);
            }}
          />
        </main>
      )}
      <Timeline
        t={t}
        end={end}
        T={sync?.run.objective.T ?? baseline?.run.objective.T ?? 0}
        playing={live ? playback.following : playback.playing}
        live={live}
        speed={playback.speed}
        markers={markers}
        onToggle={playback.toggle}
        onStep={() => {
          playback.pause();
          playback.seek(t + 5);
        }}
        onSeek={playback.seek}
        // Speed is local for replay; for live it is also sent to the source.
        onSpeed={(s) => {
          playback.setSpeed(s);
          void source.commands?.setSpeed(s);
        }}
      />
    </div>
  );
}
