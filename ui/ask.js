/**
 * Ask, as a bento: the question and its answer, questions prepared from the scan, the answers
 * kept in the app. The AI is told keys, files and code references - never a value.
 */
import { waitForTask } from './helpers.js';
import { Panel, Health, List, ListRow } from './kit.js';

const RECENT_KEY = 'sy.env.ask.recent';
const readRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 20))); } catch {} };
const when = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const short = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

function prepare({ overview, repo }) {
  const out = [];
  const t = overview.data ? overview.data.totals : null;
  if (!t) return out;
  if (t.trackedFiles) out.push({ q: 'Which env files does git track, and what do I run to untrack them and rotate what was inside?', why: `${t.trackedFiles} tracked` });
  if (t.missing) out.push({ q: `Which variables does the code read that no env file defines${repo ? ` in ${repo}` : ''}, and what should each be set to?`, why: `${t.missing} missing` });
  if (t.drift) out.push({ q: 'Where do the .env.example files disagree with the real env files, and what should the templates say?', why: `${t.drift} drifted keys` });
  if (t.placeholders) out.push({ q: 'Which variables still hold placeholder values, and which environment is affected?', why: `${t.placeholders} placeholders` });
  if (overview.shared && (overview.shared.sharedByValue || []).length) out.push({ q: 'Which secret values are reused across repositories, and what is the order to rotate them?', why: `${overview.shared.sharedByValue.length} reused values` });
  out.push({ q: `What does a new developer need to set up to run ${repo || 'each repository'} locally, in order?`, why: 'onboarding' });
  out.push({ q: 'Which variables differ between development and production, and is any difference suspicious?', why: 'environments' });
  return out.slice(0, 7);
}

