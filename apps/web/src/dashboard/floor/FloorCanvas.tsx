import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { RunData } from '../../sync/contract';
import type { Lanes } from '../model/lanes';
import { sceneAt, type Scene } from '../model/scene';
import { FloorScene, type FloorInput, type Highlight } from './FloorScene';
import { floorTheme, FLOOR_PX, GRID } from './theme';

/** React host for one Phaser floor. Hands state over by ref, never re-creates the game. */
export function FloorCanvas({
  data,
  lanes,
  timeRef,
  highlight,
  label,
}: {
  /** The run to draw; null shows an empty board. */
  data: RunData | null;
  lanes: Lanes | undefined;
  /** Precise playback time, read every frame (not through React renders). */
  timeRef: { current: number };
  highlight: Highlight;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Phaser asks for the floor every frame at the precise playback time, so
  // walkers move smoothly even while React is busy. Same time → same scene.
  const cache = useRef<{
    t: number;
    data: RunData | null;
    scene: Scene | null;
  } | null>(null);
  const sceneNow = () => {
    if (!data || !lanes) return null;
    const t = timeRef.current;
    const c = cache.current;
    if (c && c.t === t && c.data === data) return c.scene;
    const scene = sceneAt(data, t, lanes);
    cache.current = { t, data, scene };
    return scene;
  };
  // Latest props live in a ref so Phaser reads them each frame without re-mounting.
  const input = useRef<FloorInput>({ scene: sceneNow, highlight, reducedMotion: false });
  input.current = { ...input.current, scene: sceneNow, highlight };

  // Board height follows the lanes (extra waiting rows push the front wall down).
  const height = lanes
    ? Math.max(
        FLOOR_PX.height,
        Math.round(GRID.offsetY * 2 + (lanes.wallY + 0.05) * GRID.unit),
      )
    : FLOOR_PX.height;
  const game = useRef<Phaser.Game | null>(null);
  useEffect(() => {
    game.current?.scale.setGameSize(FLOOR_PX.width, height);
  }, [height]);

  useEffect(() => {
    // Track the OS "reduce motion" setting for the decorative pulse.
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const sync = () => (input.current.reducedMotion = !!media?.matches);
    sync();
    media?.addEventListener('change', sync);
    // Created once per mount; destroyed on unmount.
    const instance = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.current!,
      width: FLOOR_PX.width,
      height,
      backgroundColor: floorTheme.page,
      scene: new FloorScene(() => input.current),
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      audio: { noAudio: true },
      // Nearest-neighbour scaling keeps the 16 px sprites crisp at 3×.
      pixelArt: true,
      banner: false,
    });
    game.current = instance;
    return () => {
      media?.removeEventListener('change', sync);
      instance.destroy(true);
      game.current = null;
    };
  }, []);

  return (
    <div
      ref={host}
      className="floor"
      role="img"
      aria-label={label}
      style={{ aspectRatio: `${FLOOR_PX.width} / ${height}` }}
    />
  );
}
