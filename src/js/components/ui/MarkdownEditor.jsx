import React, { useEffect, useRef, useState } from 'react';
import { Tabs } from '@cloudflare/kumo';
import { CodeFile, Eye } from '../Icons.jsx';
import { TOOL_TABS_PROPS } from '../../modules/kumoTabs.js';
import CodeEditor from './CodeEditor.jsx';

const EDITOR_MODES = [
  {
    value: 'visual',
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Eye className="h-3.5 w-3.5" />
        所见即所得
      </span>
    ),
  },
  {
    value: 'source',
    label: (
      <span className="inline-flex items-center gap-1.5">
        <CodeFile className="h-3.5 w-3.5" />
        源码
      </span>
    ),
  },
];

function VisualMarkdownEditor({ value, onChange, readOnly, label, placeholder }) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  const valueRef = useRef(String(value ?? ''));
  const onChangeRef = useRef(onChange);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const nextValue = String(value ?? '');
    valueRef.current = nextValue;
    const crepe = crepeRef.current;
    if (crepe && crepe.getMarkdown() !== nextValue) {
      setRevision(current => current + 1);
    }
  }, [value]);

  useEffect(() => {
    crepeRef.current?.setReadonly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    let cancelled = false;
    let instance = null;
    setStatus('loading');

    const createEditor = async () => {
      try {
        const [{ createMarkdownWysiwyg }] = await Promise.all([
          import('../../modules/markdownWysiwygRuntime.js'),
          import('@milkdown/crepe/theme/common/style.css'),
          import('@milkdown/crepe/theme/classic.css'),
        ]);
        if (cancelled || !rootRef.current) return;

        instance = createMarkdownWysiwyg({
          root: rootRef.current,
          defaultValue: valueRef.current,
          placeholder,
        });
        instance.on(listener => {
          listener.markdownUpdated((_ctx, markdown) => {
            valueRef.current = markdown;
            onChangeRef.current?.(markdown);
          });
        });
        instance.setReadonly(readOnly);
        await instance.create();
        if (cancelled) {
          await instance.destroy();
          return;
        }
        crepeRef.current = instance;
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    void createEditor();
    return () => {
      cancelled = true;
      if (crepeRef.current === instance) crepeRef.current = null;
      if (instance) void instance.destroy();
    };
  }, [placeholder, readOnly, revision]);

  return (
    <div className="app-markdown-editor-visual" aria-label={label} aria-busy={status === 'loading'}>
      <div ref={rootRef} className="app-markdown-editor-crepe" />
      {status === 'loading' ? (
        <div className="app-markdown-editor-state">正在加载编辑器</div>
      ) : null}
      {status === 'error' ? (
        <div className="app-markdown-editor-state text-kumo-error">
          编辑器加载失败，请切换到源码模式
        </div>
      ) : null}
    </div>
  );
}

export default function MarkdownEditor({
  value = '',
  onChange,
  label = 'Markdown 编辑器',
  readOnly = false,
  className = '',
  minHeight = '18rem',
  placeholder = '输入 Markdown 内容',
  defaultMode = 'visual',
}) {
  const [mode, setMode] = useState(defaultMode === 'source' ? 'source' : 'visual');

  return (
    <div className={`app-markdown-editor ${className}`.trim()} style={{ minHeight }}>
      <div className="app-markdown-editor-header">
        <span className="truncate text-xs font-semibold text-kumo-strong">{label}</span>
        <Tabs {...TOOL_TABS_PROPS} value={mode} onValueChange={setMode} tabs={EDITOR_MODES} />
      </div>
      <div className="app-markdown-editor-body">
        {mode === 'source' ? (
          <CodeEditor
            value={value}
            onChange={onChange}
            fileName="document.md"
            language="markdown"
            label={`${label}源码`}
            readOnly={readOnly}
            placeholder={placeholder}
            showHeader={false}
            showLanguage={false}
            lineWrapping
            minHeight="100%"
          />
        ) : (
          <VisualMarkdownEditor
            value={value}
            onChange={onChange}
            readOnly={readOnly}
            label={label}
            placeholder={placeholder}
          />
        )}
      </div>
    </div>
  );
}
