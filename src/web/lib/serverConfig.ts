import { isTauri, invoke } from '@tauri-apps/api/core';

export async function getServerUrl(): Promise<string> {
  if (!isTauri()) return '';
  return invoke<string>('get_server_url');
}

export async function setServerUrl(url: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('set_server_url', { url });
}
