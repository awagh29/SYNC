import Phaser from 'phaser';
import type { Lanes } from '../model/lanes';
import type {
  AgentView,
  CustomerView,
  Scene as FloorState,
  SlotView,
} from '../model/scene';
import { iconKey, iconSources } from './icons';
import { css, floorTheme as c, GRID, px, py } from './theme';

/** Ids to outline because they belong to the selected decision. */
export interface Highlight {
  agentId?: string;
  resourceId?: string;
  jobId?: string;
}
/** Everything the scene reads each frame (supplied by FloorCanvas through a ref). */
export interface FloorInput {
  scene: FloorState | null;
  highlight: Highlight;
  reducedMotion: boolean;
}

// Sizes in canvas pixels, taken from the Figma components.
/** Shop/Slot: 74 × 46, radius 6, progress bar 62 × 3. */
const SLOT = { w: 74, h: 46, r: 6, bar: 62 };
/** Shop/StaffToken: ring 36, body 26, icon 14, name 10px below. */
const STAFF = { ring: 18, body: 13, icon: 14 };
/** Shop/CustomerToken: token 22, icon 12, id 10px below, late badge 8. */
const CUSTOMER = { r: 11, icon: 12, badge: 4 };
/** Role group captions in the staff area (grid positions from the Figma draft). */
const ROLE_LABELS: Array<[string, number, number, keyof typeof c.role]> = [
  ['BARISTA SLOTS', 5.0, 0.35, 'barista'],
  ['CLEANER SLOTS', 10.45, 0.35, 'cleaner'],
  ['CASHIER SLOTS', 1.35, 2.15, 'cashier'],
  ['SERVER SLOTS', 8.25, 2.15, 'server'],
];
const FONT = 'Inter, system-ui, sans-serif';

/**
 * Draws whatever FloorInput says, styled like the Figma components
 * (Shop/Slot, Shop/StaffToken, Shop/CustomerToken). No event handling and no
 * position maths beyond grid → pixel; the only time-based effect is the
 * decorative pulse on waiting staff.
 */
export class FloorScene extends Phaser.Scene {
  /** Floor layer (staff area, wall, rope, slots), redrawn every frame. */
  private g!: Phaser.GameObjects.Graphics;
  /** Customer and staff bodies, drawn above the floor layer. */
  private top!: Phaser.GameObjects.Graphics;
  /** Text objects are pooled by key and reused across frames. */
  private texts = new Map<string, Phaser.GameObjects.Text>();
  /** Icon images, pooled by key like the texts. */
  private icons = new Map<string, Phaser.GameObjects.Image>();
  /** Keys drawn this frame; the rest are hidden. */
  private used = new Set<string>();

  constructor(private read: () => FloorInput) {
    super('floor');
  }

  /** Loads the role and person icons (rendered at 2× for crisp scaling). */
  preload() {
    for (const icon of iconSources({
      onAccent: css(c.onAccent),
      secondary: css(c.textSecondary),
      muted: css(c.textMuted),
    }))
      this.load.svg(icon.key, icon.uri, {
        width: icon.size * 2,
        height: icon.size * 2,
      });
  }

  create() {
    this.g = this.add.graphics().setDepth(0);
    this.top = this.add.graphics().setDepth(5);
  }

  /** Draws (or reuses) a text label identified by key. */
  private text(
    key: string,
    value: string,
    x: number,
    y: number,
    opts: {
      size: number;
      color: number;
      weight?: string;
      originX?: number;
      depth?: number;
      alpha?: number;
    },
  ) {
    let t = this.texts.get(key);
    if (!t) {
      t = this.add.text(0, 0, '', {
        fontFamily: FONT,
        fontSize: `${opts.size}px`,
        fontStyle: opts.weight ?? '400',
        color: css(opts.color),
        resolution: 2,
      });
      this.texts.set(key, t);
    }
    if (t.text !== value) t.setText(value);
    t.setOrigin(opts.originX ?? 0.5, 0.5)
      .setPosition(x, y)
      .setColor(css(opts.color))
      .setDepth(opts.depth ?? 10)
      .setAlpha(opts.alpha ?? 1)
      .setVisible(true);
    this.used.add(key);
  }

