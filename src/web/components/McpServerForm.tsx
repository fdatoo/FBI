import { useState } from 'react';
import type { McpServer } from '@shared/types.js';
import { CATALOG } from '../lib/catalog.js';

interface McpServerFormProps {
  initial: McpServer | null;
  onSave: (data: {
    name: string;
    type: 'stdio' | 'sse';
    command: string | null;
    args: string[];
    url: string | null;
    env: Record<string, string>;
  }) => void;
  onCancel: () => void;
  skipCatalog?: boolean;
}

export function McpServerForm({ initial, onSave, onCancel, skipCatalog }: McpServerFormProps) {
  const [showCatalog, setShowCatalog] = useState(initial === null && !skipCatalog);
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<'stdio' | 'sse'>(initial?.type ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? 'npx');
  const [argsText, setArgsText] = useState((initial?.args ?? []).join('\n'));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>(
    Object.entries(initial?.env ?? {}).map(([key, value]) => ({ key, value }))
  );

  function applyEntry(entry: (typeof CATALOG)[0]) {
    setName(entry.name);
    setType(entry.type);
    setCommand(entry.command);
    setArgsText(entry.args.join('\n'));
    setEnvRows(entry.requiredEnv.map((key) => ({ key, value: '' })));
    setShowCatalog(false);
  }

  function submit() {
    const env: Record<string, string> = {};
    for (const { key, value } of envRows) {
      if (key.trim()) env[key.trim()] = value;
    }
    onSave({
      name: name.trim(),
      type,
      command: type === 'stdio' ? command.trim() || null : null,
      args: type === 'stdio' ? argsText.split('\n').map((s) => s.trim()).filter(Boolean) : [],
      url: type === 'sse' ? url.trim() || null : null,
      env,
    });
  }

  if (showCatalog) {
    return (
      <div className="border rounded dark:border-gray-600 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b dark:border-gray-600 bg-gray-50 dark:bg-gray-800">
          <span className="text-sm font-medium">Choose from catalog</span>
          <button type="button" onClick={() => setShowCatalog(false)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Add custom instead →
          </button>
        </div>
        {CATALOG.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center justify-between px-3 py-2.5 border-b last:border-0 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
          >
            <div>
              <span className="text-sm font-medium">{entry.emoji} {entry.name}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">{entry.description}</span>
              {entry.requiredEnv.length > 0 && (
                <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">
                  requires {entry.requiredEnv.join(', ')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => applyEntry(entry)}
              className="text-xs bg-blue-600 text-white px-2.5 py-1 rounded hover:bg-blue-700"
            >
              Add
            </button>
          </div>
        ))}
        <div className="px-3 py-2 border-t dark:border-gray-700">
          <button type="button" onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded dark:border-gray-600 p-4 space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Type</label>
        <div className="flex gap-4">
          {(['stdio', 'sse'] as const).map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={type === t} onChange={() => setType(t)} /> {t}
            </label>
          ))}
        </div>
      </div>
      {type === 'stdio' ? (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Args <span className="font-normal text-gray-500">(one per line)</span></label>
            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="w-full border rounded px-2 py-1 text-sm font-mono dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium mb-1">URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100"
          />
        </div>
      )}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium">Environment variables</label>
          <button
            type="button"
            onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            + Add
          </button>
        </div>
        {envRows.length > 0 && (
          <div className="border rounded dark:border-gray-600 overflow-hidden">
            <div className="grid grid-cols-[1fr_1fr_auto] text-xs font-medium bg-gray-50 dark:bg-gray-800 border-b dark:border-gray-600">
              <div className="px-2 py-1.5">Key</div>
              <div className="px-2 py-1.5 border-l dark:border-gray-600">Value</div>
              <div className="px-2 py-1.5" />
            </div>
            {envRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] border-t dark:border-gray-600">
                <input
                  value={row.key}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[i] = { ...next[i], key: e.target.value };
                    setEnvRows(next);
                  }}
                  placeholder="KEY"
                  className="px-2 py-1 text-sm font-mono bg-transparent outline-none dark:text-gray-100"
                />
                <input
                  value={row.value}
                  onChange={(e) => {
                    const next = [...envRows];
                    next[i] = { ...next[i], value: e.target.value };
                    setEnvRows(next);
                  }}
                  placeholder="value or $SECRET_NAME"
                  className="px-2 py-1 text-sm font-mono bg-transparent outline-none border-l dark:border-gray-600 dark:text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => setEnvRows(envRows.filter((_, j) => j !== i))}
                  className="px-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Use <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">$SECRET_NAME</code> to reference a project secret
        </p>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="text-sm px-3 py-1.5 border rounded dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">
          Cancel
        </button>
        <button type="button" onClick={submit} className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700">
          {initial ? 'Save' : 'Add server'}
        </button>
      </div>
    </div>
  );
}
