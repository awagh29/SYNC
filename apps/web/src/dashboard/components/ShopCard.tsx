import type { Policy } from '../../sync/contract';
import type { Scene } from '../model/scene';
import { FloorCanvas } from '../floor/FloorCanvas';
import type { Highlight } from '../floor/FloorScene';

const TITLE: Record<Policy, string> = { baseline: 'Baseline', sync: 'SYNC' };

/**
 * One policy's shop: header with Done / Late at the current time, and the
 * Phaser floor. Baseline and SYNC cards render the same component side by side.
 */
export function ShopCard({
  policy,
  scene,
  highlight,
}: {
  policy: Policy;
  scene: Scene | null;
  highlight: Highlight;
}) {
  return (
    <section
      className={`shop-card series-${policy}`}
      aria-label={`${TITLE[policy]} shop floor`}
    >
      <header>
        <span className="swatch" aria-hidden />
        <h2>{TITLE[policy]}</h2>
        <dl>
          <div>
            <dt>Done</dt>
            <dd>{scene?.done ?? '—'}</dd>
          </div>
          <div className={scene?.late ? 'bad' : ''}>
            <dt>Late</dt>
            <dd>{scene?.late ?? '—'}</dd>
          </div>
        </dl>
      </header>
      <FloorCanvas
        scene={scene}
        highlight={highlight}
        label={`${TITLE[policy]} floor at ${Math.round(scene?.t ?? 0)} seconds`}
      />
    </section>
  );
}
