# CTM + 汇入匝道仿真后端

一维道路拥堵波与匝道流量仿真后端。只提供 **HTTP API + CLI**、虚构道路/需求生成器和自动化测试；没有网页、车辆路径规划或真实设备连接。

- 模型：单向分段道路 + 一个汇入匝道，三角形基本图（triangular fundamental diagram）的单元传输模型（CTM）。
- 推进：按各单元**发送量/接收量**和合流优先级**同步**更新（同一时步只读旧状态，先算全部流量再写入新状态），不会边算边覆盖凭空增/丢车。
- 边界：上游主路与匝道需求超过可进入量时进入持久化边界队列，绝不静默丢弃；结束仍在队列中的车辆计入“未服务”，不计入已服务出流。
- 合流：仅在供给不足时按优先级（默认主路 0.6）分配，一方用不完的份额自动让给另一方。
- 方案版本：任何参数/需求修改都 **fork 出新版本与新运行**，历史版本与运行不可变。

## 单位（全程一致）

| 量 | 单位 |
| --- | --- |
| 车辆数 | veh |
| 密度 | veh/km |
| 流率 / 需求 / 限流 | veh/h |
| 自由流速 `vf`、拥堵波速 `w` | km/h（`w` 以正数给出，物理上向上游传播） |
| 单元长度 | km |
| 时步 `dtHours` / 时刻 | h（默认 1/120 h = 30 s） |

三角形基本图一致性校验：每单元容量 `Q <= vf·ρcrit` 且 `vf·ρcrit = w·(ρjam−ρcrit)`；
CFL 条件：对所有单元 `max(vf,w)·dt / L <= 1`，否则拒绝建版本（错误码 `VALIDATION_ERROR`）。

## 依赖与运行环境

- Node.js **>= 22.5**（开发使用 v25.5）。运行时使用内置的 `node:sqlite`，**无需 npm install 任何运行时依赖**；测试使用内置 `node:test`。
- 可选：`npm install` 仅在需要编辑器类型或 `npm run typecheck` 时安装 `typescript` 与 `@types/node`（开发依赖，运行/测试不依赖）。
- 所有数据、临时数据库、导出文件都写入本项目 `data/`；服务只绑定 `127.0.0.1`，端口传 `0` 由系统自动分配并写入 `data/server.port`。

## 快速开始

```powershell
# 可重复端到端演示（固定种子，三方案对比 + 守恒账）
npm run demo

# 启动 API（仅 127.0.0.1，自动端口；端口见 data/server.port）
npm start

# 或后台方式：仅启动/停止本项目进程（pid 记录在 data/server.pid）
npm run serve:start
npm run serve:stop
# 前台停止：Ctrl+C；后台停止：npm run serve:stop（只结束本项目记录的 pid）
```

可选环境变量：`CTM_DB`（默认 `data/ctm.sqlite`），`CTM_PORT`（默认 0 自动端口）。

## 测试

```powershell
npm test
```

覆盖：自由流手算（脉冲每 30 s 推进一个单元）、排队形成与消散、满阻断、需求脉冲、合流竞争优先级与空闲份额、不合法时步（CFL）、全程守恒/非负/密度上限、同步更新、固定输入复现、幂等重复提交、失败路径、事务回滚、关闭重开持久化、API 参数校验/错误码/分页、仅绑定本机。

## CLI

数据库可用 `$env:CTM_DB="data/x.sqlite"` 指向独立文件。变更类命令都会打印 **before -> after** 状态。

```powershell
# 建路段（虚构道路 + 需求，固定种子可复现）
node --experimental-sqlite src/cli.ts init-road --name corridor --seed 7 --horizon 120

node --experimental-sqlite src/cli.ts list

# 导入需求（JSON，见 examples/demand.sample.json）；产生新版本
node --experimental-sqlite src/cli.ts import-demand --version 1 --file examples/demand.sample.json --label imported

# 模拟瓶颈降容（对需求区间的瓶颈单元乘系数，0<factor<=1）；产生新版本
node --experimental-sqlite src/cli.ts bottleneck --version 1 --factor 0.3 --label cap30 --start 40 --end 90

# 匝道限流 veh/h；产生新版本
node --experimental-sqlite src/cli.ts meter --version 1 --rate 300 --label meter300 --start 40 --end 90

# 运行（幂等键可重复提交；可注入种子）
node --experimental-sqlite src/cli.ts run --version 1 --idempotency-key k1 --seed 7

# 查询某时刻密度/车辆数/队列/进出流
node --experimental-sqlite src/cli.ts query --run 1 --step 60

# 比较两个方案的运行（出流、累计延误、未服务、拥堵峰值等）
node --experimental-sqlite src/cli.ts compare --a 1 --b 2

# 导出守恒账（veh，含 demand = exited + onRoad + unserved 残差）
node --experimental-sqlite src/cli.ts ledger --run 1 --out data/ledger.json
```

