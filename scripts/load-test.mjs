import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.BASE_URL || 'http://127.0.0.1:3099';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sample-vmagent.yml');
const draftPath = path.join(root, 'data', 'draft.yml');
const runtimeProfilePath = path.join(root, 'data', 'runtime-profile.json');
const reportPath = path.join(root, 'docs', 'perf-results.json');

const originalConfig = await fs.readFile(configPath, 'utf8');
const originalDraft = await fs.readFile(draftPath, 'utf8').catch(() => originalConfig);
const originalRuntimeProfile = await fs.readFile(runtimeProfilePath, 'utf8').catch(() => null);

const safeYaml = `global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: load_safe\n    metrics_path: /metrics\n    static_configs:\n      - targets:\n          - load-safe.internal:8080\n        labels:\n          env: perf\n          team: infra\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n`;

const riskyYaml = `global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: BadJob\n    metrics_path: /metrics\n    static_configs:\n      - targets:\n          - load-risk.internal:8080\n        labels:\n          Env: perf\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n`;

const profile = {
  cluster: { enabled: true, membersCount: 3, memberNum: 1, replicationFactor: 1 },
  remoteWrite: { shardByURL: true, tmpDataPath: '/var/lib/vmagent-remotewrite-data' },
  governance: {
    ruleBundle: {
      enabled: true,
      enforcementMode: 'warn',
      rules: {
        labelNaming: { enabled: true, pattern: '^[a-z_][a-z0-9_]*$' },
        metricNaming: { enabled: true, pattern: '^[a-z_:][a-z0-9_:]*$' },
        suspiciousChanges: { enabled: true, additionsThreshold: 5 },
      },
    },
  },
  deployment: {
    target: 'docker',
    docker: {
      image: 'victoriametrics/vmagent:latest',
      containerName: 'vmagent',
      configMountPath: '/etc/vmagent/config.yml',
      dataMountPath: '/var/lib/vmagent-remotewrite-data',
      extraArgs: [],
    },
    systemd: {
      serviceName: 'vmagent',
      configPath: '/etc/vmagent/config.yml',
      dataPath: '/var/lib/vmagent-remotewrite-data',
      extraArgs: [],
      controlledApply: { enabled: true, targetDir: './data/systemd-preview' },
    },
  },
};

const blockProfile = structuredClone(profile);
blockProfile.governance.ruleBundle.enforcementMode = 'block';

const report = {
  startedAt: new Date().toISOString(),
  base,
  scenarios: [],
};

let riskyRevisionId = null;
let baselineRevisionId = null;

