const numberOrZero = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const summarizeDockerContainers = (docker, getContainerState) => {
  const containers = Array.isArray(docker?.containers) ? docker.containers : [];
  if (containers.length > 0) {
    let running = 0;
    let paused = 0;
    containers.forEach((container) => {
      const state = getContainerState(container);
      if (state === 'running') running += 1;
      if (state === 'paused') paused += 1;
    });
    return {
      containers,
      total: containers.length,
      running,
      paused,
      stopped: Math.max(0, containers.length - running - paused),
      hasDetails: true,
    };
  }

  const running = numberOrZero(docker?.runningCount ?? docker?.running);
  const stopped = numberOrZero(docker?.stoppedCount ?? docker?.stopped);
  return {
    containers,
    total: running + stopped,
    running,
    paused: 0,
    stopped,
    hasDetails: false,
  };
};
