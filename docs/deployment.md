# vmagent-ui 部署说明

这份文档只讲当前仓库里**已经能跑**的部署方式，不吹未来形态。项目本质上是一个 Node.js 单体：

- Fastify API：`server.mjs`
- 静态前端：`public/`
- 本地状态目录：`data/`
- 默认配置文件：`config/sample-vmagent.yml`

---

## 1. 先理解这个项目实际管什么

vmagent-ui 负责四件事：

1. 编辑 vmagent 配置草稿
2. 做 YAML / 业务规则 / 尽力而为的 vmagent dry-run 校验
3. 做风险扫描、发布、revision、rollback、audit 留痕
4. 导出部署骨架（Docker / Compose / Kubernetes / systemd）

它**不是** vmagent 自身；真实采集仍由 vmagent 进程承担。

---

## 2. 环境要求

### 必需

- Node.js 20+（当前实测 Node.js 24 可运行）
- npm

### 可选

- `vmagent` 二进制
  - 用于启用原生 `-dryRun`
  - 没有也能运行，但会跳过原生 dry-run，只保留 YAML / 业务规则校验

### 默认端口

- Web UI / API：`3099`

---

## 3. 本地开发

```bash
cd vmagent-ui
npm install
npm start
```

打开：

- <http://127.0.0.1:3099>

### 常用开发校验

```bash
node --check server.mjs
node --check public/app.js
node --check scripts/smoke-test.mjs
node --check scripts/load-test.mjs
npm run test:smoke
npm run test:load
```

### 常见环境变量

```bash
PORT=3099
HOST=0.0.0.0
VMAGENT_CONFIG_PATH=./config/sample-vmagent.yml
VMAGENT_BIN=vmagent
DEFAULT_AUTHOR=web-ui

# 真实接入 vmagent 时可用
VMAGENT_RELOAD_URL=http://127.0.0.1:8429/-/reload
VMAGENT_PID=12345
VMAGENT_RESTART_CMD="systemctl restart vmagent"
```

> 三种 apply 方式是互斥优先级：`VMAGENT_RELOAD_URL` > `VMAGENT_PID` > `VMAGENT_RESTART_CMD` > noop。

---

## 4. 本机单机部署

适合一台机器同时跑 vmagent-ui 和 vmagent。

### 推荐目录

```text
/opt/vmagent-ui/
  server.mjs
  public/
  lib/
  config/
  data/
```

### 启动方式

```bash
cd /opt/vmagent-ui
npm ci --omit=dev
HOST=127.0.0.1 PORT=3099 npm start
```

### 单机落地建议

- 把 `config/` 与 `data/` 放在持久盘
- 如果要让反向代理访问，只把 3099 暴露给 Nginx / Caddy，不建议直接公网暴露
- 如果接真实 vmagent，优先用 `VMAGENT_RELOAD_URL` 或受控 `VMAGENT_RESTART_CMD`

---

## 5. Docker / Compose 部署

项目目前已经能导出 Compose 骨架；仓库里没有预制 Dockerfile，所以最务实的办法是先在宿主机直接运行，或者自行补一个最小镜像。

### 5.1 用 API 导出 Compose 骨架

先启动 vmagent-ui，再请求：

```bash
curl -s http://127.0.0.1:3099/api/deployment/compose/export \
  -H 'content-type: application/json' \
  -d '{"mode":"save","outputPath":"./data/test-output/docker-compose.vmagent.yml"}'
```

生成文件示例位置：

- `data/test-output/docker-compose.vmagent.yml`

### 5.2 自己写一个最小 Compose（推荐）

如果要把 vmagent-ui 本身也容器化，建议额外维护一个 compose 文件，例如：

```yaml
services:
  vmagent-ui:
    image: node:24-bookworm-slim
    working_dir: /app
    command: sh -lc "npm ci && npm start"
    ports:
      - "3099:3099"
    environment:
      HOST: 0.0.0.0
      PORT: 3099
      VMAGENT_CONFIG_PATH: /app/config/sample-vmagent.yml
    volumes:
      - ./:/app
```

这更偏开发/验证，不是精简生产镜像。生产场景建议再补 Dockerfile。

---

## 6. systemd 部署

这个项目已经提供两层 systemd 能力：

1. **导出 vmagent 的 unit 骨架**
2. **对 unit 文件做 controlled apply**（只写文件，不替你执行 `systemctl`）

### 6.1 查看 systemd 计划

