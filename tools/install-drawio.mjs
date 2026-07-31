import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const version = '31.1.5';
const expectedSha256 = '43b0437762cf25375e233726d6539792584c4bd38176e4eceae5ea4359090278';
const root = process.cwd();
const target = path.join(root, 'src', 'pwa-public', 'vendor', 'drawio');
const indexFile = path.join(target, 'index.html');
const tempFile = path.join(root, '.tmp', `drawio-${version}.war`);

if (existsSync(indexFile)) {
  process.stdout.write(`draw.io ${version} assets already installed.\n`);
  process.exit(0);
}

mkdirSync(path.dirname(tempFile), { recursive: true });
mkdirSync(target, { recursive: true });
const response = await fetch(`https://github.com/jgraph/drawio/releases/download/v${version}/draw.war`);
if (!response.ok || !response.body) throw new Error(`draw.io download failed: HTTP ${response.status}`);
await pipeline(response.body, createWriteStream(tempFile));

const digest = createHash('sha256');
const bytes = await import('node:fs/promises').then(fs => fs.readFile(tempFile));
digest.update(bytes);
if (digest.digest('hex') !== expectedSha256) {
  rmSync(tempFile, { force: true });
  throw new Error('draw.io archive checksum mismatch');
}

const result = spawnSync('tar', ['-xf', tempFile, '-C', target], { stdio: 'inherit' });
if (result.status !== 0 || !existsSync(indexFile)) throw new Error('draw.io archive extraction failed');
process.stdout.write(`draw.io ${version} installed in ${target}.\n`);
