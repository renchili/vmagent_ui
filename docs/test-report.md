# vmagent-ui 测试说明

> 本文档覆盖当前项目的关键主流程验证，尤其是：配置编辑、风险治理闭环、部署骨架导出、systemd dry-run、安全边界和页面截图留档。

## 1. 测试目标

验证当前版本是否具备以下能力：

### 配置主流程

- 页面可正常打开
- 能加载当前草稿 YAML
- 能显示 JSON 预览
- 普通模式与高级模式都可工作
- 能执行服务端校验
- 能保存草稿
- 能执行发布

### 风险治理闭环

- 能生成 `riskScan`
- 能生成 `decisionPolicy`
- `warn` 模式命中风险时默认允许
- `block` 模式命中风险时默认拒绝
- `block` 模式下必须提供：
  - `decision=force_apply`
  - `confirm=true`
  - `overrideToken`
  - `overrideReason`
- 保存 / 发布链路会记录最小审计信息

### 部署相关

- 能生成 Docker Compose 预览
- 能保存 Compose 文件
- 能下载 Compose 文件
- 能生成 systemd plan
- systemd apply 默认 dry-run，不会做危险真实修改

### 留档相关

- 能生成页面截图
- README 能引用截图

---

## 2. 测试环境

- Node.js 本地运行
- 页面访问地址：`http://127.0.0.1:3099`
- 示例配置：`config/sample-vmagent.yml`
- 截图工具：Playwright

如果机器上没有 `vmagent` 可执行文件：

- 原生 `-dryRun` 检查会自动跳过
- 其余 YAML / 业务规则校验仍可继续执行

---

## 3. 自动化测试

### 启动服务

```bash
cd vmagent-ui
npm install
npm start
```

### 语法检查

```bash
node --check server.mjs
node --check public/app.js
node --check lib/risk-scan.mjs
node --check scripts/smoke-test.mjs
```

### smoke test

```bash
npm run test:smoke
```

通过时输出：

```bash
smoke ok
```

### 页面截图

```bash
npm run test:screenshot
```

输出文件：

- `docs/vmagent-ui-screenshot.png`

---

## 4. smoke test 覆盖点

`scripts/smoke-test.mjs` 当前覆盖以下关键 API / 主流程：

### 基础可用性

- `GET /api/health`
- `POST /api/validate`（正常配置）

### 风险治理闭环

#### 用例 A：warn + 命中风险

请求特征：

- 风险配置（例如 `job_name=BadJob`、label `Env=demo`）
- `enforcementMode=warn`

期望：

- `riskScan.hasRisk = true`
- `riskScan.decisionPolicy.requiredAction = allow_apply`

#### 用例 B：block + 命中风险 + 未确认

请求特征：

- 同样的风险配置
- `enforcementMode=block`
- 直接保存，不带确认参数

期望：

- `validate` 返回 `overrideToken`
- `POST /api/config` 返回 400
- 错误信息提示需要 `confirm=true`

#### 用例 C：block + 命中风险 + 强制生效（save）

请求特征：

- `decision=force_apply`
- `confirm=true`
- `overrideToken=<validate 返回值>`
- `overrideReason=<人工判断原因>`

期望：

- `POST /api/config` 成功
- `riskDecision.finalAction = force_apply`

#### 用例 D：block + 命中风险 + 未确认 publish

期望：

- `POST /api/publish` 返回 400
- 错误信息提示需要 `confirm=true`

#### 用例 E：block + 命中风险 + 强制生效（publish）

期望：

- `POST /api/publish` 成功
- 生成 revision
- revision 内包含 `riskScan` / `riskDecision`

#### 用例 F：revision / rollback 恢复

测试过程：

- 先 publish 一个带风险 revision
- 再 publish 一个安全 revision
- 调用 `POST /api/rollback/:id` 回滚到前一个 revision

期望：

- 当前配置恢复到目标 revision 内容
- `data/draft.yml` 同步恢复
- `GET /api/audit` 可看到 rollback 记录
- publish 的风险决策记录仍然保留

### 部署骨架

- `POST /api/deployment/compose/export`（inline）
- `POST /api/deployment/compose/export`（save）
- `POST /api/deployment/compose/export`（download）
- `POST /api/systemd/plan`
- `POST /api/systemd/apply`（dry-run）

