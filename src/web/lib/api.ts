import type {
  DailyUsage, ListeningPort, McpServer, Project, Run, RunUsageBreakdownRow, SecretName, Settings,
  UsageState, FileDiffPayload, ChangesPayload, HistoryOp, HistoryResult, FilesHeadEntry, FilesDirtyEntry,
} from '@shared/types.js';

let _baseUrl = '';

export function setApiBaseUrl(url: string): void {
  _baseUrl = url.replace(/\/$/, '');
}

export function apiBase(): string {
  return _baseUrl;
}

export function wsBase(): string {
  if (_baseUrl) {
    return _baseUrl.replace(/^http/, 'ws');
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function xhrUploadJson<T>(url: string, file: File, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', _baseUrl + url);
    xhr.responseType = 'text';
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error(`Non-JSON response: ${xhr.responseText}`));
        }
      } else {
        let err = 'unknown';
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body.error) err = body.error;
        } catch { /* keep 'unknown' */ }
        reject(new Error(`HTTP ${xhr.status}: ${err}`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('aborted'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(_baseUrl + url, {
      ...init,
      headers: {
        ...(init?.body != null ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
    throw new ApiError(res.status, `HTTP ${res.status}: ${text}`, body);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Expected JSON but got ${contentType}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export type McpServerInput = {
  name: string;
  type: 'stdio' | 'sse';
  command?: string | null;
  args?: string[];
  url?: string | null;
  env?: Record<string, string>;
};

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: number) => request<Project>(`/api/projects/${id}`),
  createProject: (body: Omit<Project, 'id' | 'created_at' | 'updated_at'>) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  updateProject: (id: number, patch: Partial<Omit<Project, 'id' | 'created_at' | 'updated_at'>>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  listSecrets: (projectId: number) =>
    request<SecretName[]>(`/api/projects/${projectId}/secrets`),
  upsertSecret: (projectId: number, name: string, value: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  removeSecret: (projectId: number, name: string) =>
    request<void>(`/api/projects/${projectId}/secrets/${name}`, { method: 'DELETE' }),

  listRuns: (state?: 'queued' | 'running' | 'waiting' | 'awaiting_resume' | 'succeeded' | 'failed' | 'cancelled') =>
    request<Run[]>(state ? `/api/runs?state=${state}` : '/api/runs'),
  listRunsPaged: (params: {
    state?: 'queued' | 'running' | 'waiting' | 'awaiting_resume' | 'succeeded' | 'failed' | 'cancelled';
    project_id?: number;
    q?: string;
    limit: number;
    offset: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.state) qs.set('state', params.state);
    if (typeof params.project_id === 'number') qs.set('project_id', String(params.project_id));
    if (params.q) qs.set('q', params.q);
    qs.set('limit', String(params.limit));
    qs.set('offset', String(params.offset));
    return request<{ items: Run[]; total: number }>(`/api/runs?${qs.toString()}`);
  },
  listProjectRuns: (projectId: number) =>
    request<Run[]>(`/api/projects/${projectId}/runs`),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
  getRunListeningPorts: (id: number) =>
    request<{ ports: ListeningPort[] }>(`/api/runs/${id}/listening-ports`),
  getRecentPrompts: (projectId: number, limit = 10) =>
    request<{ prompt: string; last_used_at: number; run_id: number }[]>(
      `/api/projects/${projectId}/prompts/recent?limit=${limit}`
    ),
  createRun: (
    projectId: number,
    prompt: string,
    branch?: string,
    draftToken?: string,
    modelParams?: {
      model: string | null;
      effort: string | null;
      subagent_model: string | null;
    },
    force?: boolean,
    mockOptions?: { mock: boolean; mock_scenario: string | null },
  ) =>
    request<Run>(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        branch: branch && branch.trim() !== '' ? branch.trim() : undefined,
        draft_token: draftToken ?? undefined,
        // Spread so null values serialize as null (server treats null === unset).
        ...(modelParams ?? {}),
        ...(mockOptions ?? {}),
        ...(force ? { force: true } : {}),
      }),
    }),
  deleteRun: (id: number) => request<void>(`/api/runs/${id}`, { method: 'DELETE' }),
  renameRun: (id: number, title: string) =>
    request<Run>(`/api/runs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  continueRun: (
    id: number,
    modelParams: {
      model: string | null;
      effort: string | null;
      subagent_model: string | null;
    },
  ) =>
    request<void>(`/api/runs/${id}/continue`, {
      method: 'POST',
      body: JSON.stringify(modelParams),
    }),

  getSettings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: {
    global_prompt?: string;
    notifications_enabled?: boolean;
    concurrency_warn_at?: number;
    image_gc_enabled?: boolean;
    global_marketplaces?: string[];
    global_plugins?: string[];
    auto_resume_enabled?: boolean;
    auto_resume_max_attempts?: number;
    usage_notifications_enabled?: boolean;
  }) => request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  runGc: () => request<{ deletedCount: number; deletedBytes: number }>(
    '/api/settings/run-gc', { method: 'POST', body: JSON.stringify({}) }),

  getConfigDefaults: () => request<{ defaultMarketplaces: string[]; defaultPlugins: string[] }>(
    '/api/config/defaults'
  ),

  createRunPr: (id: number) => request<{ number: number; url: string; state: string; title: string }>(
    `/api/runs/${id}/github/pr`, { method: 'POST', body: JSON.stringify({}) }),

  getRunChanges: (id: number) => request<ChangesPayload>(`/api/runs/${id}/changes`),

  getRunCommitFiles: (id: number, sha: string) =>
    request<{ files: FilesHeadEntry[] }>(`/api/runs/${id}/commits/${encodeURIComponent(sha)}/files`),

  getRunSubmoduleCommitFiles: (id: number, submodulePath: string, sha: string) =>
    request<{ files: FilesHeadEntry[] }>(
      `/api/runs/${id}/submodule/${submodulePath.split('/').map(encodeURIComponent).join('/')}/commits/${encodeURIComponent(sha)}/files`
    ),

  postRunHistory: (id: number, op: HistoryOp) =>
    request<HistoryResult>(`/api/runs/${id}/history`, {
      method: 'POST',
      body: JSON.stringify(op),
    }),

  getRunFileDiff: (id: number, path: string, ref: string = 'worktree') =>
    request<FileDiffPayload>(
      `/api/runs/${id}/file-diff?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`,
    ),

  getRunSiblings: (id: number) => request<Run[]>(`/api/runs/${id}/siblings`),

  getUsage: () => request<UsageState>('/api/usage'),
  getDailyUsage: (days = 14) => request<DailyUsage[]>(`/api/usage/daily?days=${days}`),
  listDailyUsage: (days = 14) => request<DailyUsage[]>(`/api/usage/daily?days=${days}`), // alias kept for UsagePage
  getRunUsageBreakdown: (runId: number) => request<RunUsageBreakdownRow[]>(`/api/usage/runs/${runId}`),

  // Global MCP servers
  listMcpServers: () => request<McpServer[]>('/api/mcp-servers'),
  createMcpServer: (input: McpServerInput) =>
    request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(input) }),
  updateMcpServer: (id: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMcpServer: (id: number) =>
    request<void>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),

  // Per-project MCP servers
  listProjectMcpServers: (projectId: number) =>
    request<McpServer[]>(`/api/projects/${projectId}/mcp-servers`),
  createProjectMcpServer: (projectId: number, input: McpServerInput) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProjectMcpServer: (projectId: number, serverId: number, patch: Partial<McpServerInput>) =>
    request<McpServer>(`/api/projects/${projectId}/mcp-servers/${serverId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProjectMcpServer: (projectId: number, serverId: number) =>
    request<void>(`/api/projects/${projectId}/mcp-servers/${serverId}`, { method: 'DELETE' }),

  // Draft and run file uploads
  uploadDraftFile: (
    file: File,
    draftToken: string | null,
    onProgress?: (pct: number) => void,
  ): Promise<{ draft_token: string; filename: string; size: number; uploaded_at: number }> => {
    const url = draftToken
      ? `/api/draft-uploads?draft_token=${encodeURIComponent(draftToken)}`
      : '/api/draft-uploads';
    return xhrUploadJson(url, file, onProgress);
  },

  deleteDraftFile: (draftToken: string, filename: string) =>
    request<void>(
      `/api/draft-uploads/${encodeURIComponent(draftToken)}/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    ),

  uploadRunFile: (
    runId: number,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ filename: string; size: number; uploaded_at: number }> =>
    xhrUploadJson(`/api/runs/${runId}/uploads`, file, onProgress),

  listRunUploads: (runId: number) =>
    request<{ files: Array<{ filename: string; size: number; uploaded_at: number }> }>(
      `/api/runs/${runId}/uploads`,
    ),

  deleteRunUpload: (runId: number, filename: string) =>
    request<void>(
      `/api/runs/${runId}/uploads/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    ),

  getRunWip: (id: number) =>
    request<{ ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[] } | { ok: false; reason: 'no-wip' }>(
      `/api/runs/${id}/wip`
    ),

  getRunWipFile: (id: number, path: string) =>
    request<FileDiffPayload>(
      `/api/runs/${id}/wip/file?path=${encodeURIComponent(path)}`
    ),

  discardRunWip: (id: number) =>
    request<void>(`/api/runs/${id}/wip/discard`, { method: 'POST' }),

  downloadRunWipPatch: (id: number): string =>
    `/api/runs/${id}/wip/patch`,

  fetchQuanticoScenarios: () =>
    request<{ scenarios: string[] }>('/api/quantico/scenarios'),

};
