import { memo } from 'react';
import type {
  Agent,
  Decision,
  Policy,
  Resource,
  ResourceType,
} from '../../sync/contract';
import {
  decisionsAt,
  filterLabels,
  type DecisionFilter,
} from '../model/decisions';

/**
 * Decision history (Figma Dashboard › Decisions): header with the policy and
 * count so far, filter chips, a newest-first list up to the playhead, and the
 * selected decision's detail — reason, candidates with estimated finish bars,
 * and the admission result. Clicking the policy name switches Baseline ↔ SYNC.
 */
interface Props {
  policy: Policy;
  onPolicy(p: Policy): void;
  decisions: Decision[];
  agents: Agent[];
  resources: Resource[];
  t: number;
  filter: DecisionFilter;
  onFilter(f: DecisionFilter): void;
  selectedId?: string;
  onSelect(d: Decision): void;
}

/** Row titles per kind of work, as in the Figma rows ("c28 · Take order"). */
const WORK: Record<ResourceType, string> = {
  register: 'Take order',
  bar: 'Make drink',
  pickup: 'Hand to customer',
  clean: 'Clean up',
};

/** Simulated seconds with one decimal. */
const fmtT = (t: number) => `${t.toFixed(1)}s`;

/** Assign / Wait pill with a coloured dot. */
function KindChip({ kind }: { kind: Decision['kind'] }) {
  return (
    <span className={`chip kind-${kind}`}>
      <span className="dot" aria-hidden />
      {kind === 'wait' ? 'Wait' : 'Assign'}
    </span>
  );
}

/** Memoised: re-renders when a new decision is due, not on every playback tick. */
export const DecisionsPanel = memo(function DecisionsPanel(p: Props) {
  const { list, counts } = decisionsAt(p.decisions, p.t, p.filter);
  // Id → display lookups; fall back to the raw id.
  const agent = (id?: string) => p.agents.find((a) => a.id === id);
  const name = (id?: string) => agent(id)?.name ?? id ?? '—';
  const resource = (id?: string) => p.resources.find((r) => r.id === id);
  const slot = (id?: string) => resource(id)?.label ?? id ?? '—';
  const selected = p.decisions.find((d) => d.id === p.selectedId);
  const policyLabel = p.policy === 'sync' ? 'SYNC' : 'Baseline';
  const other: Policy = p.policy === 'sync' ? 'baseline' : 'sync';

  return (
    <aside className="decisions" aria-label="Decisions">
      <header>
        <h2>Decisions</h2>
        <button
          className="policy"
          title={`Show ${other === 'sync' ? 'SYNC' : 'Baseline'} decisions`}
          onClick={() => p.onPolicy(other)}
        >
          {policyLabel} · {counts.all} so far
        </button>
      </header>

      <div className="filters" role="group" aria-label="Filter decisions">
        {(Object.keys(filterLabels) as DecisionFilter[])
          .filter((f) => f === 'all' || counts[f] > 0 || p.filter === f)
          .map((f) => (
          <button
            key={f}
            className={`filter-${f}`}
            aria-pressed={p.filter === f}
            onClick={() => p.onFilter(f)}
          >
            <span className="dot" aria-hidden />
            {filterLabels[f]} <span className="count">{counts[f]}</span>
          </button>
        ))}
      </div>

      <ol className="history">
        {list.map((d) => {
          const who = agent(d.agentId);
          const work = WORK[resource(d.resourceId)?.type ?? 'register'];
          return (
            <li key={d.id}>
              <button
                aria-current={d.id === p.selectedId}
                onClick={() => p.onSelect(d)}
              >
                <span className="time">{fmtT(d.t)}</span>
                <span className="what">
                  <strong>
                    {d.jobId} · {work}
                  </strong>
                  <span className="who">
                    <span
                      className={`role-dot role-${who?.role}`}
                      aria-hidden
                    />
                    {d.kind === 'wait'
                      ? `for ${name(d.agentId)}`
                      : `${name(d.agentId)} @ ${slot(d.resourceId)}`}
                    {d.crossRole && <span className="helping"> · helping</span>}
                  </span>
                </span>
                <KindChip kind={d.kind} />
              </button>
            </li>
          );
        })}
        {!list.length && (
          <li className="empty">No decisions yet at this time.</li>
        )}
      </ol>

      {selected && (
        <section className="detail" aria-label="Selected decision">
          <header>
            <p className="eyebrow">Selected · {fmtT(selected.t)}</p>
            <KindChip kind={selected.kind} />
          </header>
          <h3>{selected.summary}</h3>
          {selected.detail && <p className="reason">{selected.detail}</p>}
          <ul className="candidates">
            {(() => {
              // Bars show time until each candidate would be done.
              const span = Math.max(
                0.1,
                ...selected.candidates.map((c) => c.estFinish - selected.t),
              );
              return selected.candidates.map((c) => (
                <li key={c.agentId} className={c.chosen ? 'chosen' : ''}>
                  <span className="who">
                    <span
                      className={`role-dot role-${agent(c.agentId)?.role}`}
                      aria-hidden
                    />
                    {name(c.agentId)}
                    {c.startIn !== undefined && (
                      <>
                        {' '}
                        (
                        {c.startIn > 0
                          ? `wait ${c.startIn.toFixed(1)} s`
                          : 'start now'}
                        )
                      </>
                    )}
                  </span>
                  <span className="track">
                    <span
                      className="fill"
                      style={{
                        width: `${((c.estFinish - selected.t) / span) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="when">
                    {c.chosen ? 'done' : 'would be'} {fmtT(c.estFinish)}
                  </span>
                </li>
              ));
            })()}
          </ul>
          {selected.admission && (
            <p className="admission">
              {slot(selected.admission.resourceId ?? selected.resourceId)}
              {selected.kind === 'wait' ? ' reserved' : ''} →{' '}
              <span className={`chip admission-${selected.admission.status}`}>
                <span className="dot" aria-hidden />
                {selected.admission.status === 'admitted'
                  ? 'Admitted'
                  : 'Rejected'}
              </span>{' '}
              <span className="muted">
                {selected.admission.status === 'rejected' &&
                selected.admission.reason
                  ? selected.admission.reason
                  : `claim ${slot(selected.admission.resourceId ?? selected.resourceId)} for ${name(selected.agentId)}`}
              </span>
            </p>
          )}
          {selected.followUpId && (
            <button
              className="link"
              onClick={() => {
                const next = p.decisions.find(
                  (d) => d.id === selected.followUpId,
                );
                if (next) p.onSelect(next);
              }}
            >
              Then: {selected.followUpId} →
            </button>
          )}
        </section>
      )}
    </aside>
  );
});
