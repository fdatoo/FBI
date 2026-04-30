import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelParamsCollapse } from './ModelParamsCollapse.js';

describe('ModelParamsCollapse', () => {
  const nullParams = { model: null, effort: null, subagent_model: null };

  it('renders a summary line with "default" / "inherit" when all values are null', () => {
    render(<ModelParamsCollapse value={nullParams} onChange={() => {}} />);
    const summary = screen.getByTestId('modelparams-summary');
    expect(summary.textContent).toMatch(/default/);
    expect(summary.textContent).toMatch(/inherit/);
  });

  it('renders concrete values in the summary when set', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: 'sonnet' }}
        onChange={() => {}}
      />,
    );
    const summary = screen.getByTestId('modelparams-summary');
    expect(summary.textContent).toMatch(/opus/);
    expect(summary.textContent).toMatch(/xhigh/);
    expect(summary.textContent).toMatch(/sonnet/);
  });

  it('is collapsed by default; clicking the header expands the controls', () => {
    render(<ModelParamsCollapse value={nullParams} onChange={() => {}} />);
    expect(screen.queryByTestId('modelparams-model-select')).toBeNull();
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    expect(screen.getByTestId('modelparams-model-select')).toBeInTheDocument();
  });

  it('effort options match the selected model — opus includes xhigh', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    const values = Array.from(effort.options).map((o) => o.value);
    expect(values).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('effort options exclude xhigh when model is sonnet', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'sonnet', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    const values = Array.from(effort.options).map((o) => o.value);
    expect(values).toEqual(['', 'low', 'medium', 'high', 'max']);
  });

  it('disables effort when model = haiku', () => {
    render(
      <ModelParamsCollapse
        value={{ model: 'haiku', effort: null, subagent_model: null }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    const effort = screen.getByTestId('modelparams-effort-select') as HTMLSelectElement;
    expect(effort.disabled).toBe(true);
  });

  it('clears effort when model switches to haiku', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-model-select'), {
      target: { value: 'haiku' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'haiku',
      effort: null,
      subagent_model: null,
    });
  });

  it('clears effort when it becomes invalid (opus+xhigh → sonnet)', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: 'xhigh', subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-model-select'), {
      target: { value: 'sonnet' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'sonnet',
      effort: null,
      subagent_model: null,
    });
  });

  it('emits onChange with the new effort value', () => {
    const onChange = vi.fn();
    render(
      <ModelParamsCollapse
        value={{ model: 'opus', effort: null, subagent_model: null }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('modelparams-toggle'));
    fireEvent.change(screen.getByTestId('modelparams-effort-select'), {
      target: { value: 'high' },
    });
    expect(onChange).toHaveBeenCalledWith({
      model: 'opus',
      effort: 'high',
      subagent_model: null,
    });
  });
});
