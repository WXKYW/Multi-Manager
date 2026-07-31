import React from 'react';
import { formatDateTime } from '../../modules/utils.js';

/**
 * 文档状态栏 — 显示字数、字符数、大纲条目数和最后保存时间。
 */
export default function DocumentStatusBar({
  wordCount = 0,
  charCount = 0,
  outlineCount = 0,
  lastSavedAt = null,
  className = '',
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-4 border-t border-kumo-line px-3 py-1.5 text-[11px] text-kumo-subtle ${className}`.trim()}
    >
      <span>{charCount} 字符</span>
      <span>{wordCount} 词</span>
      {outlineCount > 0 && <span>{outlineCount} 个标题</span>}
      {lastSavedAt && (
        <span className="ml-auto">
          上次保存 {formatDateTime(new Date(lastSavedAt))}
        </span>
      )}
    </div>
  );
}
