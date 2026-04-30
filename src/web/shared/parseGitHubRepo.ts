export function parseGitHubRepo(url: string): string | null {
  if (!url) return null;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}
