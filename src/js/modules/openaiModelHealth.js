export function modelHealthKey(endpointId, modelId) {
  return JSON.stringify([String(endpointId || ''), String(modelId || '').trim()]);
}

export function endpointModelIds(endpoint) {
  const models = Array.isArray(endpoint?.models) ? endpoint.models : [];
  return Array.from(
    new Set(
      models
        .map(model => (typeof model === 'string' ? model : model?.id))
        .map(model => String(model || '').trim())
        .filter(Boolean)
    )
  );
}

export function modelHealthTargets(endpoints) {
  return (Array.isArray(endpoints) ? endpoints : []).flatMap(endpoint => {
    if (!endpoint?.enabled) return [];
    return endpointModelIds(endpoint).map(modelId => ({ endpointId: endpoint.id, modelId }));
  });
}

export function normalizeModelHealthRecord(record, fallbackError = '检测未返回结果') {
  const rawStatus = String(record?.status || '').toLowerCase();
  const status =
    rawStatus === 'operational' || rawStatus === 'healthy'
      ? 'healthy'
      : rawStatus === 'degraded'
        ? 'degraded'
        : 'error';
  const parsedLatency = Number(record?.latency);
  const latency = Number.isFinite(parsedLatency) ? parsedLatency : null;

  return {
    status,
    loading: false,
    latency,
    checkedAt: record?.checkedAt || Date.now(),
    ...(status === 'error' ? { error: record?.error || fallbackError } : {}),
  };
}

export function countModelHealthResults(results) {
  return (Array.isArray(results) ? results : []).reduce(
    (counts, result) => {
      if (result.status === 'healthy') counts.healthy += 1;
      else if (result.status === 'degraded') counts.degraded += 1;
      else counts.failed += 1;
      return counts;
    },
    { healthy: 0, degraded: 0, failed: 0 }
  );
}
