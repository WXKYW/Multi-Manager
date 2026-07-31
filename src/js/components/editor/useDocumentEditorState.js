import { useState, useCallback, useRef, useEffect } from 'react';

const DEFAULT_SETTINGS = {
  defaultMode: 'write',
  preferredSplitLayout: 'edit-preview',
  showOutline: true,
  showStatusBar: true,
};

/**
 * 文档编辑器共享状态 hook。
 * 管理模式 (write/split/source)、内容、dirty 标记、保存状态和大纲。
 */
export function useDocumentEditorState(initialMarkdown = '', settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };

  const [mode, setMode] = useState(merged.defaultMode);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [showOutline, setShowOutline] = useState(merged.showOutline);
  const [showPreview, setShowPreview] = useState(merged.defaultMode === 'split');
  const [outline, setOutline] = useState([]);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  const dirtyRef = useRef(false);
  const markdownRef = useRef(initialMarkdown);

  const updateMarkdown = useCallback((next) => {
    const value = typeof next === 'function' ? next(markdownRef.current) : next;
    markdownRef.current = value;
    setMarkdown(value);
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
    // Update counts
    const text = String(value ?? '');
    setCharCount(text.length);
    setWordCount(text.trim() ? text.trim().split(/\s+/).length : 0);
  }, []);

  const markSaved = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
    setSaveState('saved');
    setLastSavedAt(Date.now());
  }, []);

  const markSaving = useCallback(() => {
    setSaveState('saving');
  }, []);

  const markSaveError = useCallback(() => {
    setSaveState('error');
  }, []);

  const updateOutline = useCallback((items) => {
    setOutline(items || []);
  }, []);

  // Extract outline from markdown headings
  useEffect(() => {
    const headings = [];
    const regex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    const text = markdownRef.current || '';
    while ((match = regex.exec(text)) !== null) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        id: `heading-${headings.length}`,
      });
    }
    setOutline(headings);
  }, [markdown]);

  const toggleOutline = useCallback(() => setShowOutline((v) => !v), []);
  const togglePreview = useCallback(() => setShowPreview((v) => !v), []);

  return {
    mode,
    setMode,
    markdown,
    setMarkdown: updateMarkdown,
    dirty,
    saveState,
    setSaveState,
    lastSavedAt,
    markSaved,
    markSaving,
    markSaveError,
    showOutline,
    setShowOutline,
    toggleOutline,
    showPreview,
    setShowPreview,
    togglePreview,
    outline,
    updateOutline,
    wordCount,
    charCount,
    markdownRef,
  };
}