try {
  await get('/api/health');

  report.scenarios.push(await runScenario({
    name: 'validate-safe',
    method: 'POST',
    path: '/api/validate',
    body: { mode: 'advanced', yaml: safeYaml, runtimeProfile: profile },
    iterations: Number(process.env.VALIDATE_ITERATIONS || 30),
    concurrency: Number(process.env.VALIDATE_CONCURRENCY || 5),
    expect: (data) => data.ok === true,
  }));

  report.scenarios.push(await runScenario({
    name: 'config-save-safe',
    method: 'POST',
    path: '/api/config',
    body: { mode: 'advanced', yaml: safeYaml, runtimeProfile: profile },
    iterations: Number(process.env.CONFIG_ITERATIONS || 12),
    concurrency: Number(process.env.CONFIG_CONCURRENCY || 2),
    expect: (data) => data.ok === true,
  }));

  const blockValidate = await request('POST', '/api/validate', { mode: 'advanced', yaml: riskyYaml, runtimeProfile: blockProfile });
  const overrideToken = blockValidate.data?.riskScan?.decisionPolicy?.confirmation?.overrideToken;
  if (!overrideToken) throw new Error('load test preflight failed: missing overrideToken for block profile');

  report.scenarios.push(await runScenario({
    name: 'publish-safe-serial',
    method: 'POST',
    path: '/api/publish',
    bodyFactory: (index) => ({
      mode: 'advanced',
      yaml: safeYaml.replace('load_safe', `load_safe_${index}`),
      runtimeProfile: profile,
      note: `load safe publish ${index}`,
    }),
    iterations: Number(process.env.PUBLISH_ITERATIONS || 4),
    concurrency: 1,
    expect: (data) => {
      if (!data?.ok || !data?.revision?.id) return false;
      baselineRevisionId = data.revision.id;
      return true;
    },
  }));

  report.scenarios.push(await runScenario({
    name: 'revisions-list',
    method: 'GET',
    path: '/api/revisions',
    iterations: Number(process.env.REVISIONS_ITERATIONS || 20),
    concurrency: Number(process.env.REVISIONS_CONCURRENCY || 4),
    expect: (data) => Array.isArray(data.items),
  }));

  report.scenarios.push(await runScenario({
    name: 'publish-risk-force-serial',
    method: 'POST',
    path: '/api/publish',
    bodyFactory: (index) => ({
      mode: 'advanced',
      yaml: riskyYaml,
      runtimeProfile: blockProfile,
      note: `load forced publish ${index}`,
      decision: 'force_apply',
      confirm: true,
      overrideToken,
      overrideReason: 'performance harness exercising block+force_apply publish path',
    }),
    iterations: Number(process.env.RISKY_PUBLISH_ITERATIONS || 1),
    concurrency: 1,
    expect: (data) => {
      if (!data?.ok || data?.riskDecision?.finalAction !== 'force_apply' || !data?.revision?.id) return false;
      riskyRevisionId = data.revision.id;
      return true;
    },
  }));

  report.scenarios.push(await runScenario({
    name: 'publish-risk-rejected-wrong-token',
    method: 'POST',
    path: '/api/publish',
    body: {
      mode: 'advanced',
      yaml: riskyYaml,
      runtimeProfile: blockProfile,
      note: 'load rejected publish wrong token',
      decision: 'force_apply',
      confirm: true,
      overrideToken: 'deadbeefdeadbeef',
      overrideReason: 'negative perf path',
    },
    iterations: Number(process.env.REJECTED_PUBLISH_ITERATIONS || 3),
    concurrency: 1,
    expect: (_data, _index, result) => result.status === 400,
  }));

  if (!riskyRevisionId) throw new Error('load test failed to create risky revision for rollback');

  report.scenarios.push(await runScenario({
    name: 'rollback-serial',
    method: 'POST',
    pathFactory: () => `/api/rollback/${riskyRevisionId}`,
    body: {},
    iterations: Number(process.env.ROLLBACK_ITERATIONS || 2),
    concurrency: 1,
    expect: (data) => data?.ok === true && data?.revision?.id === riskyRevisionId,
  }));

  report.finishedAt = new Date().toISOString();
  report.summary = summarizeReport(report.scenarios);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, reportPath, summary: report.summary }, null, 2));
} finally {
  await fs.writeFile(configPath, originalConfig, 'utf8');
  await fs.writeFile(draftPath, originalDraft, 'utf8').catch(() => {});
  if (originalRuntimeProfile !== null) {
    await fs.writeFile(runtimeProfilePath, originalRuntimeProfile, 'utf8');
  }
}

async function runScenario({ name, method, path: fixedPath, pathFactory, body, bodyFactory, iterations, concurrency, expect }) {
  const started = Date.now();
  let cursor = 0;
  const samples = [];
  const failures = [];

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= iterations) return;
      const currentPath = pathFactory ? pathFactory(index) : fixedPath;
      const currentBody = bodyFactory ? bodyFactory(index) : body;
      const startedAt = Date.now();
      try {
        const result = await request(method, currentPath, currentBody);
        const durationMs = Date.now() - startedAt;
        const ok = expect ? expect(result.data, index, result) : result.ok;
        samples.push({ durationMs, status: result.status });
        if (!ok) failures.push({ index, status: result.status, body: truncate(JSON.stringify(result.data)) });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        samples.push({ durationMs, status: 0 });
        failures.push({ index, status: 0, body: truncate(error.message) });
      }
    }
  });

  await Promise.all(workers);
  const totalMs = Date.now() - started;
  const durations = samples.map((item) => item.durationMs).sort((a, b) => a - b);
  const successCount = samples.length - failures.length;
  return {
    name,
    method,
    path: fixedPath || '[dynamic]',
    iterations,
    concurrency,
    totalMs,
    throughputRps: round(samples.length / (totalMs / 1000)),
    successCount,
    failureCount: failures.length,
    successRate: round(successCount / samples.length),
    latencyMs: {
      min: durations[0] || 0,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations[durations.length - 1] || 0,
      avg: round(durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)),
    },
    failures: failures.slice(0, 5),
  };
}

async function get(pathname) {
  return (await request('GET', pathname)).data;
}

async function request(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function round(value) {
  return Number(value.toFixed(2));
}

function truncate(value, limit = 240) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function summarizeReport(scenarios) {
  const totalRequests = scenarios.reduce((sum, item) => sum + item.iterations, 0);
  const totalFailures = scenarios.reduce((sum, item) => sum + item.failureCount, 0);
  return {
    scenarioCount: scenarios.length,
    totalRequests,
    totalFailures,
    overallSuccessRate: totalRequests ? round((totalRequests - totalFailures) / totalRequests) : 0,
  };
}
