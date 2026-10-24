import Phaser from 'phaser';
import type {
  AgentView,
  CustomerView,
  Facing,
  Scene as FloorState,
  SlotView,
} from '../model/scene';
import {
  FURNITURE,
  guestFrame,
  SHEETS,
  SLOT_FRAME,
  SCALE,
  staffFrame,
  TILE_PX,
  URBAN,
  WALK_CYCLE,
} from './sprites';
import { css, floorTheme as c, GRID, px, py } from './theme';

/** Ids to outline because they belong to the selected decision. */
export interface Highlight {
  agentId?: string;
  resourceId?: string;
  jobId?: string;
}
/** Everything the scene reads each frame (supplied by FloorCanvas through a ref). */
export interface FloorInput {
  /**
   * The floor at the current playback time. Called every frame, so people
   * move smoothly even while React is busy re-rendering the panels.
   */
  scene: () => FloorState | null;
  highlight: Highlight;
  reducedMotion: boolean;
}

const HALF = TILE_PX / 2;
/** Catch-up speed on screen, grid units per wall second (normal walks are ~2). */
const GLIDE_SPEED = 10;
/** Feet sit this far below a person's lane position (sprites are drawn bottom-anchored). */
const FEET = 14;
/** Wood planks for the staff area (the Kenney packs have no wooden floor tile). */
const WOOD = { base: 0x9a6b45, gap: 0x6e4a2f, light: 0xad7c53, plank: 12 };
const WALL = { fill: 0x3b2f2a, skirting: 0x5a463d };
/** Short slot names on the furniture plates ("Register 1" → "Reg 1"). */
const SHORT: Record<string, string> = {
  register: 'Reg',
  pickup: 'Pick',
  bar: 'Bar',
  clean: 'Clean',
};
const FONT = 'Inter, system-ui, sans-serif';

/**
 * Pixel-art shop floor (Figma "Pixel floor · draft v1"). Draws whatever
 * FloorInput says with Kenney CC0 sprites: tiled floors, furniture for slots,
 * 4-direction characters with a walk cycle, and small overlays (tags,
 * progress, bubbles). Positions, states and facing come from sceneAt; the
 * walk cycle runs on scene time, so pausing and scrubbing stay exact. The only
 * real-time effect is decorative steam.
 */
export class FloorScene extends Phaser.Scene {
  /** Static floor (built once from the zones, slots and lanes). */
  private built = false;
  /** Per-frame overlays: wall, progress, outlines, tag plates, bubbles. */
  private g!: Phaser.GameObjects.Graphics;
  /** Pools reused across frames, keyed by id. */
  private sprites = new Map<string, Phaser.GameObjects.Sprite>();
  private texts = new Map<string, Phaser.GameObjects.Text>();
  /** Keys drawn this frame; the rest are hidden. */
  private used = new Set<string>();

  constructor(private read: () => FloorInput) {
    super('floor');
  }

  /** Loads the three sprite sheets as 16 × 16 frames. */
  preload() {
    for (const sheet of Object.values(SHEETS))
      this.load.spritesheet(sheet.key, sheet.url, {
        frameWidth: 16,
        frameHeight: 16,
        spacing: sheet.spacing,
      });
  }

  create() {
    this.g = this.add.graphics().setDepth(900);
  }

  /** Floor, walls, counters and decor: drawn once, they never change during a run. */
  /** IN / OUT doors and signs; moved with the front wall each frame. */
  private doors?: Phaser.GameObjects.Container;

