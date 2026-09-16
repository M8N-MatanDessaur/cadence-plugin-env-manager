/**
 * Environments in Cadence 3.0: three regions and a header, like the other plugins.
 *
 *   Sidebar: Overview, Exposure, Missing, Drift, Shared, Ask; the repository; a search.
 *   Main: the workspace as a bento, one repository as a dashboard (files, the variable
 *   matrix, what code needs and does not get, the template drift), one variable.
 *   Right: what to fix first.
 *
 * Secret values are masked everywhere; a value is revealed only where you click Reveal, and
 * the AI never receives a value at all - only keys, files and code references.
 */
import { ensureStyles, NavItem, Section } from './kit.js';
import { ago } from './helpers.js';
import { useOverview, Overview, OverviewAside, Exposure, Missing, Drift, Shared } from './overview.js';
import { useRepo, RepoPage, RepoAside, VariablePage, VariableAside } from './repo.js';
import { Ask } from './ask.js';

export const API = '/api/plugins/env-manager';

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'chart', hint: 'Every repository: its env files, what is exposed, what code is missing.' },
  { id: 'exposure', label: 'Exposure', icon: 'warning', hint: 'Env files git tracks or does not ignore, and secrets hardcoded in source.' },
  { id: 'missing', label: 'Missing', icon: 'clock', hint: 'Variables the code reads that no env file defines, and variables nothing reads.' },
  { id: 'drift', label: 'Drift', icon: 'story', hint: 'Where the real env files and the example template disagree.' },
  { id: 'shared', label: 'Shared', icon: 'epic', hint: 'Variables and secret values that several repositories share.' },
  { id: 'ask', label: 'Ask', icon: 'search', hint: 'A question about the environments. The AI reads keys and code, never values.' },
];

