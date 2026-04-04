import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const COMMON_SYSTEMD_DIR_HINTS = [
  {
    dir: '/etc/systemd/system',
    hint: '常见的持久化 unit 目录。通常需要 root 才能写入。',
  },
  {
    dir: '/usr/lib/systemd/system',
    hint: '常见的发行版打包目录。通常由包管理器维护，不建议手工覆盖。',
  },
  {
    dir: '/lib/systemd/system',
    hint: '部分发行版会把系统 unit 放在这里；也通常不建议手工直接写。',
  },
  {
    dir: '/run/systemd/system',
    hint: '运行时临时 unit 目录，重启后通常不会保留。',
  },
];

export async function buildSystemdPlan(profile, options = {}) {
  const serviceName = profile?.deployment?.systemd?.serviceName || 'vmagent';
  const targetDir = String(options.targetDir || '').trim();
  const enableWrites = Boolean(options.enableWrites);
  const artifact = options.artifact || null;
  const unitFile = targetDir
    ? path.join(targetDir, `${serviceName}.service`)
    : `/etc/systemd/system/${serviceName}.service`;

  const targetInspection = await inspectTargetDir(targetDir, serviceName);
  const warnings = [
    '默认只提供 dry-run / plan；不会直接修改宿主机 systemd。',
    '当前不会自动执行 systemctl daemon-reload / restart；这些步骤只在 plan 中提示。',
  ];

  if (!enableWrites) {
    warnings.push('当前是只读模式；即使 targetDir 看起来可写，也不会实际写文件。');
  }
  if (enableWrites) {
    warnings.push('真实 apply 仍只会写 unit 文件到 targetDir，不会替你执行 systemctl。');
  } else {
    warnings.push('真实 apply 需要显式传入 enableWrites=true，并提供可写 targetDir。');
  }

  if (!targetInspection.targetDirProvided) {
    warnings.push('未提供 targetDir；plan 会默认展示 /etc/systemd/system 路径作为参考。');
  }
  if (targetInspection.targetDirProvided && !targetInspection.writable) {
    warnings.push('targetDir 当前不可写；如果之后启用 controlled apply，大概率会失败。');
  }
  if (targetInspection.parentExists === false) {
    warnings.push('targetDir 的父目录不存在；当前不会自动创建缺失的上层目录。');
  }

  const steps = [
    {
      type: 'write-unit-file',
      path: unitFile,
      description: `将渲染后的 ${serviceName}.service 写入受控目录或真实 systemd 目录。`,
      safe: enableWrites && Boolean(targetInspection.canAttemptWrite),
      blockedReason: enableWrites && !targetInspection.canAttemptWrite ? 'targetDir 检查未通过' : undefined,
    },
    {
      type: 'daemon-reload',
      command: 'systemctl daemon-reload',
      description: '重新加载 systemd unit 定义。当前仅生成提示，不执行。',
      safe: false,
    },
    {
      type: 'restart-service',
      command: `systemctl restart ${serviceName}`,
      description: '重启 vmagent 服务。当前仅生成提示，不执行。',
      safe: false,
    },
  ];

  return {
    ok: true,
    mode: enableWrites ? 'controlled-apply' : 'dry-run',
    enableWrites,
    serviceName,
    unitFile,
    warnings,
    steps,
    checks: targetInspection,
    artifactSummary: artifact
      ? {
          execStart: artifact.execStart,
          configPath: artifact.paths?.configPath,
          dataPath: artifact.paths?.dataPath,
        }
      : null,
  };
}

