import { describe, expect, it } from 'vitest';
import {
  countModelHealthResults,
  endpointModelIds,
  modelHealthKey,
  modelHealthTargets,
  normalizeModelHealthRecord,
} from './openaiModelHealth.js';

describe('OpenAI model health helpers', () => {
  it('keeps the same model on different endpoints as separate targets', () => {
    const targets = modelHealthTargets([
      { id: 'endpoint-a', enabled: true, models: ['shared-model', 'model-a'] },
      { id: 'endpoint-b', enabled: true, models: ['shared-model'] },
      { id: 'endpoint-c', enabled: false, models: ['disabled-model'] },
    ]);

    expect(targets).toEqual([
      { endpointId: 'endpoint-a', modelId: 'shared-model' },
      { endpointId: 'endpoint-a', modelId: 'model-a' },
      { endpointId: 'endpoint-b', modelId: 'shared-model' },
    ]);
    expect(modelHealthKey('endpoint-a', 'shared-model')).not.toBe(
      modelHealthKey('endpoint-b', 'shared-model')
    );
  });

  it('normalizes and deduplicates an endpoint model list', () => {
    expect(
      endpointModelIds({ models: [' model-a ', { id: 'model-a' }, { id: 'model-b' }, null] })
    ).toEqual(['model-a', 'model-b']);
  });

  it('normalizes backend records and counts visible outcomes', () => {
    const results = [
      normalizeModelHealthRecord({ status: 'operational', latency: 120 }),
      normalizeModelHealthRecord({ status: 'degraded', latency: 24000 }),
      normalizeModelHealthRecord({ status: 'failed', error: 'HTTP 429' }),
    ];

    expect(results[0]).toMatchObject({ status: 'healthy', latency: 120, loading: false });
    expect(results[2]).toMatchObject({ status: 'error', error: 'HTTP 429' });
    expect(countModelHealthResults(results)).toEqual({ healthy: 1, degraded: 1, failed: 1 });
  });
});
