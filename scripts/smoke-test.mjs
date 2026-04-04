import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.BASE_URL || 'http://127.0.0.1:3099';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'config', 'sample-vmagent.yml');
const draftPath = path.join(root, 'data', 'draft.yml');
const sampleYaml = await fs.readFile(configPath, 'utf8');
const composeSavePath = './data/test-output/docker-compose.smoke.yml';

const profile = {
  cluster: {
    enabled: true,
    membersCount: 3,
    memberNum: 1,
    replicationFactor: 1,
  },
  remoteWrite: {
    shardByURL: true,
    tmpDataPath: '/var/lib/vmagent-remotewrite-data',
  },
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
    },
    systemd: {
      serviceName: 'vmagent',
      configPath: '/etc/vmagent/config.yml',
      controlledApply: {
        enabled: true,
        targetDir: './data/systemd-preview',
      },
    },
  },
};

const blockProfile = { ...profile, governance: { ruleBundle: { ...profile.governance.ruleBundle, enforcementMode: 'block' } } };
const riskyYaml = `global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: BadJob\n    static_configs:\n      - targets:\n          - demo.internal:8080\n        labels:\n          Env: demo\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n`;
const publishedYaml = `global:\n  scrape_interval: 30s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: publish-demo\n    static_configs:\n      - targets:\n          - publish.demo.internal:8080\n        labels:\n          env: smoke\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n`;

const originalConfig = await fs.readFile(configPath, 'utf8');
const originalDraft = await fs.readFile(draftPath, 'utf8').catch(() => originalConfig);

let forcedPublishRevisionId = null;
let baselineRevisionId = null;

