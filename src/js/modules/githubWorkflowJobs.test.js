import { describe, expect, it } from 'vitest';
import { workflowJobMatchesDefinition } from './githubWorkflowJobs.js';

describe('GitHub workflow job matching', () => {
  it('matches a non-matrix job whose GitHub expression resolves at runtime', () => {
    expect(workflowJobMatchesDefinition(
      { name: 'Build, verify and publish latest' },
      {
        id: 'build-and-publish',
        name: "Build, verify and publish ${{ github.ref == 'refs/heads/main' && 'latest' || 'dev' }}",
      },
    )).toBe(true);
  });

  it('does not match a different job with only a small shared prefix', () => {
    expect(workflowJobMatchesDefinition(
      { name: 'Build documentation' },
      {
        id: 'build-and-publish',
        name: 'Build, verify and publish ${{ env.IMAGE_TAG }}',
      },
    )).toBe(false);
  });

  it('keeps matrix suffix matching', () => {
    expect(workflowJobMatchesDefinition(
      { name: 'Test (node-22)' },
      { id: 'test', name: 'Test (${{ matrix.node }})', matrix: true },
    )).toBe(true);
  });
});
