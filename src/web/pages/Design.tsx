import { useState } from 'react';
import {
  Button, IconButton, Link, Kbd, Pill, StatusDot, Tag,
  Input, Textarea, Toggle, Checkbox, Select,
  Card, Section, Tabs, Dialog, Drawer, Menu, Tooltip, Table, THead, TR, TH, TD,
  ExternalLink, PlayIcon, GearIcon, ChevronDownIcon,
} from '@ui/primitives/index.js';
import { FormRow, KeyboardHint, EmptyState, LoadingState, ErrorState, SplitPane } from '@ui/patterns/index.js';
import { StatCard, ProgressBar, Sparkline, TimestampRelative, CodeBlock, FilterChip, DiffRow, DiffBlock } from '@ui/data/index.js';
import { toggleTheme } from '@ui/theme.js';

export function DesignPage() {
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [tab, setTab] = useState<'terminal' | 'files' | 'github'>('terminal');
  const [chip, setChip] = useState('all');
  const [toggle, setToggle] = useState(true);
  const [check, setCheck] = useState(false);

  return (
    <div className="p-6 space-y-8 max-w-6xl">
      <header className="flex items-center justify-between border-b border-border pb-3">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Design · showcase</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={toggleTheme}>Toggle theme</Button>
          <KeyboardHint keys={['⌘', 'K']} label="search" />
        </div>
      </header>

      <Section title="Buttons">
        <div className="flex items-center gap-2 flex-wrap">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <IconButton aria-label="settings">⚙</IconButton>
          <Link href="#">A link</Link>
          <a href="#" className="text-accent">
            Open docs <ExternalLink />
          </a>
        </div>
      </Section>

      <Section title="Icons">
        <div className="flex items-center gap-4 flex-wrap text-text-dim">
          <span className="flex items-center gap-1"><PlayIcon /> play</span>
          <span className="flex items-center gap-1"><GearIcon /> gear</span>
          <span className="flex items-center gap-1"><ChevronDownIcon /> chevron-down</span>
        </div>
      </Section>

      <Section title="Pills, Dots, Tags, Kbd, Code">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="ok">succeeded</Pill>
          <Pill tone="run">starting</Pill>
          <Pill tone="run">running</Pill>
          <Pill tone="attn">waiting</Pill>
          <Pill tone="fail">failed</Pill>
          <Pill tone="warn">cancelled</Pill>
          <Pill tone="wait">queued</Pill>
          <StatusDot tone="ok" aria-label="ok" />
          <StatusDot tone="run" aria-label="run" />
          <StatusDot tone="attn" aria-label="attn" />
          <Tag>main</Tag>
          <CodeBlock>feat/recent-prompts</CodeBlock>
          <Kbd>⌘</Kbd><Kbd>K</Kbd>
        </div>
      </Section>

      <Section title="Form primitives">
        <div className="max-w-md space-y-3">
          <FormRow label="Project name" hint="Human-readable."><Input className="w-full" placeholder="My project" /></FormRow>
          <FormRow label="Branch"><Input className="w-full" placeholder="feat/branch-name" /></FormRow>
          <FormRow label="Prompt"><Textarea className="w-full" rows={3} placeholder="Describe what Claude should do…" /></FormRow>
          <FormRow label="Notifications">
            <div className="flex items-center gap-2">
              <Toggle checked={toggle} onChange={setToggle} aria-label="enable notifications" />
              <span className="text-[14px] text-text-dim">enabled</span>
            </div>
          </FormRow>
          <FormRow label="I agree">
            <div className="flex items-center gap-2">
              <Checkbox checked={check} onChange={setCheck} id="agree" aria-label="agree" />
              <label htmlFor="agree" className="text-[14px] text-text-dim">Accept terms</label>
            </div>
          </FormRow>
          <FormRow label="Backend" htmlFor="backend-select">
            <Select id="backend-select"><option>claude</option><option>codex</option></Select>
          </FormRow>
        </div>
      </Section>

      <Section title="Tabs + Drawer + Dialog + Menu + Tooltip">
        <div className="space-y-4">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'terminal', label: 'terminal' },
            { value: 'files', label: 'files', count: 3 },
            { value: 'github', label: 'github' },
          ]} />
          <Drawer open={drawer} onToggle={setDrawer} header={<span>files (3)</span>}>
            <div className="p-3 space-y-1">
              <DiffRow status="modified" filename="src/web/App.tsx" additions={12} deletions={3} />
              <DiffRow status="added" filename="src/web/ui/primitives/Button.tsx" additions={48} deletions={0} />
            </div>
          </Drawer>
          <div className="flex items-center gap-3">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Menu
              trigger={<Button variant="ghost">Actions ▾</Button>}
              items={[
                { id: 'follow', label: 'Follow up', onSelect: () => {} },
                { id: 'cancel', label: 'Cancel', onSelect: () => {} },
                { id: 'delete', label: 'Delete', onSelect: () => {}, danger: true },
              ]}
            />
            <Tooltip label="Switch theme (⌘T)"><Button variant="ghost" onClick={toggleTheme}>Theme</Button></Tooltip>
          </div>
          <Dialog open={dialog} onClose={() => setDialog(false)} title="Confirm delete">
            <p className="text-[14px] text-text-dim mb-4">This removes the run and its transcript.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>Delete</Button>
            </div>
          </Dialog>
        </div>
      </Section>

      <Section title="Cards, Stats, Progress, Sparkline">
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <Card>
            <div className="p-4"><p className="text-[14px] text-text-dim">A card. Primitive container.</p></div>
          </Card>
          <div className="flex gap-2">
            <StatCard label="Active" value={1} tone="accent" delta="running" />
            <StatCard label="Today" value={7} delta="↑ 3 vs yesterday" />
            <StatCard label="Failed" value={1} tone="fail" />
          </div>
          <div>
            <p className="text-[13px] text-text-faint mb-1">Tokens used — 1.2M / 5M</p>
            <ProgressBar value={1_200_000} max={5_000_000} aria-label="tokens" />
          </div>
          <Sparkline values={[3, 5, 2, 7, 4, 9, 6, 11, 8, 14]} aria-label="runs per day" />
        </div>
      </Section>

      <Section title="DiffBlock">
        <DiffBlock hunks={[{
          header: '@@ -1,3 +1,3 @@',
          lines: [
            { kind: 'ctx', text: 'unchanged line' },
            { kind: 'del', text: 'removed line' },
            { kind: 'add', text: 'added line' },
          ],
        }]} />
      </Section>

      <Section title="Filters + Table">
        <div className="flex gap-2 mb-3">
          <FilterChip active={chip === 'all'} onClick={() => setChip('all')}>all</FilterChip>
          <FilterChip active={chip === 'running'} onClick={() => setChip('running')}>running</FilterChip>
          <FilterChip active={chip === 'failed'} onClick={() => setChip('failed')}>failed</FilterChip>
        </div>
        <Table>
          <THead><TR><TH>Run</TH><TH>Branch</TH><TH>State</TH><TH>Started</TH></TR></THead>
          <tbody>
            <TR><TD>#42</TD><TD>feat/recent-prompts</TD><TD><Pill tone="run">running</Pill></TD><TD><TimestampRelative iso={new Date(Date.now() - 2 * 60_000).toISOString()} /></TD></TR>
            <TR><TD>#41</TD><TD>fix/dark-terminal</TD><TD><Pill tone="ok">succeeded</Pill></TD><TD><TimestampRelative iso={new Date(Date.now() - 14 * 60_000).toISOString()} /></TD></TR>
          </tbody>
        </Table>
      </Section>

      <Section title="Empty, Loading, Error states">
        <div className="grid grid-cols-3 gap-3">
          <EmptyState title="No projects yet" description="Create one to start running agents." action={<Button>Create project</Button>} hint={<KeyboardHint keys={['c', 'p']} />} />
          <LoadingState />
          <ErrorState message="Failed to load runs. Check connection and retry." />
        </div>
      </Section>

      <Section title="SplitPane">
        <div className="h-64 border border-border-strong rounded-lg overflow-hidden">
          <SplitPane
            left={<div className="p-3 text-[14px] text-text-dim">master list</div>}
            right={<div className="p-3 text-[14px] text-text-dim">detail pane</div>}
          />
        </div>
      </Section>
    </div>
  );
}