```bash
curl -s http://127.0.0.1:3099/api/systemd/plan \
  -H 'content-type: application/json' \
  -d '{"targetDir":"./data/systemd-preview"}' | jq
```

### 6.2 受控写入 unit 文件

```bash
curl -s http://127.0.0.1:3099/api/systemd/apply \
  -H 'content-type: application/json' \
  -d '{"targetDir":"./data/systemd-preview","enableWrites":true}' | jq
```

输出文件示例：

- `data/systemd-preview/vmagent.service`

### 6.3 真正上线到宿主机 systemd

把生成的 unit 文件人工审核后复制到：

- `/etc/systemd/system/vmagent.service`

然后由具备 root 权限的操作者执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart vmagent
sudo systemctl status vmagent --no-pager
```

> 当前项目**不会自动执行**这些命令。这是故意留的安全边界。

---

## 7. 真实 vmagent 接入方式

这是最关键的一段：vmagent-ui 只负责写配置和触发 apply，真正生效靠你怎么接 vmagent。

### 方案 A：HTTP reload（优先推荐）

适用于你的 vmagent 暴露了 reload 接口。

```bash
export VMAGENT_RELOAD_URL="http://127.0.0.1:8429/-/reload"
npm start
```

发布或回滚后，后端会 `POST` 到这个地址。

### 方案 B：向进程发 SIGHUP

```bash
export VMAGENT_PID="12345"
npm start
```

发布或回滚后，后端会执行：

- `process.kill(<pid>, 'SIGHUP')`

### 方案 C：受控 restart 命令

```bash
export VMAGENT_RESTART_CMD="systemctl restart vmagent"
npm start
```

发布或回滚后，后端会尝试执行这条命令。

### 方案选择建议

- 有 reload 接口：优先 `VMAGENT_RELOAD_URL`
- 没有 reload，但你能稳定拿到主进程 PID：用 `VMAGENT_PID`
- 最后才是 `VMAGENT_RESTART_CMD`

### 配置文件路径

默认正式配置文件路径来自：

- `VMAGENT_CONFIG_PATH`
- 未设置时：`config/sample-vmagent.yml`

生产里应该显式改成真实路径，比如：

```bash
export VMAGENT_CONFIG_PATH=/etc/vmagent/config.yml
```

---

## 8. 上线前验证清单

至少跑下面这些检查：

### 8.1 基础启动

```bash
curl -s http://127.0.0.1:3099/api/health
curl -s http://127.0.0.1:3099/api/config | jq '.sourcePath, .draftPath, .runtimeProfilePath'
```

### 8.2 自动化回归

```bash
npm run test:smoke
npm run test:load
```

### 8.3 真实发布链路演练

至少演练一次：

1. `POST /api/validate`
2. `POST /api/config`
3. `POST /api/publish`
4. `GET /api/revisions`
5. `POST /api/rollback/:id`
6. `GET /api/audit`

### 8.4 apply 通道确认

确认当前配置的 apply 行为是你预期的：

- HTTP reload
- SIGHUP
- restart command
- noop

不要在上线后才发现发布成功了但 vmagent 没 reload。

### 8.5 systemd / Compose 产物人工审阅

重点核对：

- vmagent 二进制路径
- config 路径
- data 路径
- container image
- extra args
- 目标目录是否可写

---

## 9. 生产使用边界

当前版本适合：

- 单机或小规模受控场景
- 配置治理原型
- 本地运维台 / 值班台

当前还不适合直接宣称为：

- 多租户平台
- HA 控制面
- 强鉴权生产控制台
- 完整 CI/CD 发布系统

原因很直接：

- 没有登录鉴权
- 没有细粒度 RBAC
- 没有数据库
- 没有并发冲突治理
- revision / audit 是本地文件实现

---

## 10. 建议的最小上线组合

如果现在就要落地，我会建议：

1. vmagent-ui 跑在内网单机
2. 前面挂一层 Nginx / Caddy 做访问控制
3. `VMAGENT_CONFIG_PATH` 指向真实 vmagent 配置文件
4. `VMAGENT_RELOAD_URL` 或 `VMAGENT_RESTART_CMD` 明确配置
5. 每次发布前先跑 validate
6. 保留 `data/revisions/` 与 `data/audit/` 的备份

---

## 11. 相关文档

- 功能总览：`README.md`
- 测试与验收：`docs/test-report.md`
- 压测说明与结果：`docs/perf.md`
