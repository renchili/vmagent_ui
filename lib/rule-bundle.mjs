export const DEFAULT_RULE_BUNDLE = {
  version: 1,
  enabled: true,
  enforcementMode: 'warn',
  rules: {
    labelNaming: {
      enabled: true,
      severity: 'warning',
      pattern: '^[a-z_][a-z0-9_]*$',
      description: 'Label 名建议使用 snake_case，只包含小写字母、数字和下划线，且不能数字开头。',
    },
    metricNaming: {
      enabled: true,
      severity: 'warning',
      pattern: '^[a-z_:][a-z0-9_:]*$',
      description: 'Metric / job 名建议使用 Prometheus 风格命名，只包含小写字母、数字、下划线、冒号。',
    },
    suspiciousChanges: {
      enabled: true,
      severity: 'warning',
      additionsThreshold: 5,
      description: '新增过多 label、target 或 job 时给出人工复核提示。',
    },
    metricsVolume: {
      enabled: false,
      severity: 'warning',
      estimatedSeriesPerTarget: 1000,
      maxEstimatedSeries: 200000,
      maxLabelCombinationsPerMetric: 1000,
      highCardinalityLabels: ['user_id', 'session_id', 'trace_id', 'request_id', 'device_id'],
      growthTrend: {
        enabled: false,
        minHistoryPoints: 3,
        consecutiveGrowthPeriods: 3,
        maxGrowthRatio: 0.3,
        observedTotalSeriesHistory: [],
      },
      observedMetrics: [],
      description: '基于预算与观测数据识别 metrics 总量、高基数 label 组合与持续增长风险。',
    },
  },
};

export function normalizeRuleBundle(input = {}) {
  return {
    ...DEFAULT_RULE_BUNDLE,
    ...(input || {}),
    rules: {
      labelNaming: {
        ...DEFAULT_RULE_BUNDLE.rules.labelNaming,
        ...(input.rules?.labelNaming || {}),
      },
      metricNaming: {
        ...DEFAULT_RULE_BUNDLE.rules.metricNaming,
        ...(input.rules?.metricNaming || {}),
      },
      suspiciousChanges: {
        ...DEFAULT_RULE_BUNDLE.rules.suspiciousChanges,
        ...(input.rules?.suspiciousChanges || {}),
      },
      metricsVolume: {
        ...DEFAULT_RULE_BUNDLE.rules.metricsVolume,
        ...(input.rules?.metricsVolume || {}),
        highCardinalityLabels: Array.isArray(input.rules?.metricsVolume?.highCardinalityLabels)
          ? input.rules.metricsVolume.highCardinalityLabels.map((item) => String(item).trim()).filter(Boolean)
          : [...DEFAULT_RULE_BUNDLE.rules.metricsVolume.highCardinalityLabels],
        observedMetrics: Array.isArray(input.rules?.metricsVolume?.observedMetrics)
          ? input.rules.metricsVolume.observedMetrics.map((item) => ({
              name: String(item?.name || '').trim(),
              seriesCount: Number(item?.seriesCount || 0),
              labelCombinations: Number(item?.labelCombinations || 0),
              growthRatio: Number(item?.growthRatio || 0),
            })).filter((item) => item.name)
          : [],
        growthTrend: {
          ...DEFAULT_RULE_BUNDLE.rules.metricsVolume.growthTrend,
          ...(input.rules?.metricsVolume?.growthTrend || {}),
          observedTotalSeriesHistory: Array.isArray(input.rules?.metricsVolume?.growthTrend?.observedTotalSeriesHistory)
            ? input.rules.metricsVolume.growthTrend.observedTotalSeriesHistory.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
            : [],
        },
      },
    },
  };
}

export function validateRuleBundle(bundle) {
  const normalized = normalizeRuleBundle(bundle);
  const errors = [];
  for (const key of ['labelNaming', 'metricNaming']) {
    const pattern = normalized.rules[key].pattern;
    try {
      new RegExp(pattern);
    } catch (error) {
      errors.push({ source: 'rules', path: `rules.${key}.pattern`, message: `无效正则：${error.message}` });
    }
  }
  const threshold = Number(normalized.rules.suspiciousChanges.additionsThreshold);
  if (!Number.isFinite(threshold) || threshold < 1) {
    errors.push({ source: 'rules', path: 'rules.suspiciousChanges.additionsThreshold', message: 'additionsThreshold 必须 >= 1。' });
  }

  const metricsVolume = normalized.rules.metricsVolume;
  for (const [path, value] of [
    ['rules.metricsVolume.estimatedSeriesPerTarget', metricsVolume.estimatedSeriesPerTarget],
    ['rules.metricsVolume.maxEstimatedSeries', metricsVolume.maxEstimatedSeries],
    ['rules.metricsVolume.maxLabelCombinationsPerMetric', metricsVolume.maxLabelCombinationsPerMetric],
    ['rules.metricsVolume.growthTrend.minHistoryPoints', metricsVolume.growthTrend.minHistoryPoints],
    ['rules.metricsVolume.growthTrend.consecutiveGrowthPeriods', metricsVolume.growthTrend.consecutiveGrowthPeriods],
  ]) {
    if (!Number.isFinite(Number(value)) || Number(value) < 1) {
      errors.push({ source: 'rules', path, message: `${path.split('.').slice(-1)[0]} 必须 >= 1。` });
    }
  }
  if (!Number.isFinite(Number(metricsVolume.growthTrend.maxGrowthRatio)) || Number(metricsVolume.growthTrend.maxGrowthRatio) < 0) {
    errors.push({ source: 'rules', path: 'rules.metricsVolume.growthTrend.maxGrowthRatio', message: 'maxGrowthRatio 必须 >= 0。' });
  }

  if (!['warn', 'block'].includes(normalized.enforcementMode)) {
    errors.push({ source: 'rules', path: 'enforcementMode', message: 'enforcementMode 仅支持 warn / block。' });
  }
  return { ok: errors.length === 0, errors, bundle: normalized };
}
