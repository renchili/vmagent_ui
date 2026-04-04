# vmagent-ui 部署说明（Go + MySQL 迁移版）

这份文档对应的是 **Go/Gin + MySQL** 方向，不再把旧的 Node/Fastify 当目标架构。

---

## 1. 架构

当前目标架构：

- API 后端：Go + Gin
- 数据库：MySQL 8+
- 前端：静态页面 `public/`
- vmagent 实际生效方式：后续接 reload / restart / file write pipeline

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

---

## 3. 初始化数据库

schema 文件：

- `migrations/001_init.sql`

当前表：

- `config_drafts`
- `revisions`
- `audit_logs`

服务启动时也会自动执行基础 migration。

---

## 4. 生产部署最短路径

### 目录建议

```text
/opt/vmagent-ui/
  vmagent-ui              # Go 二进制
  public/
  config/
  .env
```

### 编译

```bash
cd vmagent-ui
go build -o vmagent-ui ./cmd/server
```

### systemd

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

## 5. 反向代理

建议只监听本机地址，再让 Nginx 反代：

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

## 6. 当前限制

这还是迁移第一阶段：

- rollback 还没迁完
- deployment export 还没迁完
- systemd controlled apply 还没迁完
- risk scan 规则还没完整迁到 Go
- apply vmagent 还只是基础占位

所以现在最适合：

- 后端重构起步
- 接口对齐迭代
- 本地联调 / 内部验证

还不适合直接宣称“完整生产版已经完成”。
