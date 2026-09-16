/**
 * One repository as a dashboard, and one variable inside it.
 *
 * The repository: its files with their git standing, the variable matrix (one row per
 * variable, one column per env file, secrets masked, empties and placeholders flagged),
 * what code reads that no file defines, what nothing reads, the template drift, secrets
 * hardcoded in source, and an AI panel that explains the setup or writes an example file
 * with comments - from keys and code, never from values.
 * The variable: its value per file (Reveal is a click, and gated), every line of code that
 * reads it, the other repositories that define it, and Set to write a value into a file.
 */
import { ago, waitForTask } from './helpers.js';
import { Panel, Stat, Health, List, ListRow } from './kit.js';
import { riskTone, riskColour } from './overview.js';

export function useRepo(host, name) {
  const { react, api } = host;
  const { useState, useEffect, useCallback } = react;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    if (!name) return;
    setError(null);
    api(`/api/plugins/env-manager/repos/${encodeURIComponent(name)}/detail`).then(setData).catch((e) => setError(e.message));
  }, [name]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  return { data, error, reload };
}

/** A masked cell with a Reveal that fetches the raw value only when clicked. */
function Cell({ host, api: API, repo, file, cell, secret }) {
  const { h, react, api, notify } = host;
  const { useState } = react;
  const [shown, setShown] = useState(null);
  if (!cell || !cell.present) return h('span', { className: 'mpanel__meta', style: { color: 'var(--sy-rosin)' } }, 'missing');
  if (cell.empty) return h('span', { className: 'mpanel__meta', style: { color: 'var(--sy-brass)' } }, 'empty');
  if (!secret) return h('code', { style: { fontSize: 12 }, title: cell.value }, cell.value);
  const reveal = async () => { try { const r = await api(`${API}/repos/${encodeURIComponent(repo)}/reveal`, { method: 'POST', body: JSON.stringify({ file, key: cell.key }) }); setShown(r.value); } catch (e) { notify(e.message, 'rosin'); } };
  return h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0 } },
    h('code', { style: { fontSize: 12 } }, shown !== null ? shown : cell.value),
    h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0, flex: 'none' }, title: shown !== null ? 'Hide' : 'Reveal the value', onClick: () => (shown !== null ? setShown(null) : reveal()) }, shown !== null ? 'hide' : 'reveal'),
    shown !== null ? h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0, flex: 'none' }, onClick: () => { navigator.clipboard.writeText(shown).then(() => notify('Copied', 'moss')).catch(() => {}); } }, 'copy') : null);
}

