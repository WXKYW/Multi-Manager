export const getOSIconClass = (platform, { offline = false } = {}) => {
  const baseClass = 'shrink-0 text-base leading-none';
  const stateClass = offline ? 'text-kumo-subtle opacity-60 grayscale' : '';
  const value = String(platform || '').toLowerCase();
  let icon = 'fas fa-server text-kumo-subtle';
  if (value.includes('debian')) icon = 'si si-debian si--color';
  else if (value.includes('ubuntu')) icon = 'si si-ubuntu si--color';
  else if (value.includes('centos')) icon = 'si si-centos si--color';
  else if (value.includes('alpine')) icon = 'si si-alpinelinux si--color';
  else if (value.includes('redhat') || value.includes('rhel')) icon = 'si si-redhat si--color';
  else if (value.includes('fedora')) icon = 'si si-fedora si--color';
  else if (value.includes('rocky')) icon = 'si si-rockylinux si--color';
  else if (value.includes('alma')) icon = 'si si-almalinux si--color';
  else if (value.includes('arch')) icon = 'si si-archlinux si--color';
  else if (value.includes('windows')) icon = 'fab fa-windows app-os-windows';
  else if (value.includes('darwin') || value.includes('mac')) icon = 'si si-apple si--color';
  else if (value) icon = 'si si-linux si--color';
  return `${icon} ${baseClass} ${stateClass}`.trim();
};

export const getServerPlatformLabel = (server) => [
  server?.platform,
  server?.platform_version || server?.platformVersion,
].filter(Boolean).join(' ');