  private buildStatic(scene: FloorState) {
    this.built = true;
    const W = GRID.offsetX * 2 + GRID.width * GRID.unit;
    const { lanes } = scene;
    // Customer area: stone tiles everywhere first.
    this.add
      // Taller than the canvas so a board that grows later (extra waiting rows) stays tiled.
      .tileSprite(0, 0, W, 2000, SHEETS.urban.key, URBAN.stone)
      .setOrigin(0)
      .setTileScale(SCALE)
      .setDepth(0);
    const staff = scene.zones.find((z) => z.kind === 'staff');
    const back = scene.slots.filter(
      (s) => s.type === 'bar' || s.type === 'clean',
    );
    const front = scene.slots.filter(
      (s) => s.type === 'register' || s.type === 'pickup',
    );
    if (staff) {
      const x = px(staff.x),
        y = py(staff.y);
      const w = staff.w * GRID.unit,
        h = staff.h * GRID.unit;
      const wallBottom = back.length ? py(back[0].y) - HALF : y + TILE_PX;
      const floor = this.add.graphics().setDepth(1);
      // Wood planks with staggered seams.
      floor
        .fillStyle(WOOD.base, 1)
        .fillRect(x, wallBottom, w, y + h - wallBottom);
      for (let top = wallBottom, i = 0; top < y + h; top += WOOD.plank, i++) {
        floor.fillStyle(WOOD.light, 1).fillRect(x, top, w, 2);
        floor.fillStyle(WOOD.gap, 1).fillRect(x, top + WOOD.plank - 2, w, 2);
        for (let sx = x + (i % 3) * 32; sx < x + w; sx += 96)
          floor.fillRect(sx, top, 2, WOOD.plank - 2);
      }
      // Back wall with skirting; a plant in each corner (Figma: columns 0 and 16).
      floor.fillStyle(WALL.fill, 1).fillRect(x, y, w, wallBottom - y);
      floor.fillStyle(WALL.skirting, 1).fillRect(x, wallBottom - 6, w, 6);
      this.tile(FURNITURE.plantA, x + HALF, wallBottom + HALF, 2);
      this.tile(FURNITURE.plantB, x + w - HALF, wallBottom + HALF, 2);
      // Front counter spans the staff area minus one tile each side (columns 1–15).
      if (front.length)
        this.counterRun(
          FURNITURE.counter,
          x + TILE_PX + HALF,
          x + w - TILE_PX - HALF,
          py(front[0].y),
        );
    }
    // Back counters: the bar run (one tile left of Bar 1 to three right of the last
    // bar, columns 4–10) and a short run around the sink (columns 13–15).
    const bars = back.filter((s) => s.type === 'bar');
    if (bars.length) {
      const xs = bars.map((s) => px(s.x));
      this.counterRun(
        FURNITURE.counterBack,
        Math.min(...xs) - TILE_PX,
        Math.max(...xs) + 3 * TILE_PX,
        py(bars[0].y),
      );
    }
    for (const sink of back.filter((s) => s.type === 'clean'))
      this.counterRun(
        FURNITURE.counterBack,
        px(sink.x) - TILE_PX,
        px(sink.x) + TILE_PX,
        py(sink.y),
      );
    // Doors in the front wall: open glass doors with IN / OUT signs. They sit
    // in one container that follows the wall when the board grows (update).
    this.doors = this.add.container(0, 0).setDepth(4);
    const signs = this.add.graphics();
    this.doors.add(signs);
    for (const [span, label] of [
      [lanes.doorIn, 'IN'],
      [lanes.doorOut, 'OUT'],
    ] as const) {
      const dx = px((span[0] + span[1]) / 2);
      this.doors.add(
        this.add.image(dx, 0, SHEETS.urban.key, URBAN.doorOpen).setScale(SCALE),
      );
      const w = label.length * 7 + 10;
      signs.fillStyle(c.good, 1).fillRect(dx - w / 2, -HALF - 14, w, 12);
      this.doors.add(
        this.add
          .text(dx, -HALF - 8, label, {
            fontFamily: FONT,
            fontSize: '8px',
            fontStyle: '700',
            color: css(c.onAccent),
            resolution: 2,
          })
          .setOrigin(0.5),
      );
    }
  }

  /** A row of counter tiles from x1 to x2 (inclusive) at height y. */
  private counterRun(frame: number, x1: number, x2: number, y: number) {
    for (let x = x1; x <= x2 + 0.5; x += TILE_PX) this.tile(frame, x, y, 2);
  }

  /** Adds a static 3× furniture tile centred at (x, y). */
  private tile(frame: number, x: number, y: number, depth: number) {
    return this.add
      .image(x, y, SHEETS.indoors.key, frame)
      .setScale(SCALE)
      .setDepth(depth);
  }

