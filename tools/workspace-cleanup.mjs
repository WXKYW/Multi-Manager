import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');

const protectedPaths = [
  '.env',
  'data',
  'backup',
  'backend-go/data',
  'backend-go/internal/server/data',
  'node_modules',
  'public',
];

const fixedCleanablePaths = ['.cache', '.tmp', 'dist', 'backend-go/tmp', 'backend-go/api-monitor.exe', 'agent-rust/target'];

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function resolveRel(rel) {
  return path.resolve(root, rel);
}

function insideRoot(abs) {
  const relative = path.relative(root, abs);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const protectedAbs = protectedPaths.map(resolveRel);

function isProtected(abs) {
  return protectedAbs.some((protectedPath) => abs === protectedPath || abs.startsWith(`${protectedPath}${path.sep}`));
}

function exists(rel) {
  return fs.existsSync(resolveRel(rel));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sizeOf(abs) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    total += sizeOf(path.join(abs, entry.name));
  }
  return total;
}

function collectTemporaryTestFiles() {
  const testDir = resolveRel('test');
  if (!fs.existsSync(testDir)) return [];

  const results = [];
  for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^Trace-\d{8}T\d+\.json$/.test(entry.name) || entry.name === 'agent-install.test.js') {
      results.push(toPosix(path.join('test', entry.name)));
    }
  }
  return results;
}

function collectCandidates() {
  const seen = new Set();
  const candidates = [];
  for (const rel of [...fixedCleanablePaths, ...collectTemporaryTestFiles()]) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolveRel(rel);
    const existsNow = fs.existsSync(abs);
    candidates.push({
      rel,
      abs,
      exists: existsNow,
      size: existsNow ? sizeOf(abs) : 0,
    });
  }
  return candidates;
}

const candidates = collectCandidates();
const invalid = candidates.filter((item) => !insideRoot(item.abs) || isProtected(item.abs));
if (invalid.length) {
  console.error('Workspace cleanup refused unsafe targets:');
  for (const item of invalid) console.error(`  - ${item.rel}`);
  process.exit(1);
}

const total = candidates.reduce((sum, item) => sum + item.size, 0);

console.log(`Workspace cleanup mode: ${shouldApply ? 'apply' : 'check'}`);
console.log('');

console.log('Protected paths:');
for (const rel of protectedPaths) {
  const abs = resolveRel(rel);
  const status = fs.existsSync(abs) ? formatBytes(sizeOf(abs)) : 'missing';
  console.log(`  - ${rel} (${status})`);
}
console.log('');

console.log('Cleanable allowlist:');
for (const item of candidates) {
  const status = item.exists ? formatBytes(item.size) : 'missing';
  console.log(`  - ${item.rel} (${status})`);
}
console.log(`Total cleanable size: ${formatBytes(total)}`);

if (!shouldApply) {
  console.log('');
  console.log('No files deleted. Run npm run clean:workspace to delete only the allowlisted regenerable targets.');
  process.exit(0);
}

console.log('');
console.log('Deleting allowlisted targets:');
for (const item of candidates) {
  if (!item.exists) {
    console.log(`  - skipped ${item.rel} (missing)`);
    continue;
  }
  fs.rmSync(item.abs, { recursive: true, force: true });
  console.log(`  - deleted ${item.rel} (${formatBytes(item.size)})`);
}

console.log('Workspace cleanup completed.');

