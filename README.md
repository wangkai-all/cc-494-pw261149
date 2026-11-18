# 归因控制台 · Attribution Console

多渠道营销归因分析应用。支持**末次触点 / 线性 / 时间衰减**三种模型，处理**跨设备、自然流量、退款与回看窗口变化**；每次运行都锁定模型版本、参数与输入快照，口径修订只会产生新结果，并可在「贡献迁移」里对照旧结果查看渠道贡献如何重新分配。无法归因的转化单独统计并说明原因。

零依赖：Node 24 内置 `node:http`、`node:sqlite`，前端为原生 ES Module，无构建步骤。

## 快速开始

```bash
npm run seed     # 重建 data/attribution.sqlite3：演示用户、快照、基线运行、口径修订运行
npm start        # http://localhost:4173
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4173` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 目录 |
| `DB_PATH` | `$DATA_DIR/attribution.sqlite3` | 数据库文件（测试用临时目录隔离） |

`npm run seed` 会**清空并重建**业务表，只用于演示环境。`npm start` 首次启动时若数据库为空，也会自动写入种子快照。

### 演示身份

点击右上角用户区切换身份（演示用，无需密码）：

| 用户 | 角色 | 可执行 |
| --- | --- | --- |
| 林岚 | 管理员 admin | 全部：新建快照/运行、CSV / JSON / 审计导出 |
| 周迅 | 分析师 analyst | 新建快照/运行、CSV 导出 |
| 陈默 | 查看者 viewer | 只读，不可导出、不可新建 |

权限在服务端校验，前端按钮置灰只是提示；直接请求受限接口会返回 401 / 403。

## 模型与版本

模型语义由 `src/lib/attribution.js` 的 `MODEL_REGISTRY` 中的 `(id, version)` 唯一确定。

| 模型 | 版本 | 语义 |
| --- | --- | --- |
| `last_touch` | 1.0.0 | 100% 归给窗口内最后一个触点 |
| `last_touch` | 1.1.0 | 末次为 `direct` 时回退到最后一个非直接触点（`direct_fallback`，默认开） |
| `linear` | 1.0.0 | 窗口内触点均分 |
| `time_decay` | 1.0.0 | 未归一化权重 `0.5 ^ (距转化小时数 / half_life_hours)`，默认半衰期 168 小时；同一转化内再归一化 |

通用参数：`lookback_days`（1–365，默认 30）、`include_direct`、`include_organic`、`dedupe_same_session`。

- 版本号不可复用；改动任何分支语义都必须新增版本，旧版本保留在注册表中，历史结果永远可以复算。
- `last_touch@1.1.0` 在注册表中声明 `supersedes: '1.0.0'`（表示该版本延续自 1.0.0 的口径修订）；种子数据中另用运行级 `supersedes` 字段把新运行关联到旧运行，用于演示贡献迁移。
- 参数只接受注册表 schema 中声明的键：越界会被裁剪到边界，未知键被忽略，非数字报 400。

## 结果锁定与指纹

一次运行由 **输入快照 + 引擎版本 + 模型 (id, version) + 归一化参数 + 退款策略** 决定：

1. 快照按 payload 的稳定哈希去重；同内容重复上传返回已有快照。
2. 运行按上述五元组计算指纹，`runs.fingerprint` 有唯一索引；同参数重复运行返回已有结果（`deduped: true`），不会覆盖或改写历史。
3. 结果哈希 `result_hash` 覆盖渠道行、转化行、路径、总额与无法归因分桶，不含时间戳。
4. `POST /api/runs/:id/verify` 用当前快照重新计算，返回 `result_match`、`snapshot_match`、`channel_rows_match`，用于复核结果未被篡改。

改版（如 1.0.0 → 1.1.0）只能通过新建运行实现；旧运行原样保留，`superseded_by` 指向新运行。贡献迁移接口逐渠道对比两个运行，给出贡献、份额、转化数与排名变化，并校验总额守恒。

## 数据口径

输入 payload：

