import { memo } from 'react';
import { Pause, Play, SkipForward } from 'lucide-react';
import { simSpeeds, type SimSpeed } from '../../sync/source';

/**
 * Playback bar: play/pause, 5 s step, speed, and a scrubbable track with
 * arrival ticks, Wait ticks and the horizon T. A transparent range input
 * over the track handles dragging and keyboard access.
 */

/** A tick on the track. */
export interface Marker {
  t: number;
  kind: 'arrival' | 'wait';
}

interface Props {
  t: number;
  end: number;
  T: number;
  playing: boolean;
  live: boolean;
  /** False when time is driven elsewhere (live feeder): hides play, step and speed. */
  controls?: boolean;
  speed: SimSpeed;
  markers: Marker[];
  onToggle(): void;
  onStep(): void;
  onSeek(t: number): void;
  onSpeed(s: SimSpeed): void;
}

export function Timeline(p: Props) {
  const pct = (v: number) => `${(100 * v) / Math.max(1, p.end)}%`;
  return (
    <footer className="timeline" aria-label="Timeline">
      <div className="controls" hidden={p.controls === false}>
        <button
          onClick={p.onToggle}
          aria-label={p.live ? 'Follow live' : p.playing ? 'Pause' : 'Play'}
        >
          {p.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button onClick={p.onStep} aria-label="Step forward 5 seconds">
          <SkipForward size={16} />
        </button>
        <div className="segmented" role="group" aria-label="Speed">
          {simSpeeds.map((s) => (
            <button
              key={s}
              aria-pressed={p.speed === s}
              onClick={() => p.onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div className="track">
        <div className="rail" />
        <div className="played" style={{ width: pct(p.t) }} />
        <Markers markers={p.markers} end={p.end} />
        {p.T <= p.end && (
          <span className="horizon" style={{ left: pct(p.T) }} title="T" />
        )}
        <input
          type="range"
          aria-label="Simulated time"
          min={0}
          max={p.end}
          step={0.25}
          value={p.t}
          onChange={(e) => p.onSeek(Number(e.target.value))}
        />
      </div>
      <span className="time">
        t={Math.round(p.t)}s <small>/ T={p.T}s</small>
      </span>
    </footer>
  );
}

/**
 * Arrival / Wait ticks on the track. Hundreds of spans that only change with
 * the data, so they skip the playback-time re-renders.
 */
const Markers = memo(function Markers({
  markers,
  end,
}: {
  markers: Marker[];
  end: number;
}) {
  const pct = (v: number) => `${(100 * v) / Math.max(1, end)}%`;
  return (
    <>
      {markers.map((m, i) => (
        <span key={i} className={`marker ${m.kind}`} style={{ left: pct(m.t) }} />
      ))}
    </>
  );
});
