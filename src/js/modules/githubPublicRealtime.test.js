import { describe, expect, it } from 'vitest';
import {
  getPublicGithubDataUpdatedAt,
  getPublicGithubRefreshInterval,
  mergePublicGithubRepositories,
} from './githubPublicRealtime.js';

describe('GitHub public page realtime helpers', () => {
  it('polls active workflows faster than completed workflows', () => {
    expect(
      getPublicGithubRefreshInterval({
        repositories: [{ latest_run: { status: 'in_progress' } }],
      })
    ).toBe(10_000);
    expect(
      getPublicGithubRefreshInterval({
        repositories: [{ latest_run: { status: 'completed', conclusion: 'success' } }],
      })
    ).toBe(30_000);
  });

  it('uses repository data time instead of the public page configuration time', () => {
    expect(
      getPublicGithubDataUpdatedAt({
        updatedAt: '2026-07-17T01:20:00Z',
        repositories: [
          {
            updated_at: '2026-07-18T00:01:00Z',
            latest_run: { updated_at: '2026-07-18T00:02:00Z' },
          },
        ],
      })
    ).toBe('2026-07-18T00:02:00Z');
  });

  it('falls back to the page timestamp when repository timestamps are absent', () => {
    expect(
      getPublicGithubDataUpdatedAt({
        createdAt: '2026-07-16T00:00:00Z',
        updatedAt: '2026-07-17T00:00:00Z',
        repositories: [{ updated_at: 'not-a-date' }],
      })
    ).toBe('2026-07-17T00:00:00Z');
  });

  it('reloads workflow details when the same run receives a newer collection', () => {
    const previous = [
      {
        id: 1,
        latest_run: { run_id: 42, status: 'in_progress', collected_at: '2026-07-18T00:00:00Z' },
        jobs: [{ id: 1, status: 'in_progress' }],
        workflow: { nodes: ['old'] },
      },
    ];
    const next = [
      {
        id: 1,
        latest_run: { run_id: 42, status: 'in_progress', collected_at: '2026-07-18T00:00:10Z' },
      },
    ];

    expect(mergePublicGithubRepositories(next, previous)[0]).not.toHaveProperty('jobs');
  });

  it('keeps workflow details when the run revision is unchanged', () => {
    const previous = [
      {
        id: 1,
        latest_run: { run_id: 42, status: 'completed', collected_at: '2026-07-18T00:00:10Z' },
        jobs: [{ id: 1, status: 'completed' }],
      },
    ];
    const next = [
      {
        id: 1,
        latest_run: { run_id: 42, status: 'completed', collected_at: '2026-07-18T00:00:10Z' },
      },
    ];

    expect(mergePublicGithubRepositories(next, previous)[0].jobs).toEqual(previous[0].jobs);
  });
});