`npm run cli -- <args>` 等价于上面的 `node ... src/cli.ts`。

## HTTP API

JSON 请求/响应。错误统一形如 `{"error":{"code","message"}}`，状态码：`400 VALIDATION_ERROR`、`404 NOT_FOUND`、`409 CONFLICT`、`400`（非法 JSON / 分页参数）、`500 INTERNAL`。重复运行可通过请求头 `Idempotency-Key: <key>` 或体字段 `idempotencyKey` 幂等。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/scenarios` | 建路段（`{name}`） |
| GET | `/api/scenarios` | 列场景 |
| GET | `/api/scenarios/:id` | 场景详情 |
| POST | `/api/scenarios/:id/versions` | 建版本（params + demand + horizonSteps，带校验） |
| GET | `/api/scenarios/:id/versions` | 版本列表 |
| GET | `/api/versions/:id` | 版本详情 |
| POST | `/api/versions/:id/fork` | 修改参数/需求 -> **新版本** |
| POST | `/api/versions/:id/runs` | 运行（支持幂等键、`seed`） |
| GET | `/api/runs/:id` | 运行结果汇总 |
| GET | `/api/runs/:id/steps?limit=&offset=` | 分页查询各时刻密度/队列/流（`limit` 1–1000） |
| GET | `/api/runs/:id/ledger` | 守恒账 |
| POST | `/api/runs/compare` | `{runA, runB}` 方案比较 |

### 版本参数（params）

```json
{
  "cellLengthKm": [0.5, 0.5, 0.5, 0.5],
  "vf": 60, "w": 15,
  "rhoCrit": 30, "rhoJam": 150,
  "capacity": [1800, 1800, 1800, 1800],
  "dtHours": 0.008333333333333333,
  "mergeCell": 2,
  "bottleneckCell": 3,
  "mainlinePriority": 0.6,
  "initialDensity": [0, 0, 0, 0]
}
```

需求条目覆盖半开区间 `[startStep, endStep)`，必须从 0 连续拼接至 `horizonSteps`，不允许空隙/重叠；`meterRate` 给数值（veh/h）或 `"off"`；`capacityFactor` 在 (0,1]。

## 模型说明

- 发送量 `S_i = min(N_i, Q_i·dt)`；接收量 `R_i = min(Q_i·dt, (w·dt/L_i)(Njam_i − N_i))`。
- 普通边界流量 `f = min(S_上游, R_下游)`；合流单元把主路与匝道两个来源对同一个 `R` 做优先级分配，空闲份额可被另一侧利用。
- 匝道先经过限流（`meterRate·dt`）再参与合流竞争；未放行部分留在匝道队列。
- 下游出口为无限大汇（自由出流）。
- 状态更新 `N_i^{k+1} = N_i^k + 流入 − 流出`，全部由旧状态一次性算出；运行内部每步断言非负且不超过堵塞密度。
- 累计延误 = 路段拥堵延误（速度低于 `vf` 的在途车辆时间）+ 边界队列等待时间（veh·h）。
- 守恒账：`总需求 = 已出流 + 期末在途 + 期末未服务队列`，残差应为 0（浮点容差 1e-4 veh）。

## 目录

```
src/engine.ts    三角形基本图 CTM、合流分配、CFL/参数校验、同步更新
src/generator.ts 种子化虚构道路与需求生成器
src/db.ts        SQLite 迁移（可重复执行）与仓储/事务
src/service.ts   版本/运行编排、幂等、守恒账、方案比较
src/api.ts       HTTP 路由、校验、错误码、分页
src/serve.ts     仅本机自动端口的服务入口
src/cli.ts       命令行
src/demo.ts      固定种子可重复端到端演示
tests/           node:test 自动化测试
```
