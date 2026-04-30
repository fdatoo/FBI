import { useEffect, useState } from 'react';
import { Select } from '@ui/primitives/Select.js';
import { FieldLabel } from '@ui/primitives/FieldLabel.js';
import { api } from '../lib/api.js';

export interface RecentPromptsDropdownProps {
  projectId: number;
  onPick: (prompt: string) => void;
}

export function RecentPromptsDropdown({ projectId, onPick }: RecentPromptsDropdownProps) {
  const [prompts, setPrompts] = useState<string[]>([]);
  useEffect(() => {
    void api.getRecentPrompts(projectId)
      .then((rows) => setPrompts(rows.map((r) => r.prompt)))
      .catch(() => setPrompts([]));
  }, [projectId]);
  if (prompts.length === 0) return null;
  return (
    <div>
      <FieldLabel>Recent prompts</FieldLabel>
      <Select defaultValue="" onChange={(e) => { if (e.target.value) onPick(e.target.value); }}>
        <option value="" disabled>Pick a recent prompt…</option>
        {prompts.map((p, i) => <option key={i} value={p}>{p.slice(0, 80)}</option>)}
      </Select>
    </div>
  );
}
