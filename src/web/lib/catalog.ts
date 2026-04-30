export interface CatalogEntry {
  name: string;
  description: string;
  emoji: string;
  type: 'stdio' | 'sse';
  command: string;
  args: string[];
  requiredEnv: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    name: 'fetch',
    description: 'HTTP requests from the agent',
    emoji: '🌐',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    requiredEnv: [],
  },
  {
    name: 'github',
    description: 'GitHub API',
    emoji: '🐙',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: ['GITHUB_TOKEN'],
  },
  {
    name: 'postgres',
    description: 'Query a Postgres database',
    emoji: '🗄️',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    requiredEnv: ['POSTGRES_CONNECTION_STRING'],
  },
  {
    name: 'puppeteer',
    description: 'Headless browser — screenshots, clicks',
    emoji: '🖥️',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    requiredEnv: [],
  },
  {
    name: 'sequential-thinking',
    description: 'Structured multi-step reasoning',
    emoji: '🧠',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    requiredEnv: [],
  },
  {
    name: 'brave-search',
    description: 'Web search',
    emoji: '🔍',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: ['BRAVE_API_KEY'],
  },
  {
    name: 'memory',
    description: 'Persistent memory across runs',
    emoji: '💾',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    requiredEnv: [],
  },
];
