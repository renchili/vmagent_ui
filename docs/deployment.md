# vmagent-ui 部署说明（Go + MySQL 现状版）

这份文档描述的是 **当前仓库已经落地的实现**，不是未来规划。

---

## 1. 架构

当前后端架构：

- API：Go + Gin
- 数据库：MySQL 8+
- 前端：静态页面 `public/`
- 配置落地：写入 `VMAGENT_CONFIG_PATH`
- apply：支持 reload / SIGHUP / restart command

apply 优先级：

1. `VMAGENT_RELOAD_URL`
2. `VMAGENT_PID`
3. `VMAGENT_RESTART_CMD`
4. noop

---

## 2. 本地联调

### Docker Compose

```bash
cd vmagent-ui
docker compose -f docker-compose.mysql.yml up --build
```

服务：

- MySQL: `127.0.0.1:3306`
- vmagent-ui: `127.0.0.1:3099`

### 本机启动 Go 后端

先建库：

```sql
CREATE DATABASE vmagent_ui CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

再启动：

```bash
cd vmagent-ui
export MYSQL_DSN='root:root@tcp(127.0.0.1:3306)/vmagent_ui?parseTime=true&multiStatements=true'
go run ./cmd/server
```

也可以：

```bash
./scripts/start-go-backend.sh
```

---

## 3. 数据库

schema 文件：

- `migrations/001_init.sql`

当前表：

- `config_drafts`
- `revisions`
- `audit_logs`

服务启动时会自动尝试执行基础 migration。

---

## 4. 生产部署最短路径

### 编译

```bash
cd vmagent-ui
go build -o vmagent-ui ./cmd/server
```

### 推荐目录

```text
/opt/vmagent-ui/
  vmagent-ui
  public/
  config/
  .env
```

### systemd 托管 vmagent-ui 自身

```ini
[Unit]
Description=vmagent-ui (Go)
After=network.target mysql.service

[Service]
WorkingDirectory=/opt/vmagent-ui
EnvironmentFile=/opt/vmagent-ui/.env
ExecStart=/opt/vmagent-ui/vmagent-ui
Restart=always
User=root

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vmagent-ui
sudo systemctl status vmagent-ui --no-pager
```

---

## 5. vmagent apply 接法

### 方式 A：HTTP reload

```bash
export VMAGENT_RELOAD_URL="http://127.0.0.1:8429/-/reload"
```

### 方式 B：SIGHUP

```bash
export VMAGENT_PID=12345
```

### 方式 C：restart command

```bash
export VMAGENT_RESTART_CMD="systemctl restart vmagent"
```

如果都不配，发布/回滚只会写配置文件，不会触发生效动作。

---

## 6. 反向代理

建议只监听本机，再用 Nginx 反代：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3099;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 7. 当前接口覆盖面

已经可用：

- config 读写 / validate / publish
- revisions / rollback / audit
- runtime profile
- deployment artifacts
- compose export
- systemd plan / controlled apply
- render-yaml
- risk scan + manual decision semantics

---

## 8. 当前仍需继续打磨的点

虽然主链路已经在 Go 版落地，但现在仍建议把它视为：

> **可运行、可继续迭代的迁移后版本**

还值得继续补的地方：

- 前端端到端交互回归
- deployment/runtime 子结构进一步细化
- 旧 Node 参考实现的退役与清理
- 更多真实环境验收（尤其是 vmagent reload / restart 行为）
