const el = (id) => document.getElementById(id);
let currentMode = 'normal';
let lastRiskScan = null;

boot().catch(renderError);

async function boot() {
  bind();
  await loadAll();
}

function bind() {
  el('loadBtn').onclick = loadAll;
  el('validateBtn').onclick = validateCurrent;
  el('saveBtn').onclick = () => submitAction('/api/config');
  el('publishBtn').onclick = () => submitAction('/api/publish');
  el('decisionAllowBtn').onclick = () => setDecision('allow_apply');
  el('decisionBlockBtn').onclick = () => setDecision('block_apply');
  el('decisionForceBtn').onclick = () => setDecision('force_apply');
  el('jsonRefreshBtn').onclick = syncJsonFromYaml;
  el('formatBtn').onclick = formatYamlFromJson;
  el('addJobBtn').onclick = () => {
    const jobs = collectStructuredConfig().jobs;
    jobs.push({ jobName: '', metricsPath: '/metrics', scheme: 'http', targets: [{ address: '', labelsText: '' }] });
    renderJobs(jobs);
  };
  document.querySelectorAll('input[name="mode"]').forEach((node) => node.onchange = () => setMode(node.value));
  ['rulesEnabled','ruleEnforcementMode','labelRuleEnabled','labelRulePattern','metricRuleEnabled','metricRulePattern','suspiciousRuleEnabled','suspiciousThreshold'].forEach((id) => el(id).oninput = renderRulePreview);
}

async function loadAll() {
  const config = await api('/api/config');
  el('configPath').textContent = config.sourcePath;
  el('draftPath').textContent = config.draftPath;
  el('runtimeProfilePath').textContent = config.runtimeProfilePath;
  el('yamlEditor').value = config.yaml;
  el('jsonEditor').value = JSON.stringify(config.json, null, 2);
  fillStructuredConfig(config.structuredConfig);
  fillRuntimeProfile(config.runtimeProfile || {});
  fillRuleBundle(config.ruleBundle);
  setMode(config.mode || 'normal');
  renderRisk(config.riskScan);
}

function setMode(mode) {
  currentMode = mode;
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  const advanced = mode === 'advanced';
  el('yamlEditor').readOnly = !advanced;
  el('jsonEditor').readOnly = !advanced;
  el('advancedPanel').classList.toggle('disabled', !advanced);
  el('normalPanel').classList.toggle('disabled', advanced);
  el('modeHint').textContent = advanced ? '高级模式已开启：你可以直接编辑 YAML / JSON。' : '普通模式已开启：只能用表单编辑，源码区只读。';
}

function fillStructuredConfig(config) {
  el('scrapeInterval').value = config?.global?.scrapeInterval || '15s';
  el('scrapeTimeout').value = config?.global?.scrapeTimeout || '10s';
  el('remoteWriteUrl').value = config?.remoteWrite?.[0]?.url || '';
  renderJobs((config?.jobs || []).map((job) => ({
    ...job,
    targets: (job.targets || []).map((target) => ({ address: target.address, labelsText: Object.entries(target.labels || {}).map(([k,v]) => `${k}=${v}`).join('\n') })),
  })));
}

function renderJobs(jobs) {
  const container = el('jobsContainer');
  container.innerHTML = '';
  jobs.forEach((job) => {
    const card = document.createElement('div');
    card.className = 'item';
    card.innerHTML = `
      <div class="form-grid two-cols compact">
        <div><label>job_name</label><input data-role="jobName" value="${escapeHtml(job.jobName || '')}" /></div>
        <div><label>metrics_path</label><input data-role="metricsPath" value="${escapeHtml(job.metricsPath || '/metrics')}" /></div>
        <div><label>scheme</label><input data-role="scheme" value="${escapeHtml(job.scheme || 'http')}" /></div>
      </div>
      <div class="targets"></div>
      <button data-action="add-target">新增 target</button>
      <button data-action="remove-job">删除 job</button>`;
    const targetsWrap = card.querySelector('.targets');
    const targets = job.targets?.length ? job.targets : [{ address: '', labelsText: '' }];
    targets.forEach((target) => targetsWrap.appendChild(buildTargetNode(target)));
    card.querySelector('[data-action="add-target"]').onclick = () => targetsWrap.appendChild(buildTargetNode({ address: '', labelsText: '' }));
    card.querySelector('[data-action="remove-job"]').onclick = () => { card.remove(); };
    container.appendChild(card);
  });
}

