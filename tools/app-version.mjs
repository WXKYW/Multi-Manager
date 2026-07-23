import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function normalizeReleaseVersion(value, fallback = '0.0.0') {
  const match = String(value || '')
    .trim()
    .match(SEMVER_PATTERN);
  if (match) return `v${match[1]}`;

  const fallbackMatch = String(fallback || '')
    .trim()
    .match(SEMVER_PATTERN);
  return `v${fallbackMatch?.[1] || '0.0.0'}`;
}

export function formatDevelopmentVersion(commitSha) {
  const normalizedSha = String(commitSha || '')
    .trim()
    .toLowerCase();
  return `dev-${normalizedSha ? normalizedSha.slice(-4) : 'local'}`;
}

export function resolveAppVersion({
  explicitVersion = '',
  refName = '',
  branchName = '',
  commitSha = '',
  packageVersion = '0.0.0',
} = {}) {
  const explicit = String(explicitVersion || '').trim();
  if (explicit) {
    return SEMVER_PATTERN.test(explicit)
      ? normalizeReleaseVersion(explicit, packageVersion)
      : explicit;
  }

  const ref = String(refName || '').trim();
  const tagName = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (SEMVER_PATTERN.test(tagName)) {
    return normalizeReleaseVersion(tagName, packageVersion);
  }

  const branch = String(branchName || ref.replace(/^refs\/heads\//, '')).trim();
  if (branch === 'main' || branch === 'master') {
    return normalizeReleaseVersion(packageVersion);
  }

  return formatDevelopmentVersion(commitSha);
}

function readGitValue(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function resolveAppVersionFromEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  let packageVersion = '0.0.0';
  try {
    const packageJson = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    packageVersion = packageJson.version || packageVersion;
  } catch {
    // Keep the safe fallback for unusual build contexts.
  }

  return resolveAppVersion({
    explicitVersion: env.VITE_APP_VERSION,
    refName: env.GITHUB_REF || env.GITHUB_REF_NAME,
    branchName: env.GITHUB_HEAD_REF || readGitValue(cwd, ['branch', '--show-current']),
    commitSha: env.GITHUB_SHA || readGitValue(cwd, ['rev-parse', 'HEAD']),
    packageVersion,
  });
}