export async function executeSystemdPlan({ fs: injectedFs, profile, artifact, options = {} }) {
  const io = injectedFs || fs;
  const plan = await buildSystemdPlan(profile, { ...options, artifact });
  if (!plan.enableWrites) {
    return { ok: true, changed: false, plan, message: 'Dry-run only; no files were written.' };
  }

  if (!options.targetDir) {
    return { ok: false, changed: false, plan, error: 'Controlled apply requires options.targetDir.' };
  }

  if (!plan.checks.canAttemptWrite) {
    return {
      ok: false,
      changed: false,
      plan,
      error: 'targetDir 检查未通过：目录不存在、父目录不存在或当前进程不可写。',
    };
  }

  await io.mkdir(path.dirname(plan.unitFile), { recursive: true });
  await io.writeFile(plan.unitFile, `${artifact.unit}\n`, 'utf8');

  return {
    ok: true,
    changed: true,
    plan,
    writes: [
      {
        type: 'unit-file',
        path: plan.unitFile,
      },
    ],
    nextManualSteps: [
      '核对生成的 unit 文件内容。',
      '确认 configPath / dataPath / vmagent 二进制路径在目标机器存在。',
      '如需真实启用，再由具备 root 权限的操作者手动执行 systemctl daemon-reload && systemctl restart <service>.',
    ],
  };
}

async function inspectTargetDir(targetDir, serviceName) {
  const normalizedTargetDir = String(targetDir || '').trim();
  const unitFile = normalizedTargetDir
    ? path.join(normalizedTargetDir, `${serviceName}.service`)
    : `/etc/systemd/system/${serviceName}.service`;
  const parentDir = normalizedTargetDir ? path.dirname(normalizedTargetDir) : path.dirname('/etc/systemd/system');
  const info = {
    targetDirProvided: Boolean(normalizedTargetDir),
    targetDir: normalizedTargetDir || null,
    resolvedTargetDir: normalizedTargetDir ? path.resolve(normalizedTargetDir) : null,
    unitFile,
    exists: false,
    isDirectory: false,
    writable: false,
    parentDir,
    parentExists: null,
    parentWritable: null,
    canAttemptWrite: false,
    commonDirHint: findCommonDirHint(normalizedTargetDir),
    notes: [],
  };

  if (!normalizedTargetDir) {
    info.notes.push('未提供 targetDir；这里只给出默认目标路径参考，不做真实写入前置检查。');
    return info;
  }

  try {
    const stat = await fs.stat(normalizedTargetDir);
    info.exists = true;
    info.isDirectory = stat.isDirectory();
    if (!info.isDirectory) {
      info.notes.push('targetDir 已存在，但不是目录。');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      info.notes.push('targetDir 当前不存在。');
    } else {
      info.notes.push(`无法读取 targetDir 状态：${error.message}`);
    }
  }

  if (info.exists && info.isDirectory) {
    info.writable = await isWritable(normalizedTargetDir);
    if (!info.writable) {
      info.notes.push('targetDir 存在，但当前进程没有写权限。');
    }
  }

  try {
    const parentStat = await fs.stat(parentDir);
    info.parentExists = parentStat.isDirectory();
    if (!info.parentExists) {
      info.notes.push('targetDir 的父路径存在，但不是目录。');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      info.parentExists = false;
      info.notes.push('targetDir 的父目录不存在。');
    } else {
      info.parentExists = null;
      info.notes.push(`无法读取父目录状态：${error.message}`);
    }
  }

  if (info.parentExists) {
    info.parentWritable = await isWritable(parentDir);
    if (info.parentWritable === false && !info.exists) {
      info.notes.push('父目录存在，但当前进程没有权限在其中创建 targetDir。');
    }
  }

  info.canAttemptWrite = Boolean(
    normalizedTargetDir
      && ((info.exists && info.isDirectory && info.writable)
        || (!info.exists && info.parentExists && info.parentWritable))
  );

  return info;
}

async function isWritable(targetPath) {
  try {
    await fs.access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function findCommonDirHint(targetDir) {
  if (!targetDir) return null;
  const resolved = path.resolve(targetDir);
  return COMMON_SYSTEMD_DIR_HINTS.find(({ dir }) => resolved === dir || resolved.startsWith(`${dir}/`)) || null;
}
