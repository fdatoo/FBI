import type { ChangesPayload } from '@shared/types.js';

export type ShipDot = 'amber' | 'accent' | null;

export function computeShipDot(p: ChangesPayload): ShipDot {
  if (!p.branch_name) return null;
  const behind = p.branch_base?.behind ?? 0;
  const ahead = p.branch_base?.ahead ?? 0;
  if (behind > 0) return 'amber';
  const gh = p.integrations.github;
  const prMerged = gh?.pr?.state === 'MERGED';
  const checksOk = !gh?.checks || gh.checks.state === 'success';
  if (ahead > 0 && !prMerged && checksOk) return 'accent';
  return null;
}
