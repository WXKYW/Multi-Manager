import { describe, expect, it } from 'vitest';
import { formatGitHubRepositoryDescription, renderGitHubEmoji } from './githubEmoji.js';

describe('github emoji helpers', () => {
  it('replaces GitHub emoji shortcodes in repository descriptions', () => {
    expect(formatGitHubRepositoryDescription(':house_with_garden: Open source home automation')).toBe('🏡 Open source home automation');
  });

  it('keeps unknown shortcodes unchanged', () => {
    expect(renderGitHubEmoji(':not_in_map: Still raw')).toBe(':not_in_map: Still raw');
  });

  it('returns fallback for empty descriptions', () => {
    expect(formatGitHubRepositoryDescription('', 'https://github.com/example/repo')).toBe('https://github.com/example/repo');
  });
});
