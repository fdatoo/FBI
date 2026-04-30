export type OsId = 'darwin' | 'linux';
export type ArchId = 'amd64' | 'arm64';
export interface Platform { os: OsId; arch: ArchId }

export interface UADataLike {
  platform: string;
  architecture: string;
}

const FALLBACK: Platform = { os: 'darwin', arch: 'arm64' };

export function detectPlatform(input?: UADataLike | string): Platform {
  if (input == null) return FALLBACK;
  if (typeof input === 'object') return fromUAData(input);
  return fromUAString(input);
}

function fromUAData(d: UADataLike): Platform {
  const os = d.platform.toLowerCase() === 'macos' ? 'darwin'
    : d.platform.toLowerCase() === 'linux' ? 'linux'
    : null;
  if (!os) return FALLBACK;
  const arch = d.architecture.toLowerCase() === 'arm' ? 'arm64'
    : d.architecture.toLowerCase() === 'x86' ? 'amd64'
    : null;
  if (!arch) return FALLBACK;
  return { os, arch };
}

function fromUAString(ua: string): Platform {
  const lower = ua.toLowerCase();
  if (lower.includes('mac os x') || lower.includes('macintosh')) {
    // Safari on Apple Silicon still reports "Intel Mac OS X"; there is no
    // reliable way to distinguish without Client Hints, so we default to the
    // dominant case (arm64). Operators on Intel Macs can use the "other
    // platforms" link.
    return { os: 'darwin', arch: 'arm64' };
  }
  if (lower.includes('linux')) {
    if (lower.includes('aarch64') || lower.includes('arm64')) return { os: 'linux', arch: 'arm64' };
    return { os: 'linux', arch: 'amd64' };
  }
  return FALLBACK;
}
