import { useCallback, useEffect, useState } from 'react';
import type { SecretName } from '@shared/types.js';
import { api } from '../lib/api.js';
import { Input, Button } from '@ui/primitives/index.js';
import { EmptyState, ErrorState } from '@ui/patterns/index.js';

export function SecretsEditor({ projectId }: { projectId: number }) {
  const [names, setNames] = useState<SecretName[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setNames(await api.listSecrets(projectId));
  }, [projectId]);
  useEffect(() => { void refresh(); }, [refresh]);

  async function add() {
    if (!name) return;
    try {
      await api.upsertSecret(projectId, name, value);
      setName(''); setValue('');
      await refresh();
      setError(null);
    } catch (e) { setError(String(e)); }
  }
  async function remove(n: string) {
    try {
      await api.removeSecret(projectId, n);
      await refresh();
      setError(null);
    } catch (e) { setError(String(e)); }
  }

  return (
    <div className="bg-surface border border-border-strong rounded-md p-4 space-y-3">
      {names.length === 0 ? (
        <EmptyState title="No secrets" description="Add key/value secrets for this project." />
      ) : (
        <ul className="space-y-1">
          {names.map((s) => (
            <li key={s.name} className="flex justify-between items-center py-1 border-b border-border last:border-0">
              <code className="text-[14px] text-text font-mono">{s.name}</code>
              <Button variant="danger" size="sm" type="button" onClick={() => remove(s.name)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 items-center">
        <Input
          placeholder="NAME"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-40"
        />
        <Input
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          className="flex-1"
        />
        <Button type="button" variant="secondary" onClick={add}>
          Add
        </Button>
      </div>
      {error && <ErrorState message={error} />}
    </div>
  );
}
