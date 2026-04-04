export function configToStructured(config = {}) {
  return {
    global: {
      scrapeInterval: config.global?.scrape_interval || '15s',
      scrapeTimeout: config.global?.scrape_timeout || '10s',
    },
    remoteWrite: Array.isArray(config.remote_write) ? config.remote_write.map((item) => ({ url: item?.url || '' })) : [{ url: '' }],
    jobs: Array.isArray(config.scrape_configs)
      ? config.scrape_configs.map((job) => ({
          jobName: job?.job_name || '',
          metricsPath: job?.metrics_path || '/metrics',
          scheme: job?.scheme || 'http',
          targets: (job?.static_configs || []).flatMap((group) => (group?.targets || []).map((target) => ({
            address: target,
            labels: group?.labels || {},
          }))),
        }))
      : [],
  };
}

export function normalizeStructuredConfig(input = {}) {
  const normalized = {
    global: {
      scrapeInterval: input.global?.scrapeInterval || '15s',
      scrapeTimeout: input.global?.scrapeTimeout || '10s',
    },
    remoteWrite: Array.isArray(input.remoteWrite) && input.remoteWrite.length ? input.remoteWrite.map((item) => ({ url: String(item?.url || '').trim() })) : [{ url: '' }],
    jobs: Array.isArray(input.jobs) ? input.jobs.map((job) => ({
      jobName: String(job?.jobName || '').trim(),
      metricsPath: String(job?.metricsPath || '/metrics').trim() || '/metrics',
      scheme: String(job?.scheme || 'http').trim() || 'http',
      targets: Array.isArray(job?.targets) ? job.targets.map((target) => ({
        address: String(target?.address || '').trim(),
        labels: normalizeLabels(target?.labels || {}),
      })) : [],
    })) : [],
  };
  if (!normalized.jobs.length) {
    normalized.jobs.push({ jobName: '', metricsPath: '/metrics', scheme: 'http', targets: [{ address: '', labels: {} }] });
  }
  return normalized;
}

export function validateStructuredConfig(input = {}) {
  const config = normalizeStructuredConfig(input);
  const errors = [];
  if (!config.jobs.length) {
    errors.push({ source: 'structured', path: 'jobs', message: '至少需要一个采集任务。' });
  }
  config.jobs.forEach((job, index) => {
    if (!job.jobName) errors.push({ source: 'structured', path: `jobs[${index}].jobName`, message: 'jobName 不能为空。' });
    if (!job.targets.length || !job.targets.some((target) => target.address)) {
      errors.push({ source: 'structured', path: `jobs[${index}].targets`, message: '至少需要一个 target。' });
    }
  });
  config.remoteWrite.forEach((item, index) => {
    if (!item.url) errors.push({ source: 'structured', path: `remoteWrite[${index}].url`, message: 'remote write URL 不能为空。' });
  });
  return { ok: errors.length === 0, errors, config };
}

export function structuredToConfig(input = {}) {
  const config = normalizeStructuredConfig(input);
  return {
    global: {
      scrape_interval: config.global.scrapeInterval,
      scrape_timeout: config.global.scrapeTimeout,
    },
    scrape_configs: config.jobs.map((job) => ({
      job_name: job.jobName,
      metrics_path: job.metricsPath === '/metrics' ? undefined : job.metricsPath,
      scheme: job.scheme === 'http' ? undefined : job.scheme,
      static_configs: job.targets
        .filter((target) => target.address)
        .map((target) => ({
          targets: [target.address],
          ...(Object.keys(target.labels).length ? { labels: target.labels } : {}),
        })),
    })).map(cleanObject),
    remote_write: config.remoteWrite.filter((item) => item.url).map((item) => ({ url: item.url })),
  };
}

function normalizeLabels(labels) {
  if (typeof labels === 'string') {
    return parseLabelText(labels);
  }
  return Object.fromEntries(
    Object.entries(labels || {}).map(([key, value]) => [String(key).trim(), String(value).trim()]).filter(([key, value]) => key && value)
  );
}

export function parseLabelText(text) {
  return Object.fromEntries(
    String(text || '')
      .split(/\n|,/) 
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split('=');
        return [String(key || '').trim(), rest.join('=').trim()];
      })
      .filter(([key, value]) => key && value)
  );
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
