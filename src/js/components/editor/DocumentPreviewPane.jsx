import React from 'react';
import { renderMarkdown } from '../../modules/markdown.js';

/**
 * 统一 Markdown 预览面板。
 * 复用现有 renderMarkdown 函数（marked + DOMPurify + katex）。
 */
export default function DocumentPreviewPane({
  markdown = '',
  className = '',
}) {
  const html = React.useMemo(() => renderMarkdown(markdown), [markdown]);

  return (
    <div
      className={`app-markdown-preview prose prose-sm max-w-none overflow-auto p-4 ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