export function RepoPage({ host, api: API, repo, detail, overview, q, onOpenVariable, onChanged }) {
  const { h, ui, api, notify, tokens } = host;
  const { useState } = host.react;
  const { data, error } = detail;
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiKind, setAiKind] = useState(null);
  const [aiWide, setAiWide] = useState(false);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  if (error) return h(ui.EmptyState, { title: `Could not read ${repo}`, body: error });
  if (!data) return h('div', null, h('div', { className: 'mstats mstats--head' }, [0, 1, 2, 3].map((k) => h('div', { key: k, className: 'mstat' }, h(ui.Skeleton, { count: 2, height: 14 })))), h('div', { className: 'env-item', style: { marginTop: 'var(--sy-s3)' } }, Panel(host, { title: 'Variables' }, h(ui.Skeleton, { count: 6, height: 16 })), Panel(host, { title: 'Files' }, h(ui.Skeleton, { count: 3, height: 16 }))));
  if (!data.hasEnv) return h('div', null, Panel(host, { title: data.hasTemplate ? 'Only a template' : 'No env file', wide: true },
    h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s2)' } }, data.hasTemplate ? `${repo} has ${data.templateFiles.map((f) => f.name).join(', ')} but no real env file. Copy the template to .env and fill it in.` : `${repo} has no .env file at its root. ${data.missing.length ? `The code reads ${data.missing.length} variable${data.missing.length === 1 ? '' : 's'} (${data.missing.slice(0, 5).map((m) => m.key).join(', ')}) that a .env would provide.` : 'Its code reads no environment variable either.'}`),
    data.hasTemplate && host.sendToShell ? h(ui.Button, { variant: 'primary', onClick: () => host.sendToShell(`copy ${data.templateFiles[0].name} .env`, { newlines: false, target: { repo, path: data.path } }) }, 'Copy the template to .env in a shell') : null));

  const vars = data.variables.filter((v) => (!q || v.key.toLowerCase().includes(q)) && (filter === 'all' || (filter === 'secrets' && v.isSecret) || (filter === 'issues' && (v.missingIn.length || v.emptyIn.length || v.placeholderIn.length || !v.referenced)) || (filter === 'unused' && !v.referenced)));
  const files = data.files;
  const exposed = files.filter((f) => f.exposed);
  const issues = data.variables.filter((v) => v.missingIn.length || v.emptyIn.length || v.placeholderIn.length);
  const act = async (fn, done) => { try { await fn(); if (done) notify(done, 'moss'); onChanged(); } catch (e) { notify(e.message, 'rosin'); } finally { setBusy(null); } };
  const protect = () => { setBusy('protect'); act(async () => { const r = await api(`${API}/repos/${encodeURIComponent(repo)}/protect`, { method: 'POST', body: JSON.stringify({}) }); if (r.untrackCommand) notify(`Still tracked. Run: ${r.untrackCommand}`, 'brass'); }, 'Env files ignored'); };
  const writeTemplate = (content) => { setBusy('template'); act(() => api(`${API}/repos/${encodeURIComponent(repo)}/write-template`, { method: 'POST', body: JSON.stringify(content ? { content } : {}) }), `Wrote ${data.drift.template || '.env.example'}`); };

  const askAi = async (kind) => {
    setAiKind(kind); setAi(null);
    try {
      const cfg = await api('/api/config').catch(() => ({}));
      const base = window.location.origin;
      const keys = data.variables.map((v) => `${v.key}${v.isSecret ? ' (secret)' : ''}${v.referencedIn.length ? ` read in ${v.referencedIn.slice(0, 3).join(', ')}` : ' (not read by scanned code)'}${v.missingIn.length ? ` missing in ${v.missingIn.join(', ')}` : ''}`).join('\n');
      const prompt = [
        kind === 'explain' ? `Explain the environment setup of the repository "${repo}": what each variable is for (from how the code uses it), which environments differ and why, what a new developer must set first, and what looks wrong.` : kind === 'example' ? `Write a complete .env.example for the repository "${repo}": every variable, a one-line comment above each saying what it is for and where to get it (from how the code uses it), secrets left blank, safe defaults kept for the rest. Reply with the file content only, no fences.` : `Say what is missing or risky in the environment setup of "${repo}": variables the code reads that no file defines, files git tracks or does not ignore, placeholders, empties, template drift. Give the exact fix for each.`,
        `Today is ${new Date().toISOString().slice(0, 10)}. You get variable NAMES and code references only, never values; do not try to read env files, do not print or guess values.`,
        `Read from these READ-ONLY routes on the local Cadence server (plain GET with curl). Never call POST, PUT, PATCH or DELETE.`,
        `  ${base}${API}/repos/${encodeURIComponent(repo)}/detail                    files, variables (masked), missing, unused, drift, leaks`,
        `  ${base}${API}/repos/${encodeURIComponent(repo)}/variable?key=<KEY>         every line of code reading one variable`,
        `  The repository is checked out at ${data.path}; read its source to see how a variable is used, but never open a .env file.`,
        '', `Variables:\n${keys}`, data.missing.length ? `\nRead by code, defined nowhere: ${data.missing.map((m) => m.key).join(', ')}` : '',
        '', 'Short and concrete. Markdown. Do not run any bootstrap, do not save to Mind or any memory. Reply with the answer only.',
      ].join('\n');
      const result = await api('/api/orchestrator/spawn', { method: 'POST', body: JSON.stringify({ cli: cfg.DefaultCli || 'claude', from: 'env', timeout: 300000, prompt }) });
      const text = result.handledLocally ? (result.answer || '') : result.id ? await waitForTask(api, result.id, 300000) : (result.error || 'Nothing came back.');
      setAi(String(text).replace(/^\s*\[bootstrap:[^\]]*\]\s*/, '').replace(/^```[a-z]*\n?|\n?```$/g, '').trim());
    } catch (e) { notify(e.message, 'rosin'); setAiKind(null); }
  };
  const aiPanel = (wide) => Panel(host, { title: 'AI', style: wide ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined, bodyStyle: wide ? { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } : undefined,
    action: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      ai && aiKind === 'example' ? h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: !!busy, onClick: () => writeTemplate(ai) }, busy === 'template' ? 'Writing...' : `Write ${data.drift.template || '.env.example'}`) : null,
      ai && host.sendToShell ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => host.sendToShell(`Environment ${aiKind} for ${repo}:\n${ai}`, { target: { repo, path: data.path } }) }, 'Insert in terminal') : null,
      ai && host.writeNote ? h(ui.Button, { className: 'sy-btn--sm', onClick: async () => { if (await host.writeNote(`${repo} env ${aiKind}`, `# ${repo} - environment ${aiKind}\n\n${ai}`)) notify('Saved and opened', 'moss'); } }, 'Save as note') : null,
      ai ? h(ui.Button, { className: 'sy-btn--sm', onClick: () => setAiWide(!wide) }, wide ? 'Close' : 'Expand') : null,
      !ai ? meta(aiKind ? 'reading the code...' : 'keys and code only, never values') : null) },
    ai ? h('div', { style: wide ? undefined : { maxHeight: 360, overflow: 'auto', paddingRight: 4 } }, aiKind === 'example' ? h('pre', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, ai) : h(ui.Markdown, { source: ai })) : h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s2)' } }, 'Explain says what each variable does and what to set first. Example writes a commented .env.example you can save in one click. Review lists what is missing or risky with the fix for each.'),
    aiKind && !ai ? h('div', { style: { marginTop: 'var(--sy-s2)' } }, h(ui.Skeleton, { count: 4, height: 14 })) : null,
    !wide ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: ai ? 'var(--sy-s3)' : 0 } },
      h(ui.Button, { className: 'sy-btn--sm', disabled: !!aiKind && !ai, onClick: () => askAi('explain') }, 'Explain'),
      h(ui.Button, { className: 'sy-btn--sm', disabled: !!aiKind && !ai, onClick: () => askAi('example') }, 'Example with comments'),
      h(ui.Button, { className: 'sy-btn--sm', disabled: !!aiKind && !ai, onClick: () => askAi('review') }, 'Review')) : null);

  const matrix = h('div', { style: { overflowX: 'auto' } },
    h('table', { className: 'env-matrix', style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--sy-fs-sm)' } },
      h('thead', null, h('tr', null,
        h('th', { style: { textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, color: 'var(--sy-text-3)', fontWeight: 500, whiteSpace: 'nowrap' } }, 'Variable'),
        files.map((f) => h('th', { key: f.name, style: { textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, color: f.exposed ? 'var(--sy-rosin)' : 'var(--sy-text-3)', fontWeight: 500, whiteSpace: 'nowrap' } }, f.name)),
        h('th', { style: { textAlign: 'right', padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, color: 'var(--sy-text-3)', fontWeight: 500 } }, 'Read'))),
      h('tbody', null, vars.map((v) => h('tr', { key: v.key, style: { cursor: 'pointer' }, onClick: () => onOpenVariable(v.key) },
        h('td', { style: { padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, whiteSpace: 'nowrap' } },
          h('span', { className: 'mind-dot', style: { background: v.missingIn.length || v.placeholderIn.length ? 'var(--sy-rosin)' : v.emptyIn.length || !v.referenced ? 'var(--sy-brass)' : v.isSecret ? 'var(--sy-brass)' : 'var(--sy-text-3)', marginRight: 8 } }),
          h('span', { style: { fontWeight: 600 } }, v.key),
          v.isSecret ? h('span', { className: 'mpanel__meta', style: { marginLeft: 6 } }, 'secret') : null,
          !v.inTemplate && data.hasTemplate ? h('span', { className: 'mpanel__meta', style: { marginLeft: 6, color: 'var(--sy-brass)' } }, 'not in template') : null),
        files.map((f) => h('td', { key: f.name, onClick: (e) => e.stopPropagation(), style: { padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, whiteSpace: 'nowrap', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', color: v.placeholderIn.includes(f.name) ? 'var(--sy-brass)' : undefined } }, h(Cell, { host, api: API, repo, file: f.name, cell: { ...v.cells[f.name], key: v.key }, secret: v.isSecret }), v.placeholderIn.includes(f.name) ? h('span', { className: 'mpanel__meta', style: { marginLeft: 6 } }, 'placeholder') : null)),
        h('td', { style: { padding: '6px 8px', borderBottom: `1px solid ${tokens('line')}`, textAlign: 'right', whiteSpace: 'nowrap' } }, h('span', { className: 'mpanel__meta', style: { color: v.referenced ? undefined : 'var(--sy-brass)' } }, v.referenced ? `${v.referencedIn.length} file${v.referencedIn.length === 1 ? '' : 's'}` : 'not read')))))));

  return h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sy-s3)', marginBottom: 'var(--sy-s3)' } },
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } }, h('span', { className: 'mind-dot', style: { background: riskColour(data.risk) } }), h('span', { className: 'mpanel__title' }, `${files.length} env file${files.length === 1 ? '' : 's'} - ${data.hasTemplate ? data.drift.template : 'no template'} - read ${ago(data.scannedAt)}`)),
        h('h2', { style: { margin: 0, fontSize: 22, lineHeight: 1.25, fontWeight: 600, color: 'var(--sy-text)' } }, `${data.totalVars} variable${data.totalVars === 1 ? '' : 's'}, ${data.secrets.length} secret${data.secrets.length === 1 ? '' : 's'}, ${exposed.length ? `${exposed.length} file${exposed.length === 1 ? '' : 's'} exposed` : 'nothing exposed'}, ${data.missing.length ? `${data.missing.length} missing in code` : 'code fully covered'}.`),
        h('p', { className: 'mlead', style: { margin: '6px 0 0' } }, data.path))),
    aiWide && ai ? h('div', { style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 260px)', minHeight: 420 } }, aiPanel(true)) : null,
    aiWide && ai ? null : h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Risk', value: data.risk, tone: riskTone(data.risk), hint: data.tracked.length ? 'a file git tracks' : exposed.length ? 'a file not ignored' : data.missing.length ? 'code reads undefined variables' : data.risk ? 'fixable below' : 'clean' }),
      Stat(host, { label: 'Exposed files', value: exposed.length, tone: exposed.length ? 'rosin' : 'moss', hint: data.tracked.length ? `${data.tracked.length} tracked by git` : undefined }),
      Stat(host, { label: 'Missing in code', value: data.missing.length, tone: data.missing.length ? 'brass' : 'muted' }),
      Stat(host, { label: 'Rows to check', value: issues.length, tone: issues.length ? 'brass' : 'muted', hint: 'missing, empty or placeholder in a file' })),
    aiWide && ai ? null : Panel(host, { title: 'Variables', wide: true, style: { marginBottom: 'var(--sy-s3)' }, action: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [['all', 'All'], ['secrets', 'Secrets'], ['issues', 'To check'], ['unused', 'Not read']].map(([k, l]) => h(ui.Chip, { key: k, on: filter === k, onClick: () => setFilter(k) }, l))) },
      vars.length ? matrix : empty('Nothing matches.')),
    aiWide && ai ? null : h('div', { className: 'env-item' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0 } },
        data.missing.length ? Panel(host, { title: 'Read by code, defined in no file', bodyStyle: { maxHeight: 300, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: meta(`${data.missing.length}`) },
          List(host, data.missing.map((m) => ListRow(host, { key: m.key, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-rosin)' } }), label: m.key, sub: `read in ${m.referencedIn.slice(0, 4).join(', ')}${m.referencedIn.length > 4 ? ` and ${m.referencedIn.length - 4} more` : ''}`, onClick: () => onOpenVariable(m.key) })))) : null,
        (data.leaked || []).length ? Panel(host, { title: 'Hardcoded in source', bodyStyle: { maxHeight: 300, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: meta(`${data.leaked.length} - move them to env`) },
          List(host, data.leaked.slice(0, 200).map((l, i) => ListRow(host, { key: i, lead: h('span', { className: 'mind-dot', style: { background: 'var(--sy-rosin)' } }), label: `${l.file}:${l.line}`, sub: l.preview })))) : null),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0 } },
        Panel(host, { title: 'Files', bodyStyle: { maxHeight: 260, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' }, action: exposed.length ? h(ui.Button, { className: 'sy-btn--sm', variant: 'primary', disabled: !!busy, onClick: protect }, busy === 'protect' ? 'Writing...' : 'Ignore env files') : meta('all ignored') },
          List(host, [...files, ...data.templateFiles].map((f) => ListRow(host, { key: f.name, lead: h('span', { className: 'mind-dot', style: { background: f.tracked && !f.template ? 'var(--sy-rosin)' : f.exposed ? 'var(--sy-brass)' : 'var(--sy-moss)' } }), label: f.name, sub: f.template ? `template - ${f.variables} keys${f.tracked ? ' - tracked, as it should be' : ''}` : `${f.variables} variables, ${f.secrets} secret${f.secrets === 1 ? '' : 's'}${f.empties ? `, ${f.empties} empty` : ''} - ${f.tracked ? 'TRACKED BY GIT' : f.ignored ? 'ignored' : 'not ignored'}`, meta: f.tracked && !f.template && host.sendToShell ? h('button', { type: 'button', className: 'sy-btn sy-btn--sm', onClick: () => host.sendToShell(`git rm --cached ${f.name}`, { newlines: false, target: { repo, path: data.path } }), title: 'Put the untrack command in a shell' }, 'Untrack') : null })))),
        aiPanel(false),
        Panel(host, { title: 'Template', action: h(ui.Button, { className: 'sy-btn--sm', disabled: !!busy, onClick: () => writeTemplate(null), title: 'From the real files, secrets left blank' }, busy === 'template' ? 'Writing...' : data.hasTemplate ? 'Rewrite' : 'Write .env.example') },
          !data.hasTemplate ? empty('No .env.example. A newcomer has nothing to copy from.')
            : data.drift.missingFromTemplate.length || data.drift.onlyInTemplate.length ? h('div', null,
              data.drift.missingFromTemplate.length ? h('p', { className: 'mlead', style: { margin: '0 0 6px' } }, `Not in ${data.drift.template}: ${data.drift.missingFromTemplate.join(', ')}`) : null,
              data.drift.onlyInTemplate.length ? h('p', { className: 'mlead', style: { margin: 0 } }, `Only in the template: ${data.drift.onlyInTemplate.join(', ')}`) : null)
            : empty(`${data.drift.template} lists every variable.`)),
        data.unused.length ? Panel(host, { title: 'Defined, never read', action: meta(`${data.unused.length} - maybe tooling or CI`) }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, data.unused.map((k) => h(ui.Chip, { key: k, onClick: () => onOpenVariable(k) }, k)))) : null,
        Panel(host, { title: 'Details' }, h(ui.InfoGrid, { items: [{ label: 'Files', value: files.map((f) => f.name).join(', ') }, { label: 'Template', value: data.hasTemplate ? data.templateFiles.map((f) => f.name).join(', ') : 'none' }, { label: 'Secrets', value: data.secrets.length }, { label: 'Read', value: new Date(data.scannedAt).toLocaleString() }] })))));
}

