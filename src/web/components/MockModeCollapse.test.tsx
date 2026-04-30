import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockModeCollapse } from './MockModeCollapse.js';

describe('MockModeCollapse', () => {
  it('renders nothing when scenarios prop is null (capability off)', () => {
    const { container } = render(
      <MockModeCollapse value={{ mock: false, mock_scenario: null }} onChange={() => {}} scenarios={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('toggling the checkbox flips `mock`', async () => {
    const onChange = vi.fn();
    render(<MockModeCollapse
      value={{ mock: false, mock_scenario: null }}
      onChange={onChange}
      scenarios={['default', 'limit-breach']}
    />);
    await userEvent.click(screen.getByTestId('mockmode-toggle'));
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith({ mock: true, mock_scenario: 'default' });
  });

  it('changing the scenario dropdown updates mock_scenario', async () => {
    const onChange = vi.fn();
    render(<MockModeCollapse
      value={{ mock: true, mock_scenario: 'default' }}
      onChange={onChange}
      scenarios={['default', 'limit-breach']}
    />);
    await userEvent.click(screen.getByTestId('mockmode-toggle'));
    await userEvent.selectOptions(screen.getByTestId('mockmode-scenario-select'), 'limit-breach');
    expect(onChange).toHaveBeenCalledWith({ mock: true, mock_scenario: 'limit-breach' });
  });
});
