import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Decision, Policy } from '../sync/contract';
import type { RunnerClock, ScenarioRunner } from '../sync/runner';
import type { SyncSource } from '../sync/source';
import { DecisionsPanel } from './components/DecisionsPanel';
import { ScenarioPicker } from './components/ScenarioPicker';
import { Scorecard } from './components/Scorecard';
import { ShopCard } from './components/ShopCard';
import { Timeline, type Marker } from './components/Timeline';
import {
  LiveBanner,
  SampleBanner,
  TopBar,
  type DashboardMode,
} from './components/TopBar';
import type { DecisionFilter } from './model/decisions';
import { buildLanes } from './model/lanes';
import { scoreAt } from './model/scoreAt';
import { peakLine, peakWaiting, sceneAt } from './model/scene';
import { usePlayback } from './usePlayback';
import { useSyncSnapshot } from './useSyncSnapshot';

/** Shared empty list, so memoised panels see the same array when there is no run. */
const NONE: never[] = [];

/** The one-screen dashboard. Knows only the SyncSource port, never an adapter. */
export function Dashboard({
  source,
  runner,
  mode,
  onMode,
}: {
  source: SyncSource;
  /** Starts new scenarios (Live mode on the dev server); absent = no start buttons. */
  runner?: ScenarioRunner;
  /** Live / Sample toggle; the composition root swaps the source. */
  mode?: DashboardMode;
  onMode?(mode: DashboardMode): void;
}) {
  const {
    status,
    runs,
    benchmark,
    issues,
    note,
    emptyHint,
    scenarios,
    scenarioId,
    viewer,
  } = useSyncSnapshot(source);
  const { baseline, sync } = runs;
  const end = Math.max(baseline?.run.simTime ?? 0, sync?.run.simTime ?? 0);
  // Live = stream delivery that is still running; the playhead then follows it.
  const live =
    source.delivery === 'stream' &&
    [baseline, sync].some((r) => r?.run.status === 'running');
  // Time moves outside playback (the database) while a live run is running;
  // a finished scenario can be replayed with the normal controls.
  const externalClock = !!source.clockNote && live;
  // Global clock of the scenario the runner is playing: live time is read
  // from it (shared by everyone) instead of being guessed from arrivals.
  const [clock, setClock] = useState<RunnerClock>();
  useEffect(() => {
    if (!live || !runner?.clock) return setClock(undefined);
    let stop = false;
    const read = () =>
      runner.clock!().then(
        (c) => !stop && setClock(c),
        () => !stop && setClock(undefined),
      );
    void read();
    const timer = setInterval(read, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [live, runner]);
  const playback = usePlayback(
    end,
    live ? end : undefined,
    clock && clock.scenario === scenarioId ? clock : undefined,
  );
  const [policy, setPolicy] = useState<Policy>('sync');
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [selected, setSelected] = useState<Decision>();

  // Another scenario: forget the selected decision. A replay starts from 0;
  // in Live a finished scenario opens on its final tick, and a running one
  // keeps following the newest tick (seeking would stop following).
  useEffect(() => {
    setSelected(undefined);
    if (source.delivery === 'replay') playback.seek(0);
    else if (!live) playback.seek(end);
    // Reset only on scenario change; playback ticks must not reset the selection.
  }, [scenarioId]);

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
    // Long lines add queue rows in pairs (same rule for both cards).
    const line = Math.max(
      baseline ? peakLine(baseline) : 0,
      sync ? peakLine(sync) : 0,
    );
    return buildLanes(layout, capacity, line);
  }, [baseline, sync]);
  // Both floors are drawn at the same time t.
  const scenes = {
    baseline: baseline ? sceneAt(baseline, t, lanes) : null,
    sync: sync ? sceneAt(sync, t, lanes) : null,
  };
  // Scores move once per simulated second; memo keeps the card still in between.
  const second = Math.floor(t);
  const syncScore = useMemo(() => sync && scoreAt(sync, second), [sync, second]);
  const baselineScore = useMemo(
    () => baseline && scoreAt(baseline, second),
    [baseline, second],
  );
  const panelRun = runs[policy];
  // The decision list only changes when the next decision is reached, so it
  // gets the time of the newest decision so far (not every playback tick).
  const decisionT = useMemo(() => {
    const ds = panelRun?.decisions ?? [];
    let lo = 0,
      hi = ds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo ? ds[lo - 1].t : -1;
  }, [panelRun, t]);
  const onPolicy = useCallback((p: Policy) => {
    setPolicy(p);
    setSelected(undefined);
  }, []);
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
      <TopBar
        run={
          scenarios?.length || runner ? (
            <ScenarioPicker
              options={
                runner
                  ? // Every fixed scenario, with its state in the database
                    // (never run = listed but not viewable yet).
                    runner.scenarios.map((r) => {
                      const db = scenarios?.find((s) => s.id === r.id);
                      return { ...r, meta: db?.meta ?? 'not run', disabled: !db };
                    })
                  : (scenarios ?? [])
              }
              value={scenarioId}
              showMeta={source.origin === 'live' && source.delivery === 'stream'}
              onSelect={(id) => source.selectScenario?.(id)}
              onRun={
                runner &&
                (async (id) => {
                  if (!viewer) throw new Error('Not connected to the database yet.');
                  // The source follows the scenario once its new runs appear.
                  await runner.start(id, viewer);
                })
              }
              onStop={runner?.stop && (() => runner.stop!())}
              footnote={
                runner
                  ? 'Run plays Baseline + SYNC on the engine via the local feeder and follows it. Same customers (seed 5); each scenario changes one lever.'
                  : undefined
              }
            />
          ) : (
            runLabel
          )
        }
        origin={source.origin}
        status={status}
        label={source.label}
        clock={externalClock ? source.clockNote : undefined}
        onStop={runner?.stop && (() => void runner.stop!())}
        mode={mode}
        onMode={onMode}
      />
      {source.origin === 'sample' && <SampleBanner note={note} />}
      {source.origin === 'live' && note && (
        // Engine data: LIVE while something drives it, SAVED when replaying a finished pair.
        <LiveBanner note={note} tag={externalClock ? 'LIVE' : 'SAVED'} />
      )}
      {status.kind === 'disconnected' && (
        <div className="state-banner critical" role="alert">
          {status.reason}
          {status.action && (
            <button className="primary" onClick={status.action.run}>
              {status.action.label}
            </button>
          )}
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
        <main className="state-empty">
          {emptyHint ? (
            <div className="empty-hint">
              <p>{emptyHint.message}</p>
              {emptyHint.command && <code>{emptyHint.command}</code>}
            </div>
          ) : (
            'No runs yet.'
          )}
        </main>
      ) : (
        <main className="body">
          <div className="left">
            <div className="shops">
              <ShopCard
                policy="baseline"
                scene={scenes.baseline}
                data={baseline ?? null}
                lanes={lanes}
                timeRef={playback.timeRef}
                highlight={highlight('baseline')}
              />
              <ShopCard
                policy="sync"
                scene={scenes.sync}
                data={sync ?? null}
                lanes={lanes}
                timeRef={playback.timeRef}
                highlight={highlight('sync')}
              />
            </div>
            <Scorecard
              sync={syncScore}
              baseline={baselineScore}
              benchmark={benchmark}
              seedLine={source.origin === 'sample'}
            />
          </div>
          <DecisionsPanel
            policy={policy}
            onPolicy={onPolicy}
            decisions={panelRun?.decisions ?? NONE}
            agents={panelRun?.layout.agents ?? NONE}
            resources={panelRun?.layout.resources ?? NONE}
            t={decisionT}
            filter={filter}
            onFilter={setFilter}
            selectedId={selected?.id}
            // Selecting a decision only opens its detail; time keeps going
            // (no jump back, so the list does not shrink).
            onSelect={setSelected}
          />
        </main>
      )}
      <Timeline
        t={t}
        end={end}
        T={sync?.run.objective.T ?? baseline?.run.objective.T ?? 0}
        playing={live ? playback.following : playback.playing}
        live={live}
        controls={!externalClock}
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
