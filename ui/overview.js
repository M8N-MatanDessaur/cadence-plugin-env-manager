/**
 * The workspace as a bento: which repositories have env files, which expose them, what
 * code needs and does not get, where the template drifted, what several repos share.
 */
import { ago } from './helpers.js';
import { Panel, Stat, Health, Bars, List, ListRow } from './kit.js';

export const API = '/api/plugins/env-manager';
export const riskTone = (r) => (r >= 40 ? 'rosin' : r > 0 ? 'brass' : 'moss');
export const riskColour = (r) => (r >= 40 ? 'var(--sy-rosin)' : r > 0 ? 'var(--sy-brass)' : 'var(--sy-moss)');

export function useOverview(host) {
  const { react, api } = host;
  const { useState, useEffect, useCallback } = react;
  const [data, setData] = useState(null);
  const [shared, setShared] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback((fresh) => {
    setError(null);
    api(`${API}/overview${fresh === true ? '?fresh=1' : ''}`).then(setData).catch((e) => { setData({ repos: [], totals: null }); setError(e.message); });
    api(`${API}/cross-repo`).then(setShared).catch(() => setShared({ shared: [], sharedByValue: [], secretsSummary: [] }));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { data, shared, error, reload };
}

const why = (r) => [
  r.tracked.length ? `${r.tracked.length} file${r.tracked.length === 1 ? '' : 's'} tracked by git` : null,
  r.exposed.length > r.tracked.length ? `${r.exposed.length - r.tracked.length} not ignored` : null,
  r.missing.length ? `${r.missing.length} missing in code` : null,
  r.drift.missingFromTemplate.length ? `${r.drift.missingFromTemplate.length} not in the template` : null,
  r.placeholders ? `${r.placeholders} placeholder value${r.placeholders === 1 ? '' : 's'}` : null,
  r.unused.length ? `${r.unused.length} unused` : null,
].filter(Boolean).join(' - ');

export const repoRow = (host, r, onOpen, extra) => ListRow(host, {
  key: r.name,
  lead: host.h('span', { className: 'mind-dot', style: { background: r.missingOnDisk ? 'var(--sy-text-3)' : !r.hasEnv ? 'var(--sy-text-3)' : riskColour(r.risk) } }),
  label: r.name,
  sub: r.missingOnDisk ? 'folder not found on disk' : !r.hasEnv ? (r.hasTemplate ? 'only a template, no real env file' : 'no env file') : `${r.files.map((f) => f.name).join(', ')} - ${r.totalVars} variable${r.totalVars === 1 ? '' : 's'}${why(r) ? ` - ${why(r)}` : ' - clean'}`,
  meta: extra !== undefined ? extra : (r.hasEnv ? (r.risk ? `risk ${r.risk}` : 'clean') : ''),
  onClick: () => onOpen(r.name),
});

export function Overview({ host, overview, q, onOpen }) {
  const { h, ui } = host;
  const { data, error } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const loading = data === null;
  const t = data ? data.totals : null;
  const repos = (data ? data.repos : []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.missing || []).some((k) => k.toLowerCase().includes(q)));
  const withEnv = repos.filter((r) => r.hasEnv);
  const attention = withEnv.filter((r) => r.risk > 0).sort((a, b) => b.risk - a.risk);
  const clean = withEnv.filter((r) => !r.risk);
  const none = repos.filter((r) => !r.hasEnv);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Exposed files', value: !t ? '...' : t.exposedFiles, tone: t && t.exposedFiles ? 'rosin' : 'moss', hint: t && t.trackedFiles ? `${t.trackedFiles} tracked by git` : t ? 'none tracked by git' : undefined }),
      Stat(host, { label: 'Missing in code', value: !t ? '...' : t.missing, tone: t && t.missing ? 'brass' : 'muted', hint: 'read by code, defined nowhere' }),
      Stat(host, { label: 'Template drift', value: !t ? '...' : t.drift, tone: t && t.drift ? 'brass' : 'muted', hint: t ? `${t.withTemplate} of ${t.withEnv} have a template` : undefined }),
      Stat(host, { label: 'Secrets', value: !t ? '...' : t.secrets, tone: 'muted', hint: t ? `across ${t.variables} variables` : undefined })),
    h('div', { className: 'mhealth' },
      Health(host, { label: 'repositories', value: loading ? '...' : repos.length }),
      Health(host, { label: 'with env files', value: !t ? '...' : t.withEnv }),
      Health(host, { label: 'env files', value: !t ? '...' : t.files }),
      Health(host, { label: 'unused', value: !t ? '...' : t.unused }),
      Health(host, { label: 'placeholders', value: !t ? '...' : t.placeholders }),
      Health(host, { label: 'read', value: data ? ago(data.scannedAt) : '...' })),
    error ? h('p', { className: 'mlead', style: { margin: 0, color: 'var(--sy-rosin)' } }, error) : null,
    Panel(host, { title: 'Needs attention', wide: true, action: meta(loading ? '' : `${attention.length}`) },
      loading ? h(ui.Skeleton, { count: 4, height: 18 }) : attention.length ? List(host, attention.map((r) => repoRow(host, r, onOpen))) : empty('Every env file is ignored, defined, and matches its template.')),
    h('div', { className: 'env-row2' },
      Panel(host, { title: 'Clean', action: meta(loading ? '' : `${clean.length}`) },
        loading ? h(ui.Skeleton, { count: 3, height: 18 }) : clean.length ? List(host, clean.map((r) => repoRow(host, r, onOpen))) : empty('None yet.')),
      Panel(host, { title: 'No env file', action: meta(loading ? '' : `${none.length}`) },
        loading ? h(ui.Skeleton, { count: 3, height: 18 }) : none.length ? List(host, none.map((r) => repoRow(host, r, onOpen, ''))) : empty('Every repository has one.'))));
}

