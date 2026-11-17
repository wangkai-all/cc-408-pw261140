# 事件质量与结算控制台

从原始接入到结算封存的完整链路演示：**先判定流量质量，再进入转化与结算**，质量规则可版本化对比，后补证据可以让同一条事件从有效变为无效，但**已封存的结算永远不会被悄悄改写**。

全部数据都是脚本生成的虚构事件（虚构站点、设备、IP、订单号），**不做任何真实用户追踪**；所有判定都是可解释的确定性比较，**没有模型黑箱结论**。详细设计见 [docs/design.md](docs/design.md)。

## 快速开始

需要 Node.js ≥ 22.5（使用内置 `node:sqlite`，无第三方依赖）。

```bash
npm run demo      # 从零跑完整演示（多个独立进程）
npm test          # 48 个测试
npm run web       # 网页控制台 http://127.0.0.1:4317
```

演示脚本做的事（每一步都是独立的操作系统进程）：

1. 生成 7 天虚构流量到 `var/batches/*.ndjson`，写入两套规则版本（v1 基线、v2 严格）。
2. **接入进程**：校验并写入 NDJSON 批次；整文件校验通过才落库，重复文件按摘要跳过。
3. **判定进程**：v1 逐日评估，产出每个事件的判定与逐检查项贡献。
4. **分析进程**：按当前运行头生成结算草稿；前三天被财务封存。
5. 补录迟到证据（设备标记、订单撤销）。
6. **判定进程**：生成更正报告——基线是**已存库的判定历史**，候选是带新证据的重新评估。
7. 审核并批准报告：已封存日只追加更正分录，未封存日丢弃旧草稿等待重算。
8. v1 → v2 规则差异报告：两侧在**同一冻结快照**上重算。
9. 竞态演示：先入队的 v1 慢任务最后完成，但运行头仍属于后入队的 v2 快任务。

## 进程边界

```
                 ┌──────────────────────────────┐
  NDJSON 批次 -> │ 接入进程 (ingest)             │ -> raw_events / ingest_files
                 └──────────────────────────────┘
                 ┌──────────────────────────────┐
  jobs 队列 ---> │ 判定进程 (decisions lane)     │ -> decision_runs / decisions / contributions
                 │ evaluate · compare · correction│
                 └──────────────────────────────┘
                 ┌──────────────────────────────┐
  jobs 队列 ---> │ 分析进程 (analysis lane)      │ -> settlements (draft)
                 │ settle                        │
                 └──────────────────────────────┘
                 ┌──────────────────────────────┐
  浏览器 ------> │ 网页服务 (web)                │ -> 只读查询 + 规则/证据/审批写入
                 └──────────────────────────────┘
```

四个进程只通过 SQLite 文件与 `jobs` 表协作（WAL、`BEGIN IMMEDIATE`、租约 + fence），不共享内存。启动方式：

```bash
npm run ingest                    # 或 node scripts/cli.mjs ingest
npm run worker:decisions          # 判定车道
npm run worker:analysis           # 分析车道
npm run web
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm run init` | 初始化数据库 |
| `npm run seed -- --from 2026-11-10 --to 2026-11-16` | 生成虚构数据与规则版本 |
| `npm run ingest` | 原始接入进程 |
| `npm run worker` / `worker:decisions` / `worker:analysis` | 工作进程（`--lane`、`--once`、`--idle-exit-ms`） |
| `node scripts/cli.mjs enqueue evaluate\|compare\|correction\|settle ...` | 投递任务 |
| `npm run settle -- --day 2026-11-16` | 投递并消费一个结算任务 |
| `node scripts/cli.mjs seal --day YYYY-MM-DD` | 封存结算 |
| `node scripts/cli.mjs evidence --kind device_flag --key dev_x ...` | 追加证据 |
| `node scripts/cli.mjs rules list\|show\|publish\|retire ...` | 规则版本 |
| `node scripts/cli.mjs status` | 队列、运行头、结算状态 |
| `npm run reset` | 删除数据库与批次目录（追加表不能逐行删除） |

环境变量：`EQS_DB`（数据库文件）、`EQS_DATA_DIR`（批次目录）、`EQS_OPERATOR`（网页写入的审计署名）。

## 网页能做什么

- **概览**：质量率、无效/可疑数量、封存净额、每日堆叠柱图与封存净额折线（都带数据表副本）。
- **流量质量**：选择某天的运行头，查看原因分布、事件类型漏斗、会话统计，以及**被排除事件的具体原因**（逐检查项的观测值 / 比较符 / 阈值 / 证据引用）。
- **规则版本**：查看已发布版本、编辑草稿、校验、发布、退役；跨日策略（归属模式、是否升级为可疑）直接在表单里改。
- **证据**：追加生效期证据（UA 特征、IP 前缀、设备标记、订单撤销、策略备注），列表永不修改。
- **差异报告**：查看规则差异/更正报告，按日对比、原因分布、逐事件变化，确认后批准或驳回。
- **结算**：每日草稿/封存状态、封存金额与调整分录、净额，可封存或重新生成草稿。
- **任务队列**：任务参数、结果、日志时间线；可手工投递任务并观察序号与运行头。

## 关键性质（都有测试覆盖）

- 判定确定性：相同输入必得相同判定与相同运行摘要（`test/evaluate.test.mjs`）。
- 跨日：整段会话评估；`attribution-day` 与 `session-day` 两种归属模式（`test/cross-day.test.mjs`）。
- 重复订单：**首次摄入**的那条有效，后续副本无效（`test/ingest-store.test.mjs`）。
- 追加不可变：原始事件、证据、判定、贡献、任务日志、审计日志、已封存结算、调整分录均由触发器拒绝 UPDATE/DELETE。
- 运行头按**入队序号**保护，晚结束的旧任务只归档为 `superseded`（`test/queue-race.test.mjs`、`test/process.test.mjs`）。
- 租约与 fence：租约被接管后，旧工作者的提交、结算、报告一律丢弃。
- 更正报告以**已存库判定**为基线，新证据才会体现为差异。
- 冻结快照：一次任务内所有日期、两侧规则看到同一水位与证据集。
- 接入校验：一个坏行拒绝整个批次，不会半写入。
