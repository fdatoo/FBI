import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setServerUrl } from '../lib/serverConfig.js';
import { Button, Input } from '@ui/primitives/index.js';

interface DiscoveredServer { name: string; url: string; }

export function ServerPicker({ onConnect }: { onConnect: (url: string) => void }) {
  const [input, setInput] = useState('');
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  async function discover() {
    setDiscovering(true);
    setError(null);
    try {
      const found = await invoke<DiscoveredServer[]>('discover_servers');
      setServers(found);
      if (found.length === 0) setError('No FBI servers found — enter a URL manually');
    } catch {
      setError('Could not reach Tailscale — enter a URL manually');
    } finally {
      setDiscovering(false);
    }
  }

  async function connect(url: string) {
    setConnecting(true);
    setError(null);
    try {
      await setServerUrl(url);
      onConnect(url);
    } catch {
      setError('Failed to save server URL — please try again');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-bg">
      <div className="w-full max-w-md p-8 space-y-6">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Connect to FBI server</h1>
        <p className="text-[14px] text-text-dim">
          Enter your FBI server URL or discover servers on your Tailscale network.
        </p>

        <div className="space-y-3">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="http://"
            className="w-full font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter' && input) void connect(input); }}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={discover}
              disabled={discovering}
              className="flex-1"
            >
              {discovering ? 'Searching…' : 'Discover'}
            </Button>
            <Button
              type="button"
              onClick={() => void connect(input)}
              disabled={!input || connecting}
              className="flex-1"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </div>

        {error && (
          <p className="text-[13px] text-fail">{error}</p>
        )}

        {servers.length > 0 && (
          <div className="space-y-1">
            <p className="text-[12px] text-text-faint uppercase tracking-wider">Discovered servers</p>
            {servers.map((s) => (
              <button
                key={s.url}
                type="button"
                className="w-full text-left px-3 py-2 rounded text-[13px] hover:bg-surface-raised transition-colors"
                onClick={() => setInput(s.url)}
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-text-dim ml-2">{s.url}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
