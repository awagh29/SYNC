import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { SimSpeed } from '../sync/source';

/**
 * Playback clock. One animation-frame loop advances the precise time in a
 * ref (`timeRef`, read every frame by the Phaser floors), while React state
 * `t` follows it only a few times per second for the panels. So the floors
 * animate smoothly however long a React render or a data rebuild takes.
 *
 * Replay: t moves by wall time × speed; seeking, play/pause and speed stay in
 * the UI (INTERFACE.md §3).
 *
 * Live: t follows the newest data, decoupled from when rows arrive:
 * - with a global clock (the runner's start time and ms per tick) t moves at
 *   the clock's pace, a delay behind it that adapts to how far the engine lags;
 * - without one, at the pace estimated from recent arrivals.
 * t may run up to LIVE_AHEAD ticks past the newest data (walks are time-based,
 * so people keep walking) and eases to a stop only if data stays late. It
 * never steps back while following.
 */

/** Live: target spot behind the newest data, in ticks. */
const LIVE_DELAY = 1;
/** Live: how far t may run past the newest data before it has stopped. */
const LIVE_AHEAD = 1;
/** Live: t slows down over this many ticks before LIVE_AHEAD (no hard stop). */
const EASE_ZONE = 1;
/** Live: further behind than this, t snaps forward (e.g. after a long pause). */
const LIVE_LAG = 6;
/** How hard t steers back toward its target spot (per tick of error). */
const STEER = 0.5;
/** Live pace before enough arrivals are observed (simulated s per s). */
const LIVE_RATE_GUESS = 1;
/** Arrivals the live pace is averaged over (no global clock). */
const LIVE_RATE_WINDOW = 8;
/** Global clock: delay grows / shrinks at most this fast (ticks per second). */
const DELAY_GROW = 0.5;
const DELAY_SHRINK = 0.1;
/** React state follows the precise time at most this often (ms). */
const STATE_EVERY_MS = 100;

export function usePlayback(
  end: number,
  liveTime?: number,
  /** Global clock of the live scenario, when its runner shares one. */
  clock?: { startedAt: number; tickMs: number },
) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(4);
  const [following, setFollowing] = useState(true);
  /** Precise playback time, updated every animation frame. */
  const timeRef = useRef(0);

  // Values the frame loop reads without restarting.
  const live = useRef({ latest: liveTime, following, clock, playing, speed, end });
  live.current = { latest: liveTime, following, clock, playing, speed, end };

  /** Live pace from recent arrivals (used without a global clock). */
  const rate = useRef(LIVE_RATE_GUESS);
  const arrivals = useRef<Array<{ time: number; at: number }>>([]);
  useEffect(() => {
    if (liveTime === undefined) return;
    const list = arrivals.current;
    if (!list.length || liveTime > list[list.length - 1].time)
      list.push({ time: liveTime, at: performance.now() });
    while (list.length > LIVE_RATE_WINDOW) list.shift();
    const first = list[0];
    const last = list[list.length - 1];
    // Only trust a span of at least a couple of seconds.
    if (last.at - first.at >= 2000)
      rate.current = ((last.time - first.time) * 1000) / (last.at - first.at);
  }, [liveTime]);

  /** Delay behind the global clock, in ticks; adapts to how far the engine lags. */
  const delay = useRef(LIVE_DELAY);
  useEffect(() => {
    delay.current = LIVE_DELAY;
  }, [clock?.startedAt]);

  // The one frame loop.
  useEffect(() => {
    let frame = 0;
    let before: number | null = null;
    let pushedAt = 0;
    /** Time last handed to React state. */
    let pushed = timeRef.current;
    const step = (now: number) => {
      const dt = before === null ? 0 : Math.min(0.25, (now - before) / 1000);
      before = now;
      const s = live.current;
      const prev = timeRef.current;
      let next = prev;
      if (s.latest !== undefined && s.following) {
        const latest = s.latest;
        let pace: number;
        let target: number;
        if (s.clock) {
          const global = (Date.now() - s.clock.startedAt) / s.clock.tickMs;
          // Grow the delay (gently) while the engine lags behind the clock.
          const needed = Math.max(LIVE_DELAY, global - latest + LIVE_DELAY);
          const d = delay.current;
          delay.current =
            d + Math.max(-DELAY_SHRINK * dt, Math.min(DELAY_GROW * dt, needed - d));
          pace = 1000 / s.clock.tickMs;
          target = global - delay.current;
        } else {
          pace = rate.current;
          target = latest - LIVE_DELAY;
        }
        // Steer toward the target spot, then ease off near the data's edge.
        const cap = latest + LIVE_AHEAD;
        const steer = Math.max(0, Math.min(2, 1 + (target - prev) * STEER));
        const ease = Math.max(0, Math.min(1, (cap - prev) / EASE_ZONE));
        next = Math.min(cap, prev + dt * pace * steer * ease);
        // Far behind (just started following): catch up at once.
        next = Math.max(next, latest - LIVE_LAG, 0);
      } else if (s.latest === undefined && s.playing) {
        next = Math.min(s.end, prev + dt * s.speed);
        if (next >= s.end) setPlaying(false);
      }
      timeRef.current = next;
      // React follows a few times per second (also catches seeks and the end).
      if (next !== pushed && now - pushedAt >= STATE_EVERY_MS) {
        pushedAt = now;
        pushed = next;
        setT(next);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // The loop reads everything through refs; it runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jump = (next: number) => {
    timeRef.current = next;
    setT(next);
  };

  return {
    t,
    /** Precise time, updated every frame (floors read it directly). */
    timeRef: timeRef as MutableRefObject<number>,
    playing,
    speed,
    following,
    setSpeed,
    /** Jump to a time (clamped). In live mode, seeking back stops following. */
    seek(next: number) {
      jump(Math.max(0, Math.min(end, next)));
      if (liveTime !== undefined) setFollowing(next >= liveTime);
    },
    /** Play/pause in replay (restarting from 0 at the end); "follow live" in live mode. */
    toggle() {
      if (liveTime !== undefined) return setFollowing(true);
      if (timeRef.current >= end) jump(0);
      setPlaying((p) => !p);
    },
    pause() {
      setPlaying(false);
    },
  };
}
