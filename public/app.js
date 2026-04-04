const healthEl = document.getElementById('health');
const configPathEl = document.getElementById('configPath');
const draftPathEl = document.getElementById('draftPath');
const yamlEditor = document.getElementById('yamlEditor');
const jsonEditor = document.getElementById('jsonEditor');
const validationOutput = document.getElementById('validationOutput');
const revisionList = document.getElementById('revisionList');
const auditList = document.getElementById('auditList');
const authorEl = document.getElementById('author');
const noteEl = document.getElementById('note');

async function boot() {
  await loadAll();
  bind();
}

function bind() {
  document.getElementById('loadBtn').onclick = loadAll;
  document.getElementById('jsonRefreshBtn').onclick = syncJsonFromYaml;
  document.getElementById('formatBtn').onclick = formatYamlFromJson;
  document.getElementById('validateBtn').onclick = validateCurrent;
  document.getElementById('saveBtn').onclick = saveDraft;
  document.getElementById('publishBtn').onclick = publish;
}

async function loadAll() {
  const [health, config, revisions, audit] = await Promise.all([
    api('/api/health'),
    api('/api/config'),
    api('/api/revisions'),
    api('/api/audit'),
  ]);

  healthEl.innerHTML = `<div class="success">服务正常</div>`;
  configPathEl.textContent = config.sourcePath;
  draftPathEl.textContent = config.draftPath;
  yamlEditor.value = config.yaml;
  jsonEditor.value = JSON.stringify(config.json, null, 2);
  renderRevisions(revisions.items || []);
  renderAudit(audit.items || []);
}

async function validateCurrent() {
  const result = await api('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml: yamlEditor.value }),
  });
  validationOutput.textContent = JSON.stringify(result, null, 2);
}

async function saveDraft() {
  const result = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml: yamlEditor.value, author: authorEl.value }),
  });
  validationOutput.textContent = JSON.stringify(result, null, 2);
  await loadAll();
}

async function publish() {
  const result = await api('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml: yamlEditor.value, author: authorEl.value, note: noteEl.value }),
  });
  validationOutput.textContent = JSON.stringify(result, null, 2);
  await loadAll();
}

async function syncJsonFromYaml() {
  try {
    const result = await api('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: yamlEditor.value }),
    });
    jsonEditor.value = JSON.stringify(result.parsed || {}, null, 2);
    validationOutput.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    validationOutput.textContent = error.stack || error.message;
  }
}

async function formatYamlFromJson() {
  try {
    const value = JSON.parse(jsonEditor.value);
    const rendered = await api('/api/render-yaml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: value }),
    });
    yamlEditor.value = rendered.yaml;
    await validateCurrent();
  } catch (error) {
    validationOutput.textContent = error.stack || error.message;
  }
}

function renderRevisions(items) {
  revisionList.innerHTML = items.length ? '' : '<div class="item">暂无版本</div>';
  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <strong>${item.id}</strong>
      <div>${item.note || ''}</div>
      <div class="meta">${item.author} · ${item.createdAt}</div>
      <div class="meta">jobs: ${(item.summary?.scrapeJobs || []).join(', ') || '-'}</div>
      <button data-revision="${item.id}">回滚到此版本</button>
    `;
    el.querySelector('button').onclick = async () => {
      const result = await api(`/api/rollback/${item.id}`, { method: 'POST' });
      validationOutput.textContent = JSON.stringify(result, null, 2);
      await loadAll();
    };
    revisionList.appendChild(el);
  });
}

function renderAudit(items) {
  auditList.innerHTML = items.length ? '' : '<div class="item">暂无审计记录</div>';
  items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `
      <strong>${item.action}</strong>
      <div>${item.summary || ''}</div>
      <div class="meta">${item.author || '-'} · ${item.ts}</div>
    `;
    auditList.appendChild(el);
  });
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

boot().catch((error) => {
  validationOutput.textContent = error.stack || error.message;
});
