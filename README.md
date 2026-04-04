# vmagent-ui

一个务实可运行的 vmagent 配置管理台 MVP，围绕 **配置编辑、校验、风险扫描、发布留痕、部署骨架导出** 做了一条最小可用闭环。

![vmagent-ui 页面截图](./docs/vmagent-ui-screenshot.png)

> 当前截图由 `node scripts/screenshot.mjs` 基于本地运行页面生成，默认输出到 `docs/vmagent-ui-screenshot.png`。

---

## 目录

- [当前已实现的全部功能点](#当前已实现的全部功能点)
- [快速开始](#快速开始)
- [典型使用流程](#典型使用流程)
- [风险治理闭环](#风险治理闭环)
- [API 总览](#api-总览)
- [请求示例 / 典型输入输出](#请求示例--典型输入输出)
- [测试与验证](#测试与验证)
- [当前边界](#当前边界)

---

## 当前已实现的全部功能点

### 1. 配置编辑：普通模式 / 高级模式

#### 普通模式（结构化表单）

- 通过表单维护 vmagent 配置，不直接编辑 YAML
- 已覆盖字段：
  - `global.scrape_interval`
  - `global.scrape_timeout`
  - `remote_write[0].url`
  - `scrape_configs[].job_name`
  - `scrape_configs[].metrics_path`
  - `scrape_configs[].scheme`
  - `scrape_configs[].static_configs[].targets`
  - `scrape_configs[].static_configs[].labels`
- 支持新增 / 删除 job
- 支持新增 / 删除 target
- 前端会把 labels 文本（`key=value`）转成对象结构
- 后端统一把结构化表单转换成 YAML

#### 高级模式（源码编辑）

- 允许直接编辑 YAML / JSON
- 支持 YAML → JSON 预览
- 支持 JSON → YAML 格式化输出
- 与普通模式共享同一套：
  - 校验逻辑
  - 风险扫描逻辑
  - 保存草稿逻辑
  - 发布逻辑

### 2. vmagent 配置校验

后端会做两层校验：

#### 基础结构 / 业务校验

- `scrape_configs` 至少有一个
- 每个 job 必须有 `job_name`
- `job_name` 不允许重复
- 每个 job 至少有一个 target
- `remote_write[0].url` 在普通模式下必须填写

#### vmagent 原生 dry-run 校验（尽力而为）

- 尝试调用：
  - `vmagent -promscrape.config=... -promscrape.config.strictParse=true -dryRun`
- 如果宿主机没有 `vmagent` 二进制：
  - 自动跳过原生校验
  - 仍然保留 YAML / 业务规则校验结果

### 3. runtime profile / 运行参数管理

支持独立维护 vmagent 运行侧参数：

- `cluster.enabled`
- `cluster.membersCount`
- `cluster.memberNum`
- `cluster.replicationFactor`
- `remoteWrite.shardByURL`
- `remoteWrite.tmpDataPath`
- `deployment.target`

支持的 deployment target：

- `docker`
- `kubernetes`
- `systemd`

runtime profile 会保存到：

- `data/runtime-profile.json`

### 4. 规则清单（rule bundle）

支持前端配置、后端归一化、保存和随 revision 留痕：

- `enabled`
- `enforcementMode = warn | block`
- `rules.labelNaming`
- `rules.metricNaming`
- `rules.suspiciousChanges`

当前内置规则：

#### `labelNaming`

- 检查 label key 是否符合正则
- 默认建议 snake_case

#### `metricNaming`

- 检查 `job_name`
- 检查 `metric_relabel_configs[].target_label`

#### `suspiciousChanges`

- 检查新增 job
- 检查新增 target 数量是否超过阈值
- 检查新增 label 数量是否超过阈值

### 5. 风险扫描 / 风险治理闭环

#### 当前已实现的风险动作三态

- `allow_apply`：允许生效
- `block_apply`：明确不生效
- `force_apply`：人工确认后强制生效

#### 当前已实现的模式语义

##### `warn`

- 命中风险：**只提醒，不阻止保存 / 发布**
- 默认动作：`allow_apply`
- 不需要 `overrideToken`
- 如果操作者人工判断“不该生效”，可显式提交 `block_apply`

##### `block`

- 命中风险：**默认阻止保存 / 发布**
- 只有满足以下条件时才允许继续：
  - `decision=force_apply`
  - `confirm=true`
  - `overrideToken=<validate 返回值>`
  - `overrideReason=<人工判断依据>`

#### UI 已支持的人工确认能力

页面已提供：

- 风险横幅 `riskBanner`
- 风险语义说明 `riskSemantics`
- 三态按钮：
  - 选择允许生效
  - 选择不生效
  - 选择强制生效
- `decision` 字段
- `confirm` 勾选
- `overrideToken` 输入
- `overrideReason` 文本框

#### 后端已支持的判断逻辑

- 无风险 → 直接允许
- 有风险 + `warn` → 默认允许；如显式 `block_apply` 则终止
- 有风险 + `block` → 默认拒绝；只有 `force_apply + confirm + overrideToken + overrideReason` 才放行

### 6. 草稿保存 / 发布

#### 草稿保存

- `POST /api/config`
- 保存 YAML 草稿到：
  - `data/draft.yml`
- 同时保存 runtime profile
- 同时写入审计日志

#### 发布

- `POST /api/publish`
- 会：
  - 生成 revision
  - 写入正式配置文件
  - 保存 runtime profile
  - 调用 apply 逻辑（reload / sighup / restart / noop）
  - 写入审计日志

### 7. revision / 回滚 / 审计

#### revisions

- 发布时生成 revision 文件：`data/revisions/*.json`
- revision 当前记录：
  - `id`
  - `author`
  - `note`
  - `mode`
  - `createdAt`
  - `sha256`
  - `summary`
  - `validation`
  - `runtimeValidation`
  - `runtimeProfile`
  - `riskScan`
  - `riskDecision`
  - `yaml`
  - `json`

#### rollback

- `POST /api/rollback/:id`
- 将 revision 中的配置恢复到：
  - 草稿文件
  - 正式配置文件
- 再触发 apply

#### audit

- `GET /api/audit`
- 审计日志位于：`data/audit/audit.log`
- 当前已记录动作包括：
  - `save_draft`
  - `publish`
  - `rollback`
  - `save_runtime_profile`
- 风险相关字段最少记录：
  - `riskDecision`
  - `riskSummary`

### 8. 部署骨架导出

#### Docker

- 生成 `docker run` 命令
- 自动注入 runtime profile 对应的 vmagent 参数

#### Docker Compose

- 支持生成 compose YAML
- 支持三种导出方式：
  - `inline`
  - `save`
  - `download`

#### Kubernetes

- 生成基础 Deployment YAML
- 注入 vmagent 参数

#### systemd

- 生成 `.service` unit 文本
- 支持 dry-run / plan
- 支持 controlled apply（受控目录写文件，不直接 systemctl）

### 9. systemd dry-run / controlled apply

#### `POST /api/systemd/plan`

会返回：

- warnings
- steps
- targetDir 检查结果
- unit file 目标路径
- `execStart / configPath / dataPath` 摘要

#### `POST /api/systemd/apply`

- 默认 dry-run，不写文件
- 只有：
  - `enableWrites=true`
  - 且 `targetDir` 可写
  才会把 unit 文件写入受控目录
- **不会自动执行**：
  - `systemctl daemon-reload`
  - `systemctl restart`

### 10. 页面截图 / 测试脚本

#### smoke test

- 脚本：`scripts/smoke-test.mjs`
- 已覆盖：
  - `GET /api/health`
  - `POST /api/validate`
  - `POST /api/config`
  - `POST /api/deployment/compose/export`
  - `POST /api/systemd/plan`
  - `POST /api/systemd/apply`
  - warn / block 风险治理关键路径

#### screenshot

- 脚本：`scripts/screenshot.mjs`
- 输出：`docs/vmagent-ui-screenshot.png`

---

## 快速开始

```bash
cd vmagent-ui
npm install
npm start
```

默认地址：

- `http://127.0.0.1:3099`

### 运行测试

```bash
npm run test:smoke
npm run test:screenshot
```

---

## 典型使用流程

### 流程 1：普通模式修改后发布

1. 打开页面
2. 保持 `普通模式`
3. 填写：
   - `scrape_interval`
   - `scrape_timeout`
   - `remote_write URL`
   - job / target / labels
4. 点击 **校验 / 扫描**
5. 查看风险结果
6. 如果可接受，点击 **保存草稿** 或 **发布**

### 流程 2：高级模式直接改 YAML

1. 切换到 `高级模式`
2. 直接编辑 YAML / JSON
3. 点击 `YAML → JSON` 或 `JSON → YAML`
4. 点击 **校验 / 扫描**
5. 再执行保存或发布

### 流程 3：block 模式下人工 override

1. 把 `enforcementMode` 改成 `block`
2. 故意制造一个风险配置（比如 `job_name` 大写、label key 大写）
3. 点击 **校验 / 扫描**
4. 观察返回：
   - 风险横幅
   - `overrideToken`
   - 当前语义是默认阻止
5. 填：
   - `decision=force_apply`
   - 勾选 `confirm`
   - 填 `overrideReason`
6. 点击 **保存草稿** 或 **发布**

---

## 风险治理闭环

### validate 返回什么

后端扫描后会返回：

- `riskScan.hasRisk`
- `riskScan.requiresManualDecision`
- `riskScan.summary`
- `riskScan.findings[]`
- `riskScan.decisionPolicy`

`decisionPolicy` 是这次闭环的核心，它明确告诉前端：

- 当前默认动作是什么
- 当前模式是提醒还是阻止
- 是否需要人工确认
- 是否需要 override token
- 是否必须填写原因

### save / publish 怎么决策

后端接收以下输入：

```json
{
  "decision": "allow_apply | block_apply | force_apply",
  "confirm": true,
  "overrideToken": "b2fa371ebbcfaa79",
  "overrideReason": "值班人确认这是一次受控演练"
}
```

然后按以下规则决策：

- **无风险** → 放行
- **有风险 + warn**
  - 未指定决策 → 默认 `allow_apply`
  - 显式 `block_apply` → 拒绝本次调用
- **有风险 + block**
  - 未确认 → 拒绝
  - token 不匹配 → 拒绝
  - 没填原因 → 拒绝
  - 全部满足 → `force_apply`

### 审计里记录什么

当前至少会记录：

```json
{
  "riskDecision": {
    "decision": "force_apply",
    "confirm": true,
    "overrideReason": "值班人确认是一次受控演练，需要继续验证发布链路。",
    "overrideTokenUsed": true,
    "overrideToken": "b2fa371ebbcfaa79"
  },
  "riskSummary": "检测到风险候选：当前为 block，默认阻止保存/发布；只有人工确认后才能强制生效。"
}
```

---

## API 总览

### 配置 / 校验 / 发布

- `GET /api/health`
- `GET /api/config`
- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `POST /api/rollback/:id`

### runtime profile / 审计 / revision

- `GET /api/runtime-profile`
- `POST /api/runtime-profile`
- `GET /api/revisions`
- `GET /api/audit`

### 部署骨架

- `GET /api/deployment/:target`
- `POST /api/deployment/compose/export`
- `POST /api/systemd/plan`
- `POST /api/systemd/apply`

### 辅助转换

- `POST /api/render-yaml`

---

## 请求示例 / 典型输入输出

### 1) 健康检查

```bash
curl http://127.0.0.1:3099/api/health
```

示例返回：

```json
{
  "ok": true,
  "configPath": "/path/to/config/sample-vmagent.yml"
}
```

### 2) 校验一个正常配置

```bash
curl -s http://127.0.0.1:3099/api/validate \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "mode": "advanced",
  "yaml": "global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: demo-app\n    static_configs:\n      - targets:\n          - demo.internal:8080\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n",
  "runtimeProfile": {
    "deployment": { "target": "docker" }
  }
}
JSON
```

关键返回字段：

```json
{
  "ok": true,
  "riskScan": {
    "hasRisk": false,
    "decisionPolicy": {
      "requiredAction": "allow_apply"
    }
  }
}
```

### 3) block 模式下校验风险配置

```bash
curl -s http://127.0.0.1:3099/api/validate \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "mode": "advanced",
  "yaml": "global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: BadJob\n    static_configs:\n      - targets:\n          - demo.internal:8080\n        labels:\n          Env: demo\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n",
  "runtimeProfile": {
    "governance": {
      "ruleBundle": {
        "enabled": true,
        "enforcementMode": "block"
      }
    },
    "deployment": { "target": "docker" }
  }
}
JSON
```

关键返回字段示例：

```json
{
  "ok": true,
  "riskScan": {
    "hasRisk": true,
    "summary": "检测到风险候选：当前为 block，默认阻止保存/发布；只有人工确认后才能强制生效。",
    "decisionPolicy": {
      "requiredAction": "force_apply",
      "confirmation": {
        "needed": true,
        "confirmField": "confirm",
        "decisionField": "decision",
        "overrideToken": "b2fa371ebbcfaa79"
      }
    }
  }
}
```

### 4) block 模式下强制保存草稿

```bash
curl -s http://127.0.0.1:3099/api/config \
  -H 'content-type: application/json' \
  -d @- <<'JSON'
{
  "mode": "advanced",
  "yaml": "global:\n  scrape_interval: 15s\n  scrape_timeout: 10s\nscrape_configs:\n  - job_name: BadJob\n    static_configs:\n      - targets:\n          - demo.internal:8080\n        labels:\n          Env: demo\nremote_write:\n  - url: http://victoriametrics:8428/api/v1/write\n",
  "runtimeProfile": {
    "governance": {
      "ruleBundle": {
        "enabled": true,
        "enforcementMode": "block"
      }
    },
    "deployment": { "target": "docker" }
  },
  "decision": "force_apply",
  "confirm": true,
  "overrideToken": "b2fa371ebbcfaa79",
  "overrideReason": "值班人确认这是一次受控演练"
}
JSON
```

关键返回字段示例：

```json
{
  "ok": true,
  "riskDecision": {
    "ok": true,
    "finalAction": "force_apply"
  }
}
```

### 5) 导出 compose（inline）

```bash
curl -s http://127.0.0.1:3099/api/deployment/compose/export \
  -H 'content-type: application/json' \
  -d '{"mode":"inline"}'
```

典型返回：

```json
{
  "ok": true,
  "mode": "inline",
  "artifact": {
    "type": "compose",
    "yaml": "services:\n  vmagent: ..."
  },
  "copyHint": "可直接复制 artifact.yaml，或用 mode=download / mode=save 获取文件。"
}
```

### 6) systemd plan

```bash
curl -s http://127.0.0.1:3099/api/systemd/plan \
  -H 'content-type: application/json' \
  -d '{"targetDir":"./data/systemd-preview"}'
```

典型返回重点：

```json
{
  "ok": true,
  "plan": {
    "mode": "dry-run",
    "warnings": [
      "默认只提供 dry-run / plan；不会直接修改宿主机 systemd。"
    ],
    "steps": [
      { "type": "write-unit-file" },
      { "type": "daemon-reload" },
      { "type": "restart-service" }
    ]
  }
}
```

---

## 测试与验证

### 我已完成的验证

已实际执行：

```bash
node --check server.mjs
node --check public/app.js
node --check lib/risk-scan.mjs
node --check scripts/smoke-test.mjs
node scripts/smoke-test.mjs
node scripts/screenshot.mjs
```

已验证结果：

- 服务能启动
- 页面截图已生成：`docs/vmagent-ui-screenshot.png`
- smoke test 输出：`smoke ok`
- 风险治理关键路径已覆盖：
  - warn 模式命中风险 → 默认允许
  - block 模式命中风险 → 默认拒绝
  - block 模式确认后 → 可 `force_apply`
- publish 风险 override 已覆盖：
  - block 模式未确认 publish → 拒绝
  - block 模式确认后 publish → 成功并落 revision
- revision / rollback 已覆盖：
  - publish 后可在 revisions 中看到治理元信息
  - rollback 后配置与草稿都恢复到指定 revision
  - audit 中能看到 publish / rollback 留痕
- compose 导出正常
- systemd plan / apply dry-run 正常

### 测试脚本说明

#### `npm run test:smoke`

覆盖：

- 健康检查
- 正常配置校验
- warn 风险扫描
- block 风险扫描
- block 模式未确认拒绝保存
- block 模式确认后允许强制保存
- block 模式未确认 publish → 拒绝
- block 模式带 `force_apply + confirm + overrideToken + overrideReason` publish → 成功
- `GET /api/revisions` 可观察 revision / 风险治理元信息
- `POST /api/rollback/:id` 可恢复配置与草稿
- `GET /api/audit` 可观察 publish / rollback 留痕
- compose 导出
- systemd plan
- systemd apply dry-run

#### `npm run test:screenshot`

- 打开本地页面
- 生成整页截图
- 保存到：`docs/vmagent-ui-screenshot.png`

更多测试说明见：

- [`docs/test-report.md`](./docs/test-report.md)

---

## 当前边界

### 风险治理边界

- `overrideToken` 是轻量绑定机制，不是强安全签名体系
- 没有用户身份认证 / RBAC
- “人工确认”目前仅表示调用方自声明已复核
- 没有完整审批单状态机
- 没有多人审批 / 二次复核 / 过期失效
- `warn` 模式当前默认允许，不会强制二次确认

### 配置编辑边界

- 普通模式目前主要覆盖常见 `static_configs` 用例
- 尚未覆盖更复杂的：
  - service discovery
  - relabel_configs 全量编辑
  - scrape 级高级参数矩阵

### 部署边界

- Docker / Compose / Kubernetes / systemd 目前属于“导出骨架”级别
- systemd apply 不会自动执行 `systemctl`
- 真实生产接入前还需要：
  - root / sudo 策略
  - 二进制路径确认
  - 配置路径与数据路径存在性校验
  - 环境级差异处理

### 平台能力边界

- 没有 RBAC
- 没有多环境发布编排
- 没有审批工作流 UI
- 没有更细 diff 展示
- 没有并发编辑冲突处理

---

## 小结

当前版本已经形成一条完整、可运行、可验证的 MVP 闭环：

- **普通模式表单 / 高级模式源码编辑**
- **基础校验 + vmagent dry-run（可跳过）**
- **规则清单 + 风险扫描**
- **warn / block 语义区分**
- **人工判断是否生效**
- **保存 / 发布 / revision / 审计留痕**
- **部署骨架导出（Docker / Compose / Kubernetes / systemd）**
- **smoke test + 截图脚本 + 测试说明**