export function RepoAside({ host, api: API, repo, detail, onOpenVariable, onChanged }) {
  const { h, ui } = host;
  const { data } = detail;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const FILL = { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }, bodyStyle: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } };
  const first = [];
  if (data) {
    for (const f of data.files) if (f.tracked) first.push({ label: `${f.name} is tracked by git`, sub: 'untrack it, then rotate the secrets inside', tone: 'var(--sy-rosin)' });
    for (const f of data.files) if (!f.tracked && f.exposed) first.push({ label: `${f.name} is not ignored`, sub: 'one git add away from a leak', tone: 'var(--sy-brass)' });
    for (const m of data.missing) first.push({ label: m.key, sub: 'read by code, defined in no file', tone: 'var(--sy-rosin)', key: m.key });
    for (const v of data.variables) if (v.placeholderIn.length) first.push({ label: v.key, sub: `placeholder in ${v.placeholderIn.join(', ')}`, tone: 'var(--sy-brass)', key: v.key });
    for (const v of data.variables) if (v.missingIn.length) first.push({ label: v.key, sub: `missing in ${v.missingIn.join(', ')}`, tone: 'var(--sy-brass)', key: v.key });
    for (const v of data.variables) if (v.emptyIn.length) first.push({ label: v.key, sub: `empty in ${v.emptyIn.join(', ')}`, tone: 'var(--sy-text-3)', key: v.key });
  }
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', flex: 1, minHeight: 0, height: '100%' } },
    Panel(host, { title: 'Fix first', ...FILL, action: meta(data ? `${first.length}` : '...') },
      !data ? h(ui.Skeleton, { count: 4, height: 16 }) : first.length ? List(host, first.slice(0, 30).map((x, i) => ListRow(host, { key: i, lead: h('span', { className: 'mind-dot', style: { background: x.tone } }), label: x.label, sub: x.sub, onClick: x.key ? () => onOpenVariable(x.key) : undefined }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing to fix here.')));
}

export function VariablePage({ host, api: API, repo, name, detail, overview, onChanged }) {
  const { h, ui, api, notify, tokens } = host;
  const { useState, useEffect } = host.react;
  const [info, setInfo] = useState(null);
  const [file, setFile] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setInfo(null); api(`${API}/repos/${encodeURIComponent(repo)}/variable?key=${encodeURIComponent(name)}`).then((d) => { setInfo(d); if (!file) setFile((d.files || [])[0] || '.env'); }).catch((e) => setInfo({ error: e.message })); }, [repo, name]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const empty = (text) => h('p', { className: 'mlead', style: { margin: 0 } }, text);
  const v = info && info.variable;
  const files = info ? info.files || [] : [];
  const elsewhere = [];
  for (const r of (overview.data ? overview.data.repos : [])) if (r.name !== repo && (r.files || []).length && overview.shared && (overview.shared.shared || []).some((s) => s.key === name && (s.repos || Object.keys(s.perRepo || {})).includes(r.name))) elsewhere.push(r.name);
  const set = async () => {
    if (!file) return;
    setBusy(true);
    try { const r = await api(`${API}/repos/${encodeURIComponent(repo)}/set`, { method: 'POST', body: JSON.stringify({ file, key: name, value }) }); notify(`${r.added ? 'Added' : 'Updated'} ${name} in ${file}`, 'moss'); setValue(''); setInfo(null); api(`${API}/repos/${encodeURIComponent(repo)}/variable?key=${encodeURIComponent(name)}`).then(setInfo); onChanged(); }
    catch (e) { notify(e.message, 'rosin'); } finally { setBusy(false); }
  };
  return h('div', null,
    h('div', { style: { marginBottom: 'var(--sy-s3)' } },
      h('h2', { style: { margin: 0, fontSize: 22, lineHeight: 1.25, fontWeight: 600, color: 'var(--sy-text)' } }, !info ? 'Reading...' : v ? `${v.isSecret ? 'A secret, ' : ''}defined in ${files.filter((f) => v.cells[f] && v.cells[f].present).length} of ${files.length} file${files.length === 1 ? '' : 's'}, read in ${(info.references || []).length} place${(info.references || []).length === 1 ? '' : 's'}.` : `Read in ${(info.references || []).length} place${(info.references || []).length === 1 ? '' : 's'}, defined in no env file.`),
      h('p', { className: 'mlead', style: { margin: '6px 0 0' } }, info && info.inTemplates && info.inTemplates.length ? `Listed in ${info.inTemplates.join(', ')}.` : info ? 'Not listed in a template.' : '')),
    h('div', { className: 'mstats mstats--head' },
      Stat(host, { label: 'Kind', value: !info ? '...' : info.isSecret ? 'Secret' : 'Plain', tone: info && info.isSecret ? 'brass' : 'muted' }),
      Stat(host, { label: 'Defined in', value: !info ? '...' : v ? files.filter((f) => v.cells[f] && v.cells[f].present).length : 0, tone: v ? 'moss' : 'rosin', hint: v && v.missingIn.length ? `missing in ${v.missingIn.join(', ')}` : undefined }),
      Stat(host, { label: 'Read in', value: !info ? '...' : (info.references || []).length, tone: info && (info.references || []).length ? 'muted' : 'brass', hint: info && !(info.references || []).length ? 'nothing scanned reads it' : undefined }),
      Stat(host, { label: 'Elsewhere', value: !overview.shared ? '...' : elsewhere.length, tone: 'muted', hint: elsewhere.length ? elsewhere.slice(0, 2).join(', ') : undefined })),
    h('div', { className: 'env-item' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0 } },
        Panel(host, { title: 'Per file', action: meta(info && info.isSecret ? 'masked - reveal is a click' : '') },
          !info ? h(ui.Skeleton, { count: 3, height: 16 }) : files.length ? List(host, files.map((f) => ListRow(host, { key: f, lead: h('span', { className: 'mind-dot', style: { background: v && v.cells[f] && v.cells[f].present ? (v.cells[f].empty ? 'var(--sy-brass)' : 'var(--sy-moss)') : 'var(--sy-rosin)' } }), label: f, sub: v && v.placeholderIn.includes(f) ? 'looks like a placeholder' : v && v.cells[f] && v.cells[f].present && !v.cells[f].empty ? `${v.cells[f].length} characters` : '', meta: h(Cell, { host, api: API, repo, file: f, cell: v ? { ...v.cells[f], key: name } : { present: false }, secret: !!(info && info.isSecret) }) }))) : empty('No env file in this repository.')),
        Panel(host, { title: 'Read by', action: meta(info ? `${(info.references || []).length}` : '...') },
          !info ? h(ui.Skeleton, { count: 4, height: 16 }) : (info.references || []).length ? h('div', { style: { maxHeight: 420, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } }, List(host, info.references.map((r, i) => ListRow(host, { key: i, lead: h('code', { className: 'mpanel__meta' }, `${r.line}`), label: r.file, sub: r.text })))) : empty('No scanned source file reads it. It may be used by a build tool, CI, or a framework convention.'))),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0 } },
        Panel(host, { title: 'Set a value', action: meta('written in place, nothing else touched') },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h(ui.Field, { label: 'File' }, h(ui.Select, { value: file, onChange: (e) => setFile(e.target.value), 'aria-label': 'Env file' }, (files.length ? files : ['.env']).map((f) => h('option', { key: f, value: f }, f)))),
            h(ui.Field, { label: 'Value' }, h(ui.Input, { value, type: info && info.isSecret ? 'password' : 'text', placeholder: v && v.cells[file] && v.cells[file].present ? 'New value' : 'Value to add', onChange: (e) => setValue(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') set(); } })),
            h('div', { style: { display: 'flex', gap: 8 } },
              h(ui.Button, { variant: 'primary', disabled: busy || !file, onClick: set }, busy ? 'Writing...' : v && v.cells[file] && v.cells[file].present ? `Update in ${file}` : `Add to ${file}`)))),
        Panel(host, { title: 'Elsewhere in the workspace', action: meta(overview.shared ? `${elsewhere.length}` : '...') },
          elsewhere.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, elsewhere.map((r) => h(ui.Chip, { key: r }, r))) : empty('Only this repository defines it.')))));
}

export function VariableAside({ host, repo, name, detail, overview, onOpen, onOpenVariable }) {
  const { h, ui } = host;
  const { data } = detail;
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const v = data ? data.variables.find((x) => x.key === name) : null;
  const siblings = data ? data.variables.filter((x) => x.key !== name && x.key.split('_')[0] === name.split('_')[0]).slice(0, 12) : [];
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)' } },
    Panel(host, { title: 'Standing', action: meta(v ? '' : 'undefined') },
      v ? h(ui.InfoGrid, { items: [{ label: 'Secret', value: v.isSecret ? 'yes' : 'no' }, { label: 'Same everywhere', value: v.sameEverywhere ? 'yes' : 'no, differs by file' }, { label: 'In template', value: v.inTemplate ? 'yes' : 'no' }, { label: 'Read', value: v.referenced ? `${v.referencedIn.length} files` : 'nowhere scanned' }] }) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Read by code but defined in no env file. Set a value on the left.')),
    siblings.length ? Panel(host, { title: 'Same prefix', action: meta(`${siblings.length}`) }, h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, siblings.map((s) => h(ui.Chip, { key: s.key, onClick: () => onOpenVariable && onOpenVariable(s.key) }, s.key)))) : null);
}
