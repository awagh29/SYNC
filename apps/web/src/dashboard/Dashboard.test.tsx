// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { MockSyncSource } from '../sync/mock/MockSyncSource';
import { SpacetimeSyncSource } from '../sync/live/SpacetimeSyncSource';
import { Dashboard } from './Dashboard';

/** Dashboard through the port with a real mock source; Phaser is stubbed (no canvas in jsdom). */

vi.mock('./floor/FloorCanvas', () => ({
  FloorCanvas: ({ label }: { label: string }) => (
    <div role="img" aria-label={label} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('renders the mock runs through the port: floors, scorecard, decisions, sample banner', async () => {
  vi.useFakeTimers();
  render(<Dashboard source={new MockSyncSource({ seed: 5 })} />);
  expect(screen.getByText('Connecting to SYNC…')).toBeTruthy();
  await act(async () => vi.advanceTimersByTime(0));
  expect(screen.getByRole('note').textContent).toMatch(/placeholders/);
  expect(screen.getByLabelText('SYNC shop floor')).toBeTruthy();
  expect(screen.getByLabelText('Baseline shop floor')).toBeTruthy();
  expect(screen.getByText('Not measured')).toBeTruthy();
  expect(screen.getByText(/^SYNC finished/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Simulated time'), {
    target: { value: '400' },
  });
  const wait = screen.getByRole('button', { name: /^Wait/ });
  expect(wait.textContent).toMatch(/Wait \d+/);
  fireEvent.click(wait);
  // First row of the decision history (the Scorecard legend is a list too).
  const first = document.querySelector<HTMLButtonElement>('.history button')!;
  fireEvent.click(first);
  const detail = screen.getByLabelText('Selected decision').textContent;
  expect(detail).toMatch(/wait for the/i);
  expect(detail).toMatch(/Admitted/);
  expect(detail).toMatch(/done \d/);
});

it('shows the live adapter as disconnected instead of inventing data', () => {
  render(<Dashboard source={new SpacetimeSyncSource()} />);
  expect(screen.getByRole('alert').textContent).toMatch(/not implemented/);
  expect(screen.queryByRole('note')).toBeNull();
});
