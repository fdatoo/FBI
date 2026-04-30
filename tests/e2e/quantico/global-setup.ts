/**
 * Playwright globalSetup: warm the docker image cache before any tests run.
 *
 * Cold GitHub runners take ~2-3 minutes for the orchestrator's first image
 * build (apt-get install git/openssh + npm install -g claude-code in
 * postbuild.sh). Individual tests use 5-30s deadlines to assert on
 * scenario output, so the first one or two tests on a cold runner always
 * fail — and with parallel workers, the first batch all race the cold
 * build simultaneously, fail, and leave the next batch with a hot cache.
 *
 * Spin up a primer run via the API and poll until docker reports the run
 * has actually launched a container (state past "starting"). After that,
 * the project's image is cached in the docker daemon and every real test
 * starts with a warm cache.
 *
 * Locally with `reuseExistingServer: true`, the image is already built —
 * the warmup polls once, sees state has progressed, and returns in
 * seconds.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
// Cold cargo+npm build inside docker can run a couple of minutes on a fresh
// GitHub runner. 5 min gives plenty of slack.
const WARMUP_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;

interface ProjectRow { id: number }
interface RunRow { id: number; state: string }

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// Use a dedicated warmup project rather than ensureProject (which would
// pick up the test project). Reusing the test project would leave its
// run_id sequence + WIP repo state perturbed by the primer run, which
// shows up as flaky scroll/byte-loss assertions in tests that follow.
async function warmupProject(): Promise<number> {
  const list = await http<ProjectRow[]>('GET', '/api/projects');
  const existing = list.find((p) => (p as { name?: string }).name === 'e2e-warmup');
  if (existing) return existing.id;
  const created = await http<ProjectRow>('POST', '/api/projects', {
    name: 'e2e-warmup',
    repo_url: '/tmp/empty-repo.git',
    default_branch: 'main',
  });
  return created.id;
}

export default async function globalSetup(): Promise<void> {
  const start = Date.now();
  console.log('[globalSetup] warming up FBI docker image cache…');

  const projectId = await warmupProject();
  const run = await http<RunRow>('POST', `/api/projects/${projectId}/runs`, {
    prompt: 'warmup',
    mock: true,
    mock_scenario: 'crash-fast', // exits in ~1s once the container starts
  });
  const runId = run.id;
  console.log(`[globalSetup] primer run #${runId} created; polling for image build`);

  const deadline = start + WARMUP_TIMEOUT_MS;
  let lastState = run.state;
  // Wait for the primer to reach a TERMINAL state (succeeded / failed /
  // cancelled), not just leave `starting`. If we let it sit mid-lifecycle
  // and then DELETE, the orchestrator's await_and_complete races real
  // tests' run lifecycles and surfaces as flaky scroll/byte-loss
  // assertions in the tests that follow.
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'errored']);
  while (Date.now() < deadline) {
    let cur: RunRow;
    try {
      cur = await http<RunRow>('GET', `/api/runs/${runId}`);
    } catch (e) {
      console.log(`[globalSetup] poll error: ${e}; continuing`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    if (cur.state !== lastState) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[globalSetup] run #${runId}: ${lastState} → ${cur.state} (+${elapsed}s)`);
      lastState = cur.state;
    }
    if (TERMINAL.has(cur.state)) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Run is terminal — cleanup is a non-racy DELETE.
  try {
    await fetch(`${BASE}/api/runs/${runId}`, { method: 'DELETE' });
  } catch { /* noop */ }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[globalSetup] image cache warm; ${elapsed}s elapsed`);
}
