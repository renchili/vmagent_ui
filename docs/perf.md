# vmagent-ui 压测说明与结果

这份文档讲两件事：

1. 怎么跑最小可复现压测
2. 我这次实际跑了什么、结果如何

---

## 1. 压测目标

当前不是要打极限 QPS，而是验证这个 MVP 在**基础并发和状态变更链路**下不会立刻散架。

覆盖接口：

- `POST /api/validate`
- `POST /api/config`
- `POST /api/publish`
- `GET /api/revisions`
- `POST /api/rollback/:id`
- 负向发布链路：错误 `overrideToken` 的 `POST /api/publish`

设计原则：

- **无状态读接口**（如 validate、revisions）可以并发一点
- **有状态写接口**（publish、rollback）用串行小样本，更贴近真实运维流程
- 压测后恢复 `config/sample-vmagent.yml`、`data/draft.yml`、`data/runtime-profile.json`

---

## 2. 运行方式

先启动服务：

```bash
cd vmagent-ui
npm install
npm start
```

另开一个终端运行：

```bash
npm run test:load
# 如果环境里没有 npm，也可以直接：
node scripts/load-test.mjs
```

也可以调整默认强度：

```bash
VALIDATE_ITERATIONS=60 \
VALIDATE_CONCURRENCY=10 \
CONFIG_ITERATIONS=20 \
CONFIG_CONCURRENCY=4 \
PUBLISH_ITERATIONS=6 \
REVISIONS_ITERATIONS=40 \
REVISIONS_CONCURRENCY=8 \
ROLLBACK_ITERATIONS=3 \
npm run test:load
```

结果会写到：

- `docs/perf-results.json`

---

## 3. 脚本说明

脚本位置：

- `scripts/load-test.mjs`

它会做这些事：

1. 读取当前正式配置 / 草稿 / runtime profile 作为备份
2. 对 `validate` 跑并发请求
3. 对 `config save` 跑小并发请求
4. 先做一次 block 风险校验拿到 `overrideToken`
5. 串行跑安全 publish
6. 跑 `GET /api/revisions`
7. 串行跑一次带 `force_apply` 的风险 publish
8. 用新生成的 revision 跑 rollback
9. 输出每个场景的：
   - 总耗时
   - 吞吐
   - 成功率
   - p50 / p95 / max 延迟
10. 最后恢复本地配置文件

---

## 4. 我这次实际跑的环境

- 时间：2026-04-04（Asia/Singapore）
- 运行方式：本地 Node.js 单进程
- 服务地址：`http://127.0.0.1:3099`
- Node.js：`v24.14.1`
- vmagent 原生 dry-run：本机未提供二进制时会自动跳过

本次采用脚本默认参数：

- `validate-safe`: 30 次，5 并发
- `config-save-safe`: 12 次，2 并发
- `publish-safe-serial`: 4 次，串行
- `revisions-list`: 20 次，4 并发
- `publish-risk-force-serial`: 1 次，串行
- `publish-risk-rejected-wrong-token`: 3 次，串行
- `rollback-serial`: 2 次，串行

---

## 5. 本次实际结果

以 `docs/perf-results.json` 为准。摘要如下：

| 场景 | 请求数 | 并发 | 成功率 | p50 | p95 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| validate-safe | 30 | 5 | 100% | 16ms | 21ms | 纯校验链路稳定 |
| config-save-safe | 12 | 2 | 100% | 8ms | 10ms | 保存草稿稳定 |
| publish-safe-serial | 4 | 1 | 100% | 7ms | 8ms | 串行发布可用 |
| revisions-list | 20 | 4 | 100% | 20ms | 22ms | revision 列表读取稳定 |
| publish-risk-force-serial | 1 | 1 | 100% | 7ms | 7ms | block + force_apply 链路可跑通 |
| publish-risk-rejected-wrong-token | 3 | 1 | 100% | 5ms | 5ms | 错误 token 被稳定拒绝（预期 400） |
| rollback-serial | 2 | 1 | 100% | 3ms | 5ms | rollback 恢复正常 |

> 上表数值来自本次实际执行生成的 `docs/perf-results.json`。如果你重新跑，数值会随机器状态轻微波动。

---

## 6. 结果解读

这次结果说明了几件事：

### 6.1 MVP 级别的本地控制面没有明显性能瓶颈

- validate / save / revisions 这类本地文件 + 内存处理路径，在小并发下都很轻
- publish / rollback 之所以也快，主要是当前 apply 默认为 `noop`

### 6.2 真正的瓶颈未来会在外部依赖

如果接上真实生产路径，耗时大概率会出现在：

- `vmagent -dryRun`
- 真实磁盘 IO
- HTTP reload
- `systemctl restart`
- 宿主机权限边界

所以现在的结果只能证明：

- **应用本身的控制面逻辑是通的**
- **本地单进程、小并发下没有明显异常**

不能证明：

- 高并发生产流量下绝对稳
- 多人同时修改时无冲突
- 真实重载链路一定快

### 6.3 写接口采用串行压测是故意的

`publish` / `rollback` 都会改本地状态文件。硬做高并发写压测没有太大业务意义，反而容易把测试变成“文件争用实验”。

---

## 7. 建议的后续压测方向

如果要继续往上线前推进，建议补三类测试：

1. **真实 vmagent 接入压测**
   - 开启 `VMAGENT_RELOAD_URL` 或 `VMAGENT_RESTART_CMD`
   - 观察发布链路真实耗时

2. **更高并发读压测**
   - 重点打 `validate`、`GET /api/config`、`GET /api/revisions`

3. **异常路径压测**
   - 不合法 YAML
   - 重复 job_name
   - block 风险未确认 publish
   - 不可写 systemd targetDir

---

## 8. 结论

这轮最小压测的结论很简单：

- 脚本可运行
- 核心接口已覆盖
- 本地默认场景下通过
- 结果已落盘到 `docs/perf-results.json`

对现在这个 MVP，我会给出的判断是：

**适合继续做单机受控交付，不适合跳过鉴权/并发治理直接当成大规模生产控制面。**
