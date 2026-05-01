import type {
  UsageSnapshot, RunWsStateMessage, RunWsTitleMessage, RunWsBranchMessage, ChangesPayload,
} from '@shared/types.js';

type UsageListener = (runId: number, snapshot: UsageSnapshot) => void;
type StateListener = (runId: number, frame: RunWsStateMessage) => void;
type TitleListener = (runId: number, frame: RunWsTitleMessage) => void;
type BranchListener = (runId: number, frame: RunWsBranchMessage) => void;
type ChangesListener = (runId: number, payload: ChangesPayload) => void;

const usageListeners = new Set<UsageListener>();
const stateListeners = new Set<StateListener>();
const titleListeners = new Set<TitleListener>();
const branchListeners = new Set<BranchListener>();
const changesListeners = new Set<ChangesListener>();

export function publishUsage(runId: number, s: UsageSnapshot): void {
  for (const l of usageListeners) l(runId, s);
}
export function publishState(runId: number, frame: RunWsStateMessage): void {
  for (const l of stateListeners) l(runId, frame);
}
export function publishTitle(runId: number, frame: RunWsTitleMessage): void {
  for (const l of titleListeners) l(runId, frame);
}
export function publishBranch(runId: number, frame: RunWsBranchMessage): void {
  for (const l of branchListeners) l(runId, frame);
}
export function publishChanges(runId: number, payload: ChangesPayload): void {
  for (const l of changesListeners) l(runId, payload);
}
export function subscribeUsage(l: UsageListener): () => void {
  usageListeners.add(l);
  return () => { usageListeners.delete(l); };
}
export function subscribeState(l: StateListener): () => void {
  stateListeners.add(l);
  return () => { stateListeners.delete(l); };
}
export function subscribeTitle(l: TitleListener): () => void {
  titleListeners.add(l);
  return () => { titleListeners.delete(l); };
}
export function subscribeBranch(l: BranchListener): () => void {
  branchListeners.add(l);
  return () => { branchListeners.delete(l); };
}
export function subscribeChanges(l: ChangesListener): () => void {
  changesListeners.add(l);
  return () => { changesListeners.delete(l); };
}
