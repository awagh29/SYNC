import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Layering rules that keep the mock swappable for the real backend:
 *   sync/contract, sync/source  — pure port, imports nothing
 *   sync/mock                   — port only (no live, no dashboard, no DB)
 *   sync/live                   — port + DB bindings (no mock, no dashboard)
 *   dashboard/**                — port only; adapters chosen in dashboard/main.tsx
 *   existing app (app/, game/, components/, lib/, main.tsx) — untouched by the new layers
 */
const root = __dirname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)
        ? [p]
        : [];
  });
const imports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
    (m) => m[1],
  );
const rel = (file: string) => relative(root, file).replaceAll('\\', '/');

const rules: Array<[RegExp, RegExp, string]> = [
  [
    /^sync\/(contract|source)\.ts$/,
    /^(?!\.\/contract$)/,
    'port depends on the contract only',
  ],
  [
    /^sync\/mock\//,
    /(\/live\/|dashboard|@sync\/bindings|spacetimedb|react|phaser)/,
    'mock sees the port only',
  ],
  [
    /^sync\/live\//,
    /(\/mock\/|dashboard|react|phaser)/,
    'live adapter sees the port and DB only',
  ],
  [
    /^dashboard\/(?!main\.tsx$)/,
    /(sync\/mock|sync\/live|@sync\/bindings|spacetimedb)/,
    'dashboard sees the port only',
  ],
  [
    /^(app|game|components|lib)\/|^main\.tsx$/,
    /(\/sync\/|dashboard)/,
    'existing app stays independent',
  ],
];

describe('layer boundaries', () => {
  for (const file of files(root)) {
    const name = rel(file);
    for (const [where, banned, why] of rules) {
      if (!where.test(name)) continue;
      it(`${name}: ${why}`, () => {
        const bad = imports(file).filter((i) => banned.test(i));
        expect(bad).toEqual([]);
      });
    }
  }
});