  /** Draws (or reuses) an icon image identified by key. */
  private icon(
    key: string,
    texture: string,
    x: number,
    y: number,
    size: number,
    depth: number,
    alpha = 1,
  ) {
    let img = this.icons.get(key);
    if (!img) {
      img = this.add.image(0, 0, texture);
      this.icons.set(key, img);
    }
    if (img.texture.key !== texture) img.setTexture(texture);
    img
      .setPosition(x, y)
      .setDisplaySize(size, size)
      .setDepth(depth)
      .setAlpha(alpha)
      .setVisible(true);
    this.used.add(key);
  }

  /** Phaser calls this every frame: floor, slots, customers, staff, highlights. */
  update(time: number) {
    const { scene, highlight, reducedMotion } = this.read();
    this.g.clear();
    this.top.clear();
    this.used.clear();
    if (!scene) return this.hideUnused();
    // Decorative pulse for waiting staff; off when the user prefers reduced motion.
    const pulse = reducedMotion ? 1 : 0.55 + 0.45 * Math.sin(time / 220);

    this.drawStaffArea(scene);
    this.drawLanes(scene.lanes, scene.queueFolded);
    for (const s of scene.slots)
      this.drawSlot(s, highlight.resourceId === s.id);
    // Standing customers first, walking ones on top so they are never hidden.
    const customers = [...scene.customers].sort(
      (a, b) => Number(a.walking) - Number(b.walking),
    );
    customers.forEach((cu, i) =>
      this.drawCustomer(cu, highlight.jobId === cu.id, 6 + i * 0.001),
    );
    for (const a of scene.agents)
      this.drawAgent(a, highlight.agentId === a.id, pulse);
    this.hideUnused();
  }

  /** Staff-only area with its caption and the role group labels (no customer boxes). */
  private drawStaffArea(scene: FloorState) {
    const staff = scene.zones.find((z) => z.kind === 'staff');
    if (staff) {
      this.g.fillStyle(c.surface, 1);
      this.g.fillRoundedRect(
        px(staff.x),
        py(staff.y),
        staff.w * GRID.unit,
        staff.h * GRID.unit,
        8,
      );
      this.g.lineStyle(1, c.borderSubtle, 1);
      this.g.strokeRoundedRect(
        px(staff.x),
        py(staff.y),
        staff.w * GRID.unit,
        staff.h * GRID.unit,
        8,
      );
      this.text('zone:staff', 'STAFF ONLY', px(staff.x) + 8, py(staff.y) + 10, {
        size: 9,
        color: c.textMuted,
        weight: '600',
        originX: 0,
      });
    }
    for (const [label, x, y, role] of ROLE_LABELS) {
      this.g.fillStyle(c.role[role], 1);
      this.g.fillCircle(px(x), py(y), 3.5);
      this.text(`role:${label}`, label, px(x) + 9, py(y), {
        size: 10,
        color: c.textSecondary,
        weight: '600',
        originX: 0,
      });
    }
  }

  /** Front wall with door gaps and the queue rope (long line only). Lanes and spots stay invisible. */
  private drawLanes(l: Lanes, folded: boolean) {
    const g = this.g;
    // Rope with stanchions between the two queue rows, only while the line is long.
    if (folded) {
      g.lineStyle(2, c.borderStrong, 1);
      g.lineBetween(
        px(l.rope[0].x),
        py(l.rope[0].y),
        px(l.rope[1].x),
        py(l.rope[1].y),
      );
      g.fillStyle(c.textSecondary, 1);
      for (let k = 0; k <= 4; k++) {
        const x = l.rope[0].x + ((l.rope[1].x - l.rope[0].x) * k) / 4;
        g.fillCircle(px(x), py(l.rope[0].y), 3.5);
      }
    }
    // Front wall with the two door openings and arrows (in at left, out at right).
    const wall = py(l.wallY);
    const right = GRID.offsetX * 2 + GRID.width * GRID.unit;
    g.lineStyle(2, c.borderStrong, 1);
    g.lineBetween(0, wall, px(l.doorIn[0]), wall);
    g.lineBetween(px(l.doorIn[1]), wall, px(l.doorOut[0]), wall);
    g.lineBetween(px(l.doorOut[1]), wall, right, wall);
    g.fillStyle(c.textMuted, 1);
    const inX = px((l.doorIn[0] + l.doorIn[1]) / 2);
    const outX = px((l.doorOut[0] + l.doorOut[1]) / 2);
    g.fillTriangle(inX, wall - 3, inX - 5, wall + 7, inX + 5, wall + 7);
    g.fillTriangle(outX, wall + 8, outX - 5, wall - 2, outX + 5, wall - 2);
  }