---

## 5. 手工测试建议

### 5.1 UI 主流程

1. 打开页面
2. 确认默认进入普通模式
3. 查看：
   - 配置路径
   - 草稿路径
   - runtime profile 路径
4. 点击“校验 / 扫描”
5. 观察：
   - 风险横幅
   - JSON 预览
   - 校验输出

### 5.2 warn 模式验证

1. 把 `enforcementMode` 设为 `warn`
2. 填风险配置：
   - `job_name = BadJob`
   - label key = `Env`
3. 点击“校验 / 扫描”
4. 期望：
   - 风险横幅出现
   - 语义说明里写明当前只是提醒
   - 默认 `decision = allow_apply`
5. 点击“保存草稿”
6. 应成功

### 5.3 block 模式验证

1. 把 `enforcementMode` 切到 `block`
2. 继续使用风险配置
3. 点击“校验 / 扫描”
4. 期望：
   - 风险横幅出现
   - 语义说明里写明当前默认阻止
   - `overrideToken` 自动带出
5. 不填确认直接点“保存草稿”
6. 应失败
7. 然后：
   - 点击“选择强制生效”
   - 勾选确认
   - 填 `overrideReason`
8. 再次保存
9. 应成功

### 5.4 审计验证

请求成功后可检查：

```bash
curl -s http://127.0.0.1:3099/api/audit
```

重点看最新记录是否包含：

- `riskDecision`
- `riskSummary`

---

## 6. 典型命令样例

### 健康检查

```bash
curl http://127.0.0.1:3099/api/health
```

### 校验风险配置（block）

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

### 带 override 强制保存

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
  "overrideToken": "<validate 返回 token>",
  "overrideReason": "值班人确认这是一次受控演练"
}
JSON
```

### 导出 compose 文件到本地

```bash
curl -s http://127.0.0.1:3099/api/deployment/compose/export \
  -H 'content-type: application/json' \
  -d '{"mode":"save","outputPath":"./data/test-output/docker-compose.manual.yml"}'
```

### 获取 systemd plan

```bash
curl -s http://127.0.0.1:3099/api/systemd/plan \
  -H 'content-type: application/json' \
  -d '{"targetDir":"./data/systemd-preview"}'
```

---

## 7. 结果判定标准

通过时至少应满足：

- Web 页面可访问：`http://127.0.0.1:3099`
- README 已包含截图与完整功能清单
- `GET /api/health` 成功
- 正常配置 `POST /api/validate` 成功
- 风险配置在 `warn` / `block` 下返回不同 `decisionPolicy`
- `block` 模式未确认时不能保存
- `block` 模式确认后能强制保存
- `block` 模式未确认时不能 publish
- `block` 模式在 `force_apply + confirm + overrideToken + overrideReason` 满足后能 publish
- `GET /api/revisions` 可看到 revision 与风险治理元信息
- `POST /api/rollback/:id` 后正式配置与草稿都恢复到目标 revision
- `GET /api/audit` 可看到 publish / rollback 与风险决策留痕
- Compose 导出成功
- systemd plan 返回 warnings / steps
- systemd apply dry-run 返回 `changed: false`
- 页面截图文件存在：`docs/vmagent-ui-screenshot.png`

---

## 8. 当前测试边界

- smoke 主要覆盖关键 API、publish 风险 override、revision / rollback 主流程，但不是全量回归测试
- 已覆盖服务端主链路；仍没有浏览器端断言框架去逐个验证 DOM 细节
- 已覆盖回滚后的配置恢复与审计可观察性；仍未覆盖更复杂的多 revision 分支场景
- 没有覆盖复杂配置矩阵（如高级 relabel / service discovery）
- 没有覆盖真实 systemd / root 权限接入

---

## 9. 建议的后续补测项

如果后续继续推进，可以再补：

- 截图对比 / DOM smoke
- 更多普通模式字段覆盖
- 多 deployment target 的 artifact 快照测试
- publish / rollback 的异常分支（错误 overrideToken、缺失 overrideReason、回滚不存在 revision）
- 更细粒度的 audit / revision schema 快照断言
