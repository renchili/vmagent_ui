import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import crypto from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRuntimeProfile, saveRuntimeProfile, validateRuntimeProfile } from './lib/runtime-profile.mjs';
import { renderDeploymentArtifacts } from './lib/deployments.mjs';
import { buildSystemdPlan, executeSystemdPlan } from './lib/systemd-apply.mjs';
import { configToStructured, structuredToConfig, validateStructuredConfig } from './lib/structured-config.mjs';
import { scanConfigChange, evaluateRiskDecision } from './lib/risk-scan.mjs';

const exec = promisify(execCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT || 3099);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DRAFT_PATH = path.join(DATA_DIR, 'draft.yml');
const RUNTIME_PROFILE_PATH = path.join(DATA_DIR, 'runtime-profile.json');
const REV_DIR = path.join(DATA_DIR, 'revisions');
const AUDIT_PATH = path.join(DATA_DIR, 'audit', 'audit.log');
const CONFIG_PATH = process.env.VMAGENT_CONFIG_PATH || path.join(__dirname, 'config', 'sample-vmagent.yml');
const VMAGENT_BIN = process.env.VMAGENT_BIN || 'vmagent';
const RELOAD_URL = process.env.VMAGENT_RELOAD_URL || '';
const RELOAD_SIGNAL_PID = process.env.VMAGENT_PID || '';
const RESTART_CMD = process.env.VMAGENT_RESTART_CMD || '';
const AUTHOR = process.env.DEFAULT_AUTHOR || 'web-ui';

await ensurePaths();
if (!(await exists(DRAFT_PATH))) await fs.copyFile(CONFIG_PATH, DRAFT_PATH);

app.register(fastifyStatic, { root: path.join(__dirname, 'public'), prefix: '/' });

app.get('/api/health', async () => ({ ok: true, configPath: CONFIG_PATH }));
app.get('/api/config', async () => {
  const yamlText = await fs.readFile(DRAFT_PATH, 'utf8');
  const parsed = YAML.parse(yamlText) || {};
  const runtimeProfile = await loadRuntimeProfile(RUNTIME_PROFILE_PATH);
  return buildConfigResponse({ yamlText, parsed, runtimeProfile, mode: 'normal' });
});

app.post('/api/config', async (request, reply) => {
  const body = request.body || {};
  const prepared = await prepareConfigPayload(body);
  if (!prepared.ok) return reply.code(400).send(prepared);
  await fs.writeFile(DRAFT_PATH, prepared.yamlText, 'utf8');
  await saveRuntimeProfile(RUNTIME_PROFILE_PATH, prepared.runtimeValidation.profile);
  await appendAudit({
    action: 'save_draft',
    author: body.author || AUTHOR,
    summary: `Saved ${prepared.mode} draft with rule bundle`,
    riskDecision: prepared.riskDecision.audit,
    riskSummary: prepared.responseExtras.riskScan?.summary || '',
  });
  return { ok: true, riskDecision: prepared.riskDecision, ...prepared.responseExtras, deploymentArtifacts: renderDeploymentArtifacts(prepared.runtimeValidation.profile) };
});

app.post('/api/validate', async (request, reply) => {
  const prepared = await prepareConfigPayload(request.body || {}, { skipRiskDecision: true });
  if (!prepared.ok) return reply.code(400).send(prepared);
  return { ok: true, ...prepared.responseExtras, deploymentArtifacts: renderDeploymentArtifacts(prepared.runtimeValidation.profile) };
});

app.get('/api/runtime-profile', async () => {
  const profile = await loadRuntimeProfile(RUNTIME_PROFILE_PATH);
  return { ok: true, profile, deploymentArtifacts: renderDeploymentArtifacts(profile) };
});

app.post('/api/runtime-profile', async (request, reply) => {
  const body = request.body || {};
  const runtimeValidation = validateRuntimeProfile(body.runtimeProfile || body);
  if (!runtimeValidation.ok) return reply.code(400).send(runtimeValidation);
  const profile = await saveRuntimeProfile(RUNTIME_PROFILE_PATH, runtimeValidation.profile);
  await appendAudit({ action: 'save_runtime_profile', author: body.author || AUTHOR, summary: `Updated runtime profile for ${profile.deployment.target}` });
  return { ok: true, profile, deploymentArtifacts: renderDeploymentArtifacts(profile) };
});