  /** Shop/Slot: fill and stroke by state, label + sub line, progress bar when busy. */
  private drawSlot(s: SlotView, lit: boolean) {
    const g = this.g;
    const x = px(s.x) - SLOT.w / 2;
    const y = py(s.y) - SLOT.h / 2;
    g.fillStyle(c.stationFill, 1);
    g.fillRoundedRect(x, y, SLOT.w, SLOT.h, SLOT.r);
    if (s.state === 'busy') {
      g.fillStyle(c.stationFillBusy, 0.14);
      g.fillRoundedRect(x, y, SLOT.w, SLOT.h, SLOT.r);
    }
    if (s.state === 'claimed')
      this.dashedRect(x, y, SLOT.w, SLOT.h, c.stationStrokeClaimed, 1.5, 4, 3);
    else {
      g.lineStyle(1, s.state === 'busy' ? c.textSecondary : c.stationStroke, 1);
      g.strokeRoundedRect(x, y, SLOT.w, SLOT.h, SLOT.r);
    }
    if (lit) {
      g.lineStyle(2.5, c.focus, 1);
      g.strokeRoundedRect(x - 3, y - 3, SLOT.w + 6, SLOT.h + 6, SLOT.r + 2);
    }
    const sub =
      s.state === 'busy'
        ? (s.taskLabel ?? 'busy')
        : s.state === 'claimed'
          ? 'claimed'
          : 'idle';
    const busyShift = s.state === 'busy' ? -3 : 0;
    this.text(`slot:${s.id}`, s.label, px(s.x), py(s.y) - 7 + busyShift, {
      size: 12,
      color: c.textPrimary,
      weight: '600',
    });
    this.text(`slotSub:${s.id}`, sub, px(s.x), py(s.y) + 8 + busyShift, {
      size: 10,
      color: c.textSecondary,
    });
    if (s.state === 'busy') {
      const bx = px(s.x) - SLOT.bar / 2;
      const by = y + SLOT.h - 8;
      g.fillStyle(c.sunken, 1);
      g.fillRect(bx, by, SLOT.bar, 3);
      if (s.progress !== null) {
        g.fillStyle(c.progress, 1);
        g.fillRect(bx, by, SLOT.bar * s.progress, 3);
      }
    }
  }

  /** Shop/CustomerToken: raised disc + person icon, ring by stage, id below. */
  private drawCustomer(cu: CustomerView, lit: boolean, depth: number) {
    const g = this.top;
    const x = px(cu.x);
    const y = py(cu.y);
    const leaving = cu.stage === 'leaving';
    const alpha = leaving ? 0.45 : 1;
    g.fillStyle(c.raised, alpha);
    g.fillCircle(x, y, CUSTOMER.r);
    if (lit) {
      g.lineStyle(2.5, c.focus, 1);
      g.strokeCircle(x, y, CUSTOMER.r + 3);
    }
    if (cu.late && !leaving) {
      g.lineStyle(2, c.critical, 1);
      g.strokeCircle(x, y, CUSTOMER.r);
      g.fillStyle(c.critical, 1);
      g.fillCircle(x + CUSTOMER.r - 2, y - CUSTOMER.r + 2, CUSTOMER.badge);
    } else if (cu.stage === 'waiting') {
      this.dashedCircle(this.top, x, y, CUSTOMER.r, c.textMuted, 1, 10);
    } else {
      const [color, width] =
        cu.stage === 'ordering'
          ? [c.textPrimary, 1.5]
          : cu.stage === 'ready'
            ? [c.good, 1.5]
            : [c.textMuted, 1];
      g.lineStyle(width, color, alpha);
      g.strokeCircle(x, y, CUSTOMER.r);
    }
    this.icon(
      `cust:${cu.id}`,
      leaving ? iconKey.personMuted : iconKey.person,
      x,
      y,
      CUSTOMER.icon,
      depth + 0.5,
      alpha,
    );
    this.text(`custId:${cu.id}`, cu.id, x, y + CUSTOMER.r + 8, {
      size: 10,
      color: c.textMuted,
      depth: depth + 0.5,
      alpha,
    });
  }

