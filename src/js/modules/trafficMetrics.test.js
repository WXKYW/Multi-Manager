import { describe, expect, it } from 'vitest';
import { normalizeTrafficLimitMode, resolveTrafficUsedBytes } from './trafficMetrics.js';

describe('traffic quota mode', () => {
  it('uses both directions for total quotas', () => {
    expect(resolveTrafficUsedBytes(600, 500, 'total')).toBe(1100);
  });

  it('uses only download traffic for download quotas', () => {
    expect(resolveTrafficUsedBytes(600, 500, 'download')).toBe(600);
  });

  it('uses only upload traffic for upload quotas', () => {
    expect(resolveTrafficUsedBytes(600, 500, 'upload')).toBe(500);
  });

  it('normalizes unknown modes to total and clamps invalid values', () => {
    expect(normalizeTrafficLimitMode('unexpected')).toBe('total');
    expect(resolveTrafficUsedBytes(-100, Number.NaN, 'unexpected')).toBe(0);
  });
});
