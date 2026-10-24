/**
 * Icons from the Figma components (Shop/StaffToken role icons, Shop/CustomerToken
 * person), exported as SVG paths. Phaser loads them as textures, tinted per use.
 */
import type { Role } from '../../sync/contract';

/** Stroke paths on a 14 × 14 grid (lucide-style, 2px round strokes). */
const ROLE_PATHS: Record<Role, string[]> = {
  cashier: [
    'M2.33 1.17V12.84L3.5 12.25L4.66 12.84L5.83 12.25L7 12.84L8.16 12.25L9.33 12.84L10.5 12.25L11.66 12.84V1.17L10.5 1.75L9.33 1.17L8.16 1.75L7 1.17L5.83 1.75L4.66 1.17L3.5 1.75L2.33 1.17Z',
    'M9.34 4.67H5.84C5.53 4.67 5.23 4.79 5.01 5.01C4.79 5.23 4.67 5.53 4.67 5.84C4.67 6.15 4.79 6.44 5.01 6.66C5.23 6.88 5.53 7 5.84 7H8.17C8.48 7 8.78 7.13 9 7.35C9.21 7.56 9.34 7.86 9.34 8.17C9.34 8.48 9.21 8.78 9 9C8.78 9.21 8.48 9.34 8.17 9.34H4.67',
    'M7 10.21V3.79',
  ],
  barista: [
    'M5.83 1.17V2.34',
    'M8.17 1.17V2.34',
    'M9.33 4.67C9.49 4.67 9.64 4.73 9.75 4.84C9.86 4.95 9.92 5.1 9.92 5.25V9.92C9.92 10.54 9.67 11.13 9.23 11.57C8.8 12.01 8.2 12.25 7.58 12.25H4.08C3.46 12.25 2.87 12.01 2.43 11.57C2 11.13 1.75 10.54 1.75 9.92V5.25C1.75 5.1 1.81 4.95 1.92 4.84C2.03 4.73 2.18 4.67 2.33 4.67H10.5C11.12 4.67 11.71 4.92 12.15 5.35C12.59 5.79 12.83 6.38 12.83 7C12.83 7.62 12.59 8.22 12.15 8.65C11.71 9.09 11.12 9.34 10.5 9.34H9.92',
    'M3.5 1.17V2.34',
  ],
  server: [
    'M7 1.75V1.17',
    'M8.99 10.15L10.85 8.52C10.96 8.41 11.1 8.33 11.24 8.27C11.38 8.22 11.54 8.19 11.69 8.19C11.85 8.19 12 8.23 12.14 8.29C12.28 8.35 12.41 8.44 12.52 8.55C12.62 8.66 12.71 8.79 12.76 8.93C12.82 9.08 12.85 9.23 12.85 9.39C12.84 9.54 12.81 9.69 12.75 9.83C12.69 9.98 12.6 10.1 12.49 10.21L10.39 12.14C9.98 12.6 9.4 12.84 8.75 12.84H6.42C5.78 12.84 5.2 12.6 4.79 12.14L4.03 11.28C3.97 11.22 3.91 11.17 3.83 11.14C3.76 11.1 3.67 11.09 3.59 11.09H2.92',
    'M1.17 8.17H8.17C8.48 8.17 8.78 8.29 9 8.51C9.21 8.73 9.34 9.03 9.34 9.34C9.34 9.65 9.21 9.94 9 10.16C8.78 10.38 8.48 10.5 8.17 10.5H7',
    'M2.33 5.83H11.66',
    'M2.92 5.83C2.92 4.75 3.35 3.71 4.12 2.95C4.88 2.18 5.92 1.75 7 1.75C8.09 1.75 9.12 2.18 9.89 2.95C10.66 3.71 11.09 4.75 11.09 5.83',
    'M2.92 8.17V11.67C2.92 11.82 2.86 11.97 2.75 12.08C2.64 12.19 2.49 12.25 2.34 12.25H1.17',
  ],
  cleaner: [
    'M1.75 1.75H1.76',
    'M4.08 2.92H4.09',
    'M6.42 4.08H6.43',
    'M1.75 4.08H1.76',
    'M4.08 5.25H4.09',
    'M1.75 6.42H1.76',
    'M11.08 2.92H8.75V5.25H11.08V2.92Z',
    'M11.08 5.25L12.25 6.42V12.25C12.25 12.6 12.01 12.83 11.66 12.83H8.16C7.81 12.83 7.58 12.6 7.58 12.25V6.42L8.75 5.25',
    'M7.58 8.17L12.25 7',
    'M7.58 11.09L12.25 9.92',
  ],
};

/** Person icon on a 12 × 12 grid. */
const PERSON_PATHS = [
  'M9.5 10.5V9.5C9.5 8.97 9.29 8.46 8.91 8.09C8.54 7.71 8.03 7.5 7.5 7.5H4.5C3.97 7.5 3.46 7.71 3.09 8.09C2.71 8.46 2.5 8.97 2.5 9.5V10.5',
  'M6 5.5C7.1 5.5 8 4.6 8 3.5C8 2.4 7.1 1.5 6 1.5C4.9 1.5 4 2.4 4 3.5C4 4.6 4.9 5.5 6 5.5Z',
];

/** SVG data URI for a set of stroke paths in one colour. */
function svgUri(paths: string[], size: number, color: string) {
  const body = paths
    .map(
      (d) =>
        `<path d="${d}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Texture key per icon. */
export const iconKey = {
  role: (role: Role) => `icon-role-${role}`,
  person: 'icon-person',
  personMuted: 'icon-person-muted',
};

/** Everything FloorScene must preload: key, data URI and native size. */
export function iconSources(colors: {
  onAccent: string;
  secondary: string;
  muted: string;
}) {
  return [
    ...(Object.keys(ROLE_PATHS) as Role[]).map((role) => ({
      key: iconKey.role(role),
      uri: svgUri(ROLE_PATHS[role], 14, colors.onAccent),
      size: 14,
    })),
    {
      key: iconKey.person,
      uri: svgUri(PERSON_PATHS, 12, colors.secondary),
      size: 12,
    },
    {
      key: iconKey.personMuted,
      uri: svgUri(PERSON_PATHS, 12, colors.muted),
      size: 12,
    },
  ];
}
