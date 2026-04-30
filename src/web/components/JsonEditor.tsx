import { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { createTheme } from '@uiw/codemirror-themes';
import { json } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';

const lightTheme = createTheme({
  theme: 'light',
  settings: {
    background: '#ffffff',
    foreground: '#111827',
    caret: '#111827',
    selection: '#dbeafe',
    selectionMatch: '#dbeafe',
    lineHighlight: 'transparent',
    gutterBackground: '#f9fafb',
    gutterForeground: '#9ca3af',
  },
  styles: [
    { tag: t.propertyName, color: '#1d4ed8' },
    { tag: t.string, color: '#15803d' },
    { tag: t.number, color: '#b45309' },
    { tag: t.bool, color: '#7c3aed' },
    { tag: t.null, color: '#7c3aed' },
  ],
});

const darkTheme = createTheme({
  theme: 'dark',
  settings: {
    background: '#111827',
    foreground: '#f3f4f6',
    caret: '#f3f4f6',
    selection: '#1f2937',
    selectionMatch: '#1f2937',
    lineHighlight: 'transparent',
    gutterBackground: '#111827',
    gutterForeground: '#6b7280',
  },
  styles: [
    { tag: t.propertyName, color: '#93c5fd' },
    { tag: t.string, color: '#86efac' },
    { tag: t.number, color: '#fdba74' },
    { tag: t.bool, color: '#c4b5fd' },
    { tag: t.null, color: '#c4b5fd' },
  ],
});

interface JsonEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function JsonEditor({ label, value, onChange }: JsonEditorProps) {
  // We toggle `.light` on <html>, not `.dark`. Dark is the default (no class).
  // NOTE: CodeMirror theme objects use intentional concrete hex colors — they are opaque
  // and cannot resolve CSS variables. TODO: read from tokens.css at mount time.
  const [isDark, setIsDark] = useState(() =>
    !document.documentElement.classList.contains('light')
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(!document.documentElement.classList.contains('light'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const status = parseStatus(value);

  return (
    <label className="block">
      <span className="block text-[14px] font-medium text-text-dim mb-1.5">{label}</span>
      <div className="border border-border-strong rounded-md overflow-hidden bg-surface-sunken">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={[json()]}
          theme={isDark ? darkTheme : lightTheme}
          minHeight="112px"
          className="text-sm"
        />
      </div>
      {status === 'valid' && (
        <p className="mt-1 text-[13px] text-ok">✓ Valid JSON</p>
      )}
      {status !== 'valid' && status !== 'empty' && (
        <p className="mt-1 text-[13px] text-fail">✗ {status}</p>
      )}
    </label>
  );
}

function parseStatus(value: string): 'valid' | 'empty' | string {
  if (!value.trim()) return 'empty';
  try {
    JSON.parse(value);
    return 'valid';
  } catch (e) {
    return (e as Error).message;
  }
}