try {
  await assertOk('/api/health');

  const validate = await post('/api/validate', { mode: 'advanced', yaml: sampleYaml, runtimeProfile: profile });
  if (!validate.ok) throw new Error(`validate failed: ${JSON.stringify(validate)}`);

  const warnRisk = await post('/api/validate', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: profile,
  });
  if (!warnRisk.riskScan?.hasRisk) throw new Error('warn risk scan should detect risk');
  if (warnRisk.riskScan?.decisionPolicy?.requiredAction !== 'allow_apply') throw new Error('warn mode should default allow_apply');

  const blockRisk = await post('/api/validate', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
  });
  const overrideToken = blockRisk.riskScan?.decisionPolicy?.confirmation?.overrideToken;
  if (!overrideToken) throw new Error('block mode should expose overrideToken');
  if (blockRisk.riskScan?.decisionPolicy?.requiredAction !== 'force_apply') throw new Error('block mode should require force_apply');

  const saveBlocked = await postExpectError('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
  });
  if (!String(saveBlocked.errors?.[0]?.message || '').includes('confirm=true')) throw new Error('block save should require confirmation');

  const saveForced = await post('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    decision: 'force_apply',
    confirm: true,
    overrideToken,
    overrideReason: '值班人确认是一次受控演练，需要继续验证发布链路。',
  });
  if (saveForced.riskDecision?.finalAction !== 'force_apply') throw new Error('forced save should return force_apply');

  const publishBlocked = await postExpectError('/api/publish', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    note: 'smoke publish should fail without confirmation',
  });
  if (!String(publishBlocked.errors?.[0]?.message || '').includes('confirm=true')) throw new Error('block publish should require confirmation');

  const forcedPublish = await post('/api/publish', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    note: 'smoke forced publish',
    decision: 'force_apply',
    confirm: true,
    overrideToken,
    overrideReason: '值班人确认这是 publish 风险强制生效链路测试。',
  });
  if (forcedPublish.riskDecision?.finalAction !== 'force_apply') throw new Error('forced publish should return force_apply');
  forcedPublishRevisionId = forcedPublish.revision?.id;
  if (!forcedPublishRevisionId) throw new Error('forced publish should create revision id');
  const forcedConfig = await fs.readFile(configPath, 'utf8');
  if (!forcedConfig.includes('BadJob')) throw new Error('forced publish should update active config');

  const safePublish = await post('/api/publish', {
    mode: 'advanced',
    yaml: publishedYaml,
    runtimeProfile: profile,
    note: 'smoke safe publish baseline for rollback',
  });
  baselineRevisionId = safePublish.revision?.id;
  if (!baselineRevisionId) throw new Error('safe publish should create baseline revision');
  const baselineConfig = await fs.readFile(configPath, 'utf8');
  if (!baselineConfig.includes('publish-demo')) throw new Error('safe publish should update active config to publish-demo');

  const revisions = await get('/api/revisions');
  const forcedRevision = (revisions.items || []).find((item) => item.id === forcedPublishRevisionId);
  const baselineRevision = (revisions.items || []).find((item) => item.id === baselineRevisionId);
  if (!forcedRevision?.riskDecision || forcedRevision.riskDecision.decision !== 'force_apply') throw new Error('forced publish revision should persist riskDecision');
  if (!forcedRevision?.riskScan?.hasRisk) throw new Error('forced publish revision should persist riskScan');
  if (!baselineRevision || baselineRevision.note !== 'smoke safe publish baseline for rollback') throw new Error('baseline revision should be listed');

  const rollback = await post(`/api/rollback/${forcedPublishRevisionId}`, {});
  const rolledBackConfig = await fs.readFile(configPath, 'utf8');
  const rolledBackDraft = await fs.readFile(draftPath, 'utf8');
  if (!rolledBackConfig.includes('BadJob')) throw new Error('rollback should restore forced publish config');
  if (!rolledBackDraft.includes('BadJob')) throw new Error('rollback should also restore draft');
  if (rollback.revision?.id !== forcedPublishRevisionId) throw new Error('rollback response should reference restored revision');

  const audit = await get('/api/audit');
  const latestRollback = (audit.items || []).find((item) => item.action === 'rollback' && item.revisionId === forcedPublishRevisionId);
  const latestPublish = (audit.items || []).find((item) => item.action === 'publish' && item.revisionId === forcedPublishRevisionId);
  if (!latestRollback) throw new Error('audit should contain rollback record');
  if (!latestPublish?.riskDecision || latestPublish.riskDecision.decision !== 'force_apply') throw new Error('audit should retain publish riskDecision');

  const compose = await post('/api/deployment/compose/export', { runtimeProfile: profile, mode: 'inline' });
  if (!compose.artifact?.yaml?.includes('services:')) throw new Error('compose export missing services');
  if (!compose.copyHint) throw new Error('compose export missing copy hint');

  const composeSaved = await post('/api/deployment/compose/export', {
    runtimeProfile: profile,
    mode: 'save',
    outputPath: composeSavePath,
  });
  if (!composeSaved.saved || !composeSaved.outputPath?.endsWith('docker-compose.smoke.yml')) {
    throw new Error(`compose save failed: ${JSON.stringify(composeSaved)}`);
  }

  const download = await fetch(`${base}/api/deployment/compose/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeProfile: profile, mode: 'download', fileName: 'downloaded-compose.yml' }),
  });
  if (!download.ok) throw new Error(`compose download failed: ${await download.text()}`);
  if ((download.headers.get('content-disposition') || '').includes('downloaded-compose.yml') === false) {
    throw new Error('compose download missing attachment header');
  }

  const plan = await post('/api/systemd/plan', { runtimeProfile: profile });
  if (!plan.plan?.warnings?.length) throw new Error('systemd plan missing warnings');
  if (!plan.plan?.checks || typeof plan.plan.checks.targetDirProvided !== 'boolean') {
    throw new Error('systemd plan missing readonly checks');
  }

  const checkedPlan = await post('/api/systemd/plan', { runtimeProfile: profile, targetDir: './data/systemd-preview' });
  if (!checkedPlan.plan?.checks?.targetDirProvided) throw new Error('systemd checked plan should mark targetDirProvided');

  const apply = await post('/api/systemd/apply', { runtimeProfile: profile, enableWrites: false });
  if (apply.changed !== false) throw new Error('systemd dry-run should not write files');

  console.log('smoke ok');
} finally {
  await fs.writeFile(configPath, originalConfig, 'utf8');
  await fs.writeFile(draftPath, originalDraft, 'utf8').catch(() => {});
}

async function assertOk(pathname) {
  const data = await get(pathname);
  if (!data.ok) throw new Error(`request failed for ${pathname}`);
}

async function get(pathname) {
  const response = await fetch(`${base}${pathname}`);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function post(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function postExpectError(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (response.ok) throw new Error(`expected error for ${pathname}: ${JSON.stringify(data)}`);
  return data;
}