app.get('/api/revisions', async () => {
  const files = (await fs.readdir(REV_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
  const items = [];
  for (const file of files) items.push(JSON.parse(await fs.readFile(path.join(REV_DIR, file), 'utf8')));
  return { items };
});

app.post('/api/publish', async (request, reply) => {
  const body = request.body || {};
  const prepared = await prepareConfigPayload(body);
  if (!prepared.ok) return reply.code(400).send(prepared);
  const author = body.author || AUTHOR;
  const note = body.note || `publish from ${prepared.mode} mode`;
  const revision = await createRevision(prepared.yamlText, prepared.runtimeValidation.profile, author, note, prepared.validation, prepared.runtimeValidation, prepared.responseExtras.riskScan, prepared.mode, prepared.riskDecision.audit);
  const writeResult = await atomicWrite(CONFIG_PATH, prepared.yamlText);
  await saveRuntimeProfile(RUNTIME_PROFILE_PATH, prepared.runtimeValidation.profile);
  const applyResult = await applyConfig();
  await appendAudit({
    action: 'publish',
    author,
    summary: note,
    revisionId: revision.id,
    applyResult,
    deploymentTarget: prepared.runtimeValidation.profile.deployment.target,
    riskDecision: prepared.riskDecision.audit,
    riskSummary: prepared.responseExtras.riskScan?.summary || '',
  });
  return { ok: true, revision, writeResult, applyResult, riskDecision: prepared.riskDecision, ...prepared.responseExtras, deploymentArtifacts: renderDeploymentArtifacts(prepared.runtimeValidation.profile) };
});

app.post('/api/rollback/:id', async (request, reply) => {
  const id = request.params.id;
  const file = path.join(REV_DIR, `${id}.json`);
  if (!(await exists(file))) return reply.code(404).send({ ok: false, error: 'Revision not found' });
  const revision = JSON.parse(await fs.readFile(file, 'utf8'));
  await atomicWrite(DRAFT_PATH, revision.yaml);
  await atomicWrite(CONFIG_PATH, revision.yaml);
  if (revision.runtimeProfile) await saveRuntimeProfile(RUNTIME_PROFILE_PATH, revision.runtimeProfile);
  const applyResult = await applyConfig();
  await appendAudit({ action: 'rollback', author: AUTHOR, summary: `Rollback to ${id}`, revisionId: id, applyResult });
  return { ok: true, revision, applyResult, deploymentArtifacts: renderDeploymentArtifacts(revision.runtimeProfile || await loadRuntimeProfile(RUNTIME_PROFILE_PATH)) };
});

app.get('/api/audit', async () => {
  if (!(await exists(AUDIT_PATH))) return { items: [] };
  const content = await fs.readFile(AUDIT_PATH, 'utf8');
  return { items: content.trim() ? content.trim().split('\n').map((line) => JSON.parse(line)).reverse() : [] };
});

app.get('/api/deployment/:target', async (request, reply) => {
  const target = request.params.target;
  const profile = await loadRuntimeProfile(RUNTIME_PROFILE_PATH);
  const artifacts = renderDeploymentArtifacts(profile);
  if (!artifacts[target]) return reply.code(404).send({ ok: false, error: 'Unsupported deployment target' });
  return { ok: true, target, profile, artifact: artifacts[target] };
});

app.post('/api/deployment/compose/export', async (request, reply) => {
  const body = request.body || {};
  const runtimeValidation = validateRuntimeProfile(body.runtimeProfile || await loadRuntimeProfile(RUNTIME_PROFILE_PATH));
  if (!runtimeValidation.ok) return reply.code(400).send(runtimeValidation);
  const artifact = renderDeploymentArtifacts(runtimeValidation.profile).compose;
  const fileName = sanitizeFileName(body.fileName || 'docker-compose.vmagent.yml');
  const outputPath = body.outputPath ? path.resolve(__dirname, body.outputPath) : path.join(__dirname, 'data', fileName);
  const mode = body.mode || 'inline';
  if (mode === 'save') {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, artifact.yaml, 'utf8');
    return { ok: true, mode, artifact, fileName, outputPath, saved: true, bytes: Buffer.byteLength(artifact.yaml, 'utf8') };
  }
  if (mode === 'download') {
    reply.header('content-type', 'application/yaml; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${fileName}"`);
    reply.header('x-compose-file-name', fileName);
    return reply.send(artifact.yaml);
  }
  return { ok: true, mode: 'inline', artifact, fileName, outputPath, saved: false, bytes: Buffer.byteLength(artifact.yaml, 'utf8'), copyHint: '可直接复制 artifact.yaml，或用 mode=download / mode=save 获取文件。' };
});

app.post('/api/systemd/plan', async (request, reply) => {
  const body = request.body || {};
  const runtimeValidation = validateRuntimeProfile(body.runtimeProfile || await loadRuntimeProfile(RUNTIME_PROFILE_PATH));
  if (!runtimeValidation.ok) return reply.code(400).send(runtimeValidation);
  const artifacts = renderDeploymentArtifacts(runtimeValidation.profile);
  const plan = await buildSystemdPlan(runtimeValidation.profile, { artifact: artifacts.systemd, targetDir: body.targetDir || runtimeValidation.profile.deployment.systemd.controlledApply.targetDir, enableWrites: false });
  return { ok: true, plan, artifact: artifacts.systemd };
});

app.post('/api/systemd/apply', async (request, reply) => {
  const body = request.body || {};
  const runtimeValidation = validateRuntimeProfile(body.runtimeProfile || await loadRuntimeProfile(RUNTIME_PROFILE_PATH));
  if (!runtimeValidation.ok) return reply.code(400).send(runtimeValidation);
  const artifacts = renderDeploymentArtifacts(runtimeValidation.profile);
  const targetDir = body.targetDir || runtimeValidation.profile.deployment.systemd.controlledApply.targetDir;
  const result = await executeSystemdPlan({ fs, profile: runtimeValidation.profile, artifact: artifacts.systemd, options: { targetDir, enableWrites: Boolean(body.enableWrites) } });
  if (!result.ok) return reply.code(400).send(result);
  return result;
});

app.post('/api/render-yaml', async (request, reply) => {
  const body = request.body || {};
  if (body.mode === 'normal') {
    const structuredValidation = validateStructuredConfig(body.structuredConfig || {});
    if (!structuredValidation.ok) return reply.code(400).send(structuredValidation);
    const yaml = YAML.stringify(structuredToConfig(structuredValidation.config));
    return { ok: true, yaml, json: structuredToConfig(structuredValidation.config), structuredConfig: structuredValidation.config };
  }
  const yaml = normalizeInputToYaml(body);
  return { ok: true, yaml };
});

app.listen({ port: PORT, host: HOST }).then(() => app.log.info(`vmagent-ui listening on http://${HOST}:${PORT}`)).catch((err) => { app.log.error(err); process.exit(1); });

async function prepareConfigPayload(body, options = {}) {
  const mode = body.mode === 'advanced' ? 'advanced' : 'normal';
  const runtimeValidation = validateRuntimeProfile(body.runtimeProfile);
  if (!runtimeValidation.ok) return { ok: false, errors: runtimeValidation.errors, runtimeValidation };

  let yamlText = '';
  let parsed = {};
  let structuredConfig = null;
  let structuredValidation = null;

  if (mode === 'normal') {
    structuredValidation = validateStructuredConfig(body.structuredConfig || {});
    if (!structuredValidation.ok) return { ok: false, errors: structuredValidation.errors, structuredValidation, runtimeValidation };
    structuredConfig = structuredValidation.config;
    parsed = structuredToConfig(structuredConfig);
    yamlText = YAML.stringify(parsed);
  } else {
    yamlText = normalizeInputToYaml(body);
    try {
      parsed = YAML.parse(yamlText) || {};
    } catch (error) {
      return { ok: false, errors: [{ source: 'yaml', message: error.message }] };
    }
    structuredConfig = configToStructured(parsed);
  }

  const validation = await validateYaml(yamlText, parsed);
  if (!validation.ok) return { ok: false, errors: validation.errors, validation, runtimeValidation, structuredValidation };

  const currentConfigText = await fs.readFile(CONFIG_PATH, 'utf8').catch(() => '');
  const currentConfig = currentConfigText ? YAML.parse(currentConfigText) || {} : {};
  const riskScan = scanConfigChange({ previousConfig: currentConfig, nextConfig: validation.parsed, ruleBundle: runtimeValidation.profile.governance.ruleBundle, context: { mode } });

  const responseExtras = {
    mode,
    yaml: yamlText,
    json: validation.parsed,
    parsed: validation.parsed,
    structuredConfig,
    runtimeProfile: runtimeValidation.profile,
    validation,
    runtimeValidation,
    structuredValidation,
    ruleBundle: runtimeValidation.profile.governance.ruleBundle,
    riskScan,
    sourcePath: CONFIG_PATH,
    draftPath: DRAFT_PATH,
    runtimeProfilePath: RUNTIME_PROFILE_PATH,
  };

  if (options.skipRiskDecision) {
    return { ok: true, mode, yamlText, validation, runtimeValidation, structuredValidation, responseExtras };
  }

  const riskDecision = evaluateRiskDecision({
    riskScan,
    requestDecision: {
      decision: body.decision,
      confirm: body.confirm,
      overrideToken: body.overrideToken,
      overrideReason: body.overrideReason,
      approveRisk: body.approveRisk,
    },
  });

  if (!riskDecision.ok) {
    return {
      ok: false,
      errors: [{ source: 'risk', message: riskDecision.message || '风险决策未通过。' }],
      validation,
      runtimeValidation,
      structuredValidation,
      riskScan,
      riskDecision,
      ...responseExtras,
    };
  }

  return { ok: true, mode, yamlText, validation, runtimeValidation, structuredValidation, responseExtras, riskDecision };
}

function buildConfigResponse({ yamlText, parsed, runtimeProfile, mode }) {
  const structuredConfig = configToStructured(parsed);
  const riskScan = scanConfigChange({ previousConfig: parsed, nextConfig: parsed, ruleBundle: runtimeProfile.governance.ruleBundle, context: { mode } });
  return { yaml: yamlText, json: parsed, parsed, structuredConfig, mode, runtimeProfile, ruleBundle: runtimeProfile.governance.ruleBundle, riskScan, deploymentArtifacts: renderDeploymentArtifacts(runtimeProfile), sourcePath: CONFIG_PATH, draftPath: DRAFT_PATH, runtimeProfilePath: RUNTIME_PROFILE_PATH };
}

function normalizeInputToYaml(body, fallbackYaml = '') {
  if (typeof body.yaml === 'string' && body.yaml.trim()) return body.yaml;
  if (body.json && typeof body.json === 'object') return YAML.stringify(body.json);
  return fallbackYaml;
}

async function validateYaml(yamlText, parsedInput) {
  const errors = [];
  let parsed = parsedInput;
  try { parsed = parsed || YAML.parse(yamlText) || {}; } catch (error) { return { ok: false, errors: [{ source: 'yaml', message: error.message }] }; }
  if (!Array.isArray(parsed.scrape_configs) || parsed.scrape_configs.length === 0) errors.push({ source: 'schema', path: 'scrape_configs', message: 'At least one scrape_configs entry is required.' });
  const jobNames = new Set();
  for (const [index, job] of (parsed.scrape_configs || []).entries()) {
    if (!job?.job_name) errors.push({ source: 'business', path: `scrape_configs[${index}].job_name`, message: 'job_name is required.' });
    else if (jobNames.has(job.job_name)) errors.push({ source: 'business', path: `scrape_configs[${index}].job_name`, message: `Duplicate job_name: ${job.job_name}` });
    else jobNames.add(job.job_name);
    const targets = job?.static_configs?.flatMap((item) => item?.targets || []) || [];
    if (!targets.length) errors.push({ source: 'business', path: `scrape_configs[${index}].static_configs`, message: 'At least one target is required.' });
  }
  const nativeCheck = await runVmagentDryRun(yamlText);
  if (!nativeCheck.ok && nativeCheck.skipped !== true) errors.push({ source: 'vmagent', message: nativeCheck.stderr || nativeCheck.stdout || 'vmagent dry-run failed' });
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
    if (String(error?.message || '').includes('not found') || error?.code === 127) return { ok: true, skipped: true, reason: 'vmagent binary not available; native check skipped.' };
    return { ok: false, stdout: error.stdout, stderr: error.stderr, code: error.code };
  } finally { await fs.rm(tmpPath, { force: true }); }
}

async function createRevision(yamlText, runtimeProfile, author, note, validation, runtimeValidation, riskScan, mode, riskDecision) {
  const parsed = YAML.parse(yamlText) || {};
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const item = { id, author, note, mode, createdAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(yamlText).digest('hex'), summary: summarize(parsed, runtimeProfile), validation: { ok: validation.ok, nativeCheck: validation.nativeCheck, errors: validation.errors }, runtimeValidation: { ok: runtimeValidation.ok, errors: runtimeValidation.errors }, runtimeProfile, riskScan, riskDecision, yaml: yamlText, json: parsed };
  await fs.writeFile(path.join(REV_DIR, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');
  return item;
}

async function applyConfig() { if (RELOAD_URL) { try { const response = await fetch(RELOAD_URL, { method: 'POST' }); return { method: 'http-reload', ok: response.ok, status: response.status }; } catch (error) { return { method: 'http-reload', ok: false, error: error.message }; } } if (RELOAD_SIGNAL_PID) { try { process.kill(Number(RELOAD_SIGNAL_PID), 'SIGHUP'); return { method: 'sighup', ok: true, pid: Number(RELOAD_SIGNAL_PID) }; } catch (error) { return { method: 'sighup', ok: false, error: error.message }; } } if (RESTART_CMD) { try { const { stdout, stderr } = await exec(RESTART_CMD, { cwd: __dirname }); return { method: 'restart', ok: true, stdout, stderr, command: RESTART_CMD }; } catch (error) { return { method: 'restart', ok: false, stdout: error.stdout, stderr: error.stderr, code: error.code, command: RESTART_CMD }; } } return { method: 'noop', ok: true, message: 'No reload/restart configured. Config written only.' }; }
async function atomicWrite(filePath, content) { const tmp = `${filePath}.tmp`; await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(tmp, content, 'utf8'); await fs.rename(tmp, filePath); return { ok: true, path: filePath }; }
async function appendAudit(entry) { await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true }); await fs.appendFile(AUDIT_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8'); }
function summarize(parsed, runtimeProfile = {}) { return { scrapeJobs: (parsed.scrape_configs || []).map((job) => job.job_name), remoteWriteCount: Array.isArray(parsed.remote_write) ? parsed.remote_write.length : 0, clusterEnabled: Boolean(runtimeProfile.cluster?.enabled), membersCount: runtimeProfile.cluster?.membersCount ?? null, memberNum: runtimeProfile.cluster?.memberNum ?? null, replicationFactor: runtimeProfile.cluster?.replicationFactor ?? null, shardByURL: Boolean(runtimeProfile.remoteWrite?.shardByURL), tmpDataPath: runtimeProfile.remoteWrite?.tmpDataPath || null, deploymentTarget: runtimeProfile.deployment?.target || null }; }
async function ensurePaths() { await fs.mkdir(path.join(DATA_DIR, 'revisions'), { recursive: true }); await fs.mkdir(path.join(DATA_DIR, 'audit'), { recursive: true }); }
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
function shellEscape(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function sanitizeFileName(value) { return String(value || 'docker-compose.vmagent.yml').replace(/[^a-zA-Z0-9._-]/g, '_'); }
