import { useEffect, useRef, useState } from 'react';
import type { SimSpeed } from '../sync/source';

/**
 * Local playback clock for replay. Seeking, play/pause and speed stay inside
 * the UI (INTERFACE.md §3). With live delivery the clock follows the newest
 * simulated time until the viewer scrubs away.
 */
export function usePlayback(end: number, liveTime?: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(4);
  const [following, setFollowing] = useState(true);
  /** Timestamp of the previous animation frame, for frame-rate-independent playback. */
  const last = useRef<number | null>(null);

  // Live: stick to the newest time unless the viewer scrubbed back.
  useEffect(() => {
    if (liveTime !== undefined && following) setT(liveTime);
  }, [liveTime, following]);

  // Replay: advance t by real elapsed time × speed each frame, stop at the end.
  useEffect(() => {
    if (!playing || liveTime !== undefined) return;
    let frame = 0;
    const step = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        const next = Math.min(end, prev + dt * speed);
        if (next >= end) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [playing, speed, end, liveTime]);

  return {
    t,
    playing,
    speed,
    following,
    setSpeed,
    /** Jump to a time (clamped). In live mode, seeking back stops following. */
    seek(next: number) {
      setT(Math.max(0, Math.min(end, next)));
      if (liveTime !== undefined) setFollowing(next >= liveTime);
    },
    /** Play/pause in replay (restarting from 0 at the end); "follow live" in live mode. */
    toggle() {
      if (liveTime !== undefined) return setFollowing(true);
      if (t >= end) setT(0);
      setPlaying((p) => !p);
    },
    pause() {
      setPlaying(false);
    },
  };
}