export function OverviewAside({ host, overview, onOpen }) {
  const { h, ui } = host;
  const { data, shared } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const FILL = { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }, bodyStyle: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } };
  const repos = data ? data.repos : [];
  const exposed = [];
  for (const r of repos) for (const f of r.files || []) if (f.exposed) exposed.push({ repo: r.name, file: f.name, tracked: f.tracked, secrets: f.secrets });
  const reused = shared ? (shared.secretsSummary || []).filter((s) => (s.repos || []).length > 1) : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'Exposed files', ...FILL, action: meta(data ? `${exposed.length}` : '...') },
      !data ? h(ui.Skeleton, { count: 3, height: 16 }) : exposed.length ? List(host, exposed.sort((a, b) => Number(b.tracked) - Number(a.tracked)).map((e) => ListRow(host, { key: `${e.repo}/${e.file}`, lead: h('span', { className: 'mind-dot', style: { background: e.tracked ? 'var(--sy-rosin)' : 'var(--sy-brass)' } }), label: `${e.repo} - ${e.file}`, sub: e.tracked ? 'tracked by git: its history holds the values' : `not in .gitignore, ${e.secrets} secret${e.secrets === 1 ? '' : 's'} inside`, onClick: () => onOpen(e.repo) }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'No env file is tracked or unignored.')),
    Panel(host, { title: 'Secrets shared across repos', ...FILL, action: meta(shared ? `${reused.length}` : '...') },
      !shared ? h(ui.Skeleton, { count: 3, height: 16 }) : reused.length ? List(host, reused.slice(0, 20).map((s) => ListRow(host, { key: s.key, label: s.key, sub: `${s.repos.join(', ')}${s.allGitignored ? '' : ' - not ignored everywhere'}`, onClick: () => onOpen(s.repos[0]) }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'No secret key appears in more than one repository.')));
}

export function Exposure({ host, api: API, overview, q, onOpen, onChanged }) {
  const { h, ui, api, notify } = host;
  const { useState } = host.react;
  const { data } = overview;
  const [busy, setBusy] = useState(null);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const repos = (data ? data.repos : []).filter((r) => !q || r.name.toLowerCase().includes(q));
  const tracked = []; const unignored = [];
  for (const r of repos) for (const f of r.files || []) { if (f.tracked) tracked.push({ repo: r.name, ...f }); else if (f.exposed) unignored.push({ repo: r.name, ...f }); }
  const protect = async (repo) => {
    setBusy(repo);
    try { const r = await api(`${API}/repos/${encodeURIComponent(repo)}/protect`, { method: 'POST', body: JSON.stringify({}) }); notify(r.added.length ? `Added ${r.added.join(', ')} to .gitignore in ${repo}` : `.gitignore in ${repo} already covers env files`, 'moss'); if (r.untrackCommand) notify(`Still tracked: run "${r.untrackCommand}" in ${repo}`, 'brass'); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); }
  };
  const row = (f) => ListRow(host, { key: `${f.repo}/${f.name}`, lead: h('span', { className: 'mind-dot', style: { background: f.tracked ? 'var(--sy-rosin)' : 'var(--sy-brass)' } }), label: `${f.repo} - ${f.name}`, sub: `${f.variables} variables, ${f.secrets} secret${f.secrets === 1 ? '' : 's'}${f.tracked ? ' - tracked by git' : ' - not in .gitignore'}`, meta: h('span', { style: { display: 'flex', gap: 6 } }, host.sendToShell && f.tracked ? h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: (e) => { e.stopPropagation(); host.sendToShell(`git rm --cached ${f.name}`, { newlines: false, target: { repo: f.repo, path: f.path } }); }, title: 'Put the untrack command in a shell on this repo' }, 'Untrack') : null, h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: busy === f.repo, onClick: (e) => { e.stopPropagation(); protect(f.repo); }, title: 'Add .env rules to .gitignore' }, busy === f.repo ? '...' : 'Ignore')), onClick: () => onOpen(f.repo) });
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Tracked by git', value: !data ? '...' : tracked.length, tone: tracked.length ? 'rosin' : 'moss', hint: 'the history keeps every value' }),
      Stat(host, { label: 'Not ignored', value: !data ? '...' : unignored.length, tone: unignored.length ? 'brass' : 'moss', hint: 'one git add away' }),
      Stat(host, { label: 'Repositories', value: !data ? '...' : new Set([...tracked, ...unignored].map((f) => f.repo)).size }),
      Stat(host, { label: 'Fix', value: 'Ignore', tone: 'muted', hint: 'adds .env rules; Untrack for tracked ones' })),
    !data ? Panel(host, { title: 'Exposure', wide: true }, h(ui.Skeleton, { count: 4, height: 18 })) : null,
    tracked.length ? Panel(host, { title: 'Tracked by git', wide: true, action: meta('untrack, then rotate the secrets inside') }, List(host, tracked.map((f) => row({ ...f, path: repos.find((r) => r.name === f.repo).path })))) : null,
    unignored.length ? Panel(host, { title: 'Not in .gitignore', wide: true, action: meta(`${unignored.length}`) }, List(host, unignored.map((f) => row({ ...f, path: repos.find((r) => r.name === f.repo).path })))) : null,
    data && !tracked.length && !unignored.length ? Panel(host, { title: 'Exposure', wide: true }, empty('Every env file with secrets is ignored and untracked.')) : null);
}

