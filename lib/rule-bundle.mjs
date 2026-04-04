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
  if (!['warn', 'block'].includes(normalized.enforcementMode)) {
    errors.push({ source: 'rules', path: 'enforcementMode', message: 'enforcementMode 仅支持 warn / block。' });
  }
  return { ok: errors.length === 0, errors, bundle: normalized };
}
