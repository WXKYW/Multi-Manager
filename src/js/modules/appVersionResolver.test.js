import { describe, expect, it } from 'vitest';
import {
  formatDevelopmentVersion,
  normalizeReleaseVersion,
  resolveAppVersion,
} from '../../../tools/app-version.mjs';

describe('application version resolver', () => {
  it('formats development versions from the first seven commit characters', () => {
    expect(formatDevelopmentVersion('0123456789ABCDEF')).toBe('dev-0123456');
    expect(formatDevelopmentVersion('')).toBe('dev-local');
  });

  it('normalizes release versions to a v-prefixed semantic version', () => {
    expect(normalizeReleaseVersion('2.0.1')).toBe('v2.0.1');
    expect(normalizeReleaseVersion('v2.1.0-beta.1')).toBe('v2.1.0-beta.1');
  });

  it('uses the package version for main branch builds', () => {
    expect(
      resolveAppVersion({
        branchName: 'main',
        commitSha: 'abcdef12',
        packageVersion: '2.0.1',
      })
    ).toBe('v2.0.1');
  });

  it('uses the tag for release builds and the hash for development builds', () => {
    expect(
      resolveAppVersion({
        refName: 'refs/tags/v3.0.0',
        packageVersion: '2.0.1',
      })
    ).toBe('v3.0.0');
    expect(
      resolveAppVersion({
        branchName: 'dev',
        commitSha: '0123456789abcdef',
        packageVersion: '2.0.1',
      })
    ).toBe('dev-0123456');
  });

  it('allows CI and Docker builds to provide an explicit version', () => {
    expect(resolveAppVersion({ explicitVersion: '2.0.2' })).toBe('v2.0.2');
    expect(resolveAppVersion({ explicitVersion: 'dev-0123456' })).toBe('dev-0123456');
  });
});
