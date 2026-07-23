const HAPTIC_PATTERNS = {
  selection: 18,
  success: [22, 28, 18],
  warning: [28, 32, 28],
  error: [35, 36, 35],
};

let lastHapticAt = 0;

export function canUseHaptics() {
  if (typeof window === 'undefined') return false;
  if (!window.navigator || typeof window.navigator.vibrate !== 'function') return false;
  return true;
}

export function triggerHapticFeedback(type = 'selection') {
  if (!canUseHaptics()) return false;

  const now = Date.now();
  if (now - lastHapticAt < 60) return false;
  lastHapticAt = now;

  const pattern = HAPTIC_PATTERNS[type] || HAPTIC_PATTERNS.selection;
  return window.navigator.vibrate(pattern);
}
