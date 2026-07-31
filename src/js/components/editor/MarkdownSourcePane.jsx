import React from 'react';
import CodeEditor from '../ui/CodeEditor.jsx';

/**
 * 源码编辑面板 — 基于共享 CodeEditor。
 * 用于沉浸式工作区的 source 模式。
 */
export default function MarkdownSourcePane({
  value = '',
  onChange,
  readOnly = false,
  placeholder = '输入 Markdown 内容',
  label = 'Markdown 源码',
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeEditor
        value={value}
        onChange={onChange}
        fileName="document.md"
        language="markdown"
        label={label}
        readOnly={readOnly}
        placeholder={placeholder}
        showHeader={false}
        showLanguage={false}
        lineWrapping
        minHeight="100%"
        variant="embedded"
        className="flex-1"
      />
    </div>
  );
}
