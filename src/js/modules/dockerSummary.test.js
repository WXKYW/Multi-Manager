import { describe, expect, it } from 'vitest';
import { summarizeDockerContainers } from './dockerSummary.js';

const stateOf = (container) => container.state;

describe('summarizeDockerContainers', () => {
  it('uses container details when they are available', () => {
    const summary = summarizeDockerContainers({
      running: 99,
      stopped: 99,
      containers: [{ state: 'running' }, { state: 'paused' }, { state: 'exited' }],
    }, stateOf);
    expect(summary).toMatchObject({ total: 3, running: 1, paused: 1, stopped: 1, hasDetails: true });
  });

  it('falls back to Agent aggregate counts when details are omitted', () => {
    const summary = summarizeDockerContainers({ runningCount: 7, stoppedCount: 2, containers: [] }, stateOf);
    expect(summary).toMatchObject({ total: 9, running: 7, paused: 0, stopped: 2, hasDetails: false });
  });

  it('normalizes invalid aggregate values', () => {
    const summary = summarizeDockerContainers({ running: -1, stopped: 'invalid' }, stateOf);
    expect(summary).toMatchObject({ total: 0, running: 0, stopped: 0 });
  });
});