function buildTargetNode(target) {
  const node = document.createElement('div');
  node.className = 'subcard';
  node.innerHTML = `
    <label>target address</label><input data-role="targetAddress" value="${escapeHtml(target.address || '')}" />
    <label>labels（每行 key=value）</label><textarea data-role="labelsText">${escapeHtml(target.labelsText || '')}</textarea>
    <button data-action="remove-target">删除 target</button>`;
  node.querySelector('[data-action="remove-target"]').onclick = () => node.remove();
  return node;
}

function collectStructuredConfig() {
  const jobs = [...el('jobsContainer').children].map((card) => ({
    jobName: card.querySelector('[data-role="jobName"]').value,
    metricsPath: card.querySelector('[data-role="metricsPath"]').value,
    scheme: card.querySelector('[data-role="scheme"]').value,
    targets: [...card.querySelectorAll('.subcard')].map((targetNode) => ({
      address: targetNode.querySelector('[data-role="targetAddress"]').value,
      labels: targetNode.querySelector('[data-role="labelsText"]').value,
    })),
  }));
  return { global: { scrapeInterval: el('scrapeInterval').value, scrapeTimeout: el('scrapeTimeout').value }, remoteWrite: [{ url: el('remoteWriteUrl').value }], jobs };
}

function fillRuntimeProfile(profile) {
  el('clusterEnabled').checked = Boolean(profile.cluster?.enabled);
  el('membersCount').value = profile.cluster?.membersCount ?? 2;
  el('memberNum').value = profile.cluster?.memberNum ?? 0;
  el('replicationFactor').value = profile.cluster?.replicationFactor ?? 1;
  el('shardByURL').checked = Boolean(profile.remoteWrite?.shardByURL);
  el('tmpDataPath').value = profile.remoteWrite?.tmpDataPath || '/var/lib/vmagent-remotewrite-data';
  el('deploymentTarget').value = profile.deployment?.target || 'docker';
}

function collectRuntimeProfile() {
  return {
    cluster: { enabled: el('clusterEnabled').checked, membersCount: Number(el('membersCount').value || 0), memberNum: Number(el('memberNum').value || 0), replicationFactor: Number(el('replicationFactor').value || 0) },
    remoteWrite: { shardByURL: el('shardByURL').checked, tmpDataPath: el('tmpDataPath').value },
    governance: { ruleBundle: collectRuleBundle() },
    deployment: { target: el('deploymentTarget').value },
  };
}

function fillRuleBundle(bundle) {
  el('rulesEnabled').checked = Boolean(bundle?.enabled);
  el('ruleEnforcementMode').value = bundle?.enforcementMode || 'warn';
  el('labelRuleEnabled').checked = Boolean(bundle?.rules?.labelNaming?.enabled);
  el('labelRulePattern').value = bundle?.rules?.labelNaming?.pattern || '';
  el('metricRuleEnabled').checked = Boolean(bundle?.rules?.metricNaming?.enabled);
  el('metricRulePattern').value = bundle?.rules?.metricNaming?.pattern || '';
  el('suspiciousRuleEnabled').checked = Boolean(bundle?.rules?.suspiciousChanges?.enabled);
  el('suspiciousThreshold').value = bundle?.rules?.suspiciousChanges?.additionsThreshold ?? 5;
  el('metricsVolumeEnabled').checked = Boolean(bundle?.rules?.metricsVolume?.enabled);
  el('estimatedSeriesPerTarget').value = bundle?.rules?.metricsVolume?.estimatedSeriesPerTarget ?? 1000;
  el('maxEstimatedSeries').value = bundle?.rules?.metricsVolume?.maxEstimatedSeries ?? 200000;
  el('maxLabelCombinationsPerMetric').value = bundle?.rules?.metricsVolume?.maxLabelCombinationsPerMetric ?? 1000;
  el('highCardinalityLabels').value = (bundle?.rules?.metricsVolume?.highCardinalityLabels || []).join(',');
  el('growthTrendEnabled').checked = Boolean(bundle?.rules?.metricsVolume?.growthTrend?.enabled);
  el('maxGrowthRatio').value = bundle?.rules?.metricsVolume?.growthTrend?.maxGrowthRatio ?? 0.3;
  el('consecutiveGrowthPeriods').value = bundle?.rules?.metricsVolume?.growthTrend?.consecutiveGrowthPeriods ?? 3;
  el('minHistoryPoints').value = bundle?.rules?.metricsVolume?.growthTrend?.minHistoryPoints ?? 3;
  el('observedTotalSeriesHistory').value = JSON.stringify(bundle?.rules?.metricsVolume?.growthTrend?.observedTotalSeriesHistory || []);
  el('observedMetrics').value = JSON.stringify(bundle?.rules?.metricsVolume?.observedMetrics || [], null, 2);
  renderRulePreview();
}

