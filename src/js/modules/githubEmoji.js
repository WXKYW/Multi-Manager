const githubEmojiMap = {
  house_with_garden: '🏡',
  rocket: '🚀',
  sparkles: '✨',
  tada: '🎉',
  fire: '🔥',
  zap: '⚡',
  lightning: '⚡',
  star: '⭐',
  star2: '🌟',
  bug: '🐛',
  lock: '🔒',
  key: '🔑',
  warning: '⚠️',
  white_check_mark: '✅',
  x: '❌',
  construction: '🚧',
  memo: '📝',
  books: '📚',
  package: '📦',
  computer: '💻',
  robot: '🤖',
  cloud: '☁️',
  globe_with_meridians: '🌐',
  shield: '🛡️',
  wrench: '🔧',
  gear: '⚙️',
  heart: '❤️',
  eyes: '👀',
  bulb: '💡',
};

export const renderGitHubEmoji = (value) => String(value || '')
  .replace(/:([a-z0-9_+-]+):/gi, (match, name) => githubEmojiMap[String(name || '').toLowerCase()] || match);

export const formatGitHubRepositoryDescription = (value, fallback = '') => {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return renderGitHubEmoji(text);
};

export { githubEmojiMap };