export function Missing({ host, overview, q, onOpen, onOpenVariable }) {
  const { h, ui } = host;
  const { data } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const repos = data ? data.repos : [];
  const missing = []; const unused = [];
  for (const r of repos) { for (const k of r.missing || []) if (!q || k.toLowerCase().includes(q)) missing.push({ repo: r.name, key: k }); for (const k of r.unused || []) if (!q || k.toLowerCase().includes(q)) unused.push({ repo: r.name, key: k }); }
  const row = (m) => ListRow(host, { key: `${m.repo}/${m.key}`, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-brass)' } }), label: m.key, sub: m.repo, onClick: () => onOpenVariable(m.key, m.repo) });
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Missing in code', value: !data ? '...' : missing.length, tone: missing.length ? 'brass' : 'moss', hint: 'read with process.env, defined in no file' }),
      Stat(host, { label: 'Unused', value: !data ? '...' : unused.length, tone: 'muted', hint: 'defined, never read by the code scanned' }),
      Stat(host, { label: 'Repositories', value: !data ? '...' : new Set(missing.map((m) => m.repo)).size }),
      Stat(host, { label: 'Note', value: 'scan', tone: 'muted', hint: 'js, ts, cs, py files; not shell or CI' })),
    !data ? Panel(host, { title: 'Missing', wide: true }, h(ui.Skeleton, { count: 4, height: 18 })) : null,
    data ? Panel(host, { title: 'Read by code, defined nowhere', wide: true, action: meta(`${missing.length}`) }, missing.length ? List(host, missing.map(row)) : empty('Everything the code reads is defined somewhere.')) : null,
    data ? Panel(host, { title: 'Defined, never read', wide: true, action: meta(`${unused.length} - may be read by tooling, CI or a framework`) }, unused.length ? List(host, unused.map(row)) : empty('Every variable is read somewhere.')) : null);
}

