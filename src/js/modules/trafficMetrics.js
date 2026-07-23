export function normalizeTrafficLimitMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return ['upload', 'download', 'total'].includes(normalized) ? normalized : 'total';
}

export function resolveTrafficUsedBytes(rxBytes, txBytes, mode = 'total') {
  const rx = Math.max(0, Number(rxBytes) || 0);
  const tx = Math.max(0, Number(txBytes) || 0);
  switch (normalizeTrafficLimitMode(mode)) {
    case 'upload':
      return tx;
    case 'download':
      return rx;
    default:
      return rx + tx;
  }
}
