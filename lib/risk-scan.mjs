import crypto from 'node:crypto';
import { normalizeRuleBundle } from './rule-bundle.mjs';

export function scanConfigChange({ previousConfig = {}, nextConfig = {}, ruleBundle, context = {} }) {
  const bundle = normalizeRuleBundle(ruleBundle);
  const findings = [];
  const previousJobs = new Set((previousConfig.scrape_configs || []).map((job) => job?.job_name).filter(Boolean));
  const nextJobs = nextConfig.scrape_configs || [];
  const addedJobs = nextJobs.filter((job) => job?.job_name && !previousJobs.has(job.job_name));

  if (bundle.enabled && bundle.rules.metricNaming.enabled) {
    const metricPattern = new RegExp(bundle.rules.metricNaming.pattern);
    for (const job of nextJobs) {
      if (job?.job_name && !metricPattern.test(job.job_name)) {
        findings.push(makeFinding('metricNaming', bundle.rules.metricNaming.severity, `job_name ${job.job_name} 不符合命名规则`, `scrape_configs.${job.job_name}.job_name`));
      }
      if (job?.metric_relabel_configs) {
        for (const [index, rule] of job.metric_relabel_configs.entries()) {
          if (rule?.target_label && !metricPattern.test(rule.target_label)) {
            findings.push(makeFinding('metricNaming', bundle.rules.metricNaming.severity, `metric target_label ${rule.target_label} 命名可疑`, `scrape_configs.${job.job_name}.metric_relabel_configs[${index}].target_label`));
          }
        }
      }
    }
  }

  if (bundle.enabled && bundle.rules.labelNaming.enabled) {
    const labelPattern = new RegExp(bundle.rules.labelNaming.pattern);
    for (const job of nextJobs) {
      for (const [index, group] of (job.static_configs || []).entries()) {
        for (const key of Object.keys(group?.labels || {})) {
          if (!labelPattern.test(key)) {
            findings.push(makeFinding('labelNaming', bundle.rules.labelNaming.severity, `label ${key} 不符合命名规则`, `scrape_configs.${job.job_name}.static_configs[${index}].labels.${key}`));
          }
        }
      }
    }
  }

  if (bundle.enabled && bundle.rules.suspiciousChanges.enabled) {
    const threshold = Number(bundle.rules.suspiciousChanges.additionsThreshold);
    const addedTargets = countTargets(nextConfig) - countTargets(previousConfig);
    const addedLabels = countLabels(nextConfig) - countLabels(previousConfig);
    if (addedJobs.length >= 1) {
      findings.push(makeFinding('suspiciousChanges', bundle.rules.suspiciousChanges.severity, `新增 ${addedJobs.length} 个 job：${addedJobs.map((job) => job.job_name).join(', ')}`, 'scrape_configs'));
    }
    if (addedTargets >= threshold) {
      findings.push(makeFinding('suspiciousChanges', bundle.rules.suspiciousChanges.severity, `本次新增 ${addedTargets} 个 targets，超过阈值 ${threshold}`, 'scrape_configs[*].static_configs[*].targets'));
    }
    if (addedLabels >= threshold) {
      findings.push(makeFinding('suspiciousChanges', bundle.rules.suspiciousChanges.severity, `本次新增 ${addedLabels} 个 labels，超过阈值 ${threshold}`, 'scrape_configs[*].static_configs[*].labels'));
    }
  }

  if (bundle.enabled && bundle.rules.metricsVolume.enabled) {
    findings.push(...scanMetricsVolume({ nextConfig, rule: bundle.rules.metricsVolume }));
  }

  const hasRisk = findings.length > 0;
  const overrideToken = hasRisk ? createOverrideToken({ nextConfig, bundle, findings, context }) : null;
  const decisionPolicy = buildDecisionPolicy({ hasRisk, enforcementMode: bundle.enforcementMode, overrideToken });

  return {
    ok: true,
    hasRisk,
    requiresManualDecision: hasRisk,
    summary: decisionPolicy.summary,
    findings,
    decisionPolicy,
    executionPlan: {
      intendedTarget: 'vmagent / 执行侧',
      actualExecutor: 'backend-mvp-rule-engine',
      ruleBundle: bundle,
    },
  };
}

