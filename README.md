# vmagent-ui

一个务实可运行的 vmagent 配置管理台 MVP，覆盖：**配置编辑、校验、风险扫描、发布、revision / rollback、部署骨架导出、基础压测**。

![vmagent-ui 页面截图](./docs/vmagent-ui-screenshot.png)

> 截图可用 `npm run test:screenshot` 重新生成。

---

## 现在这版能做什么

- 编辑 vmagent YAML：普通表单模式 + 高级源码模式
- 服务端校验：YAML / 业务规则 / 尽力而为的 vmagent dry-run
- runtime profile 管理：cluster / remoteWrite / deployment / governance
- 风险治理闭环：`warn` / `block` / `force_apply`
- 发布留痕：revision、audit、rollback
- 部署骨架导出：Docker、Compose、Kubernetes、systemd
- systemd controlled apply：只写 unit 文件，不直接 `systemctl`
- 边界校验：非法 `outputPath` / `targetDir` 会被显式拒绝
- 自动化验证：smoke test
- 最小负载验证：load test

---

## 快速开始

```bash
cd vmagent-ui
npm install
npm start
```

打开：

- <http://127.0.0.1:3099>

### 可用脚本

```bash
npm start
npm run test:smoke
npm run test:load
npm run test:screenshot
```

---

## 目录结构

```text
vmagent-ui/
├─ config/                  # 示例 vmagent 配置
├─ data/                    # 草稿、revision、audit、systemd 预览等本地状态
├─ docs/
│  ├─ deployment.md         # 部署说明
│  ├─ perf.md               # 压测说明与结果
│  ├─ test-report.md        # 功能测试与验收
│  └─ vmagent-ui-screenshot.png
├─ lib/                     # runtime profile / 风险扫描 / systemd / deployment 渲染
├─ public/                  # 前端静态页面
├─ scripts/
│  ├─ smoke-test.mjs        # 主流程回归
│  ├─ load-test.mjs         # 最小压测
│  └─ screenshot.mjs        # 页面截图
└─ server.mjs               # Fastify API + 静态资源
```

---

## 核心 API

### 配置与发布

- `GET /api/health`
- `GET /api/config`
- `POST /api/render-yaml`
- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `POST /api/rollback/:id`
- `GET /api/audit`

### runtime profile / 部署

- `GET /api/runtime-profile`
- `POST /api/runtime-profile`
- `GET /api/deployment/:target`
- `POST /api/deployment/compose/export`
- `POST /api/systemd/plan`
- `POST /api/systemd/apply`

---

## 典型主流程

1. 打开页面，读取当前草稿
2. 修改配置（普通模式或高级模式）
3. 点击“校验 / 扫描”
4. 如命中风险，根据治理模式决定：
   - `warn`：提醒后可继续
   - `block`：必须人工确认并提供 override 信息
5. 保存草稿或直接发布
6. 发布后自动生成 revision，并写入 audit
7. 如有问题，可从 revision 列表回滚

---

## 部署方式

详细说明见：[`docs/deployment.md`](./docs/deployment.md)

当前文档已覆盖：

- 本地开发
- 本机单机部署
- Docker / Compose
- systemd
- 真实 vmagent 接入方式
- 上线前验证清单

---

## 测试与验收

详细说明见：[`docs/test-report.md`](./docs/test-report.md)

建议至少跑：

```bash
node --check server.mjs
node --check public/app.js
node --check scripts/smoke-test.mjs
node --check scripts/load-test.mjs
npm run test:smoke
npm run test:load
```

---

## 压测

详细说明见：[`docs/perf.md`](./docs/perf.md)

当前压测脚本覆盖的核心接口：

- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `POST /api/rollback/:id`
- 风险异常分支：错误 `overrideToken` 的 `POST /api/publish`

压测结果会输出到：

- `docs/perf-results.json`

---

## 真实 vmagent 接入

本项目支持三种 apply 方式，优先级如下：

1. `VMAGENT_RELOAD_URL`
2. `VMAGENT_PID`
3. `VMAGENT_RESTART_CMD`
4. 未配置时退化为 `noop`

示例：

```bash
export VMAGENT_CONFIG_PATH=/etc/vmagent/config.yml
export VMAGENT_RELOAD_URL=http://127.0.0.1:8429/-/reload
npm start
```

---

## 当前边界

这版是 MVP，边界很明确：

- 没有登录鉴权 / RBAC
- 没有数据库
- revision / audit 基于本地文件
- 没有并发冲突治理
- systemd apply 不直接替你执行 `systemctl`
- Docker / Kubernetes 目前是导出骨架，不是完整交付链

所以它适合：

- 单机受控运维台
- 原型验证
- 值班演练

不适合直接包装成多租户生产平台。

---

## 文档索引

- 部署：[`docs/deployment.md`](./docs/deployment.md)
- 测试：[`docs/test-report.md`](./docs/test-report.md)
- 压测：[`docs/perf.md`](./docs/perf.md)
