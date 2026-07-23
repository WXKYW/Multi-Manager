export const normalizeWorkflowJobName = (value) => String(value || '').trim().toLowerCase();

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const workflowTemplatePattern = (value) => String(value || '')
  .split(/\$\{\{[^}]+}}/g)
  .map((part) => escapeRegExp(part).replace(/\s+/g, '\\s+'))
  .join('.*');

const workflowMatrixJobMatches = (jobName, definition) => {
  if (!definition?.matrix) return false;
  const id = normalizeWorkflowJobName(definition.id);
  if (id === 'pytest-full') return /^run tests python .*\(\d+\)/.test(jobName);
  if (id === 'pytest-partial') return jobName.startsWith('run tests python ') && !/^run tests python .*\(\d+\)/.test(jobName);
  if (id === 'pytest-mariadb') return jobName.startsWith('run mariadb:') || jobName.startsWith('run mysql:');
  if (id === 'pytest-postgres') return jobName.startsWith('run postgres:');
  if (id === 'lint-hadolint') return jobName.startsWith('check dockerfile') || jobName.startsWith('check script/hassfest/dockerfile');
  if (id === 'base') return jobName.startsWith('prepare dependencies');
  if (id === 'audit-licenses') return jobName.startsWith('audit licenses');
  return false;
};

export const workflowJobMatchesDefinition = (job, definition) => {
  const jobName = normalizeWorkflowJobName(job?.name);
  const id = normalizeWorkflowJobName(definition?.id);
  const name = normalizeWorkflowJobName(definition?.name);
  if (!jobName) return false;
  if (workflowMatrixJobMatches(jobName, definition)) return true;
  if (name.includes('${{')) {
    const template = workflowTemplatePattern(definition.name);
    if (template && new RegExp(`^${template}$`, 'i').test(jobName)) return true;
  }
  return [id, name].some((value) => value && (
    jobName === value ||
    jobName.startsWith(`${value} (`) ||
    jobName.startsWith(`${value} / `) ||
    jobName.startsWith(`${value}:`)
  ));
};
