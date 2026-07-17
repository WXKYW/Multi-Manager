const ACTIVE_ACTION_STATUSES = new Set([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
]);

export function getPublicGithubRefreshInterval(page) {
  const repositories = Array.isArray(page?.repositories) ? page.repositories : [];
  const hasActiveWorkflow = repositories.some(repository => {
    const status = repository?.latest_run?.status || repository?.latest_action_status || '';
    return ACTIVE_ACTION_STATUSES.has(String(status).toLowerCase());
  });
  return hasActiveWorkflow ? 10_000 : 30_000;
}

export function getPublicGithubDataUpdatedAt(page) {
  const candidates = [page?.createdAt, page?.updatedAt];
  const repositories = Array.isArray(page?.repositories) ? page.repositories : [];
  repositories.forEach(repository => {
    candidates.push(
      repository?.updated_at,
      repository?.latest_action_updated_at,
      repository?.latest_action_created_at,
      repository?.latest_run?.collected_at,
      repository?.latest_run?.updated_at,
      repository?.latest_run?.created_at
    );
  });

  let latestValue = '';
  let latestTime = Number.NEGATIVE_INFINITY;
  candidates.forEach(value => {
    if (!value) return;
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed) || parsed <= latestTime) return;
    latestValue = value;
    latestTime = parsed;
  });
  return latestValue;
}

function publicGithubRunRevision(repository) {
  const run = repository?.latest_run || {};
  return [
    run.run_id || '',
    run.collected_at || '',
    run.updated_at || '',
    run.status || repository?.latest_action_status || '',
    run.conclusion || repository?.latest_action_conclusion || '',
  ]
    .map(String)
    .join('|');
}

export function mergePublicGithubRepositories(repositories = [], previousRepositories = []) {
  const previousById = new Map(
    previousRepositories.map(repository => [String(repository?.id), repository])
  );
  return repositories.map(repository => {
    const previous = previousById.get(String(repository?.id));
    if (!previous) return repository;
    const runID = String(repository?.latest_run?.run_id || '');
    const canReuseDetail =
      runID !== '' &&
      runID === String(previous?.latest_run?.run_id || '') &&
      publicGithubRunRevision(repository) === publicGithubRunRevision(previous) &&
      (Array.isArray(previous?.jobs) || previous?.workflow || previous?.workflow_error);
    if (!canReuseDetail) return repository;
    return {
      ...repository,
      jobs: previous.jobs,
      workflow: previous.workflow,
      workflow_error: previous.workflow_error,
    };
  });
}
