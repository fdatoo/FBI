import { useEffect, useState } from 'react';
import type { Run } from '@shared/types.js';
import { Dialog } from '@ui/primitives/Dialog.js';
import { Button } from '@ui/primitives/Button.js';
import { ModelParamsCollapse, type ModelParamsValue } from './ModelParamsCollapse.js';

export function ContinueRunDialog(props: {
  run: Run;
  open: boolean;
  onClose: () => void;
  onSubmit: (params: ModelParamsValue) => Promise<void> | void;
}): JSX.Element | null {
  const { run, open, onClose, onSubmit } = props;
  const [value, setValue] = useState<ModelParamsValue>({
    model: run.model,
    effort: run.effort,
    subagent_model: run.subagent_model,
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValue({
        model: run.model,
        effort: run.effort,
        subagent_model: run.subagent_model,
      });
    }
  }, [open, run.id, run.model, run.effort, run.subagent_model]);

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    try {
      await onSubmit(value);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Continue run">
      <div data-testid="continue-dialog" className="space-y-4">
        <p className="text-[13px] text-text-dim">
          Model params are pre-filled from this run. Change any to override on resume.
        </p>
        <ModelParamsCollapse value={value} onChange={setValue} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Continuing…' : 'Continue'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