  /** Draws (or reuses) a pooled sprite identified by key. */
  private sprite(
    key: string,
    texture: string,
    frame: number,
    x: number,
    y: number,
    depth: number,
    originY = 0.5,
  ) {
    let s = this.sprites.get(key);
    if (!s) {
      s = this.add.sprite(0, 0, texture, frame).setScale(SCALE);
      this.sprites.set(key, s);
    }
    s.setTexture(texture, frame)
      .setOrigin(0.5, originY)
      .setPosition(x, y)
      .setDepth(depth)
      .setAlpha(1)
      .setVisible(true);
    this.used.add(key);
    return s;
  }

  /** Draws (or reuses) a text label identified by key. */
  private text(
    key: string,
    value: string,
    x: number,
    y: number,
    size: number,
    color: number,
    depth = 950,
  ) {
    let t = this.texts.get(key);
    if (!t) {
      t = this.add.text(0, 0, '', {
        fontFamily: FONT,
        fontSize: `${size}px`,
        fontStyle: '600',
        resolution: 2,
      });
      this.texts.set(key, t);
    }
    if (t.text !== value) t.setText(value);
    t.setOrigin(0.5, 0.5)
      .setPosition(x, y)
      .setColor(css(color))
      .setDepth(depth)
      .setVisible(true);
    this.used.add(key);
    return t;
  }

  /** Phaser calls this every frame. */
  update(time: number, delta: number) {
    const input = this.read();
    const { highlight, reducedMotion } = input;
    const computed = input.scene();
    const scene = computed && this.glide(computed, delta / 1000);
    this.g.clear();
    this.used.clear();
    if (!scene) return this.hideUnused();
    if (!this.built) this.buildStatic(scene);
    // Doors stay in the front wall even after extra rows moved it down.
    this.doors?.setY(py(scene.lanes.wallY) - HALF);
    this.drawWallAndRope(scene);
    for (const s of scene.slots)
      this.drawSlot(s, highlight.resourceId === s.id, time, reducedMotion);
    for (const a of scene.agents)
      this.drawAgent(a, highlight.agentId === a.id, scene.t);
    for (const cu of scene.customers)
      this.drawCustomer(cu, highlight.jobId === cu.id, scene.t);
    this.hideUnused();
  }

  /** Where each person is drawn (grid units); moves toward the computed spot. */
  private shown = new Map<string, { x: number; y: number }>();

