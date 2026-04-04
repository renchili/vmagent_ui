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
const metricsRiskProfile = structuredClone(profile);
metricsRiskProfile.governance.ruleBundle.rules.metricsVolume = {
  enabled: true,
  estimatedSeriesPerTarget: 2000,
  maxEstimatedSeries: 1000,
  maxLabelCombinationsPerMetric: 2,
  highCardinalityLabels: ['Env', 'trace_id'],
  growthTrend: { enabled: true, minHistoryPoints: 3, consecutiveGrowthPeriods: 3, maxGrowthRatio: 0.2, observedTotalSeriesHistory: [100, 140, 180, 260] },
  observedMetrics: [{ name: 'http_requests_total', labelCombinations: 5 }],
};
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

  const metricsRisk = await post('/api/validate', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: metricsRiskProfile,
  });
  const metricRuleTypes = (metricsRisk.riskScan?.findings || []).map((item) => item.ruleType);
  if (!metricRuleTypes.includes('metricsVolume.totalSeriesBudget')) throw new Error('metrics volume should detect total series budget risk');
  if (!metricRuleTypes.includes('metricsVolume.singleMetricLabelCardinality')) throw new Error('metrics volume should detect per-metric label cardinality risk');
  if (!metricRuleTypes.includes('metricsVolume.growthTrend')) throw new Error('metrics volume should detect growth trend risk');
  if (!metricRuleTypes.includes('metricsVolume.highRiskLabel')) throw new Error('metrics volume should detect high-risk labels');

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

  const saveWrongToken = await postExpectError('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    decision: 'force_apply',
    confirm: true,
    overrideToken: 'deadbeefdeadbeef',
    overrideReason: '故意使用错误 token，验证异常分支。',
  });
  if (!String(saveWrongToken.errors?.[0]?.message || '').includes('overrideToken')) throw new Error('wrong overrideToken should be rejected');

  const saveMissingReason = await postExpectError('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    decision: 'force_apply',
    confirm: true,
    overrideToken,
  });
  if (!String(saveMissingReason.errors?.[0]?.message || '').includes('overrideReason')) throw new Error('missing overrideReason should be rejected');

  const saveForceWithoutConfirm = await postExpectError('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: blockProfile,
    decision: 'force_apply',
    confirm: false,
    overrideToken,
    overrideReason: '故意不勾确认，验证异常分支。',
  });
  if (!String(saveForceWithoutConfirm.errors?.[0]?.message || '').includes('confirm=true')) throw new Error('force_apply without confirm should be rejected');

  const warnBlock = await postExpectError('/api/config', {
    mode: 'advanced',
    yaml: riskyYaml,
    runtimeProfile: profile,
    decision: 'block_apply',
    overrideReason: 'warn 模式下人工明确阻止本次生效。',
  });
  if (!String(warnBlock.errors?.[0]?.message || '').includes('人工明确选择不生效')) throw new Error('warn mode block_apply should stop operation');

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

  const missingRollback = await postExpectError('/api/rollback/revision-does-not-exist', {});
  if (!String(missingRollback.error || '').includes('Revision not found')) throw new Error('missing revision rollback should return not found');

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

  const composeInvalidPath = await postExpectError('/api/deployment/compose/export', {
    runtimeProfile: profile,
    mode: 'save',
    outputPath: '../outside-compose.yml',
  });
  if (!String(composeInvalidPath.errors?.[0]?.message || '').includes('不允许逃逸项目目录')) {
    throw new Error('compose export should reject escaping outputPath');
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

  const invalidSystemdPlan = await postExpectError('/api/systemd/plan', { runtimeProfile: profile, targetDir: '../etc/systemd/system' });
  if (!String(invalidSystemdPlan.errors?.[0]?.message || '').includes('不允许逃逸项目目录')) throw new Error('systemd plan should reject escaping targetDir');

  const invalidSystemdApply = await postExpectError('/api/systemd/apply', { runtimeProfile: profile, targetDir: './data/systemd-preview/vmagent.service', enableWrites: true });
  if (!String(invalidSystemdApply.errors?.[0]?.message || '').includes('应指向目录')) throw new Error('systemd apply should reject file-like targetDir');

  const invalidRules = await postExpectError('/api/validate', {
    mode: 'advanced',
    yaml: sampleYaml,
    runtimeProfile: {
      ...profile,
      governance: {
        ruleBundle: {
          ...profile.governance.ruleBundle,
          enforcementMode: 'deny',
          rules: {
            ...profile.governance.ruleBundle.rules,
            metricNaming: { ...profile.governance.ruleBundle.rules.metricNaming, pattern: '[' },
            suspiciousChanges: { ...profile.governance.ruleBundle.rules.suspiciousChanges, additionsThreshold: 0 },
          },
        },
      },
    },
  });
  const invalidRuleMessages = JSON.stringify(invalidRules.errors || []);
  if (!invalidRuleMessages.includes('enforcementMode') || !invalidRuleMessages.includes('无效正则') || !invalidRuleMessages.includes('additionsThreshold')) {
    throw new Error('invalid rule bundle should return validation errors');
  }

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
