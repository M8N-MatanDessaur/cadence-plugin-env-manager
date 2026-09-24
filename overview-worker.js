// The workspace overview, off the server's thread. Walking every repository's source and asking
// git about each env file takes seconds per repo, and on the server's only thread that froze every
// shell and screen (a 169 s stall with a dozen repos). routes.js starts this with the repos and the
// config and gets back the rows and totals it used to compute inline.
const fs = require('fs');
const { workerData, parentPort } = require('worker_threads');
const { describeRepo } = require('./routes.js');

const { repos, cfg } = workerData;
const rows = [];
const totals = { repos: 0, withEnv: 0, withTemplate: 0, files: 0, variables: 0, secrets: 0, exposedFiles: 0, trackedFiles: 0, missing: 0, unused: 0, drift: 0, placeholders: 0 };
for (const ro of repos) {
  const rp = ro.path;
  totals.repos++;
  if (!rp || !fs.existsSync(rp)) { rows.push({ name: ro.name, path: rp, missingOnDisk: true, hasEnv: false, hasTemplate: false, files: [], templateFiles: [], totalVars: 0, secrets: [], missing: [], unused: [], drift: { missingFromTemplate: [], onlyInTemplate: [] }, exposed: [], tracked: [], risk: 0 }); continue; }
  let d;
  try { d = describeRepo(ro.name, rp, cfg); } catch (e) { rows.push({ name: ro.name, path: rp, error: String(e && e.message || e), hasEnv: false, hasTemplate: false, files: [], templateFiles: [], totalVars: 0, secrets: [], missing: [], unused: [], drift: { missingFromTemplate: [], onlyInTemplate: [] }, exposed: [], tracked: [], risk: 0 }); continue; }
  const slim = { name: d.name, path: d.path, hasEnv: d.hasEnv, hasTemplate: d.hasTemplate, files: d.files, templateFiles: d.templateFiles, totalVars: d.totalVars, secrets: d.secrets, missing: d.missing.map((m) => m.key), unused: d.unused, drift: d.drift, exposed: d.exposed, tracked: d.tracked, placeholders: d.variables.filter((v) => v.placeholderIn.length).length, risk: d.risk, scannedAt: d.scannedAt };
  rows.push(slim);
  if (d.hasEnv) totals.withEnv++;
  if (d.hasTemplate) totals.withTemplate++;
  totals.files += d.files.length; totals.variables += d.totalVars; totals.secrets += d.secrets.length;
  totals.exposedFiles += d.exposed.length; totals.trackedFiles += d.tracked.length;
  totals.missing += d.missing.length; totals.unused += d.unused.length; totals.drift += d.drift.missingFromTemplate.length + d.drift.onlyInTemplate.length; totals.placeholders += slim.placeholders;
}
parentPort.postMessage({ repos: rows, totals, scannedAt: new Date().toISOString() });
