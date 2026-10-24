import type { Role } from '../../sync/contract';

/**
 * Floor colours and geometry. Colour values mirror the Dark mode of
 * design/tokens.json (Phaser needs numbers, not CSS variables); keep them in
 * sync with dashboard.css.
 */
export const floorTheme = {
  page: 0x0d0d0d, // bg/page
  surface: 0x1a1a19, // bg/surface (staff area)
  raised: 0x232321, // bg/raised (customer token fill)
  sunken: 0x131312, // bg/sunken (progress track)
  borderSubtle: 0x2c2c2a, // border/subtle (lanes, spot markers)
  borderStrong: 0x383835, // border/strong (wall, ropes)
  textPrimary: 0xf0efec, // text/primary
  textSecondary: 0xc3c2b7, // text/secondary
  textMuted: 0x898781, // text/muted
  onAccent: 0x0b0b0b, // text/on-accent (role icons on role colour)
  focus: 0x6da7ec, // border/focus (selected decision outline)
  good: 0x0ca30c, // status/good
  warning: 0xfab219, // status/warning
  critical: 0xd03b3b, // status/critical
  stationFill: 0x232321, // station/fill
  stationFillBusy: 0xf0efec, // station/fill-busy, drawn at 14% alpha
  stationStroke: 0x383835, // station/stroke
  stationStrokeClaimed: 0xc3c2b7, // station/stroke-claimed (dashed)
  progress: 0xf0efec, // station/progress
  role: {
    barista: 0xc98500,
    server: 0x9085e9,
    cleaner: 0x008300,
    cashier: 0xd55181,
  } satisfies Record<Role, number>,
};

/** 0xRRGGBB → "#rrggbb" for Phaser text styles. */
export const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Grid → pixel mapping shared with the Figma layout draft. */
export const GRID = {
  unit: 56,
  offsetX: 22,
  offsetY: 20,
  width: 12.6,
  height: 7.75,
};
/** Canvas size in pixels; Phaser scales it to fit the card. */
export const FLOOR_PX = {
  width: Math.round(GRID.offsetX * 2 + GRID.width * GRID.unit),
  height: Math.round(GRID.offsetY * 2 + GRID.height * GRID.unit),
};
/** Grid → canvas pixel. */
export const px = (gx: number) => GRID.offsetX + gx * GRID.unit;
export const py = (gy: number) => GRID.offsetY + gy * GRID.unit;