export function evaluateRiskDecision({ riskScan, requestDecision = {} }) {
  const policy = riskScan?.decisionPolicy || buildDecisionPolicy({ hasRisk: false, enforcementMode: 'warn', overrideToken: null });
  const normalized = normalizeDecision(requestDecision);

  if (!riskScan?.hasRisk) {
    return {
      ok: true,
      finalAction: 'allow_apply',
      audit: {
        decision: normalized.decision || 'allow_apply',
        confirm: Boolean(normalized.confirm),
        overrideReason: normalized.overrideReason || '',
        overrideTokenUsed: false,
      },
    };
  }

  if (normalized.decision === 'block_apply') {
    return {
      ok: false,
      blockedByUser: true,
      finalAction: 'block_apply',
      message: '已由人工明确选择不生效，本次操作已终止。',
      audit: {
        decision: 'block_apply',
        confirm: Boolean(normalized.confirm),
        overrideReason: normalized.overrideReason || '',
        overrideTokenUsed: false,
      },
    };
  }

  if (policy.requiredAction === 'allow_apply') {
    return {
      ok: true,
      finalAction: normalized.decision === 'force_apply' ? 'force_apply' : 'allow_apply',
      audit: {
        decision: normalized.decision || 'allow_apply',
        confirm: Boolean(normalized.confirm),
        overrideReason: normalized.overrideReason || '',
        overrideTokenUsed: Boolean(normalized.overrideToken),
      },
    };
  }

  if (normalized.decision !== 'force_apply' || normalized.confirm !== true) {
    return {
      ok: false,
      finalAction: 'needs_confirmation',
      message: '命中风险且当前为 block；需人工确认 confirm=true 且 decision=force_apply。',
      required: policy.confirmation,
      audit: {
        decision: normalized.decision || 'needs_confirmation',
        confirm: Boolean(normalized.confirm),
        overrideReason: normalized.overrideReason || '',
        overrideTokenUsed: false,
      },
    };
  }

  if (normalized.overrideToken !== policy.confirmation.overrideToken) {
    return {
      ok: false,
      finalAction: 'needs_confirmation',
      message: 'overrideToken 无效或与当前风险扫描结果不匹配。',
      required: policy.confirmation,
      audit: {
        decision: normalized.decision || 'force_apply',
        confirm: true,
        overrideReason: normalized.overrideReason || '',
        overrideTokenUsed: Boolean(normalized.overrideToken),
      },
    };
  }

  if (!String(normalized.overrideReason || '').trim()) {
    return {
      ok: false,
      finalAction: 'needs_confirmation',
      message: 'force_apply 时必须填写 overrideReason，说明人工判断依据。',
      required: policy.confirmation,
      audit: {
        decision: normalized.decision || 'force_apply',
        confirm: true,
        overrideReason: '',
        overrideTokenUsed: true,
      },
    };
  }

  return {
    ok: true,
    finalAction: 'force_apply',
    audit: {
      decision: 'force_apply',
      confirm: true,
      overrideReason: normalized.overrideReason.trim(),
      overrideTokenUsed: true,
      overrideToken: normalized.overrideToken,
    },
  };
}

function buildDecisionPolicy({ hasRisk, enforcementMode, overrideToken }) {
  if (!hasRisk) {
    return {
      requiredAction: 'allow_apply',
      summary: '未发现明显高风险变更，可直接生效。',
      semantics: {
        warn: '无风险时直接允许。',
        block: '无风险时直接允许。',
      },
      confirmation: null,
    };
  }

  if (enforcementMode === 'warn') {
    return {
      requiredAction: 'allow_apply',
      summary: '检测到风险候选：当前为 warn，只提醒，默认允许保存/发布；如人工决定不生效，可显式选择 block_apply。',
      semantics: {
        warn: '只提醒，不强制拦截；不需要 overrideToken。',
        block: '命中风险时会阻止，除非人工确认 force_apply。',
      },
      confirmation: {
        needed: false,
        confirmField: null,
        overrideToken: null,
        overrideReasonRequired: false,
      },
    };
  }

  return {
    requiredAction: 'force_apply',
    summary: '检测到风险候选：当前为 block，默认阻止保存/发布；只有人工确认后才能强制生效。',
    semantics: {
      warn: '只提醒，不强制拦截；不需要 overrideToken。',
      block: '命中风险后默认阻止；需 decision=force_apply + confirm=true + overrideToken + overrideReason。',
    },
    confirmation: {
      needed: true,
      confirmField: 'confirm',
      decisionField: 'decision',
      overrideToken,
      overrideReasonRequired: true,
    },
  };
}

