import { describe, expect, it } from 'vitest';
import {
  formatDockerPruneResult,
  isDockerImagePruneCandidate,
  normalizeDockerTaskResult,
  summarizeDockerTaskMessage,
} from './dockerTasks.js';

describe('Docker task results', () => {
  it('marks a completed update check as failed when a container result has an error', () => {
    const task = normalizeDockerTaskResult({
      action: 'container.checkUpdates',
      state: 'success',
      message: JSON.stringify([
        { container_name: 'halowebui-go', error: 'registry timeout' },
      ]),
    });

    expect(task.state).toBe('failed');
    expect(task.error).toBe('halowebui-go: registry timeout');
    expect(summarizeDockerTaskMessage(task)).toBe('1 个容器检测失败');
  });

  it('prioritizes failed checks over available updates in mixed results', () => {
    const task = normalizeDockerTaskResult({
      action: 'container.checkUpdates',
      state: 'success',
      message: JSON.stringify([
        { container_name: 'web', has_update: true },
        { container_name: 'worker', error: 'unauthorized' },
        { container_name: 'cache', has_update: false },
      ]),
    });

    expect(task.state).toBe('failed');
    expect(summarizeDockerTaskMessage(task)).toBe('1 个容器检测失败，另有 1 个可更新');
  });

  it('keeps successful non-check tasks unchanged', () => {
    const task = { action: 'compose.update', state: 'success', message: 'Compose 操作 update 成功' };
    expect(normalizeDockerTaskResult(task)).toEqual(task);
  });

  it('formats structured prune results returned through the proxy envelope', () => {
    const data = {
      data: {
        message: JSON.stringify({ deleted: 3, reclaimed: '24.5 MB' }),
      },
    };

    expect(formatDockerPruneResult('image.prune', data)).toBe('已清理 3 个镜像，释放 24.5 MB');
    expect(formatDockerPruneResult('network.prune', { message: '{"deleted":2}' })).toBe('已清理 2 个网络');
  });
});

describe('Docker prune candidates', () => {
  it('uses the Agent dangling flag when present', () => {
    expect(isDockerImagePruneCandidate({ dangling: true, repository: 'example/app', tag: 'latest' })).toBe(true);
    expect(isDockerImagePruneCandidate({ dangling: false, repository: '<none>', tag: '<none>' })).toBe(false);
  });

  it('falls back to untagged image metadata for older Agents', () => {
    expect(isDockerImagePruneCandidate({ RepoTags: ['<none>:<none>'] })).toBe(true);
    expect(isDockerImagePruneCandidate({ RepoTags: ['example/app:latest'] })).toBe(false);
  });
});
