# Grafana 联调说明

我给这个项目补了一套最短可跑的观测链路：

- `vmagent`
- `VictoriaMetrics`
- `Grafana`
- `vmagent-ui`
- `MySQL`

对应文件：

- `docker-compose.grafana.yml`
- `config/grafana-vmagent.yml`
- `grafana/provisioning/datasources/victoriametrics.yml`

## 启动

```bash
cd vmagent-ui
docker compose -f docker-compose.grafana.yml up --build
```

启动后访问：

- vmagent-ui: <http://127.0.0.1:3099>
- Grafana: <http://127.0.0.1:3000>
- VictoriaMetrics: <http://127.0.0.1:8428>
- vmagent metrics: <http://127.0.0.1:8429/metrics>

## Grafana 登录

默认账号密码：

- 用户名：`admin`
- 密码：`admin`

首次打开时，数据源已经自动 provision 成：

- `VictoriaMetrics`

## 现在能看到什么

当前默认采集的是：

- `vmagent` 自己的指标
- `VictoriaMetrics` 自己的指标

所以你进入 Grafana 后，可以先直接试这些 PromQL：

```promql
up
```

```promql
vm_promscrape_targets
```

```promql
vm_http_requests_total
```

```promql
rate(vm_http_request_duration_seconds_count[5m])
```

## 说明

这一步的目标不是把完整 dashboard 一次做满，而是先把：

**采集 -> 存储 -> 查询 -> Grafana 展示**

这条链路先跑通。

等这条链路确认 OK，下一步最值得继续的是：

1. 给 Grafana 加 dashboard JSON provisioning
2. 给 vmagent-ui 自己补 `/metrics`
3. 把 vmagent-ui 里编辑出来的配置直接喂给这套联调栈验证