export function Ask({ host, api: API, overview, repo, onOpen }) {
  const { h, ui, api, react, icons } = host;
  const { useState, useEffect, useMemo } = react;
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  useEffect(() => { if (!asking) { setElapsed(0); return undefined; } const started = Date.now(); const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000); return () => clearInterval(t); }, [asking]);
  const suggestions = useMemo(() => prepare({ overview, repo }), [overview.data, overview.shared, repo]);
  const meta = (text) => h('span', { className: 'mpanel__meta' }, text);
  const FILL = { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }, bodyStyle: { flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 14, scrollbarGutter: 'stable' } };
  const ask = async (text) => {
    const asked = (text || question).trim();
    if (!asked || asking) return;
    setQuestion(asked); setAsking(true); setAnswer(null);
    const started = Date.now();
    try {
      const cfg = await api('/api/config').catch(() => ({}));
      const base = window.location.origin;
      const prompt = [
        `Answer a question about the environment variables of the repositories in this workspace${repo ? ` (the user is looking at "${repo}")` : ''}. Today is ${new Date().toISOString().slice(0, 10)}.`,
        'You get variable NAMES, files, git standing and code references. Secret values are masked and you must never try to read an env file, print a value, or guess one.',
        'Read from these READ-ONLY routes on the local Cadence server (plain GET with curl, JSON back). Never call POST, PUT, PATCH or DELETE.',
        `  ${base}${API}/overview                                every repository: env files with git standing, missing in code, unused, drift, placeholders, risk`,
        `  ${base}${API}/repos/<name>/detail                       one repository: files, the variable matrix (masked), missing, unused, drift, hardcoded secrets in source`,
        `  ${base}${API}/repos/<name>/variable?key=<KEY>           one variable: presence per file (masked) and every line of code that reads it`,
        `  ${base}${API}/cross-repo                               keys and (masked) values shared across repositories`,
        '  A repository path from the overview may be read for its source code, never for its env files.',
        '', `Question: ${asked}`, '',
        'Answer in Markdown from what you read only: a short lead, then bold labels, bullets or a table. Name variables, files and repositories; give exact commands when the question is about fixing. Say plainly if the data does not cover it.',
        'This is a one-off answer, not a session: do not run any bootstrap, do not save to Mind or any memory, do not mention either. Reply with the answer only.',
      ].join('\n');
      const result = await api('/api/orchestrator/spawn', { method: 'POST', body: JSON.stringify({ cli: cfg.DefaultCli || 'claude', from: 'env-ask', timeout: 300000, prompt }) });
      const text = result.handledLocally ? (result.answer || '(no answer)') : result.id ? await waitForTask(api, result.id, 300000) : (result.error || 'No answer came back.');
      const entry = { question: asked, answer: String(text).replace(/^\s*\[bootstrap:[^\]]*\]\s*/, '').trim(), at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) };
      setAnswer(entry); const next = [entry, ...recent.filter((e) => e.question !== asked)]; writeRecent(next); setRecent(next);
    } catch (e) { setAnswer({ question: asked, answer: e.message, at: new Date().toISOString(), seconds: 0 }); } finally { setAsking(false); }
  };
  const t = overview.data ? overview.data.totals : null;
  const answerPanel = asking
    ? Panel(host, { title: 'Reading the environments', action: meta(`${elapsed}s`), ...FILL }, h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, 'The AI is reading the env files (names only), the code that uses them, and writing the answer.'), h(ui.Skeleton, { count: 5, height: 16 }))
    : !answer
      ? Panel(host, { title: 'Answer', action: meta('nothing asked yet'), ...FILL },
        h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, 'The AI reads the environments through this plugin: variable names, which file has them, whether git protects the file, and the code that reads them. It never sees a value.'),
        h('div', { className: 'mhealth' }, Health(host, { label: 'with env', value: t ? `${t.withEnv}` : '...', tone: 'brass' }), Health(host, { label: 'variables', value: t ? `${t.variables}` : '...' }), Health(host, { label: 'exposed', value: t ? `${t.exposedFiles}` : '...' })))
      : Panel(host, { title: 'Answer', ...FILL, action: meta(`${when(answer.at)} - ${answer.seconds}s`) }, h('p', { className: 'mlead', style: { margin: '0 0 var(--sy-s3)' } }, answer.question), h(ui.Markdown, { source: answer.answer }));
  const column = (...children) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sy-s3)', minWidth: 0, minHeight: 0 } }, ...children);
  return h('div', { className: 'env-ask' },
    column(
      Panel(host, { title: 'Ask about the environments', action: meta(repo ? `looking at ${repo}` : 'whole workspace') },
        h('div', { style: { display: 'flex', gap: 8 } },
          h(ui.Input, { placeholder: '"what do I need to run this locally?" or "which secrets are exposed?"', value: question, disabled: asking, onChange: (e) => setQuestion(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') ask(); }, 'aria-label': 'Question' }),
          h(ui.Button, { variant: 'primary', disabled: asking || !question.trim(), onClick: () => ask() }, asking ? `Asking... ${elapsed}s` : 'Ask'))),
      answerPanel),
    column(
      Panel(host, { title: 'Worth asking', action: meta('from the scan') },
        suggestions.length ? List(host, suggestions.map((s) => ListRow(host, { key: s.q, lead: h(icons.search, { size: 13, style: { opacity: 0.6, flex: 'none' } }), label: s.q, sub: s.why, onClick: asking ? undefined : () => ask(s.q) }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Reading...')),
      Panel(host, { title: 'Recently asked', ...FILL, action: recent.length ? h('button', { type: 'button', className: 'mpanel__meta', style: { background: 'none', border: 0, cursor: 'pointer', padding: 0 }, onClick: () => { writeRecent([]); setRecent([]); } }, 'forget all') : meta('kept in the app') },
        recent.length ? List(host, recent.map((e) => ListRow(host, { key: e.at, lead: h(icons.history, { size: 13, style: { opacity: 0.6, flex: 'none' } }), label: short(e.question), sub: `${when(e.at)} - ${e.seconds}s`, onClick: () => { setQuestion(e.question); setAnswer(e); } }))) : h('p', { className: 'mlead', style: { margin: 0 } }, 'Nothing asked yet. Every answer is kept here and comes back in one click.'))));
}
