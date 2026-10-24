import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Scene } from '../model/scene';
import { FloorScene, type FloorInput, type Highlight } from './FloorScene';
import { floorTheme, FLOOR_PX, GRID } from './theme';

/** React host for one Phaser floor. Hands state over by ref, never re-creates the game. */
export function FloorCanvas({
  scene,
  highlight,
  label,
}: {
  scene: Scene | null;
  highlight: Highlight;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Latest props live in a ref so Phaser reads them each frame without re-mounting.
  const input = useRef<FloorInput>({ scene, highlight, reducedMotion: false });
  input.current = { ...input.current, scene, highlight };

  // Board height follows the lanes (extra waiting rows push the front wall down).
  const height = scene
    ? Math.max(
        FLOOR_PX.height,
        Math.round(GRID.offsetY * 2 + (scene.lanes.wallY + 0.13) * GRID.unit),
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
