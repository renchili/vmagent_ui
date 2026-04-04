import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import crypto from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 3099);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DRAFT_PATH = path.join(DATA_DIR, 'draft.yml');
const REV_DIR = path.join(DATA_DIR, 'revisions');
const AUDIT_PATH = path.join(DATA_DIR, 'audit', 'audit.log');
const CONFIG_PATH = process.env.VMAGENT_CONFIG_PATH || path.join(__dirname, 'config', 'sample-vmagent.yml');
const VMAGENT_BIN = process.env.VMAGENT_BIN || 'vmagent';
const RELOAD_URL = process.env.VMAGENT_RELOAD_URL || '';
const RELOAD_SIGNAL_PID = process.env.VMAGENT_PID || '';
const RESTART_CMD = process.env.VMAGENT_RESTART_CMD || '';
const AUTHOR = process.env.DEFAULT_AUTHOR || 'web-ui';

await ensurePaths();
if (!(await exists(DRAFT_PATH))) {
  await fs.copyFile(CONFIG_PATH, DRAFT_PATH);
}

app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

app.get('/api/health', async () => ({ ok: true, configPath: CONFIG_PATH }));

app.get('/api/config', async () => {
  const yamlText = await fs.readFile(DRAFT_PATH, 'utf8');
  const parsed = YAML.parse(yamlText) || {};
  return { yaml: yamlText, json: parsed, sourcePath: CONFIG_PATH, draftPath: DRAFT_PATH };
});

app.post('/api/config', async (request, reply) => {
  const body = request.body || {};
  const yamlText = normalizeInputToYaml(body);
  const validation = await validateYaml(yamlText);
  if (!validation.ok) {
    return reply.code(400).send(validation);
  }
  await fs.writeFile(DRAFT_PATH, yamlText, 'utf8');
  await appendAudit({ action: 'save_draft', author: body.author || AUTHOR, summary: 'Saved draft' });
  return { ok: true, validation };
});

app.post('/api/validate', async (request) => {
  const body = request.body || {};
  const yamlText = normalizeInputToYaml(body);
  return validateYaml(yamlText);
});

app.post('/api/render-yaml', async (request) => {
  const body = request.body || {};
  const yaml = normalizeInputToYaml(body);
  return { ok: true, yaml };
});

app.get('/api/revisions', async () => {
  const files = (await fs.readdir(REV_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  const items = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(REV_DIR, file), 'utf8');
    items.push(JSON.parse(raw));
  }
  return { items };
});

app.post('/api/publish', async (request, reply) => {
  const body = request.body || {};
  const yamlText = normalizeInputToYaml(body, await fs.readFile(DRAFT_PATH, 'utf8'));
  const author = body.author || AUTHOR;
  const note = body.note || 'publish from UI';
  const validation = await validateYaml(yamlText);
  if (!validation.ok) {
    return reply.code(400).send(validation);
  }

  const revision = await createRevision(yamlText, author, note, validation);
  const writeResult = await atomicWrite(CONFIG_PATH, yamlText);
  const applyResult = await applyConfig();
  await appendAudit({ action: 'publish', author, summary: note, revisionId: revision.id, applyResult });
  return { ok: true, revision, writeResult, applyResult };
});

app.post('/api/rollback/:id', async (request, reply) => {
  const id = request.params.id;
  const file = path.join(REV_DIR, `${id}.json`);
  if (!(await exists(file))) {
    return reply.code(404).send({ ok: false, error: 'Revision not found' });
  }
  const revision = JSON.parse(await fs.readFile(file, 'utf8'));
  await atomicWrite(DRAFT_PATH, revision.yaml);
  await atomicWrite(CONFIG_PATH, revision.yaml);
  const applyResult = await applyConfig();
  await appendAudit({ action: 'rollback', author: AUTHOR, summary: `Rollback to ${id}`, revisionId: id, applyResult });
  return { ok: true, revision, applyResult };
});

app.get('/api/audit', async () => {
  if (!(await exists(AUDIT_PATH))) return { items: [] };
  const content = await fs.readFile(AUDIT_PATH, 'utf8');
  const items = content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)).reverse() : [];
  return { items };
});

