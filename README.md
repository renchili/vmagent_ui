# vmagent-ui

`vmagent-ui` 现在的主线后端已经切到 **Go + Gin + MySQL**。

当前仓库状态：

- 前端：静态页面 `public/`
- 主后端：`cmd/server` + `internal/app`
- 数据库：MySQL
- 旧 Node/Fastify 后端：仍保留作参考/过渡，但不再是目标实现

---

## 当前已实现能力

### 配置与发布主链路

- `GET /api/health`
- `GET /api/config`
- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `POST /api/rollback/:id`
- `GET /api/audit`

### runtime profile / deployment

- `GET /api/runtime-profile`
- `POST /api/runtime-profile`
- `GET /api/deployment/:target`
- `POST /api/deployment/compose/export`
- `POST /api/systemd/plan`
- `POST /api/systemd/apply`
- `POST /api/render-yaml`

### 风险治理

Go 版已经接入：

- `labelNaming`
- `metricNaming`
- `suspiciousChanges`
- `metricsVolume.totalSeriesBudget`
- `metricsVolume.highRiskLabel`
- `metricsVolume.singleMetricLabelCardinality`
- `metricsVolume.growthTrend`
- `warn / block / force_apply / overrideToken / overrideReason / confirm`

### 真实 apply pipeline

发布和回滚后，Go 后端现在支持以下 apply 策略：

1. `VMAGENT_RELOAD_URL` → HTTP reload
2. `VMAGENT_PID` → `SIGHUP`
3. `VMAGENT_RESTART_CMD` → shell restart command
4. 如果都没配 → `noop`

### 测试与联调

已经补上的 Go 测试：

- `internal/app/risk_test.go`
- `internal/app/runtime_test.go`
- `internal/app/apply_test.go`

可直接运行：

```bash
npm run test:go
```

真实 vmagent 联调入口：

```bash
npm run test:integration:vmagent
```

对应文件：

- `docker-compose.vmagent.yml`
- `scripts/integration-vmagent.sh`

这套联调已经真实跑过，并且确实撞出了两个现实问题：

- Docker 构建必须带上 `go.sum`
- vmagent 若对 `-promscrape.config` 严格解析，当前 UI 生成的带 `remote_write` 顶层字段的 YAML 可能需要加 `-promscrape.config.strictParse=false`

---

## 项目结构

```text
vmagent-ui/
├─ cmd/server/              # Go 服务入口
├─ internal/app/            # 配置、存储、risk、runtime、deployment、apply
├─ migrations/              # MySQL schema
├─ public/                  # 前端静态页面
├─ config/                  # 示例 vmagent 配置
├─ Dockerfile               # Go 后端镜像
├─ docker-compose.mysql.yml # Go + MySQL 联调
├─ .env.example
└─ scripts/start-go-backend.sh
```

---

## 本地启动

### 方式 1：Docker Compose

```bash
cd vmagent-ui
docker compose -f docker-compose.mysql.yml up --build
```

打开：

- <http://127.0.0.1:3099>

### 方式 2：本机 Go + MySQL

先建库：

```sql
CREATE DATABASE vmagent_ui CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

再启动：

```bash
cd vmagent-ui
cp .env.example .env
source .env 2>/dev/null || true
go run ./cmd/server
```

或：

```bash
./scripts/start-go-backend.sh
```

---

## 环境变量

```bash
HOST=0.0.0.0
PORT=3099
MYSQL_DSN=root:root@tcp(127.0.0.1:3306)/vmagent_ui?parseTime=true&multiStatements=true
STATIC_DIR=public
DEFAULT_CONFIG_PATH=config/sample-vmagent.yml
DEFAULT_AUTHOR=web-ui
VMAGENT_CONFIG_PATH=/etc/vmagent/config.yml
APPLY_MODE=noop
VMAGENT_RELOAD_URL=http://127.0.0.1:8429/-/reload
VMAGENT_PID=12345
VMAGENT_RESTART_CMD="systemctl restart vmagent"
```

> apply 优先级：`VMAGENT_RELOAD_URL` > `VMAGENT_PID` > `VMAGENT_RESTART_CMD` > noop

---

## 当前边界

已经完成：

- Go 后端主链路
- MySQL 持久化（draft / revision / audit）
- rollback
- runtime profile 第一版
- deployment / compose / systemd 基础接口
- 风险规则主干
- 真实 apply pipeline
- `go build ./cmd/server` 编译通过

仍然建议视为 **迁移后的可用开发版 / 内部版**，不是已经完全打磨完的最终生产版。原因主要是：

- 前端还需要继续做端到端交互核对
- 某些 runtime / deployment 子结构还是偏简化实现
- 旧 Node 参考实现虽然已明确标记为 deprecated，但还未完全移除

旧 Node 后端的退役说明见：[`DEPRECATED_NODE_BACKEND.md`](./DEPRECATED_NODE_BACKEND.md)

---

## 当前状态总结

现在这套仓库已经明确以 **Go + MySQL** 为主线：

- 默认启动入口已经切到 Go
- 旧 Node 后端已降级为 deprecated 参考实现
- Go 单元测试已补入仓库并可直接运行
- 真实 vmagent 联调脚本与 compose 环境已补入仓库

后续如果继续推进，重点就不再是“决定要不要迁”，而是：

- 继续把真实 vmagent 联调跑到完全稳定
- 增加更多自动化测试覆盖
- 最终清理或移除旧 Node 参考实现
