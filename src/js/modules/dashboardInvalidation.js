const DASHBOARD_STATS_INVALIDATED_AT_KEY = 'app_dashboard_stats_invalidated_at';
export const DASHBOARD_INVALIDATION_EVENT = 'dashboard:stats-invalidated';

export const readDashboardStatsInvalidatedAt = () => {
  try {
    const raw = window.localStorage.getItem(DASHBOARD_STATS_INVALIDATED_AT_KEY);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
};

export const invalidateDashboardStats = (reason = 'manual') => {
  const timestamp = Date.now();
  try {
    window.localStorage.setItem(DASHBOARD_STATS_INVALIDATED_AT_KEY, String(timestamp));
  } catch {
    // Ignore storage failures and still emit a runtime signal.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DASHBOARD_INVALIDATION_EVENT, {
      detail: { reason, timestamp },
    }));
  }
  return timestamp;
};
