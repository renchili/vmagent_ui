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

### 后端快速部署（单机最短路径）

如果你要的不是开发模式，而是把这套后端尽快落到一台机器上，最短路径就是直接把整个 Node 服务跑起来：

```bash
cd /opt/vmagent-ui
npm ci --omit=dev
export HOST=127.0.0.1
export PORT=3099
export VMAGENT_CONFIG_PATH=/etc/vmagent/config.yml
export VMAGENT_RELOAD_URL=http://127.0.0.1:8429/-/reload
npm start
```

最小上线建议：

- 用 `Nginx` / `Caddy` 反代 `127.0.0.1:3099`
- 不要直接把 3099 暴露到公网
- `config/` 和 `data/` 放持久盘
- 如果接真实 vmagent，优先配 `VMAGENT_RELOAD_URL`

如果想做成常驻服务，可以先用 `systemd` 最小化托管：

```ini
[Unit]
Description=vmagent-ui
After=network.target

[Service]
WorkingDirectory=/opt/vmagent-ui
Environment=HOST=127.0.0.1
Environment=PORT=3099
Environment=VMAGENT_CONFIG_PATH=/etc/vmagent/config.yml
Environment=VMAGENT_RELOAD_URL=http://127.0.0.1:8429/-/reload
ExecStart=/usr/bin/npm start
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

然后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vmagent-ui
sudo systemctl status vmagent-ui --no-pager
```

更完整的部署说明见：[`docs/deployment.md`](./docs/deployment.md)

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
├─ data/                    # 草稿；revision/audit/runtime/systemd 预览等运行时状态默认本地生成
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

## 仓库跟踪策略

为了让主仓库保持干净，这一版把 **高频运行时输出** 视为可重建文件，默认不纳入版本控制：

- `data/audit/`
- `data/revisions/`
- `data/runtime-profile.json`
- `data/systemd-preview/`
- `data/test-output/`
- `docs/perf-results.json`

保留在仓库里的重点是：

- 服务端/前端源码
- 示例配置
- 部署、测试、压测文档
- 可复现这些输出的脚本

也就是说，这个仓库偏向 **source-of-truth + reproducible artifacts**，不是把每次运行产生的本地状态都一起塞进 git。

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
