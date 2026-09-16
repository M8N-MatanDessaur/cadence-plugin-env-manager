/**
 * Environment Manager Plugin -- Server-side API Routes
 * Scans repos for .env files, detects secrets, compares environments,
 * finds missing variables, and generates templates.
 */
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCfg() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (_) { return { secretPatterns: 'PASSWORD,SECRET,TOKEN,KEY,API_KEY,PRIVATE,CREDENTIAL', scanExtensions: '.js,.ts,.jsx,.tsx,.cs,.py' }; }
}
function saveCfg(data) { fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8'); }

var ENV_FILE_NAMES = ['.env', '.env.local', '.env.development', '.env.staging', '.env.production', '.env.test'];
var ENV_TEMPLATE_NAMES = ['.env.example', '.env.template', '.env.sample'];

function getSecretPatterns(cfg) {
  var raw = (cfg.secretPatterns || 'PASSWORD,SECRET,TOKEN,KEY,API_KEY,PRIVATE,CREDENTIAL');
  return raw.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
}

function getScanExtensions(cfg) {
  var raw = (cfg.scanExtensions || '.js,.ts,.jsx,.tsx,.cs,.py');
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * Parse a .env file into an array of { key, value, line, comment }
 */
function parseEnvFile(filePath) {
  var entries = [];
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var lines = content.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      var eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      var key = line.substring(0, eqIdx).trim();
      var value = line.substring(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }
      if (key) entries.push({ key: key, value: value, line: i + 1 });
    }
  } catch (_) {}
  return entries;
}

/**
 * Find all .env files in a repo root directory (non-recursive, root level only)
 */
function isTemplateEnv(name) {
  return ENV_TEMPLATE_NAMES.indexOf(name) !== -1 || name.indexOf('example') !== -1 || name.indexOf('template') !== -1 || name.indexOf('sample') !== -1;
}