```jsonc
{
  "name": "2026 Q4 全渠道归因",
  "events": [
    // 触点事件
    { "event_id": "ev_1", "ts": "2026-10-01T08:00:00Z", "identity_id": "id_001",
      "device_id": "dev_a", "channel": "paid_search", "campaign": "品牌词", "session_id": "s_1" }
  ],
  "conversions": [
    { "conversion_id": "cv_1", "ts": "2026-10-03T10:00:00Z", "received_at": "2026-10-03T11:00:00Z",
      "identity_id": "id_001", "device_id": "dev_b", "order_id": "ord_1",
      "value": 1299, "currency": "CNY", "refund_amount": 0, "refund_ts": null }
  ],
  "identityLinks": { "dev_b": "id_001" }   // 设备 → 身份（跨设备归并）
}
```

- **跨设备**：先按 `identity_id > user_id > device_id` 解析身份，并应用 `identityLinks` 归属，再按身份形成旅程；只有曝光没有转化的身份也进入统计。
- **自然流量**：`organic_search`、`direct`、`referral` 视为自然流量。默认计入；关闭 `include_organic` / `include_direct` 时被排除，因此无法归因的转化进入单独分桶，不静默丢弃。
- **回看窗口**：触点必须落在 `[转化时刻 − lookback_days 天, 转化时刻]`；转化之后的触点计入 `post_conversion_touches`。
- **重复事件**：`event_id` 或自然键（身份+时间+渠道+系列+会话）相同的触点只计一次；转化按 `conversion_id` 去重（缺省时用身份+时间+订单号），重复样本保留在数据质量页。
- **迟到转化**：`received_at` 晚于转化时刻超过 24 小时标记为迟到，但**仍然计入**本次结果（样本与金额单独统计），便于观察回填延迟。
- **退款**（`refund_policy`）：
  - `clawback`（默认）：退款按原归因权重从各渠道反向冲减；
  - `exclude`：含退款的订单整单剔除，状态 `excluded_refund`，不计入净额；
  - `ignore`：按毛额归因，仅用于与财务对账。

### 无法归因分桶

`unattributed` 单独统计笔数与金额，并给出原因：

| reason | 含义 |
| --- | --- |
| `no_touch` | 该身份没有任何触点 |
| `no_touch_in_window` | 有触点但全部在窗口外 |
| `direct_excluded_only` | 窗口内只有被排除的直接访问 |
| `organic_excluded_only` | 窗口内只有被排除的自然流量 |
| `zero_value` | 净值为 0（如全额退款后） |

恒等式：`net_value = attributed_value + unattributed.net_value`，且 `unattributed.net_value` 等于各原因金额之和（测试覆盖）。

## 页面

| 标签 | 内容 |
| --- | --- |
| 总览 | 已归因金额主数字、关键指标、渠道贡献条形图（付费/自然分组图例 + 表格视图）、无法归因原因表、广告系列表、运行配置与「校验结果」 |
| 转化路径 | 按价值排序的路径序列、跨设备路径标记、单条路径的触点/转化明细 |
| 贡献迁移 | 选择基线运行对比当前运行；同快照/不同快照提示、发散条形图、总额对照、逐渠道 Δ 贡献与排名迁移 |
| 敏感性 | 一键对当前快照跑参数变体（窗口 7/30/90 天、剔除直访/自然流量、时间衰减半衰期 24/168/720 小时、关闭直访回退），展示份额区间、排名翻转、变体参数表与矩阵 |
| 数据质量 | 重复事件/转化样本、迟到转化样本与金额、身份合并与跨设备统计、结果校验入口 |
| 导出与权限 | 按角色开放 CSV（渠道/转化/路径/无法归因）、JSON、审计日志；权限矩阵与审计流水 |

图表均提供表格视图，颜色只用于序列身份，数值与标签使用文本色；深色模式由 `data-theme` 与 `prefers-color-scheme` 共同驱动。

## 导出

| 能力 | viewer | analyst | admin |
| --- | --- | --- | --- |
| CSV（4 种视图） | — | ✓ | ✓ |
| JSON（完整运行） | — | — | ✓ |
| 审计日志 CSV | — | — | ✓ |
| 新建快照 / 运行 | — | ✓ | ✓ |

CSV 文件头包含 `run_id / snapshot_id / snapshot_hash / model / engine_version / param_hash / result_hash / refund_policy / params` 等元数据行，导出动作写入审计日志。

## API