  /** Shop/StaffToken: state ring, role-coloured body, role icon, name below. */
  private drawAgent(a: AgentView, lit: boolean, pulse: number) {
    const g = this.top;
    const x = px(a.x);
    const y = py(a.y);
    const color = c.role[a.role];
    if (a.state === 'idle') {
      g.lineStyle(1, c.textMuted, 0.6);
      g.strokeCircle(x, y, STAFF.ring);
    } else if (a.state === 'moving') {
      this.dashedCircle(g, x, y, STAFF.ring, color, 1.5, 16);
    } else if (a.state === 'waiting') {
      g.lineStyle(2.5, c.warning, pulse);
      g.strokeCircle(x, y, STAFF.ring);
    } else {
      // Working: progress pie behind the body reads as a ring.
      const k = a.progress ?? 0.65;
      g.fillStyle(c.progress, 1);
      g.slice(
        x,
        y,
        STAFF.ring,
        -Math.PI / 2,
        -Math.PI / 2 + Math.max(0.05, k) * Math.PI * 2,
        false,
      );
      g.fillPath();
    }
    g.fillStyle(color, 1);
    g.fillCircle(x, y, STAFF.body);
    g.lineStyle(2, c.page, 1);
    g.strokeCircle(x, y, STAFF.body);
    if (lit) {
      g.lineStyle(2.5, c.focus, 1);
      g.strokeCircle(x, y, STAFF.ring + 4);
    }
    this.icon(`agent:${a.id}`, iconKey.role(a.role), x, y, STAFF.icon, 8);
    this.text(
      `agentName:${a.id}`,
      a.helping ? `${a.name} · helping` : a.name,
      x,
      y + STAFF.ring + 8,
      { size: 10, color: c.textSecondary, depth: 8 },
    );
  }

  /** Dashed rectangle outline (square corners; close enough at this size). */
  private dashedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: number,
    width: number,
    dash: number,
    gap: number,
  ) {
    const corners = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
      { x, y },
    ];
    const g = this.g;
    g.lineStyle(width, color, 1);
    for (let i = 1; i < corners.length; i++) {
      const a = corners[i - 1],
        b = corners[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 0; d < len; d += dash + gap) {
        const e = Math.min(len, d + dash);
        g.lineBetween(
          a.x + ((b.x - a.x) * d) / len,
          a.y + ((b.y - a.y) * d) / len,
          a.x + ((b.x - a.x) * e) / len,
          a.y + ((b.y - a.y) * e) / len,
        );
      }
    }
  }

  /** Dashed circle as alternating arcs. */
  private dashedCircle(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    r: number,
    color: number,
    width: number,
    segments: number,
  ) {
    g.lineStyle(width, color, 1);
    const step = (Math.PI * 2) / segments;
    for (let i = 0; i < segments; i++) {
      g.beginPath();
      g.arc(x, y, r, i * step, i * step + step * 0.55);
      g.strokePath();
    }
  }

  /** Hides labels and icons that were not drawn this frame (customers who left, etc.). */
  private hideUnused() {
    for (const [key, t] of this.texts)
      if (!this.used.has(key)) t.setVisible(false);
    for (const [key, img] of this.icons)
      if (!this.used.has(key)) img.setVisible(false);
  }
}