function findEnvFiles(repoPath) {
  var found = [];
  try {
    var allFiles = fs.readdirSync(repoPath);
    for (var i = 0; i < allFiles.length; i++) {
      var name = allFiles[i];
      // Match .env, .env.*, .env-* but skip templates/examples
      if (name === '.env' || name.startsWith('.env.') || name.startsWith('.env-')) {
        if (isTemplateEnv(name)) continue;
        var fp = path.join(repoPath, name);
        try {
          var st = fs.statSync(fp);
          if (st.isFile() && found.indexOf(name) === -1) found.push(name);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return found.sort();
}

/**
 * Check if a file pattern is in .gitignore
 */
function isGitignored(repoPath, fileName) {
  try {
    var gitignorePath = path.join(repoPath, '.gitignore');
    var content = fs.readFileSync(gitignorePath, 'utf8');
    var lines = content.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      // Exact match
      if (line === fileName) return true;
      // Wildcard patterns
      if (line === '.env*' || line === '.env.*') return true;
      if (line === '*.local' && fileName.endsWith('.local')) return true;
      // Pattern with slash
      if (line === '/' + fileName) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Check if a key looks like a secret based on patterns
 */
function isSecretKey(key, patterns) {
  var upper = key.toUpperCase();
  for (var i = 0; i < patterns.length; i++) {
    if (upper.indexOf(patterns[i]) !== -1) return true;
  }
  return false;
}

/**
 * Mask a secret value -- show first 2 chars + asterisks
 */
function maskValue(value) {
  if (!value || value.length <= 2) return '****';
  return value.substring(0, 2) + '****';
}

/**
 * Recursively scan source files for env var references
 */
function scanSourceForEnvVars(repoPath, extensions) {
  var envVarRefs = {};
  var dirsToSkip = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'bin', 'obj', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv'];

  function walkDir(dir, depth) {
    if (depth > 8) return; // safety limit
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        var name = items[i];
        if (name.startsWith('.') && name !== '.env') continue;
        if (dirsToSkip.indexOf(name) !== -1) continue;
        var fullPath = path.join(dir, name);
        try {
          var stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else if (stat.isFile()) {
            var ext = path.extname(name).toLowerCase();
            if (extensions.indexOf(ext) === -1) continue;
            if (stat.size > 500000) continue; // skip large files
            try {
              var content = fs.readFileSync(fullPath, 'utf8');
              // Match process.env.VAR_NAME
              var re1 = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
              var match;
              while ((match = re1.exec(content)) !== null) {
                var varName = match[1];
                if (!envVarRefs[varName]) envVarRefs[varName] = [];
                var relPath = path.relative(repoPath, fullPath).replace(/\\/g, '/');
                if (envVarRefs[varName].indexOf(relPath) === -1) envVarRefs[varName].push(relPath);
              }
              // Match process.env['VAR_NAME'] or process.env["VAR_NAME"]
              var re2 = /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g;
              while ((match = re2.exec(content)) !== null) {
                var varName2 = match[1];
                if (!envVarRefs[varName2]) envVarRefs[varName2] = [];
                var relPath2 = path.relative(repoPath, fullPath).replace(/\\/g, '/');
                if (envVarRefs[varName2].indexOf(relPath2) === -1) envVarRefs[varName2].push(relPath2);
              }
              // Match import.meta.env.VITE_VAR_NAME or import.meta.env.NEXT_PUBLIC_
              var re3 = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
              while ((match = re3.exec(content)) !== null) {
                var varName3 = match[1];
                if (!envVarRefs[varName3]) envVarRefs[varName3] = [];
                var relPath3 = path.relative(repoPath, fullPath).replace(/\\/g, '/');
                if (envVarRefs[varName3].indexOf(relPath3) === -1) envVarRefs[varName3].push(relPath3);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  walkDir(repoPath, 0);
  return envVarRefs;
}

/**
 * Scan source files for hardcoded secret-like strings (potential leaked secrets)
 */
function scanForLeakedSecrets(repoPath, extensions, patterns) {
  var leaks = [];
  var dirsToSkip = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'bin', 'obj', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv'];

  // Build regex patterns for common secret assignments
  var secretPatterns = [];
  for (var p = 0; p < patterns.length; p++) {
    var pat = patterns[p].toLowerCase();
    // Match: someSecret = "value" or some_api_key: "value"
    secretPatterns.push(new RegExp('(?:^|\\s|,|{)\\s*["\']?\\w*' + pat.replace(/_/g, '[_]?') + '\\w*["\']?\\s*[:=]\\s*["\']([^"\'\\s]{8,})["\']', 'gi'));
  }

  function walkDir(dir, depth) {
    if (depth > 6) return;
    try {
      var items = fs.readdirSync(dir);
      for (var i = 0; i < items.length; i++) {
        var name = items[i];
        if (name.startsWith('.')) continue;
        if (dirsToSkip.indexOf(name) !== -1) continue;
        var fullPath = path.join(dir, name);
        try {
          var stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            walkDir(fullPath, depth + 1);
          } else if (stat.isFile()) {
            var ext = path.extname(name).toLowerCase();
            if (extensions.indexOf(ext) === -1) continue;
            if (stat.size > 500000) continue;
            try {
              var content = fs.readFileSync(fullPath, 'utf8');
              var lines = content.split(/\r?\n/);
              for (var ln = 0; ln < lines.length; ln++) {
                var line = lines[ln];
                // Skip comments
                if (line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('*')) continue;
                // Skip lines referencing process.env or import.meta.env (those are safe)
                if (line.indexOf('process.env') !== -1 || line.indexOf('import.meta.env') !== -1) continue;
                for (var sp = 0; sp < secretPatterns.length; sp++) {
                  secretPatterns[sp].lastIndex = 0;
                  var match = secretPatterns[sp].exec(line);
                  if (match && match[1]) {
                    // Filter out common false positives
                    var val = match[1];
                    if (val === 'undefined' || val === 'null' || val === 'true' || val === 'false') continue;
                    if (val.startsWith('process.') || val.startsWith('import.')) continue;
                    if (val.indexOf('${') !== -1 || val.indexOf('<%') !== -1) continue; // template strings
                    leaks.push({
                      file: path.relative(repoPath, fullPath).replace(/\\/g, '/'),
                      line: ln + 1,
                      snippet: line.trim().substring(0, 120),
                      matchedPattern: patterns[Math.floor(sp / 1)] // approximate
                    });
                    break; // one match per line is enough
                  }
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  walkDir(repoPath, 0);
  return leaks;
}

/**
 * Build a full scan result for a repo
 */
function scanRepo(repoPath, cfg) {
  var patterns = getSecretPatterns(cfg);
  var extensions = getScanExtensions(cfg);
  var envFiles = findEnvFiles(repoPath);

  // Parse all env files
  var fileData = {};
  var allKeys = {};
  for (var i = 0; i < envFiles.length; i++) {
    var fileName = envFiles[i];
    var entries = parseEnvFile(path.join(repoPath, fileName));
    fileData[fileName] = entries;
    for (var j = 0; j < entries.length; j++) {
      allKeys[entries[j].key] = true;
    }
  }

  // Build variable inventory
  var variables = [];
  var keyList = Object.keys(allKeys).sort();
  for (var k = 0; k < keyList.length; k++) {
    var key = keyList[k];
    var presence = {};
    for (var f = 0; f < envFiles.length; f++) {
      var found = false;
      var val = '';
      for (var e = 0; e < fileData[envFiles[f]].length; e++) {
        if (fileData[envFiles[f]][e].key === key) {
          found = true;
          val = fileData[envFiles[f]][e].value;
          break;
        }
      }
      presence[envFiles[f]] = { present: found, value: val };
    }
    variables.push({
      key: key,
      isSecret: isSecretKey(key, patterns),
      presence: presence
    });
  }

  // Scan source for env var usage
  var codeRefs = scanSourceForEnvVars(repoPath, extensions);

  // Find missing variables (used in code but not in any env file)
  var missing = [];
  var codeVarNames = Object.keys(codeRefs);
  for (var m = 0; m < codeVarNames.length; m++) {
    var varName = codeVarNames[m];
    if (!allKeys[varName]) {
      // Exclude NODE_ENV and common built-in vars
      if (varName === 'NODE_ENV' || varName === 'PORT' || varName === 'HOME' || varName === 'PATH' || varName === 'CI') continue;
      missing.push({ key: varName, referencedIn: codeRefs[varName] });
    }
  }

  // Gitignore check
  var gitignoreStatus = {};
  for (var g = 0; g < envFiles.length; g++) {
    var fn = envFiles[g];
    var shouldBeIgnored = fn !== '.env.example' && fn !== '.env.template';
    var isIgnored = isGitignored(repoPath, fn);
    gitignoreStatus[fn] = {
      isGitignored: isIgnored,
      shouldBeIgnored: shouldBeIgnored,
      ok: shouldBeIgnored ? isIgnored : true
    };
  }

  // Detect secrets in env files
  var secrets = [];
  for (var s = 0; s < variables.length; s++) {
    if (variables[s].isSecret) {
      var filesWithValue = [];
      var presKeys = Object.keys(variables[s].presence);
      for (var pk = 0; pk < presKeys.length; pk++) {
        if (variables[s].presence[presKeys[pk]].present && variables[s].presence[presKeys[pk]].value) {
          filesWithValue.push(presKeys[pk]);
        }
      }
      if (filesWithValue.length > 0) {
        secrets.push({ key: variables[s].key, files: filesWithValue });
      }
    }
  }

  return {
    envFiles: envFiles,
    fileData: fileData,
    variables: variables,
    codeRefs: codeRefs,
    missing: missing,
    gitignoreStatus: gitignoreStatus,
    secrets: secrets,
    totalVars: keyList.length
  };
}

// ── 3.0 helpers ────────────────────────────────────────────────────────────

function findTemplateFiles(repoPath) {
  try { return fs.readdirSync(repoPath).filter(function (n) { return (n === '.env' || n.startsWith('.env.') || n.startsWith('.env-')) && isTemplateEnv(n); }).sort(); } catch (_) { return []; }
}

// Whether git already tracks the file: the one exposure a .gitignore line cannot undo.
function gitTracked(repoPath, fileName) {
  try {
    var r = require('child_process').spawnSync('git', ['ls-files', '--error-unmatch', '--', fileName], { cwd: repoPath, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0;
  } catch (_) { return false; }
}

function maskFor(value) {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

var PLACEHOLDER = /^(your[-_]|xxx|changeme|change[-_]me|todo|replace|<.*>|\$\{.*\}|example|placeholder|dummy|sample)/i;

// Every line in the source tree that names the variable, with its line number.
function findReferences(repoPath, key, extensions) {
  var out = [];
  var skip = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'bin', 'obj', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv'];
  var re = new RegExp('(process\\.env\\.' + key + '\\b|process\\.env\\[[\'"]' + key + '[\'"]\\]|import\\.meta\\.env\\.' + key + '\\b|Environment\\.GetEnvironmentVariable\\("' + key + '"\\)|os\\.environ(\\.get)?\\(?\\[?[\'"]' + key + '[\'"]|\\benv\\.' + key + '\\b|"' + key + '")');
  (function walk(dir, depth) {
    if (depth > 8 || out.length > 200) return;
    var items = [];
    try { items = fs.readdirSync(dir); } catch (_) { return; }
    for (var i = 0; i < items.length; i++) {
      var name = items[i];
      if ((name.startsWith('.') && name !== '.env') || skip.indexOf(name) !== -1) continue;
      var full = path.join(dir, name);
      var st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (extensions.indexOf(path.extname(name).toLowerCase()) === -1 || st.size > 500000) continue;
      var lines; try { lines = fs.readFileSync(full, 'utf8').split(/\r?\n/); } catch (_) { continue; }
      for (var l = 0; l < lines.length; l++) if (re.test(lines[l])) { out.push({ file: path.relative(repoPath, full).replace(/\\/g, '/'), line: l + 1, text: lines[l].trim().slice(0, 160) }); if (out.length > 200) return; }
    }
  })(repoPath, 0);
  return out;
}

// Set or add KEY=value in an env file without touching anything else (order, comments, spacing).
function writeEnvValue(filePath, key, value) {
  var content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  var nl = content.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  var lines = content.length ? content.split(/\r?\n/) : [];
  var needsQuotes = /[\s#"']/.test(value) && !/^".*"$/.test(value);
  var rendered = key + '=' + (needsQuotes ? '"' + value.replace(/"/g, '\\"') + '"' : value);
  var done = false;
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    var eq = t.indexOf('=');
    if (eq !== -1 && t.substring(0, eq).trim() === key) { lines[i] = rendered; done = true; break; }
  }
  if (!done) { if (lines.length && lines[lines.length - 1] !== '') lines.push(rendered); else if (lines.length) lines.splice(lines.length - 1, 0, rendered); else lines.push(rendered); }
  var text = lines.join(nl);
  if (!text.endsWith(nl)) text += nl;
  fs.writeFileSync(filePath, text, 'utf8');
  return { updated: done, added: !done };
}

// Everything the 3.0 screens say about one repo, from a fresh scan.
function describeRepo(repoName, repoPath, cfg) {
  var scan = scanRepo(repoPath, cfg);
  scanCache[repoName] = scan;
  var patterns = getSecretPatterns(cfg);
  var templates = findTemplateFiles(repoPath);
  var templateKeys = {};
  var templateData = {};
  for (var t = 0; t < templates.length; t++) { var te = parseEnvFile(path.join(repoPath, templates[t])); templateData[templates[t]] = te; for (var k = 0; k < te.length; k++) templateKeys[te[k].key] = true; }
  var files = scan.envFiles.map(function (fn) {
    var ignored = isGitignored(repoPath, fn);
    var tracked = gitTracked(repoPath, fn);
    var entries = scan.fileData[fn] || [];
    var secretsHere = entries.filter(function (e) { return isSecretKey(e.key, patterns) && e.value; }).length;
    return { name: fn, variables: entries.length, secrets: secretsHere, empties: entries.filter(function (e) { return !e.value; }).length, ignored: ignored, tracked: tracked, exposed: tracked || (!ignored && secretsHere > 0), template: false };
  });
  var templateFiles = templates.map(function (fn) { return { name: fn, variables: (templateData[fn] || []).length, secrets: 0, empties: 0, ignored: isGitignored(repoPath, fn), tracked: gitTracked(repoPath, fn), exposed: false, template: true }; });
  var variables = scan.variables.map(function (v) {
    var cells = {};
    var names = Object.keys(v.presence);
    var emptyIn = [];
    var placeholderIn = [];
    var distinct = {};
    for (var i = 0; i < names.length; i++) {
      var pr = v.presence[names[i]];
      if (pr.present) { if (!pr.value) emptyIn.push(names[i]); else { distinct[pr.value] = true; if (PLACEHOLDER.test(pr.value)) placeholderIn.push(names[i]); } }
      cells[names[i]] = { present: pr.present, empty: pr.present && !pr.value, value: pr.present ? (v.isSecret ? maskFor(pr.value) : pr.value) : '', length: pr.present ? pr.value.length : 0, masked: v.isSecret && pr.present && !!pr.value };
    }
    var refs = scan.codeRefs[v.key] || [];
    return { key: v.key, isSecret: v.isSecret, cells: cells, emptyIn: emptyIn, placeholderIn: placeholderIn, missingIn: names.filter(function (n) { return !v.presence[n].present; }), sameEverywhere: Object.keys(distinct).length <= 1, referencedIn: refs, referenced: refs.length > 0, inTemplate: !!templateKeys[v.key] };
  });
  var unused = variables.filter(function (v) { return !v.referenced; }).map(function (v) { return v.key; });
  var driftMissingFromTemplate = templates.length ? variables.filter(function (v) { return !v.inTemplate; }).map(function (v) { return v.key; }) : [];
  var driftOnlyInTemplate = Object.keys(templateKeys).filter(function (k) { return !scan.variables.some(function (v) { return v.key === k; }); });
  var exposedFiles = files.filter(function (f) { return f.exposed; });
  var risk = 0;
  risk += files.filter(function (f) { return f.tracked; }).length * 40;
  risk += files.filter(function (f) { return !f.tracked && f.exposed; }).length * 20;
  risk += Math.min(30, scan.missing.length * 5);
  risk += Math.min(15, driftMissingFromTemplate.length * 2);
  risk += Math.min(10, variables.filter(function (v) { return v.placeholderIn.length; }).length * 3);
  return {
    name: repoName, path: repoPath, hasEnv: files.length > 0, hasTemplate: templates.length > 0,
    files: files, templateFiles: templateFiles, variables: variables, totalVars: scan.totalVars,
    secrets: scan.secrets.map(function (x) { return x.key; }), missing: scan.missing, unused: unused,
    drift: { missingFromTemplate: driftMissingFromTemplate, onlyInTemplate: driftOnlyInTemplate, template: templates[0] || null },
    exposed: exposedFiles.map(function (f) { return f.name; }), tracked: files.filter(function (f) { return f.tracked; }).map(function (f) { return f.name; }),
    risk: Math.min(100, risk), scannedAt: new Date().toISOString(),
  };
}

// In-memory cache of scan results per repo
var scanCache = {};
var overviewCache = null;

// ── Route Registration ───────────────────────────────────────────────────────


// ---- Attention: what the Plugins home shows on this app's tile. Reads the plugin's own
// routes over loopback (they carry their caches), never writes, answers within a minute.
const __attention = { value: null, until: 0 };
function __selfGet(req, path, timeoutMs) {
  return new Promise((resolve) => {
    const host = req.headers.host || `127.0.0.1:${process.env.CADENCE_PORT || 3801}`;
    const lib = require('http');
    const r = lib.get({ host: host.split(':')[0], port: Number(host.split(':')[1] || 80), path, headers: { 'x-cadence-internal': '1' } }, (resp) => { let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => { try { resolve(resp.statusCode < 400 ? JSON.parse(d) : null); } catch (_) { resolve(null); } }); });
    r.on('error', () => resolve(null));
    r.setTimeout(timeoutMs || 45000, () => { r.destroy(); resolve(null); });
  });
}
function __attentionOut(items) {
  const rank = { error: 3, warn: 2, warning: 2, info: 1 };
  const list = (items || []).filter((i) => i && i.text).map((i) => ({ level: i.level === 'warning' ? 'warn' : (i.level || 'info'), text: String(i.text) }));
  const level = list.reduce((top, i) => (rank[i.level] > rank[top] ? i.level : top), list.length ? 'info' : 'ok');
  return { count: list.length, level, items: list, readAt: new Date().toISOString() };
}
async function __attentionHandler(req, res, url, compute, json) {
  if (__attention.value && __attention.until > Date.now() && url.searchParams.get('refresh') !== '1') return json(res, __attention.value);
  let out;
  try { out = __attentionOut(await compute(req)); } catch (e) { out = { count: 0, level: 'ok', items: [], error: e.message, readAt: new Date().toISOString() }; }
  __attention.value = out; __attention.until = Date.now() + 60000;
  return json(res, out);
}

module.exports = function ({ addRoute, addPrefixRoute, json, readBody, getConfig, shell }) {
  addRoute('GET', '/attention', (req, res, url) => __attentionHandler(req, res, url, async (req) => { const o = await __selfGet(req, '/api/plugins/env-manager/overview'); const t = o && o.totals; if (!t) return []; const out = []; if (t.exposedFiles) out.push({ level: 'error', text: `${t.exposedFiles} .env file${t.exposedFiles === 1 ? '' : 's'} not ignored by git.` }); if (t.trackedFiles) out.push({ level: 'error', text: `${t.trackedFiles} .env file${t.trackedFiles === 1 ? '' : 's'} tracked in git.` }); if (t.missing) out.push({ level: 'warn', text: `${t.missing} variable${t.missing === 1 ? '' : 's'} missing against the templates.` }); if (t.drift) out.push({ level: 'info', text: `${t.drift} variable${t.drift === 1 ? '' : 's'} differ between environments.` }); return out; }, json));
  var permGate = shell && typeof shell.permGate === 'function' ? shell.permGate : null;

  function getRepos() {
    try {
      var appCfg = getConfig();
      var repos = appCfg.Repos || {};
      // Repos is an object: { "Repo Name": "/path/to/repo", ... }
      var result = [];
      var names = Object.keys(repos);
      for (var i = 0; i < names.length; i++) {
        result.push({ name: names[i], path: repos[names[i]] });
      }
      return result;
    } catch (_) {
      return [];
    }
  }

  function findRepo(repoName) {
    var repos = getRepos();
    for (var i = 0; i < repos.length; i++) {
      if (repos[i].name === repoName) return repos[i];
    }
    return null;
  }

  function getRepoPath(repo) {
    return repo.path || '';
  }

  addPrefixRoute(async (req, res, url, subpath) => {
    var method = req.method;

    try {
      // ── Config ─────────────────────────────────────────────────────────
      if (subpath === '/config' && method === 'GET') {
        var cfg = getCfg();
        return json(res, cfg);
      }
      if (subpath === '/config' && method === 'POST') {
        var body = await readBody(req);
        var cfg = getCfg();
        if (body.secretPatterns !== undefined) cfg.secretPatterns = body.secretPatterns;
        if (body.scanExtensions !== undefined) cfg.scanExtensions = body.scanExtensions;
        saveCfg(cfg);
        return json(res, { ok: true });
      }

      // ── Summary (plain text) ──────────────────────────────────────────
      if (subpath === '/summary' && method === 'GET') {
        var cfg = getCfg();
        var repos = getRepos();
        var lines = ['Environment Manager -- All Repos', '==================================', ''];

        for (var i = 0; i < repos.length; i++) {
          var repo = repos[i];
          var repoName = repo.name;
          var repoPath = getRepoPath(repo);
          if (!repoPath || !fs.existsSync(repoPath)) {
            lines.push(repoName + ' (path not found)');
            lines.push('');
            continue;
          }

          var result = scanRepo(repoPath, cfg);
          scanCache[repoName] = result;

          lines.push(repoName + ' (' + result.envFiles.length + ' env files, ' + result.totalVars + ' variables)');
          for (var f = 0; f < result.envFiles.length; f++) {
            var fn = result.envFiles[f];
            var varCount = result.fileData[fn].length;
            var gi = result.gitignoreStatus[fn];
            var giStr = gi.shouldBeIgnored ? (gi.isGitignored ? 'gitignored: YES' : 'gitignored: NO -- WARNING') : (gi.isGitignored ? 'gitignored: yes' : 'gitignored: no, OK');
            lines.push('  ' + fn + ' -- ' + varCount + ' vars (' + giStr + ')');
          }
          if (result.secrets.length > 0) {
            var secretKeys = result.secrets.map(function (s) { return s.key; });
            lines.push('  Secrets: ' + result.secrets.length + ' detected (' + secretKeys.join(', ') + ')');
          } else {
            lines.push('  Secrets: 0 detected');
          }
          lines.push('  Missing in code: ' + result.missing.length + ' vars used but not in .env');

          // Check for vars in .env but not in .env.example
          var exampleFile = null;
          if (result.fileData['.env.example']) exampleFile = '.env.example';
          else if (result.fileData['.env.template']) exampleFile = '.env.template';
          if (exampleFile) {
            var exampleKeys = {};
            for (var ek = 0; ek < result.fileData[exampleFile].length; ek++) {
              exampleKeys[result.fileData[exampleFile][ek].key] = true;
            }
            var mainEnv = result.fileData['.env'] || result.fileData['.env.local'] || [];
            var notInExample = 0;
            for (var mk = 0; mk < mainEnv.length; mk++) {
              if (!exampleKeys[mainEnv[mk].key]) notInExample++;
            }
            if (notInExample > 0) {
              lines.push('  WARNING: main .env has ' + notInExample + ' vars not in ' + exampleFile);
            }
          }
          lines.push('');
        }

        if (repos.length === 0) {
          lines.push('No repos configured in Cadence.');
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(lines.join('\n'));
        return true;
      }

      // ── Repos list ─────────────────────────────────────────────────────
      if (subpath === '/repos' && method === 'GET') {
        var cfg = getCfg();
        var repos = getRepos();
        var result = [];
        for (var i = 0; i < repos.length; i++) {
          var repo = repos[i];
          var repoName = repo.name;
          var repoPath = getRepoPath(repo);
          var envFiles = [];
          var totalVars = 0;
          var secretCount = 0;
          var missingCount = 0;
          var pathExists = repoPath && fs.existsSync(repoPath);

          if (pathExists) {
            if (scanCache[repoName]) {
              envFiles = scanCache[repoName].envFiles;
              totalVars = scanCache[repoName].totalVars;
              secretCount = scanCache[repoName].secrets.length;
              missingCount = scanCache[repoName].missing.length;
            } else {
              envFiles = findEnvFiles(repoPath);
            }
          }

          result.push({
            name: repoName,
            path: repoPath,
            pathExists: pathExists,
            envFileCount: envFiles.length,
            totalVars: totalVars,
            secretCount: secretCount,
            missingCount: missingCount,
            scanned: !!scanCache[repoName]
          });
        }
        return json(res, result);
      }

      // ── Scan all repos ────────────────────────────────────────────────
      if (subpath === '/scan-all' && method === 'POST') {
        var cfg = getCfg();
        var repos = getRepos();
        var results = [];
        for (var i = 0; i < repos.length; i++) {
          var repo = repos[i];
          var repoName = repo.name;
          var repoPath = getRepoPath(repo);
          if (!repoPath || !fs.existsSync(repoPath)) {
            results.push({ name: repoName, error: 'Path not found' });
            continue;
          }
          var result = scanRepo(repoPath, cfg);
          scanCache[repoName] = result;
          results.push({
            name: repoName,
            envFileCount: result.envFiles.length,
            totalVars: result.totalVars,
            secretCount: result.secrets.length,
            missingCount: result.missing.length
          });
        }
        return json(res, results);
      }

      // ── Cross-repo analysis ──────────────────────────────────────────
      if (subpath === '/cross-repo' && method === 'GET') {
        var cfg = getCfg();
        var secretPatterns = getSecretPatterns(cfg);
        var repos = getRepos();
        // Build a map of variable -> [{ repo, value, file, isSecret, gitignored }]
        var varMap = {};
        for (var ci = 0; ci < repos.length; ci++) {
          var cRepo = repos[ci];
          var cName = cRepo.name;
          var cPath = getRepoPath(cRepo);
          var cached = scanCache[cName];
          if (!cached) continue;

          var envFiles = cached.envFiles || [];
          for (var fi = 0; fi < envFiles.length; fi++) {
            var envFileName = envFiles[fi];
            var fullPath = path.join(cPath, envFileName);
            var entries = parseEnvFile(fullPath);
            var isIgnored = isGitignored(cPath, envFileName);
            for (var ei = 0; ei < entries.length; ei++) {
              var key = entries[ei].key;
              var val = entries[ei].value;
              var isSec = secretPatterns.some(function(p) { return key.toUpperCase().indexOf(p) !== -1; });
              if (!varMap[key]) varMap[key] = [];
              varMap[key].push({ repo: cName, value: val, file: envFileName, isSecret: isSec, gitignored: isIgnored });
            }
          }
        }

        // 1. Shared by NAME (same key in 2+ repos)
        var shared = [];
        var secretsSummary = [];
        var keys = Object.keys(varMap);
        for (var ki = 0; ki < keys.length; ki++) {
          var k = keys[ki];
          var entries2 = varMap[k];
          var repoNames = [];
          var values = [];
          for (var ri = 0; ri < entries2.length; ri++) {
            if (repoNames.indexOf(entries2[ri].repo) === -1) repoNames.push(entries2[ri].repo);
            if (values.indexOf(entries2[ri].value) === -1) values.push(entries2[ri].value);
          }
          if (repoNames.length >= 2) {
            var perRepo = {};
            for (var pri = 0; pri < entries2.length; pri++) {
              var ent = entries2[pri];
              if (!perRepo[ent.repo]) {
                var masked = ent.isSecret ? (ent.value.substring(0, 3) + '***') : ent.value;
                perRepo[ent.repo] = { value: masked, fullValue: ent.value, file: ent.file, isSecret: ent.isSecret };
              }
            }
            shared.push({
              key: k,
              count: repoNames.length,
              repos: repoNames,
              allMatch: values.length === 1,
              uniqueValues: values.length,
              perRepo: perRepo
            });
          }
          // Secret summary with per-repo details
          if (entries2[0].isSecret) {
            var secRepos = [];
            var allGitignored = true;
            var secPerRepo = {};
            for (var si = 0; si < entries2.length; si++) {
              var se = entries2[si];
              if (secRepos.indexOf(se.repo) === -1) secRepos.push(se.repo);
              if (!se.gitignored) allGitignored = false;
              if (!secPerRepo[se.repo]) {
                secPerRepo[se.repo] = {
                  masked: se.value.substring(0, 3) + '***',
                  fullValue: se.value,
                  file: se.file,
                  gitignored: se.gitignored
                };
              }
            }
            secretsSummary.push({ key: k, repos: secRepos, allGitignored: allGitignored, perRepo: secPerRepo });
          }
        }

        // 2. Shared by VALUE (same value, different key names across repos)
        var valueMap = {};
        for (var vki = 0; vki < keys.length; vki++) {
          var vk = keys[vki];
          var ventries = varMap[vk];
          for (var vei = 0; vei < ventries.length; vei++) {
            var ve = ventries[vei];
            if (!ve.value || ve.value.length < 4) continue; // skip empty/trivial values
            if (ve.isSecret) continue; // skip secrets (they'll match on API keys etc which is expected)
            if (ve.value === 'true' || ve.value === 'false' || ve.value === '0' || ve.value === '1' || ve.value === 'production' || ve.value === 'development') continue;
            var valKey = ve.value;
            if (!valueMap[valKey]) valueMap[valKey] = [];
            valueMap[valKey].push({ key: vk, repo: ve.repo, file: ve.file });
          }
        }
        var sharedByValue = [];
        var valKeys = Object.keys(valueMap);
        for (var vmi = 0; vmi < valKeys.length; vmi++) {
          var val = valKeys[vmi];
          var ves = valueMap[val];
          // Check if there are different KEY names with this same value
          var uniqueKeys = [];
          var uniqueRepos = [];
          for (var vj = 0; vj < ves.length; vj++) {
            if (uniqueKeys.indexOf(ves[vj].key) === -1) uniqueKeys.push(ves[vj].key);
            if (uniqueRepos.indexOf(ves[vj].repo) === -1) uniqueRepos.push(ves[vj].repo);
          }
          if (uniqueKeys.length >= 2) {
            sharedByValue.push({
              value: val.length > 40 ? val.substring(0, 40) + '...' : val,
              keys: uniqueKeys,
              repos: uniqueRepos,
              entries: ves
            });
          }
        }
        sharedByValue.sort(function(a, b) { return b.keys.length - a.keys.length; });

        // Sort shared by name: most shared first
        shared.sort(function(a, b) { return b.count - a.count; });

        return json(res, { shared: shared, sharedByValue: sharedByValue, secretsSummary: secretsSummary });
      }

      // ── Per-repo routes (/repos/:repoName/...) ────────────────────────
      // ── 3.0: the workspace in one call ──────────────────────────────────
      if (subpath === '/overview' && method === 'GET') {
        // Walking every repository's source takes seconds; keep the last answer two minutes unless asked fresh.
        if (overviewCache && url.searchParams.get('fresh') !== '1' && Date.now() - overviewCache.at < 120000) return json(res, overviewCache.data);
        var cfgO = getCfg();
        var reposO = getRepos();
        var rows = [];
        var totals = { repos: 0, withEnv: 0, withTemplate: 0, files: 0, variables: 0, secrets: 0, exposedFiles: 0, trackedFiles: 0, missing: 0, unused: 0, drift: 0, placeholders: 0 };
        for (var oi = 0; oi < reposO.length; oi++) {
          var ro = reposO[oi];
          var rp = getRepoPath(ro);
          totals.repos++;
          if (!rp || !fs.existsSync(rp)) { rows.push({ name: ro.name, path: rp, missingOnDisk: true, hasEnv: false, hasTemplate: false, files: [], templateFiles: [], totalVars: 0, secrets: [], missing: [], unused: [], drift: { missingFromTemplate: [], onlyInTemplate: [] }, exposed: [], tracked: [], risk: 0 }); continue; }
          var d = describeRepo(ro.name, rp, cfgO);
          var slim = { name: d.name, path: d.path, hasEnv: d.hasEnv, hasTemplate: d.hasTemplate, files: d.files, templateFiles: d.templateFiles, totalVars: d.totalVars, secrets: d.secrets, missing: d.missing.map(function (m) { return m.key; }), unused: d.unused, drift: d.drift, exposed: d.exposed, tracked: d.tracked, placeholders: d.variables.filter(function (v) { return v.placeholderIn.length; }).length, risk: d.risk, scannedAt: d.scannedAt };
          rows.push(slim);
          if (d.hasEnv) totals.withEnv++;
          if (d.hasTemplate) totals.withTemplate++;
          totals.files += d.files.length; totals.variables += d.totalVars; totals.secrets += d.secrets.length;
          totals.exposedFiles += d.exposed.length; totals.trackedFiles += d.tracked.length;
          totals.missing += d.missing.length; totals.unused += d.unused.length; totals.drift += d.drift.missingFromTemplate.length + d.drift.onlyInTemplate.length; totals.placeholders += slim.placeholders;
        }
        overviewCache = { at: Date.now(), data: { repos: rows, totals: totals, scannedAt: new Date().toISOString() } };
        return json(res, overviewCache.data);
      }

      var m3 = subpath.match(/^\/repos\/([^/]+)\/(detail|variable|reveal|set|write-template|protect)$/);
      if (m3) {
        var rName = decodeURIComponent(m3[1]);
        var rRepo = findRepo(rName);
        if (!rRepo) return json(res, { error: 'Repo not found: ' + rName }, 404);
        var rPath = getRepoPath(rRepo);
        if (!rPath || !fs.existsSync(rPath)) return json(res, { error: 'Repo path not found on disk' }, 404);
        var rCfg = getCfg();
        var envNameOk = function (f) { return typeof f === 'string' && /^\.env(\.[\w.-]+|-[\w.-]+)?$/.test(f) && f.indexOf('/') === -1 && f.indexOf('\\') === -1; };

        if (m3[2] === 'detail' && method === 'GET') {
          var det = describeRepo(rName, rPath, rCfg);
          var pats = getSecretPatterns(rCfg);
          det.leaked = scanForLeakedSecrets(rPath, getScanExtensions(rCfg), pats).map(function (l) { return { file: l.file, line: l.line, pattern: l.matchedPattern || '', preview: (l.snippet || '').slice(0, 120) }; });
          return json(res, det);
        }

        if (m3[2] === 'variable' && method === 'GET') {
          var key = url.searchParams.get('key');
          if (!key) return json(res, { error: 'key required' }, 400);
          var det2 = describeRepo(rName, rPath, rCfg);
          var v2 = det2.variables.find(function (x) { return x.key === key; }) || null;
          var refs2 = findReferences(rPath, key, getScanExtensions(rCfg));
          var inTemplates = det2.templateFiles.filter(function (tf) { return parseEnvFile(path.join(rPath, tf.name)).some(function (e) { return e.key === key; }); }).map(function (tf) { return tf.name; });
          return json(res, { key: key, variable: v2, references: refs2, files: det2.files.map(function (f) { return f.name; }), inTemplates: inTemplates, isSecret: v2 ? v2.isSecret : isSecretKey(key, getSecretPatterns(rCfg)) });
        }

        if (m3[2] === 'reveal' && method === 'POST') {
          if (permGate && !(await permGate(res, 'api', 'POST /api/plugins/env-manager/reveal', 'Reveal an environment value'))) return;
          var b1 = await readBody(req);
          if (!envNameOk(b1.file) || !b1.key) return json(res, { error: 'file and key required' }, 400);
          var e1 = parseEnvFile(path.join(rPath, b1.file)).find(function (e) { return e.key === b1.key; });
          return json(res, { key: b1.key, file: b1.file, value: e1 ? e1.value : null, present: !!e1 });
        }

        if (m3[2] === 'set' && method === 'POST') {
          if (permGate && !(await permGate(res, 'api', 'POST /api/plugins/env-manager/set', 'Write an environment variable'))) return;
          var b2 = await readBody(req);
          if (!envNameOk(b2.file) || !b2.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b2.key)) return json(res, { error: 'file and a valid key required' }, 400);
          var r2 = writeEnvValue(path.join(rPath, b2.file), b2.key, String(b2.value == null ? '' : b2.value));
          delete scanCache[rName]; overviewCache = null;
          return json(res, Object.assign({ ok: true, file: b2.file, key: b2.key }, r2));
        }

        if (m3[2] === 'write-template' && method === 'POST') {
          if (permGate && !(await permGate(res, 'api', 'POST /api/plugins/env-manager/write-template', 'Write .env.example'))) return;
          var b3 = await readBody(req);
          var target = b3.file && isTemplateEnv(b3.file) && envNameOk(b3.file) ? b3.file : '.env.example';
          var content3 = typeof b3.content === 'string' && b3.content.trim() ? b3.content : null;
          if (!content3) {
            // The same content the /template route builds, from the real files with secrets blanked.
            var det3 = describeRepo(rName, rPath, rCfg);
            var lines3 = ['# Environment variables for ' + rName, '# Copy to .env and fill in the values. Secrets are left blank on purpose.', ''];
            for (var vi = 0; vi < det3.variables.length; vi++) {
              var vv = det3.variables[vi];
              var firstVal = '';
              var names3 = Object.keys(vv.cells);
              for (var ni = 0; ni < names3.length; ni++) if (vv.cells[names3[ni]].present && !vv.cells[names3[ni]].empty) { firstVal = vv.cells[names3[ni]].value; break; }
              lines3.push(vv.key + '=' + (vv.isSecret ? '' : firstVal));
            }
            content3 = lines3.join('\n') + '\n';
          }
          fs.writeFileSync(path.join(rPath, target), content3, 'utf8');
          overviewCache = null;
          return json(res, { ok: true, file: target, bytes: Buffer.byteLength(content3) });
        }

        if (m3[2] === 'protect' && method === 'POST') {
          if (permGate && !(await permGate(res, 'api', 'POST /api/plugins/env-manager/protect', 'Add env files to .gitignore'))) return;
          var giPath = path.join(rPath, '.gitignore');
          var gi = ''; try { gi = fs.readFileSync(giPath, 'utf8'); } catch (_) {}
          var have = gi.split(/\r?\n/).map(function (l) { return l.trim(); });
          var add = ['.env', '.env.*', '!.env.example', '!.env.template', '!.env.sample'].filter(function (l) { return have.indexOf(l) === -1; });
          if (add.length) fs.writeFileSync(giPath, (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + '\n# Environment files (Cadence)\n' + add.join('\n') + '\n', 'utf8');
          var stillTracked = findEnvFiles(rPath).filter(function (f) { return gitTracked(rPath, f); });
          delete scanCache[rName]; overviewCache = null;
          return json(res, { ok: true, added: add, stillTracked: stillTracked, untrackCommand: stillTracked.length ? 'git rm --cached ' + stillTracked.join(' ') : null });
        }
      }

      var repoMatch = subpath.match(/^\/repos\/([^/]+)(\/.*)?$/);
      if (repoMatch) {
        var repoName = decodeURIComponent(repoMatch[1]);
        var repoSub = repoMatch[2] || '';
        var repo = findRepo(repoName);
        if (!repo) return json(res, { error: 'Repo not found: ' + repoName }, 404);
        var repoPath = getRepoPath(repo);
        if (!repoPath || !fs.existsSync(repoPath)) return json(res, { error: 'Repo path not found on disk' }, 404);
        var cfg = getCfg();

        // Scan a repo
        if (repoSub === '/scan' && method === 'POST') {
          var result = scanRepo(repoPath, cfg);
          scanCache[repoName] = result;
          return json(res, {
            envFileCount: result.envFiles.length,
            totalVars: result.totalVars,
            secretCount: result.secrets.length,
            missingCount: result.missing.length,
            envFiles: result.envFiles
          });
        }

        // List env files
        if (repoSub === '/files' && method === 'GET') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          var files = [];
          for (var f = 0; f < cached.envFiles.length; f++) {
            var fn = cached.envFiles[f];
            files.push({
              name: fn,
              variableCount: cached.fileData[fn].length,
              gitignore: cached.gitignoreStatus[fn]
            });
          }
          return json(res, files);
        }

        // Variables inventory
        if (repoSub === '/variables' && method === 'GET') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          // Mask secret values in the response
          var vars = cached.variables.map(function (v) {
            var maskedPresence = {};
            var presKeys = Object.keys(v.presence);
            for (var pk = 0; pk < presKeys.length; pk++) {
              var p = v.presence[presKeys[pk]];
              maskedPresence[presKeys[pk]] = {
                present: p.present,
                value: p.present ? (v.isSecret ? maskValue(p.value) : p.value) : '',
                rawValue: p.value
              };
            }
            return { key: v.key, isSecret: v.isSecret, presence: maskedPresence };
          });
          return json(res, { variables: vars, envFiles: cached.envFiles });
        }

        // Diff two env files
        if (repoSub === '/diff' && method === 'GET') {
          var file1 = url.searchParams.get('file1');
          var file2 = url.searchParams.get('file2');
          if (!file1 || !file2) return json(res, { error: 'file1 and file2 query params required' }, 400);

          var entries1 = parseEnvFile(path.join(repoPath, file1));
          var entries2 = parseEnvFile(path.join(repoPath, file2));
          var map1 = {};
          var map2 = {};
          for (var a = 0; a < entries1.length; a++) map1[entries1[a].key] = entries1[a].value;
          for (var b = 0; b < entries2.length; b++) map2[entries2[b].key] = entries2[b].value;

          var allDiffKeys = {};
          Object.keys(map1).forEach(function (k) { allDiffKeys[k] = true; });
          Object.keys(map2).forEach(function (k) { allDiffKeys[k] = true; });
          var patterns = getSecretPatterns(cfg);

          var diffs = [];
          var sortedKeys = Object.keys(allDiffKeys).sort();
          for (var d = 0; d < sortedKeys.length; d++) {
            var key = sortedKeys[d];
            var inFile1 = map1.hasOwnProperty(key);
            var inFile2 = map2.hasOwnProperty(key);
            var isSec = isSecretKey(key, patterns);
            var status = 'same';
            if (inFile1 && !inFile2) status = 'only-left';
            else if (!inFile1 && inFile2) status = 'only-right';
            else if (map1[key] !== map2[key]) status = 'different';
            diffs.push({
              key: key,
              status: status,
              isSecret: isSec,
              left: inFile1 ? (isSec ? maskValue(map1[key]) : map1[key]) : null,
              right: inFile2 ? (isSec ? maskValue(map2[key]) : map2[key]) : null,
              leftRaw: inFile1 ? map1[key] : null,
              rightRaw: inFile2 ? map2[key] : null
            });
          }
          return json(res, { file1: file1, file2: file2, diffs: diffs });
        }

        // Secrets detection
        if (repoSub === '/secrets' && method === 'GET') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          // Also scan for leaked secrets in source code
          var patterns = getSecretPatterns(cfg);
          var extensions = getScanExtensions(cfg);
          var leaked = scanForLeakedSecrets(repoPath, extensions, patterns);
          return json(res, {
            envSecrets: cached.secrets,
            leakedSecrets: leaked
          });
        }

        // Missing variables
        if (repoSub === '/missing' && method === 'GET') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          return json(res, cached.missing);
        }

        // Generate template
        if (repoSub === '/template' && method === 'POST') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          var patterns = getSecretPatterns(cfg);
          var lines = ['# Environment Variables Template', '# Generated by Cadence Environment Manager', '# Copy this file to .env and fill in the values', ''];

          var keyList = Object.keys(cached.fileData);
          // Prefer .env as source, then .env.local, then first available
          var sourceFile = '.env';
          if (!cached.fileData[sourceFile] || cached.fileData[sourceFile].length === 0) {
            sourceFile = '.env.local';
          }
          if (!cached.fileData[sourceFile] || cached.fileData[sourceFile].length === 0) {
            sourceFile = keyList[0] || '';
          }

          if (sourceFile && cached.fileData[sourceFile]) {
            var entries = cached.fileData[sourceFile];
            for (var t = 0; t < entries.length; t++) {
              var entry = entries[t];
              var isSec = isSecretKey(entry.key, patterns);
              if (isSec) {
                lines.push(entry.key + '=');
              } else {
                // Keep non-secret values as defaults
                lines.push(entry.key + '=' + entry.value);
              }
            }
          }

          // Also add any variables found in other env files but not in the source
          var sourceKeys = {};
          if (sourceFile && cached.fileData[sourceFile]) {
            cached.fileData[sourceFile].forEach(function (e) { sourceKeys[e.key] = true; });
          }
          for (var fi = 0; fi < cached.envFiles.length; fi++) {
            if (cached.envFiles[fi] === sourceFile) continue;
            var otherEntries = cached.fileData[cached.envFiles[fi]];
            var addedHeader = false;
            for (var oe = 0; oe < otherEntries.length; oe++) {
              if (!sourceKeys[otherEntries[oe].key]) {
                if (!addedHeader) {
                  lines.push('');
                  lines.push('# Additional vars from ' + cached.envFiles[fi]);
                  addedHeader = true;
                }
                sourceKeys[otherEntries[oe].key] = true;
                var isS = isSecretKey(otherEntries[oe].key, patterns);
                lines.push(otherEntries[oe].key + '=' + (isS ? '' : otherEntries[oe].value));
              }
            }
          }

          var content = lines.join('\n') + '\n';
          return json(res, { content: content, sourceFile: sourceFile });
        }

        // Gitignore check
        if (repoSub === '/gitignore-check' && method === 'GET') {
          var cached = scanCache[repoName];
          if (!cached) {
            cached = scanRepo(repoPath, cfg);
            scanCache[repoName] = cached;
          }
          return json(res, cached.gitignoreStatus);
        }

        return false;
      }

      return false;

    } catch (err) {
      return json(res, { error: err.message || 'Internal error' }, 500);
    }
  });
};
