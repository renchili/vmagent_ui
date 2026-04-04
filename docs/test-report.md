# vmagent-ui 测试与验收报告

这份文档关注的是：**功能是否跑通、部署骨架是否能产出、最小负载是否可接受**。

相关文档：

- 部署：`docs/deployment.md`
- 压测：`docs/perf.md`
- 项目总览：`README.md`

---

## 1. 测试范围

### 功能主流程

- 页面可打开
- 能读取当前草稿配置
- 普通模式 / 高级模式可工作
- `POST /api/validate` 可用
- `POST /api/config` 可用
- `POST /api/publish` 可用
- `GET /api/revisions` 可用
- `POST /api/rollback/:id` 可用
- `GET /api/audit` 可用

### 风险治理闭环

- `warn` 模式命中风险时默认允许
- `warn` 模式下人工显式 `block_apply` 会终止本次保存 / 发布
- `block` 模式命中风险时默认拒绝
- `force_apply + confirm + overrideToken + overrideReason` 可强制生效
- 错误 `overrideToken`、缺失 `overrideReason`、`confirm=false` 但 `force_apply` 都会被拒绝
- publish / rollback 会保留审计留痕

### 部署相关

- Docker Compose 可导出
- 非法 `outputPath` 会被显式拒绝
- systemd plan 可生成
- 非法 `targetDir` 会被显式拒绝
- systemd apply 默认 dry-run
- controlled apply 可写入受控目录

### 压测相关

- 提供可运行的最小压测脚本
- 已至少实际跑一轮基础负载

---

## 2. 测试环境

- 系统：WSL2 / Linux
- Node.js：`v24.14.1`
- 服务地址：`http://127.0.0.1:3099`
- 示例配置：`config/sample-vmagent.yml`
- runtime profile：`data/runtime-profile.json`

说明：

- 如果机器没有 `vmagent` 二进制，原生 `-dryRun` 会自动跳过
- 其余 YAML / 业务规则 / 风险治理链路不受影响

---

## 3. 自动化检查命令

```bash
cd vmagent-ui
node --check server.mjs
node --check public/app.js
node --check scripts/smoke-test.mjs
node --check scripts/load-test.mjs
npm run test:smoke
npm run test:load
```

---

## 4. smoke test 覆盖点

`scripts/smoke-test.mjs` 当前覆盖：

### 基础接口

- `GET /api/health`
- `POST /api/validate`

### 风险治理

- warn + 风险命中
- warn + `block_apply` 人工终止
- block + 风险命中但未确认
- block + 错误 `overrideToken`
- block + 缺失 `overrideReason`
- block + `force_apply` 但 `confirm=false`
- block + force_apply 保存
- block + force_apply 发布

### 发布留痕

- publish 生成 revision
- revision 记录 `riskScan` / `riskDecision`
- audit 记录 publish / rollback

### 回滚

- `POST /api/rollback/:id`
- 不存在 revision 时返回 404
- 回滚后正式配置与草稿同步恢复

### 部署骨架

- `POST /api/deployment/compose/export`（inline / save / download）
- `POST /api/deployment/compose/export` 非法 `outputPath`
- `POST /api/systemd/plan`
- `POST /api/systemd/plan` / `POST /api/systemd/apply` 非法 `targetDir`
- `POST /api/systemd/apply`（dry-run）
- 非法规则清单（坏正则、非法 enforcementMode、阈值 < 1）

---

## 5. load test 覆盖点

`scripts/load-test.mjs` 当前覆盖：

- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `POST /api/rollback/:id`

说明：

- `validate` / `revisions` 使用小并发
- `publish` / `rollback` 使用串行写测试，避免无意义状态互踩
- 脚本结束后会恢复配置文件与 runtime profile

---

## 6. 本次实际执行记录

### 6.1 语法检查

已执行：

```bash
node --check server.mjs
node --check public/app.js
node --check scripts/smoke-test.mjs
node --check scripts/load-test.mjs
```

结果：通过。

### 6.2 smoke test

本次环境里没有 `npm`，所以直接执行：

```bash
node scripts/smoke-test.mjs
```

结果：通过，输出 `smoke ok`。

### 6.3 load test

本次环境里没有 `npm`，所以直接执行：

```bash
node scripts/load-test.mjs
```

结果：通过，报告已输出到：

- `docs/perf-results.json`

本轮额外包含一个负向场景：

- `publish-risk-rejected-wrong-token`：验证错误 `overrideToken` 在 block 模式下稳定返回拒绝

摘要详见：`docs/perf.md`

---

## 7. 手工验收建议

### 页面层

1. 打开首页
2. 检查页面是否正确显示当前草稿
3. 切换普通模式 / 高级模式
4. 修改配置后点击“校验 / 扫描”
5. 观察 JSON 预览、校验结果、风险横幅

### 风险治理层

1. 设置 `enforcementMode=warn`
2. 填入风险配置：
   - `job_name=BadJob`
   - label key=`Env`
3. validate 后应提示风险但允许继续
4. 切到 `block`
5. 不填确认直接保存或发布，应返回 400
6. 补齐 `force_apply + confirm + overrideToken + overrideReason` 后应成功

### 发布与回滚层

1. 发布一个安全 revision
2. 发布一个风险 revision
3. 调用 `GET /api/revisions`
4. 回滚到目标 revision
5. 检查：
   - `config/sample-vmagent.yml`
   - `data/draft.yml`
   - `GET /api/audit`

### 部署层

1. 导出 compose
2. 执行 systemd plan
3. 执行 controlled apply 到受控目录
4. 人工核对 unit 内容与路径

---

## 8. 当前验收结论

本次交付已经补齐并验证：

- 功能主流程可运行
- 部署说明已补全
- 压测脚本已补全
- smoke / load 至少各实际跑过一轮
- 测试与性能结果已有文档留档

仍需明确的边界：

- 没有鉴权 / RBAC
- systemd 真实启用仍需人工执行 `systemctl`
- 真实 vmagent reload / restart 的性能表现要在目标环境再验一轮

如果按“单机受控、内网使用、人工审核上线”标准看，这版已经可以作为一个靠谱的 MVP 交付。
��付。