function createOverrideToken({ nextConfig, bundle, findings, context }) {
  const payload = JSON.stringify({ nextConfig, enforcementMode: bundle.enforcementMode, findings, mode: context.mode || 'normal' });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function normalizeDecision(input = {}) {
  return {
    decision: typeof input.decision === 'string' ? input.decision : '',
    confirm: input.confirm === true,
    overrideToken: typeof input.overrideToken === 'string' ? input.overrideToken : '',
    overrideReason: typeof input.overrideReason === 'string' ? input.overrideReason : '',
  };
}

function scanMetricsVolume({ nextConfig, rule }) {
  const findings = [];
  const jobs = nextConfig.scrape_configs || [];
  const totalTargets = countTargets(nextConfig);
  const estimatedSeriesPerTarget = Number(rule.estimatedSeriesPerTarget || 0);
  const estimatedSeries = totalTargets * estimatedSeriesPerTarget;
  if (estimatedSeries > Number(rule.maxEstimatedSeries || 0)) {
    findings.push(makeFinding('metricsVolume.totalSeriesBudget', rule.severity, `预估总 series ${estimatedSeries} 超过阈值 ${rule.maxEstimatedSeries}（targets=${totalTargets}, estimatedSeriesPerTarget=${estimatedSeriesPerTarget}）`, 'scrape_configs[*].static_configs[*].targets'));
  }

  const suspiciousLabels = new Set((rule.highCardinalityLabels || []).map((item) => String(item).trim()).filter(Boolean));
  for (const job of jobs) {
    const labelStats = buildJobLabelStats(job);
    if (labelStats.combinations > Number(rule.maxLabelCombinationsPerMetric || 0)) {
      findings.push(makeFinding('metricsVolume.singleMetricLabelCardinality', rule.severity, `job ${job.job_name || '<unknown>'} 的预估 label 组合数 ${labelStats.combinations} 超过阈值 ${rule.maxLabelCombinationsPerMetric}`, `scrape_configs.${job.job_name || '<unknown>'}.static_configs[*].labels`));
    }
    for (const key of labelStats.highRiskLabels.filter((key) => suspiciousLabels.has(key))) {
      findings.push(makeFinding('metricsVolume.highRiskLabel', rule.severity, `job ${job.job_name || '<unknown>'} 使用了高基数风险 label：${key}`, `scrape_configs.${job.job_name || '<unknown>'}.static_configs[*].labels.${key}`));
    }
  }

  for (const metric of rule.observedMetrics || []) {
    if (metric.labelCombinations > Number(rule.maxLabelCombinationsPerMetric || 0)) {
      findings.push(makeFinding('metricsVolume.singleMetricLabelCardinality', rule.severity, `metric ${metric.name} 的观测 label 组合数 ${metric.labelCombinations} 超过阈值 ${rule.maxLabelCombinationsPerMetric}`, `observedMetrics.${metric.name}.labelCombinations`));
    }
  }

  const trend = evaluateGrowthTrend(rule.growthTrend);
  if (trend.triggered) {
    findings.push(makeFinding('metricsVolume.growthTrend', rule.severity, trend.message, 'metricsVolume.growthTrend.observedTotalSeriesHistory'));
  }

  return findings;
}

function buildJobLabelStats(job = {}) {
  const valuesByLabel = new Map();
  const highRiskLabels = new Set();
  for (const group of job.static_configs || []) {
    for (const [key, value] of Object.entries(group?.labels || {})) {
      if (!valuesByLabel.has(key)) valuesByLabel.set(key, new Set());
      valuesByLabel.get(key).add(String(value));
      highRiskLabels.add(key);
    }
  }
  const combinations = [...valuesByLabel.values()].reduce((acc, set) => acc * Math.max(1, set.size), 1);
  return { combinations, highRiskLabels: [...highRiskLabels] };
}

function evaluateGrowthTrend(growthTrend = {}) {
  if (!growthTrend?.enabled) return { triggered: false };
  const history = Array.isArray(growthTrend.observedTotalSeriesHistory) ? growthTrend.observedTotalSeriesHistory.map(Number).filter((item) => Number.isFinite(item) && item >= 0) : [];
  const minHistoryPoints = Number(growthTrend.minHistoryPoints || 0);
  const consecutiveGrowthPeriods = Number(growthTrend.consecutiveGrowthPeriods || 0);
  const maxGrowthRatio = Number(growthTrend.maxGrowthRatio || 0);
  if (history.length < Math.max(minHistoryPoints, consecutiveGrowthPeriods + 1)) return { triggered: false };
  const tail = history.slice(-(consecutiveGrowthPeriods + 1));
  const strictlyIncreasing = tail.every((value, index) => index === 0 || value > tail[index - 1]);
  if (!strictlyIncreasing) return { triggered: false };
  const base = tail[0] || 0;
  const latest = tail[tail.length - 1] || 0;
  const growthRatio = base > 0 ? (latest - base) / base : latest > 0 ? Infinity : 0;
  if (growthRatio <= maxGrowthRatio) return { triggered: false };
  return {
    triggered: true,
    message: `总 series 历史观测值持续增长（${tail.join(' -> ')}），增长率 ${(growthRatio * 100).toFixed(1)}% 超过阈值 ${(maxGrowthRatio * 100).toFixed(1)}%`,
  };
}

function makeFinding(ruleType, severity, message, path) {
  return { ruleType, severity, message, path };
}

function countTargets(config) {
  return (config.scrape_configs || []).reduce((sum, job) => sum + (job.static_configs || []).reduce((inner, group) => inner + (group.targets || []).length, 0), 0);
}

function countLabels(config) {
  return (config.scrape_configs || []).reduce((sum, job) => sum + (job.static_configs || []).reduce((inner, group) => inner + Object.keys(group.labels || {}).length, 0), 0);
}
