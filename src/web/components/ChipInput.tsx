import { useId, useState } from 'react';

interface ChipInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export function ChipInput({ label, values, onChange, placeholder }: ChipInputProps) {
  const [draft, setDraft] = useState('');
  const inputId = useId();

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]);
    setDraft('');
  }

  return (
    <div className="block">
      <label htmlFor={inputId} className="block text-sm font-medium mb-1">{label}</label>
      <div className="flex flex-wrap gap-1.5 p-2 border rounded dark:border-gray-600 dark:bg-gray-900 min-h-[38px]">
        {values.map((v) => (
          <span
            key={v}
            className="flex items-center gap-1 bg-gray-200 dark:bg-gray-700 rounded px-2 py-0.5 text-sm"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="opacity-50 hover:opacity-100 leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          className="flex-1 min-w-[160px] bg-transparent outline-none text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
            if (e.key === 'Backspace' && (e.target as HTMLInputElement).value === '' && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ''}
        />
      </div>
    </div>
  );
}
