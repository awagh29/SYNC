import type { DataOrigin, SourceStatus } from '../../sync/source';

/** Top bar (logo, run, data-source badge) and the Sample data banner. */

/** Badge tone and text: connection problems first, then where the data comes from. */
const badge = (origin: DataOrigin, status: SourceStatus) =>
  status.kind === 'disconnected'
    ? { tone: 'critical', text: 'Disconnected' }
    : status.kind === 'connecting'
      ? { tone: 'warning', text: 'Connecting' }
      : origin === 'sample'
        ? { tone: 'neutral', text: 'Sample data' }
        : { tone: 'good', text: 'Live' };

export function TopBar({
  run,
  origin,
  status,
}: {
  run: string;
  origin: DataOrigin;
  status: SourceStatus;
}) {
  const b = badge(origin, status);
  return (
    <header className="topbar">
      <strong className="logo">SYNC</strong>
      <span className="run">{run}</span>
      <span className={`source-badge tone-${b.tone}`}>
        <span className="dot" aria-hidden /> {b.text}
      </span>
    </header>
  );
}

/** Shown whenever the data is sample (mock) data, so numbers are never mistaken for results. */
export function SampleBanner() {
  return (
    <div className="sample-banner" role="note">
      <span className="tag">SAMPLE</span>
      All numbers on this screen are placeholders from the mock backend, not
      SYNC results.
    </div>
  );
}
