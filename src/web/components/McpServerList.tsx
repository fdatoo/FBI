import { useEffect, useState } from 'react';
import type { McpServer } from '@shared/types.js';
import { api } from '../lib/api.js';
import { McpServerForm } from './McpServerForm.js';
import type { McpServerInput } from '../lib/api.js';

interface McpServerListProps {
  projectId: number | null; // null = global
  label?: string;
}

type FormState =
  | { mode: 'closed' }
  | { mode: 'catalog' }
  | { mode: 'custom' }
  | { mode: 'edit'; server: McpServer };

export function McpServerList({ projectId, label = 'MCP servers' }: McpServerListProps) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [form, setForm] = useState<FormState>({ mode: 'closed' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const list =
          projectId === null
            ? await api.listMcpServers()
            : await api.listProjectMcpServers(projectId);
        setServers(list);
      } catch (err) {
        setError(String(err));
      }
    }
    void load();
  }, [projectId]);

  async function handleSave(data: McpServerInput) {
    setError(null);
    try {
      if (form.mode === 'edit') {
        const updated =
          projectId === null
            ? await api.updateMcpServer(form.server.id, data)
            : await api.updateProjectMcpServer(projectId, form.server.id, data);
        setServers(servers.map((s) => (s.id === updated.id ? updated : s)));
      } else {
        const created =
          projectId === null
            ? await api.createMcpServer(data)
            : await api.createProjectMcpServer(projectId, data);
        setServers([...servers, created]);
      }
      setForm({ mode: 'closed' });
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleDelete(server: McpServer) {
    setError(null);
    try {
      if (projectId === null) {
        await api.deleteMcpServer(server.id);
      } else {
        await api.deleteProjectMcpServer(projectId, server.id);
      }
      setServers(servers.filter((s) => s.id !== server.id));
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">{label}</span>
        {form.mode === 'closed' && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForm({ mode: 'catalog' })}
              className="text-xs px-2.5 py-1 border rounded dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              + From catalog
            </button>
            <button
              type="button"
              onClick={() => setForm({ mode: 'custom' })}
              className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              + Add custom
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>}

      {servers.length > 0 && (
        <div className="border rounded dark:border-gray-600 overflow-hidden mb-3">
          {servers.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-3 py-2.5 border-b last:border-0 dark:border-gray-700 text-sm"
            >
              <div className="min-w-0">
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                  {s.type} ·{' '}
                  {s.type === 'stdio'
                    ? `${s.command ?? 'npx'} ${s.args.join(' ')}`
                    : s.url}
                </span>
              </div>
              <div className="flex gap-1.5 ml-3 shrink-0">
                {Object.keys(s.env).length > 0 && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {Object.keys(s.env).length} env
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setForm({ mode: 'edit', server: s })}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-1.5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(s)}
                  className="text-xs text-red-500 hover:text-red-700 px-1.5"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(form.mode === 'catalog' || form.mode === 'custom' || form.mode === 'edit') && (
        <McpServerForm
          initial={form.mode === 'edit' ? form.server : null}
          skipCatalog={form.mode === 'custom'}
          onSave={handleSave}
          onCancel={() => setForm({ mode: 'closed' })}
        />
      )}
    </div>
  );
}