所有 `/api/*` 数据接口都需要会话 Cookie（`POST /api/session` 获取）。响应带 CSP、`X-Content-Type-Options` 等安全头。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/me` | 当前用户、角色能力与演示用户列表 |
| `POST` | `/api/session` | `{user_id}` 登录，返回 HttpOnly Cookie |
| `DELETE` | `/api/session` | 退出 |
| `GET` | `/api/meta` | 模型注册表、退款策略、快照列表、运行列表、权限矩阵（需登录） |
| `POST` | `/api/snapshots` | 上传 payload；按哈希去重 |
| `GET` | `/api/snapshots/:id` | 快照元数据与条数摘要 |
| `POST` | `/api/runs` | 创建运行；同指纹复用 |
| `GET` | `/api/runs/:id` | 运行结果（含 `superseded_by`） |
| `POST` | `/api/runs/:id/verify` | 重算并比对哈希 |
| `GET` | `/api/runs/:id/compare/:otherId` | 贡献迁移 |
| `POST` | `/api/sensitivity` | `{snapshot_id, model_id, model_version, params, refund_policy}` |
| `GET` | `/api/audit` | 最近 300 条审计（任意登录用户可读，导出需管理员） |
| `GET` | `/api/runs/:id/export.csv?view=channels\|conversions\|paths\|unattributed` | CSV 导出 |
| `GET` | `/api/runs/:id/export.json` | 完整运行 JSON（管理员） |
| `GET` | `/api/audit/export.csv` | 审计日志 CSV（管理员） |

示例：

```bash
curl -c jar -H 'content-type: application/json' -d '{"user_id":"u_analyst"}' http://localhost:4173/api/session
curl -b jar http://localhost:4173/api/meta | jq '.runs[].id'
curl -b jar -X POST http://localhost:4173/api/runs \
  -H 'content-type: application/json' \
  -d '{"snapshot_id":"snap_xxx","model_id":"time_decay","model_version":"1.0.0","params":{"lookback_days":14,"half_life_hours":72},"refund_policy":"clawback","label":"双周窗口 · 72h 半衰期"}'
```

## 测试

```bash
npm test                        # 等价于 node --test 'test/*.test.js'
node --test test/attribution.test.js
```

| 文件 | 覆盖 |
| --- | --- |
| `test/attribution.test.js` | 跨设备合并、1.0.0/1.1.0 直访回退、线性均分与转化后触点排除、时间衰减绝对权重、窗口变化、自然流量/直访排除、三种退款策略与净额恒等式、重复去重、迟到转化、无触点、路径压缩、指纹稳定性、迁移守恒、敏感性区间（含缺席渠道取 0）、版本链 |
| `test/api.test.js` | 未登录 401、viewer 403、analyst CSV 可用而 JSON/审计 403、管理员导出与审计落库、运行指纹复用、修订替代不修改旧结果且对比净差为 0、verify 一致、敏感性、非法输入 400/404、快照去重、退出后 401 |
| `test/render.test.js` | DOM 替身加载真实 `app.js`：总览/选择器/六个视图渲染、敏感性按钮触发、无 `innerHTML` 拼接 |
| `test/charts.test.js` | 刻度、条形路径、发散方向、区间图坐标与金额格式化边界 |

测试用 `DATA_DIR`/`DB_PATH` 指向临时目录，不触碰演示数据库。

## 目录

```
src/lib/attribution.js   归因引擎（纯函数：旅程构建、模型、退款、迁移、敏感性、指纹）
src/server/index.js      HTTP 服务与路由
src/server/db.js         SQLite 连接与建表
src/server/auth.js       演示身份、会话、角色能力、审计
src/server/seed-data.js  确定性种子数据（含重复/迟到/脏数据）
src/server/seed.js       重建演示库
src/server/csv.js        RFC4180 CSV 输出
public/                  单页前端（index.html / app.js / ui.js / styles.css）
test/                    node:test 测试
```

## 已知边界

- 演示身份没有密码，会话固定 12 小时；生产接入需替换 `auth.js` 的登录方式。
- 归因是确定性的批处理；没有实时流式接入与增量回填调度。
- 时间衰减使用事件时间到转化时间的固定半衰期，不按渠道分别建模。
- 未做多币种换算：金额按输入原样汇总，混币快照需在接入前统一为 CNY。
