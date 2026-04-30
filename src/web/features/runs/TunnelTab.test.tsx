import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TunnelTab } from './TunnelTab.js';

describe('TunnelTab', () => {
  const origin = 'https://fbi.tailnet:3000';

  it('renders command, download URL, and port rows when running', () => {
    render(
      <TunnelTab
        runId={42}
        runState="running"
        origin={origin}
        ports={[{ port: 5173, proto: 'tcp' }, { port: 9229, proto: 'tcp' }]}
        detected={{ os: 'darwin', arch: 'arm64' }}
      />,
    );
    expect(screen.getByText('fbi-tunnel https://fbi.tailnet:3000 42')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download fbi-tunnel for macos \(arm64\)/i }))
      .toHaveAttribute('href', `${origin}/api/cli/fbi-tunnel/darwin/arm64`);
    expect(screen.getByText('5173')).toBeInTheDocument();
    expect(screen.getByText('9229')).toBeInTheDocument();
  });

  it('shows the empty-ports hint when running but ports=[]', () => {
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/no listening ports yet/i)).toBeInTheDocument();
  });

  it('shows state-specific hint when run is queued', () => {
    render(
      <TunnelTab runId={42} runState="queued" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/run is queued/i)).toBeInTheDocument();
  });

  it('shows state-specific hint when run is awaiting_resume', () => {
    render(
      <TunnelTab runId={42} runState="awaiting_resume" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/paused awaiting token resume/i)).toBeInTheDocument();
  });

  it('treats "waiting" like "running": ports table shown when ports exist, copy enabled', () => {
    render(
      <TunnelTab runId={42} runState="waiting" origin={origin}
        ports={[{ port: 5173, proto: 'tcp' }]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText('5173')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy command/i })).not.toBeDisabled();
    expect(screen.queryByText(/run ended/i)).toBeNull();
  });

  it('shows the empty-ports hint when waiting but ports=[]', () => {
    render(
      <TunnelTab runId={42} runState="waiting" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByText(/no listening ports yet/i)).toBeInTheDocument();
  });

  it('shows "run ended" hint for terminal states', () => {
    for (const s of ['succeeded', 'failed', 'cancelled'] as const) {
      const { unmount } = render(
        <TunnelTab runId={42} runState={s} origin={origin} ports={[]}
          detected={{ os: 'darwin', arch: 'arm64' }} />,
      );
      expect(screen.getByText(/run ended/i)).toBeInTheDocument();
      unmount();
    }
  });

  it('disables the copy button when runState is not running', () => {
    render(
      <TunnelTab runId={42} runState="succeeded" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    expect(screen.getByRole('button', { name: /copy command/i })).toBeDisabled();
  });

  it('copies the command to clipboard when the copy button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /copy command/i }));
    expect(writeText).toHaveBeenCalledWith('fbi-tunnel https://fbi.tailnet:3000 42');
  });

  it('renders an "other platforms" toggle listing the three non-detected binaries', () => {
    render(
      <TunnelTab runId={42} runState="running" origin={origin} ports={[]}
        detected={{ os: 'darwin', arch: 'arm64' }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /other platforms/i }));
    expect(screen.getByRole('link', { name: /darwin\/amd64/i })).toHaveAttribute('href', `${origin}/api/cli/fbi-tunnel/darwin/amd64`);
    expect(screen.getByRole('link', { name: /linux\/amd64/i })).toHaveAttribute('href', `${origin}/api/cli/fbi-tunnel/linux/amd64`);
    expect(screen.getByRole('link', { name: /linux\/arm64/i })).toHaveAttribute('href', `${origin}/api/cli/fbi-tunnel/linux/arm64`);
    // The detected one should not also appear in the "other" list.
    expect(screen.queryByRole('link', { name: /darwin\/arm64/i })).toBeNull();
  });
});
