# vmagent-ui

`vmagent-ui` 现在开始从旧的 Node/Fastify 单体实现，迁到你要的 **Go + MySQL** 架构。

当前仓库状态：

- 前端：仍保留现有静态页面 `public/`
- 新后端主线：**Go + Gin**
- 数据存储：**MySQL**
- 旧 Node 后端：暂时保留作过渡参考，不再作为目标架构

---

## 当前迁移进度

这次已经落下去的第一阶段内容：

- 新增 Go 服务入口：`cmd/server/main.go`
- 新增应用层：`internal/app/`
- 新增 MySQL schema：`migrations/001_init.sql`
- 新增 Dockerfile（Go 版本）
- 新增 `docker-compose.mysql.yml`
- 新增 `.env.example`
- 新增启动脚本：`scripts/start-go-backend.sh`

已经有的后端能力（Go 版第一阶段）：

- `GET /api/health`
- `GET /api/config`
- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `GET /api/audit`

已经切到 MySQL 的核心对象：

- current draft
- revisions
- audit logs

---

## 目标架构

```text
browser UI
  -> Go/Gin API
  -> MySQL
  -> vmagent config file / reload pipeline
```

目录：

```text
vmagent-ui/
├─ cmd/server/              # Go 服务入口
├─ internal/app/            # Gin / config / store / handlers
├─ migrations/              # MySQL schema
├─ public/                  # 前端静态页面
├─ config/                  # 示例 vmagent 配置
├─ Dockerfile               # Go 后端镜像
├─ docker-compose.mysql.yml # 本地 Go + MySQL 联调
├─ .env.example
└─ scripts/start-go-backend.sh
```

---

## 本地快速跑 Go + MySQL

### 方式 1：Docker Compose

```bash
cd vmagent-ui
docker compose -f docker-compose.mysql.yml up --build
```

打开：

- <http://127.0.0.1:3099>

### 方式 2：本机 Go + 本机 MySQL

先准备数据库：

```sql
CREATE DATABASE vmagent_ui CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

然后：

```bash
cd vmagent-ui
cp .env.example .env
# 按需修改 MYSQL_DSN
source .env 2>/dev/null || true
go run ./cmd/server
```

或者：

```bash
./scripts/start-go-backend.sh
```

---

## 环境变量

核心环境变量：

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
```

---

## 当前边界

这次是 **迁移第一阶段**，不是最终完成版。

已经完成：

- Go 服务骨架
- MySQL 存储骨架
- draft / revision / audit 基础链路
- 前端继续可对接 `/api/*`

还没完全迁完：

- 旧 Node 里的完整风险扫描规则还没 1:1 搬到 Go
- runtime profile 的细分逻辑目前是基础承接，不是完整治理版
- rollback / deployment export / systemd controlled apply 还没全部迁完
- 真实 vmagent apply 现在还是占位路径，需要继续补全

所以这版的定位很明确：

> **开始把项目真正扳到 Go + MySQL 主线上，而不是继续在 Node 版本上修补。**

---

## 下一阶段建议

下一步优先级我建议是：

1. 把 `rollback` 迁到 Go
2. 把 risk-scan / rule-bundle 逻辑从 Node 迁到 Go
3. 把 runtime profile 做成明确表结构或稳定 JSON schema
4. 把 deployment export / systemd API 迁完
5. 最后再清理旧 Node 后端代码