  /**
   * Nobody ever teleports. Positions come from the playback time, which can
   * jump (live start, catching up, a scenario switch) or be corrected by late
   * rows. Each person is drawn where they were last frame and moves toward
   * their computed spot: normal walks (well under GLIDE_SPEED) are followed
   * exactly; larger gaps are covered quickly at GLIDE_SPEED. Customers who
   * appear after the first frame start at the entrance and hurry in.
   */
  private glide(scene: FloorState, dt: number): FloorState {
    const first = this.shown.size === 0;
    const door = { x: scene.lanes.door.x, y: scene.lanes.door.y - 0.3 };
    const step = GLIDE_SPEED * Math.min(dt, 0.25);
    const seen = new Set<string>();
    const move = <T extends { x: number; y: number; facing: Facing }>(
      key: string,
      p: T,
      spawn?: { x: number; y: number },
    ): T => {
      seen.add(key);
      const from = this.shown.get(key) ?? (first || !spawn ? p : spawn);
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step) {
        this.shown.set(key, { x: p.x, y: p.y });
        return p;
      }
      // Hurry toward the spot, facing the way we go.
      const k = step / dist;
      const at = { x: from.x + dx * k, y: from.y + dy * k };
      this.shown.set(key, at);
      const facing: Facing =
        Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
      // Customers show the walk cycle while hurrying; staff have no walk flag.
      return { ...p, ...at, facing, ...('walking' in p ? { walking: true } : {}) };
    };
    const agents = scene.agents.map((a) => move(`a:${a.id}`, a));
    const customers = scene.customers.map((cu) => move(`c:${cu.id}`, cu, door));
    // Forget people who left, so a returning id starts fresh at the door.
    for (const key of this.shown.keys()) if (!seen.has(key)) this.shown.delete(key);
    return { ...scene, agents, customers };
  }

  /** Front wall with door gaps; queue rope only while the line is folded. */
  private drawWallAndRope(scene: FloorState) {
    const { lanes } = scene;
    const wall = py(lanes.wallY);
    const right = GRID.offsetX * 2 + GRID.width * GRID.unit;
    this.g.fillStyle(c.borderStrong, 1);
    this.g.fillRect(0, wall - 2, px(lanes.doorIn[0]), 4);
    this.g.fillRect(
      px(lanes.doorIn[1]),
      wall - 2,
      px(lanes.doorOut[0]) - px(lanes.doorIn[1]),
      4,
    );
    this.g.fillRect(
      px(lanes.doorOut[1]),
      wall - 2,
      right - px(lanes.doorOut[1]),
      4,
    );
    // A rope appears once the line reaches the row below it.
    lanes.ropes.forEach((rope, r) => {
      if (scene.lineLength <= rope.after) return;
      const from = px(rope.from.x),
        to = px(rope.to.x);
      const count = Math.max(2, Math.round((to - from) / TILE_PX) + 1);
      for (let i = 0; i < count; i++) {
        const frame =
          i === 0
            ? URBAN.ropeLeft
            : i === count - 1
              ? URBAN.ropeRight
              : URBAN.ropeMid;
        this.sprite(
          `rope:${r}:${i}`,
          SHEETS.urban.key,
          frame,
          from + (i * (to - from)) / (count - 1),
          py(rope.from.y),
          3 + rope.from.y,
        );
      }
    });
  }

  /** A slot as furniture: name plate, progress bar when busy, dashed outline when claimed, steam. */
  private drawSlot(
    s: SlotView,
    lit: boolean,
    time: number,
    reducedMotion: boolean,
  ) {
    const x = px(s.x),
      y = py(s.y);
    const g = this.g;
    this.sprite(
      `slot:${s.id}`,
      SHEETS.indoors.key,
      SLOT_FRAME[s.type],
      x,
      y,
      3 + s.y,
    );
    // Name plate: bottom edge on the front counter; top edge on the back row,
    // where staff tags sit right below the machines (as in the Figma draft).
    const backRow = s.type === 'bar' || s.type === 'clean';
    const plateTop = backRow ? y - HALF + 2 : y + HALF - 13;
    g.fillStyle(c.page, 0.7).fillRect(x - HALF + 3, plateTop, TILE_PX - 6, 11);
    this.text(
      `plate:${s.id}`,
      s.label.replace(/^\w+/, (w) => SHORT[s.type] ?? w),
      x,
      plateTop + 5.5,
      8,
      c.textPrimary,
    );
    if (s.state === 'busy') {
      g.fillStyle(c.sunken, 1).fillRect(
        x - HALF + 6,
        y - HALF - 7,
        TILE_PX - 12,
        5,
      );
      g.fillStyle(c.progress, 1).fillRect(
        x - HALF + 6,
        y - HALF - 7,
        (TILE_PX - 12) * (s.progress ?? 0),
        5,
      );
      // Decorative steam rising from working espresso machines.
      if (s.type === 'bar' && !reducedMotion)
        for (let k = 0; k < 3; k++) {
          const phase = (time / 900 + k / 3) % 1;
          g.fillStyle(c.textPrimary, 0.7 * (1 - phase));
          g.fillRect(
            x - 6 + k * 5 + Math.sin(phase * 6 + k) * 2,
            y - HALF - 12 - phase * 18,
            4,
            4,
          );
        }
    }
    if (s.state === 'claimed')
      this.dashedBox(
        x - HALF,
        y - HALF,
        TILE_PX,
        TILE_PX,
        c.stationStrokeClaimed,
      );
    if (lit)
      g.lineStyle(2, c.focus, 1).strokeRect(
        x - HALF - 3,
        y - HALF - 3,
        TILE_PX + 6,
        TILE_PX + 6,
      );
  }

  /** A staff member: role sprite facing its direction, walk cycle while moving, role tag. */
  private drawAgent(a: AgentView, lit: boolean, t: number) {
    const x = px(a.x),
      feet = py(a.y) + FEET;
    const anim = a.state === 'moving' ? WALK_CYCLE[Math.floor(t * 6) % 4] : 0;
    this.sprite(
      `agent:${a.id}`,
      SHEETS.urban.key,
      staffFrame(a.role, a.facing, anim),
      x,
      feet,
      10 + a.y,
      1,
    );
    const top = feet - TILE_PX + 4;
    // Tag above the head: dark plate, role colour square, name.
    const label = a.helping ? `${a.name} · helping` : a.name;
    const w = label.length * 5.2 + 18;
    this.g.fillStyle(c.page, 0.75).fillRect(x - w / 2, top - 14, w, 12);
    this.g.fillStyle(c.role[a.role], 1).fillRect(x - w / 2 + 3, top - 11, 6, 6);
    this.text(`agentName:${a.id}`, label, x + 5, top - 8, 8, c.textPrimary);
    if (a.state === 'waiting')
      this.bubble(
        `agentWait:${a.id}`,
        '…',
        x + 22,
        top - 2,
        c.warning,
        c.onAccent,
      );
    if (lit)
      this.g
        .lineStyle(2, c.focus, 1)
        .strokeRect(x - HALF + 4, top - 2, TILE_PX - 8, TILE_PX);
  }

  /** A customer: their guest kind (a–j) facing its direction, walk cycle, id, status bubbles. */
  private drawCustomer(cu: CustomerView, lit: boolean, t: number) {
    const x = px(cu.x),
      feet = py(cu.y) + FEET;
    const anim = cu.walking ? WALK_CYCLE[Math.floor(t * 6) % 4] : 0;
    // Walkers sort just above standing people at the same row.
    const depth = 10 + cu.y + (cu.walking ? 0.05 : 0);
    this.sprite(
      `cust:${cu.id}`,
      SHEETS.guests.key,
      guestFrame(cu.guest, cu.facing, anim),
      x,
      feet,
      depth,
      1,
    ).setAlpha(cu.stage === 'leaving' ? 0.75 : 1);
    // Id on a dark plate so it reads on the light stone floor.
    const idW = cu.id.length * 5 + 6;
    this.g.fillStyle(c.page, 0.65).fillRect(x - idW / 2, feet + 1, idW, 10);
    this.text(
      `custId:${cu.id}`,
      cu.id,
      x,
      feet + 6,
      8,
      cu.late ? c.critical : c.textPrimary,
    );
    const top = feet - TILE_PX + 6;
    if (cu.late && cu.stage !== 'leaving')
      this.bubble(`late:${cu.id}`, '!', x, top - 4, c.critical, c.textPrimary);
    else if (cu.stage === 'ready')
      this.bubble(
        `ready:${cu.id}`,
        'Ready!',
        // Beside the body, clear of the pickup counter's name plate.
        x + 30,
        feet - 14,
        c.good,
        c.onAccent,
      );
    if (lit)
      this.g
        .lineStyle(2, c.focus, 1)
        .strokeRect(x - HALF + 6, top - 2, TILE_PX - 12, TILE_PX - 4);
  }

  /** A small speech bubble with a tail, centred above (x, y). */
  private bubble(
    key: string,
    label: string,
    x: number,
    y: number,
    fill: number,
    color: number,
  ) {
    const w = label.length * 6 + 10;
    this.g.fillStyle(fill, 1).fillRect(x - w / 2, y - 14, w, 13);
    this.g.fillRect(x - 2, y - 1, 4, 3);
    this.text(key, label, x, y - 7.5, 8, color);
  }

  /** Dashed square outline (claimed slot). */
  private dashedBox(x: number, y: number, w: number, h: number, color: number) {
    const g = this.g;
    g.fillStyle(color, 1);
    for (let d = 0; d < w; d += 7) {
      g.fillRect(x + d, y, Math.min(4, w - d), 2);
      g.fillRect(x + d, y + h - 2, Math.min(4, w - d), 2);
    }
    for (let d = 0; d < h; d += 7) {
      g.fillRect(x, y + d, 2, Math.min(4, h - d));
      g.fillRect(x + w - 2, y + d, 2, Math.min(4, h - d));
    }
  }

  /** Hides pooled sprites and labels not drawn this frame (customers who left, rope, etc.). */
  private hideUnused() {
    for (const [key, s] of this.sprites)
      if (!this.used.has(key)) s.setVisible(false);
    for (const [key, t] of this.texts)
      if (!this.used.has(key)) t.setVisible(false);
  }
}