export function Drift({ host, api: API, overview, q, onOpen, onChanged }) {
  const { h, ui, api, notify } = host;
  const { useState } = host.react;
  const { data } = overview;
  const [busy, setBusy] = useState(null);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const repos = (data ? data.repos : []).filter((r) => r.hasEnv && (!q || r.name.toLowerCase().includes(q)));
  const drifted = repos.filter((r) => r.hasTemplate && (r.drift.missingFromTemplate.length || r.drift.onlyInTemplate.length));
  const noTemplate = repos.filter((r) => !r.hasTemplate);
  const write = async (repo) => {
    setBusy(repo);
    try { const r = await api(`${API}/repos/${encodeURIComponent(repo)}/write-template`, { method: 'POST', body: JSON.stringify({}) }); notify(`Wrote ${r.file} in ${repo} (secrets blank)`, 'moss'); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); }
  };
  const btn = (r, label) => h('button', { type: 'button', className: 'sy-btn sy-btn--sm', disabled: busy === r.name, onClick: (e) => { e.stopPropagation(); write(r.name); }, title: 'Write .env.example from the real files, secrets left blank' }, busy === r.name ? '...' : label);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Drifted', value: !data ? '...' : drifted.length, tone: drifted.length ? 'brass' : 'moss', hint: 'template and real files disagree' }),
      Stat(host, { label: 'No template', value: !data ? '...' : noTemplate.length, tone: noTemplate.length ? 'brass' : 'moss', hint: 'nothing tells a newcomer what to set' }),
      Stat(host, { label: 'In step', value: !data ? '...' : repos.length - drifted.length - noTemplate.length, tone: 'moss' }),
      Stat(host, { label: 'Fix', value: 'Write', tone: 'muted', hint: '.env.example, secrets blank' })),
    !data ? Panel(host, { title: 'Drift', wide: true }, h(ui.Skeleton, { count: 4, height: 18 })) : null,
    drifted.length ? Panel(host, { title: 'Template out of step', wide: true, action: meta(`${drifted.length}`) }, List(host, drifted.map((r) => ListRow(host, { key: r.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-brass)' } }), label: r.name, sub: [r.drift.missingFromTemplate.length ? `${r.drift.missingFromTemplate.length} real variable${r.drift.missingFromTemplate.length === 1 ? '' : 's'} not in ${r.drift.template}: ${r.drift.missingFromTemplate.slice(0, 6).join(', ')}${r.drift.missingFromTemplate.length > 6 ? '...' : ''}` : null, r.drift.onlyInTemplate.length ? `${r.drift.onlyInTemplate.length} only in the template: ${r.drift.onlyInTemplate.slice(0, 6).join(', ')}${r.drift.onlyInTemplate.length > 6 ? '...' : ''}` : null].filter(Boolean).join(' - '), meta: btn(r, 'Rewrite'), onClick: () => onOpen(r.name) })))) : null,
    noTemplate.length ? Panel(host, { title: 'No template', wide: true, action: meta(`${noTemplate.length}`) }, List(host, noTemplate.map((r) => ListRow(host, { key: r.name, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-text-3)' } }), label: r.name, sub: `${r.totalVars} variables in ${r.files.map((f) => f.name).join(', ')}`, meta: btn(r, 'Write .env.example'), onClick: () => onOpen(r.name) })))) : null,
    data && !drifted.length && !noTemplate.length ? Panel(host, { title: 'Drift', wide: true }, empty('Every repository has a template that matches its env files.')) : null);
}

export function Shared({ host, overview, q, onOpen, onOpenVariable }) {
  const { h, ui } = host;
  const { shared } = overview;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const byName = (shared ? shared.shared || [] : []).filter((s) => !q || s.key.toLowerCase().includes(q));
  const byValue = shared ? shared.sharedByValue || [] : [];
  const secrets = (shared ? shared.secretsSummary || [] : []).filter((s) => (s.repos || []).length > 1);
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Shared names', value: !shared ? '...' : byName.length, tone: 'brass', hint: 'same key in 2+ repositories' }),
      Stat(host, { label: 'Same secret value', value: !shared ? '...' : byValue.length, tone: byValue.length ? 'rosin' : 'moss', hint: 'one leak opens several doors' }),
      Stat(host, { label: 'Shared secrets', value: !shared ? '...' : secrets.length, tone: secrets.length ? 'brass' : 'muted' }),
      Stat(host, { label: 'Not ignored everywhere', value: !shared ? '...' : secrets.filter((s) => !s.allGitignored).length, tone: secrets.some((s) => !s.allGitignored) ? 'rosin' : 'muted' })),
    !shared ? Panel(host, { title: 'Shared', wide: true }, h(ui.Skeleton, { count: 4, height: 18 })) : null,
    byValue.length ? Panel(host, { title: 'Same value under different keys or repositories', wide: true, action: meta(`${byValue.length} - rotate once, update everywhere`) }, List(host, byValue.slice(0, 40).map((s, i) => ListRow(host, { key: i, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-rosin)' } }), label: (s.keys || []).join(', '), sub: `${(s.repos || []).join(', ')} - value ${String(s.value || '').slice(0, 3)}***`, onClick: () => onOpen(s.repos[0]) })))) : null,
    shared ? Panel(host, { title: 'Same key in several repositories', wide: true, action: meta(`${byName.length}`) }, byName.length ? List(host, byName.slice(0, 80).map((s) => ListRow(host, { key: s.key, lead: h('span', { className: 'mind-dot', style: { background: s.isSecret ? 'var(--sy-brass)' : 'var(--sy-text-3)' } }), label: s.key, sub: `${(s.repos || Object.keys(s.perRepo || {})).join(', ')}${s.sameValue === false || (s.values && s.values.length > 1) ? ' - different values' : ''}`, onClick: () => onOpenVariable(s.key, (s.repos || Object.keys(s.perRepo || {}))[0]) }))) : empty('No variable name appears in more than one repository.')) : null);
}