function Env({ host }) {
  const { h, ui, api, notify, context } = host;
  const { useState, useEffect, useMemo } = host.react;
  const [tab, setTab] = useState('overview');
  const [repo, setRepo] = useState(() => { try { return localStorage.getItem('sy.env.repo') || ''; } catch { return ''; } });
  const [openRepo, setOpenRepo] = useState(null);
  const [openVar, setOpenVar] = useState(null);
  const [q, setQ] = useState('');
  const overview = useOverview(host);
  const detail = useRepo(host, openRepo);
  useEffect(() => { ensureStyles(); }, []);
  useEffect(() => { try { if (repo) localStorage.setItem('sy.env.repo', repo); } catch {} }, [repo]);
  useEffect(() => {
    const names = (overview.data ? overview.data.repos : []).map((r) => r.name);
    if (!names.length) return;
    const focused = ((context && context()) || {}).focused;
    setRepo((cur) => (cur && names.includes(cur) ? cur : (focused && names.includes(focused.repo) ? focused.repo : '')));
  }, [overview.data]);

  const repos = overview.data ? overview.data.repos : [];
  const t = overview.data ? overview.data.totals : null;
  const current = NAV.find((n) => n.id === tab) || NAV[0];
  const leave = () => { setOpenRepo(null); setOpenVar(null); };
  const open = (name) => { setOpenVar(null); setOpenRepo(name); };
  const openVariable = (key, inRepo) => { if (inRepo) setOpenRepo(inRepo); setOpenVar(key); };
  const reloadAll = () => { overview.reload(true); if (openRepo) detail.reload(); };

  const left = h('div', { className: 'sb' },
    h('div', { className: 'sb__head' }, h('span', { className: 'sb__title' }, 'Environments')),
    h('div', { className: 'mind-stats' },
      !t ? h('span', null, 'reading the env files...') : [h('span', { key: 'e' }, `${t.withEnv} with env`), h('span', { key: 'x' }, `${t.exposedFiles} exposed`), h('span', { key: 'm' }, `${t.missing} missing`)]),
    h('ul', { className: 'sb__list', role: 'list' },
      NAV.map((n) => NavItem(host, {
        key: n.id, icon: host.icons[n.icon], label: n.label, active: tab === n.id && !openRepo, title: n.hint,
        badge: !t ? undefined : n.id === 'overview' ? (t.withEnv || undefined) : n.id === 'exposure' ? (t.exposedFiles || undefined) : n.id === 'missing' ? (t.missing || undefined) : n.id === 'drift' ? (t.drift || undefined) : undefined,
        onClick: () => { setTab(n.id); leave(); },
      }))),
    h('div', { style: { flex: 1 } }),
    Section(host, 'Repository'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '0 var(--sy-s3) var(--sy-s2)' } },
      h(ui.Select, { value: openRepo || repo, onChange: (e) => { setRepo(e.target.value); if (e.target.value) open(e.target.value); else leave(); }, 'aria-label': 'Repository' },
        h('option', { value: '' }, 'Whole workspace'),
        repos.map((r) => h('option', { key: r.name, value: r.name }, `${r.name}${r.hasEnv ? '' : ' (no env)'}`))),
      tab !== 'ask' ? h(ui.Input, { value: q, placeholder: 'Search a variable', onChange: (e) => setQ(e.target.value), 'aria-label': 'Search variables' }) : null),
    h('div', { className: 'sb__foot' }, openVar ? 'One variable. Back from the header.' : openRepo ? 'One repository. Back to the workspace from the header.' : current.hint));

  const repoRow = openRepo ? repos.find((r) => r.name === openRepo) : null;
  const header = h('div', { className: 'mind-view__head' },
    h('div', null,
      h('h1', { className: 'stage-title' }, openVar ? openVar : openRepo ? openRepo : current.label),
      h('p', { style: { margin: 0, color: 'var(--sy-text-3)', fontSize: 'var(--sy-fs-sm)' } },
        openVar ? `In ${openRepo}.` : openRepo ? (repoRow ? (repoRow.hasEnv ? `${repoRow.files.length} env file${repoRow.files.length === 1 ? '' : 's'}, ${repoRow.totalVars} variable${repoRow.totalVars === 1 ? '' : 's'}${repoRow.hasTemplate ? ', a template' : ', no template'}.` : 'No env file at the root of this repository.') : '') : `${current.hint} ${t ? `${t.withEnv} of ${t.repos} repositories have env files.` : ''}`)),
    h('div', { className: 'mind-view__actions' },
      openRepo || openVar ? h(ui.Button, { onClick: () => (openVar ? setOpenVar(null) : leave()) }, openVar ? 'Back to the repository' : 'Back to the workspace') : null,
      h(ui.Button, { onClick: reloadAll, title: 'Read the env files again' }, 'Rescan')));

  const filtered = useMemo(() => q.trim().toLowerCase(), [q]);
  const main = h('div', { style: { padding: '12px 16px 48px' } },
    overview.error ? h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)', color: 'var(--sy-rosin)' } }, overview.error) : null,
    openVar
      ? h(VariablePage, { host, api: API, repo: openRepo, name: openVar, detail, overview, onChanged: reloadAll })
      : openRepo
        ? h(RepoPage, { host, api: API, repo: openRepo, detail, overview, q: filtered, onOpenVariable: (k) => setOpenVar(k), onChanged: reloadAll })
        : tab === 'exposure' ? h(Exposure, { host, api: API, overview, q: filtered, onOpen: open, onChanged: reloadAll })
        : tab === 'missing' ? h(Missing, { host, overview, q: filtered, onOpen: open, onOpenVariable: openVariable })
        : tab === 'drift' ? h(Drift, { host, api: API, overview, q: filtered, onOpen: open, onChanged: reloadAll })
        : tab === 'shared' ? h(Shared, { host, api: API, overview, q: filtered, onOpen: open, onOpenVariable: openVariable })
        : tab === 'ask' ? h(Ask, { host, api: API, overview, repo, onOpen: open })
        : h(Overview, { host, overview, q: filtered, onOpen: open }));

  const right = openVar
    ? h(VariableAside, { host, repo: openRepo, name: openVar, detail, overview, onOpen: open, onOpenVariable: (k) => setOpenVar(k) })
    : openRepo
      ? h(RepoAside, { host, api: API, repo: openRepo, detail, onOpenVariable: (k) => setOpenVar(k), onChanged: reloadAll })
      : h(OverviewAside, { host, overview, onOpen: open });

  return h(ui.Regions, { left, right, paneId: `env-${tab}`, paneLabel: openVar ? 'This variable' : openRepo ? 'Fix first' : 'Exposure' },
    h('div', { className: 'env-main' }, h('div', { style: { padding: '32px 16px 0' } }, header), main));
}

Env.cadenceComponent = true;
export default Env;
