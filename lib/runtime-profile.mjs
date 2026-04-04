import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULE_BUNDLE, normalizeRuleBundle, validateRuleBundle } from './rule-bundle.mjs';

export const DEFAULT_RUNTIME_PROFILE = {
  cluster: {
    enabled: false,
    membersCount: 2,
    memberNum: 0,
    replicationFactor: 1,
  },
  remoteWrite: {
    shardByURL: false,
    tmpDataPath: '/var/lib/vmagent-remotewrite-data',
  },
  governance: {
    ruleBundle: DEFAULT_RULE_BUNDLE,
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
    kubernetes: {
      namespace: 'monitoring',
      name: 'vmagent',
      configMountPath: '/etc/vmagent/config.yml',
      dataMountPath: '/var/lib/vmagent-remotewrite-data',
      replicas: 1,
      extraArgs: [],
    },
    systemd: {
      serviceName: 'vmagent',
      configPath: '/etc/vmagent/config.yml',
      dataPath: '/var/lib/vmagent-remotewrite-data',
      extraArgs: [],
      controlledApply: {
        enabled: false,
        targetDir: '',
      },
    },
  },
};

export async function loadRuntimeProfile(profilePath) {
  try {
    const raw = await fs.readFile(profilePath, 'utf8');
    return normalizeRuntimeProfile(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return structuredClone(DEFAULT_RUNTIME_PROFILE);
    }
    throw error;
  }
}

export async function saveRuntimeProfile(profilePath, profile) {
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  const normalized = normalizeRuntimeProfile(profile);
  await fs.writeFile(profilePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function normalizeRuntimeProfile(input = {}) {
  return {
    cluster: {
      ...DEFAULT_RUNTIME_PROFILE.cluster,
      ...(input.cluster || {}),
    },
    remoteWrite: {
      ...DEFAULT_RUNTIME_PROFILE.remoteWrite,
      ...(input.remoteWrite || {}),
    },
    governance: {
      ...DEFAULT_RUNTIME_PROFILE.governance,
      ...(input.governance || {}),
      ruleBundle: normalizeRuleBundle(input.governance?.ruleBundle || DEFAULT_RUNTIME_PROFILE.governance.ruleBundle),
    },
    deployment: {
      ...DEFAULT_RUNTIME_PROFILE.deployment,
      ...(input.deployment || {}),
      docker: {
        ...DEFAULT_RUNTIME_PROFILE.deployment.docker,
        ...(input.deployment?.docker || {}),
      },
      kubernetes: {
        ...DEFAULT_RUNTIME_PROFILE.deployment.kubernetes,
        ...(input.deployment?.kubernetes || {}),
      },
      systemd: {
        ...DEFAULT_RUNTIME_PROFILE.deployment.systemd,
        ...(input.deployment?.systemd || {}),
        controlledApply: {
          ...DEFAULT_RUNTIME_PROFILE.deployment.systemd.controlledApply,
          ...(input.deployment?.systemd?.controlledApply || {}),
        },
      },
    },
  };
}

export function validateRuntimeProfile(profile) {
  const normalized = normalizeRuntimeProfile(profile);
  const errors = [];
  const { cluster, remoteWrite, governance, deployment } = normalized;

  if (cluster.enabled) {
    if (!Number.isInteger(cluster.membersCount) || cluster.membersCount <= 0) {
      errors.push({ source: 'runtime', path: 'cluster.membersCount', message: 'membersCount 必须是大于 0 的整数。' });
    }
    if (!Number.isInteger(cluster.memberNum) || cluster.memberNum < 0) {
      errors.push({ source: 'runtime', path: 'cluster.memberNum', message: 'memberNum 必须是大于等于 0 的整数。' });
    }
    if (Number.isInteger(cluster.membersCount) && Number.isInteger(cluster.memberNum) && cluster.memberNum >= cluster.membersCount) {
      errors.push({ source: 'runtime', path: 'cluster.memberNum', message: 'memberNum 必须小于 membersCount。' });
    }
    if (!Number.isInteger(cluster.replicationFactor) || cluster.replicationFactor <= 0) {
      errors.push({ source: 'runtime', path: 'cluster.replicationFactor', message: 'replicationFactor 必须是大于 0 的整数。' });
    }
  }

  if (typeof remoteWrite.tmpDataPath !== 'string' || !remoteWrite.tmpDataPath.trim()) {
    errors.push({ source: 'runtime', path: 'remoteWrite.tmpDataPath', message: 'tmpDataPath 不能为空。' });
  }

  const rulesValidation = validateRuleBundle(governance.ruleBundle);
  if (!rulesValidation.ok) {
    errors.push(...rulesValidation.errors);
  }

  if (!['docker', 'kubernetes', 'systemd'].includes(deployment.target)) {
    errors.push({ source: 'runtime', path: 'deployment.target', message: 'deployment.target 仅支持 docker / kubernetes / systemd。' });
  }

  if (typeof deployment.docker.image !== 'string' || !deployment.docker.image.trim()) {
    errors.push({ source: 'runtime', path: 'deployment.docker.image', message: 'docker.image 不能为空。' });
  }

  if (typeof deployment.systemd.serviceName !== 'string' || !deployment.systemd.serviceName.trim()) {
    errors.push({ source: 'runtime', path: 'deployment.systemd.serviceName', message: 'systemd.serviceName 不能为空。' });
  }

  if (typeof deployment.systemd.configPath !== 'string' || !deployment.systemd.configPath.trim()) {
    errors.push({ source: 'runtime', path: 'deployment.systemd.configPath', message: 'systemd.configPath 不能为空。' });
  }

  if (deployment.systemd.controlledApply.enabled && !String(deployment.systemd.controlledApply.targetDir || '').trim()) {
    errors.push({
      source: 'runtime',
      path: 'deployment.systemd.controlledApply.targetDir',
      message: '启用 systemd controlled apply 时，必须提供 targetDir。',
    });
  }

  return { ok: errors.length === 0, errors, profile: normalized };
}