function collectRuleBundle() {
  return {
    enabled: el('rulesEnabled').checked,
    enforcementMode: el('ruleEnforcementMode').value,
    rules: {
      labelNaming: { enabled: el('labelRuleEnabled').checked, pattern: el('labelRulePattern').value },
      metricNaming: { enabled: el('metricRuleEnabled').checked, pattern: el('metricRulePattern').value },
      suspiciousChanges: { enabled: el('suspiciousRuleEnabled').checked, additionsThreshold: Number(el('suspiciousThreshold').value || 5) },
    },
  };
}

function renderRulePreview() { el('rulePreview').textContent = JSON.stringify(collectRuleBundle(), null, 2); }

async function validateCurrent() {
  const result = await submit('/api/validate');
  renderResult(result);
}

async function submitAction(url) {
  const result = await submit(url);
  renderResult(result);
}

async function submit(url) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: currentMode,
      structuredConfig: collectStructuredConfig(),
      yaml: el('yamlEditor').value,
      json: safeParseJson(el('jsonEditor').value),
      runtimeProfile: collectRuntimeProfile(),
      note: el('note').value,
      author: el('author').value,
      decision: el('riskDecision').value,
      confirm: el('riskConfirm').checked,
      overrideToken: el('overrideToken').value,
      overrideReason: el('overrideReason').value,
    }),
  });
}

function renderResult(result) {
  el('validationOutput').textContent = JSON.stringify(result, null, 2);
  if (result.yaml) el('yamlEditor').value = result.yaml;
  if (result.json) el('jsonEditor').value = JSON.stringify(result.json, null, 2);
  if (result.structuredConfig) fillStructuredConfig(result.structuredConfig);
  if (result.ruleBundle) fillRuleBundle(result.ruleBundle);
  renderRisk(result.riskScan, result.riskDecision);
}

function renderRisk(riskScan, riskDecision) {
  lastRiskScan = riskScan || null;
  const banner = el('riskBanner');
  if (!riskScan) {
    banner.textContent = '等待校验…';
    banner.className = 'risk-banner';
    el('riskSemantics').textContent = '';
    return;
  }
  banner.textContent = riskScan.summary;
  banner.className = `risk-banner ${riskScan.hasRisk ? 'danger' : 'safe'}`;
  const policy = riskScan.decisionPolicy || {};
  const mode = el('ruleEnforcementMode').value;
  const semanticText = [
    `当前 enforcementMode=${mode}`,
    `处理语义：${policy.semantics?.[mode] || '未定义'}`,
    riskDecision?.finalAction ? `本次结果：${riskDecision.finalAction}` : '',
  ].filter(Boolean).join(' ｜ ');
  el('riskSemantics').textContent = semanticText;
  el('riskDecision').value = policy.requiredAction === 'force_apply' ? 'force_apply' : 'allow_apply';
  el('riskConfirm').checked = false;
  el('overrideToken').value = policy.confirmation?.overrideToken || '';
  el('overrideReason').placeholder = policy.confirmation?.needed ? 'block 模式下强制生效时，必须填写人工判断依据' : '可选：记录提醒已知、为何仍允许或为何人工阻止';
}

function setDecision(value) {
  el('riskDecision').value = value;
  if (value === 'force_apply' && lastRiskScan?.decisionPolicy?.confirmation?.overrideToken) {
    el('overrideToken').value = lastRiskScan.decisionPolicy.confirmation.overrideToken;
  }
}

async function syncJsonFromYaml() {
  const result = await api('/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'advanced', yaml: el('yamlEditor').value, runtimeProfile: collectRuntimeProfile() }) });
  renderResult(result);
}

async function formatYamlFromJson() {
  const result = await api('/api/render-yaml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: safeParseJson(el('jsonEditor').value) }) });
  el('yamlEditor').value = result.yaml;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}
function safeParseJson(text) { try { return text?.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } }
function renderError(error) { el('validationOutput').textContent = error.stack || error.message; }
function escapeHtml(value) { return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