app.listen({ port: PORT, host: HOST })
  .then(() => app.log.info(`vmagent-ui listening on http://${HOST}:${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

function normalizeInputToYaml(body, fallbackYaml = '') {
  if (typeof body.yaml === 'string' && body.yaml.trim()) return body.yaml;
  if (body.json && typeof body.json === 'object') return YAML.stringify(body.json);
  return fallbackYaml;
}

async function validateYaml(yamlText) {
  const errors = [];
  let parsed;
  try {
    parsed = YAML.parse(yamlText) || {};
  } catch (error) {
    return { ok: false, errors: [{ source: 'yaml', message: error.message }] };
  }

  if (!Array.isArray(parsed.scrape_configs) || parsed.scrape_configs.length === 0) {
    errors.push({ source: 'schema', path: 'scrape_configs', message: 'At least one scrape_configs entry is required.' });
  }

  const jobNames = new Set();
  for (const [index, job] of (parsed.scrape_configs || []).entries()) {
    if (!job?.job_name) {
      errors.push({ source: 'business', path: `scrape_configs[${index}].job_name`, message: 'job_name is required.' });
    } else if (jobNames.has(job.job_name)) {
      errors.push({ source: 'business', path: `scrape_configs[${index}].job_name`, message: `Duplicate job_name: ${job.job_name}` });
    } else {
      jobNames.add(job.job_name);
    }
    const targets = job?.static_configs?.flatMap((item) => item?.targets || []) || [];
    if (!targets.length) {
      errors.push({ source: 'business', path: `scrape_configs[${index}].static_configs`, message: 'At least one target is required.' });
    }
  }

  const nativeCheck = await runVmagentDryRun(yamlText);
  if (!nativeCheck.ok && nativeCheck.skipped !== true) {
    errors.push({ source: 'vmagent', message: nativeCheck.stderr || nativeCheck.stdout || 'vmagent dry-run failed' });
  }

  return { ok: errors.length === 0, errors, nativeCheck, parsed };
}

async function runVmagentDryRun(yamlText) {
  const tmpPath = path.join(DATA_DIR, `.validate-${Date.now()}.yml`);
  await fs.writeFile(tmpPath, yamlText, 'utf8');
  try {
    const command = `${VMAGENT_BIN} -promscrape.config=${shellEscape(tmpPath)} -promscrape.config.strictParse=true -dryRun`;
    const { stdout, stderr } = await exec(command, { cwd: __dirname });
    return { ok: true, stdout, stderr, command };
  } catch (error) {
    if (String(error?.message || '').includes('not found') || error?.code === 127) {
      return { ok: true, skipped: true, reason: 'vmagent binary not available; native check skipped.' };
    }
    return { ok: false, stdout: error.stdout, stderr: error.stderr, code: error.code };
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

async function createRevision(yamlText, author, note, validation) {
  const parsed = YAML.parse(yamlText) || {};
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const item = {
    id,
    author,
    note,
    createdAt: new Date().toISOString(),
    sha256: crypto.createHash('sha256').update(yamlText).digest('hex'),
    summary: summarize(parsed),
    validation: {
      ok: validation.ok,
      nativeCheck: validation.nativeCheck,
      errors: validation.errors,
    },
    yaml: yamlText,
    json: parsed,
  };
  await fs.writeFile(path.join(REV_DIR, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');
  return item;
}

async function applyConfig() {
  if (RELOAD_URL) {
    try {
      const response = await fetch(RELOAD_URL, { method: 'POST' });
      return { method: 'http-reload', ok: response.ok, status: response.status };
    } catch (error) {
      return { method: 'http-reload', ok: false, error: error.message };
    }
  }
  if (RELOAD_SIGNAL_PID) {
    try {
      process.kill(Number(RELOAD_SIGNAL_PID), 'SIGHUP');
      return { method: 'sighup', ok: true, pid: Number(RELOAD_SIGNAL_PID) };
    } catch (error) {
      return { method: 'sighup', ok: false, error: error.message };
    }
  }
  if (RESTART_CMD) {
    try {
      const { stdout, stderr } = await exec(RESTART_CMD, { cwd: __dirname });
      return { method: 'restart', ok: true, stdout, stderr, command: RESTART_CMD };
    } catch (error) {
      return { method: 'restart', ok: false, stdout: error.stdout, stderr: error.stderr, code: error.code, command: RESTART_CMD };
    }
  }
  return { method: 'noop', ok: true, message: 'No reload/restart configured. Config written only.' };
}

async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
  return { ok: true, path: filePath };
}

async function appendAudit(entry) {
  await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true });
  await fs.appendFile(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function summarize(parsed) {
  return {
    scrapeJobs: (parsed.scrape_configs || []).map((job) => job.job_name),
    remoteWriteCount: Array.isArray(parsed.remote_write) ? parsed.remote_write.length : 0,
  };
}

async function ensurePaths() {
  await fs.mkdir(path.join(DATA_DIR, 'revisions'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'audit'), { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
