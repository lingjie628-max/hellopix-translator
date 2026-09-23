# USDT-TRC20 自动充值结算 · 现状审计报告

> 版本：RC-02 前置审计
> 日期：2026-09-23
> 范围：**只审计现状，不含任何实现**。所有结论均来自生产库与代码实测，标注了文件与行号。
> 本轮不做：私钥保存、自动提现、自动转账、以及充值以外的任何功能。

---

## 0. 先说结论：两个硬约束会直接卡住你的尾数方案

你的规则是「标准价 35.000 USDT，实际应付随机成 35.427」。但在生产库上实测：

| 阻碍 | 实际定义（生产库实测） | 后果 |
| --- | --- | --- |
| **金额精度不够** | `paid_amount numeric(14,2)` | `35.427` 会被存成 **`35.43`** —— 尾数直接被抹掉 |
| **CHECK 禁止加价** | `recharges_check1: CHECK (paid_amount <= original_amount)` | 应付 35.427 > 原价 35.000，**INSERT 直接被拒** |
| **CHECK 锁定等式** | `recharges_check2: CHECK ((original_amount - discount_amount) = paid_amount)` | 尾数加在 paid 上就破坏等式；加在 original 上则污染原价 |
| **没有过期时间** | `recharges` 表**没有** `expires_at` 列 | 你的「交易时间与订单有效期匹配」这一条无法判定 |
| **没有地址快照** | `recharges` 表**没有**收款地址列 | 管理员换地址后，历史订单无法核对"当时该转到哪" |

实测：

```
SELECT 35.427::numeric(14,2), 35.427::numeric(14,3);
 rounded_to_2dp | exact_3dp
          35.43 |    35.427
```

**这五条必须先解决，否则写多少代码都存不进库。** 详见第 7 节。

---

## 1. 现在充值相关有哪些表

| 表 | 用途 | 与充值的关系 |
| --- | --- | --- |
| `recharges` | **充值订单主表** | 核心。见下方字段清单 |
| `character_transfers` | 主账号 → 子账号 划转 | **不是**充值的字符流水，只记划转 |
| `translate_logs` | 翻译消耗明细 | 消耗侧 |
| `app_settings` | 配置（`payment.channels` / `billing.*`） | 收款地址存这里 |
| `audit_logs` | 超管操作审计 | `admin_id` 有外键指向 `admins` —— **商户侧写不进去** |
| `orders` | 计数工单系统 | **与本轮无关**，是另一条业务线 |

### `recharges` 字段（生产库实测）

```
id, user_id, package_id, order_number(UNIQUE), kind(package|characters|manual),
payment_type, quantity, chars, original_amount numeric(14,2),
discount_amount numeric(14,2), paid_amount numeric(14,2),
status smallint CHECK IN (0,1,2,3),
provider_transaction_id varchar(160), idempotency_key(UNIQUE),
paid_at, created_at, updated_at
```

索引：
```
recharges_pkey                    UNIQUE (id)
recharges_order_number_key        UNIQUE (order_number)
recharges_idempotency_key_key     UNIQUE (idempotency_key)
recharges_provider_tx_uidx        UNIQUE (payment_type, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL
recharges_user_created_idx        (user_id, created_at DESC)
recharges_status_created_idx      (status, created_at)
```

### 缺什么

- ❌ 链上交易表（TXID / 区块 / 确认数 / from / to / 合约）
- ❌ 字符总账（主账号充值的字符流水）—— 只有主→子划转有流水
- ❌ 异常池
- ❌ 订单收款地址快照、代币合约快照、过期时间
- ❌ 链扫描游标

---

## 2. 当前订单状态机

```sql
status smallint NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2, 3))
```

| 值 | 含义 | 谁写入 |
| --- | --- | --- |
| `0` | 未支付 | `/userRecharge/create` 唯一初始值 |
| `1` | 已支付 | `/admin/recharges/status`（超管手点）、`/admin/translate/grant`（直接插 status=1） |
| `2` | **无定义** | **全库无任何代码写入或读取** |
| `3` | **无定义** | **全库无任何代码写入或读取** |

**2 和 3 是在 CHECK 里声明了但从未使用的死状态。** 前端 `AdminRecharges.vue` 也只认 0 和 1（`status === 1 ? '已支付' : '未支付'`）。

**当前唯一的迁移路径是 `0 → 1`，且只能由超管手工触发。** 没有过期、取消、异常、退款等状态。

---

## 3. TRC20 收款地址配置在哪里

**存储**：`app_settings['payment.channels']`（jsonb 数组）

**默认值**（`production.js:1303`）：
```js
PAYMENT_DEFAULTS = [{ id:'usdt-trc20', name:'USDT', network:'TRC20', address:'', note:'', enabled:0 }]
```

**读**：`readSettings()` @ `production.js:1307`
- 合并默认值，保证新增字段能补上
- 地址过 `normalizeTronAddress()`
- 前端拿到的渠道 = 这个函数的输出

**写**：`POST /admin/settings/save`，`paymentChannels` 分支 @ `production.js:1405`
- `normalizeTronAddress` + `validTronAddress` **强制校验**，校验和不匹配直接 400 `BAD_PAYMENT_ADDRESS`
- 启用但没填地址 → 400 `PAYMENT_ADDRESS_REQUIRED`

**下单时**（`production.js:178`）：
```js
const channels = (await readSettings()).paymentChannels.filter(item => item.enabled && item.address)
if (!channels.length) throw new ApiError(503, '收款方式尚未配置', 'PAYMENT_NOT_CONFIGURED')
```
只把地址**返回给前端展示**，**没有写进订单**。

> ⚠️ **缺口**：订单不存地址快照。管理员之后改了收款地址，历史待支付订单就再也无法回答"这单当时该转到哪个地址"。而这恰恰是你要求的第一条校验（"收款地址正确"）。

---

## 4. 是否已有 TRON 查询 / 监听代码

**完全没有。**

全库搜索 `tronscan|tronweb|tron_api|txid|tx_hash|confirmations|solidified|block_number|chainwatcher|watcher`：

```
server/routes/production.js:824   ← 只有这里，且只是接收管理员手填的 txId 字符串
server/routes/production.js:839   ← 查重
server/routes/production.js:851   ← 存库
```

唯一与 TRON 有关的代码是 `server/lib/tron-address.js`（61 行）：

```js
module.exports = { validTronAddress, normalizeTronAddress, base58Decode }
```

纯 Base58Check 地址校验，**不发任何网络请求**。

### 缺什么

- ❌ 没有 USDT 合约地址常量（TRC20 USDT = `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`）
- ❌ 没有链 API 客户端
- ❌ 没有服务端出网白名单 —— `PIX_ALLOWED_API_HOSTS` 是 **Electron 客户端**用的，服务端 `config.js` 里没有对应机制
- ❌ 没有区块游标、没有扫描任务

### 需要你定的两件事

1. **链数据源**：TronGrid（官方，免费额度够用，需 API Key）／ Tronscan API ／ 自建 Tron 全节点（最贵也最可靠）
2. **确认条件**：TRON 的最终性是 `solidified`（约 19 块 ≈ 57 秒）。是「1 个确认就入账」还是「等 solidified」？我建议后者，但延迟约 1 分钟

---

## 5. 当前字符发放入口在哪里

**唯一的原子入口**：`repo.adjustChars(client, kind, id, delta)` @ `production-repository.js:388`

```js
UPDATE ${table} SET char_balance=char_balance+$2,updated_at=NOW()
WHERE id=$1 AND char_balance+$2>=0 RETURNING *
// 无返回行 → throw ApiError(409, '字符余额不足', 'INSUFFICIENT_CHARS')
```

原子、带余额守卫，**可以直接复用**。

**调用点共 3 处**（全部内联在路由里，没有服务层）：

| 位置 | 场景 |
| --- | --- |
| `production.js:847` | `/admin/recharges/status` —— 超管确认收款 |
| `production.js:872` | `/admin/translate/grant` —— 后台直接送字符 |
| `production.js:212/215` | `/team/subs/chars` —— 主账号划给子账号 |

> ⚠️ **缺口**：`character_transfers` 只记「主 → 子」划转。**主账号充值到账的字符没有独立流水**，只有 `recharges` 一条订单记录。你要求的"写字符流水"目前没有落点。

---

## 6. 哪些现有代码可以复用

### 直接复用（高价值）

| 资产 | 位置 | 复用方式 |
| --- | --- | --- |
| **TXID 唯一索引** | `recharges_provider_tx_uidx` | **数据库层已经保证 TXID 不重复**，直接依赖它兜底 |
| **结算骨架** | `/admin/recharges/status` @ `production.js:820` | FOR UPDATE 锁单 → 幂等短路 → TXID 查重 → adjustChars → UPDATE → audit —— **这就是 SettlementService 的雏形，抽出来即可** |
| `repo.adjustChars` | `production-repository.js:388` | 直接调用 |
| `repo.transaction` / `repo.audit` | 仓储层 | 直接调用 |
| `normalizeTronAddress` / `validTronAddress` | `lib/tron-address.js` | 校验订单快照地址与链上 to 地址 |
| **幂等任务范式** | `scripts/maintenance.js --apply` | 定时补扫照这个写：默认真跑干跑、`--apply` 才落库 |
| **定时任务挂载点** | `/etc/cron.d/hello-pix-ops` | 已有 3 条任务，加第 4 条即可，不用新建 systemd timer |
| **告警通道** | `scripts/alert.js` | 异常池积压要发告警 |

### 现有 `/admin/recharges/status` 的结算流程（要抽成服务）

```js
repo.transaction(async client => {
  SELECT * FROM recharges WHERE id=$1 FOR UPDATE        // ① 锁单
  if (status === 1) return { alreadyPaid: true }         // ② 幂等短路
  SELECT order_number FROM recharges
    WHERE payment_type=$1 AND provider_transaction_id=$2 AND id<>$3   // ③ TXID 查重
    → 有则 409 TX_ALREADY_USED
  repo.adjustChars(client, 'main', userId, chars)        // ④ 发放
  UPDATE recharges SET status=1, paid_at=NOW(), provider_transaction_id=...  // ⑤ 置状态
  repo.audit(...)                                        // ⑥ 审计
})
```

**这套逻辑本身是对的**，问题在于它是路由内联的、只认「超管手点」、且缺少链上字段校验。RC-02 要做的就是把它提成 `RechargeSettlementService`，让链监听器、人工补单、用户「我已付款」三个入口共用。

---

## 7. 需要新增什么

### 7.1 Migration（020 起，当前最新是 019）

| # | 内容 |
| --- | --- |
| `020_recharge_amount_precision` | 三个金额列 `numeric(14,2)` → `numeric(14,3)`；**删除** `recharges_check1`（`paid<=original`）与 `recharges_check2`（等式）；**新增** `paid_amount = original_amount - discount_amount + surcharge` 且 `surcharge BETWEEN 0.001 AND 0.999`。`original_amount` 保持**标准价不被污染** |
| `021_recharge_chain_fields` | `recharges` 加 `pay_address`（快照）、`pay_token_contract`（快照）、`expires_at`、`chain_tx_id`、`chain_seen_at`、`confirmations`、`block_number`、`from_address` |
| `022_chain_transactions` | 新表：`tx_id` UNIQUE、`to_address`、`from_address`、`token_contract`、`amount_milli`、`block_number`、`confirmations`、`raw`、`seen_at`。**链上事实的唯一锚点** |
| `023_char_ledger` | 新表：主账号字符总账（`user_id`、`delta`、`balance_after`、`reason`、`reference_type`、`reference_id`、`idempotency_key` UNIQUE） |
| `024_recharge_exceptions` | 异常池：`kind`（少付/多付/错代币/错地址/过期/无法匹配/重复付款/重复 TXID）、`tx_id`、`payload`、`status`、`resolved_by`、`resolved_at` |
| `025_recharge_suffix_guard` | 唯一索引 `(pay_address, paid_amount) WHERE status = 0` —— **尾数唯一性的数据库兜底** |
| `026_chain_scan_cursor` | 扫描游标：`address`、`last_block`、`updated_at` |

> 全部只增不改历史数据。`020` 改精度是 `ALTER COLUMN TYPE`，PostgreSQL 会重写表；当前 `recharges` 只有 0 行，代价为零。

### 7.2 Service

| 文件 | 职责 |
| --- | --- |
| `server/services/recharge-settlement-service.js` | **唯一结算核心**。入口：`settleFromChain(tx)` / `settleManual(orderId, admin)` / `claimPaid(orderId, userId, txId)`。内部：锁单 → 校验 → TXID 唯一 → pending→paid → 发放字符 → 充值流水 → 字符流水 → 审计 → commit |
| `server/services/tron-chain-service.js` | 链 API 客户端：按地址查 TRC20 转账、解码 TRC20 `transfer` 事件、读确认数。**只读，不发交易** |
| `server/services/recharge-suffix-service.js` | 尾数生成：整数运算（milli-USDT），冲突重随机，**绝不 +1**，池满抛 `SUFFIX_POOL_EXHAUSTED` |

### 7.3 Worker

| 文件 | 职责 |
| --- | --- |
| `scripts/recharge-watcher.js` | 定时扫描：读游标 → 拉新区块 → 解 TRC20 转账 → 交给 SettlementService。**自己不碰余额** |
| `scripts/recharge-rescan.js` | 补扫：从 `cursor - N` 重扫，防链 API 故障或服务重启漏单。靠 TXID 幂等去重 |
| `deploy/cron.d/hello-pix-ops` 追加 | 每 1 分钟扫描 + 每 10 分钟补扫 |

### 7.4 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/userRecharge/create` | **改造**：走 suffix-service，写地址与合约快照，写 `expires_at` |
| `POST` | `/userRecharge/claimPaid` | 新增：用户填 TXID 声明已付 → 复用结算核心 |
| `GET` | `/userRecharge/status` | 新增：查订单当前状态（前端轮询用） |
| `GET` | `/admin/recharge-exceptions` | 新增：异常池列表 |
| `POST` | `/admin/recharge-exceptions/:id/resolve` | 新增：人工处理异常 |
| `POST` | `/admin/recharges/status` | **改造**：改为调用结算核心，保留手工补单能力 |

### 7.5 测试

| 文件 | 覆盖 |
| --- | --- |
| `test/recharge-suffix.test.js` | 整数运算无浮点误差、001–999 范围、000 永不出现、**冲突重随机而非 +1**、池满报错 |
| `test/recharge-settlement.test.js` | 幂等（同 TXID 两次只发一次）、锁单、非 pending 拒绝、TXID 冲突、并发、失败整体回滚 |
| `test/tron-chain-service.test.js` | TRC20 事件解码、合约过滤、确认数判定、异常应答处理（用固定 fixture，不打真实网络） |
| `test/recharge-watcher.test.js` | 重复扫描不重复入账、游标推进、补扫去重 |
| `test/recharge-exceptions.test.js` | 八类异常全部进池且不入账 |

---

## 8. 唯一性与幂等：具体怎么保证

### 8.1 随机尾数唯一

**不用「先查再插」—— 那有竞态。** 三层保证：

```js
// ① 全程整数，不碰浮点
const baseMilli = Math.round(standardPrice * 1000)   // 35.000 → 35000

// ② 随机尾数 001–999（000 排除）
const suffix = crypto.randomInt(1, 1000)             // 1..999，绝不用 +1 递增

// ③ 唯一索引兜底，冲突就重随机
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    INSERT ... paid_amount = (baseMilli + suffix) / 1000
    return
  } catch (e) {
    if (e.code === '23505' && isSuffixConflict(e)) { suffix = crypto.randomInt(1, 1000); continue }
    throw e
  }
}
throw new ApiError(503, '当前待支付订单过多，请稍后重试', 'SUFFIX_POOL_EXHAUSTED')
```

唯一索引：
```sql
CREATE UNIQUE INDEX recharges_amount_uq
  ON recharges (pay_address, paid_amount) WHERE status = 0;
```

**关键点**：
- 冲突重随机，**不是 +1**（+1 会让尾数可预测，也违背你的规则）
- 0.001 精度以整数承载（milli-USDT），`35.427 → 35427`
- 原来 `crypto.randomInt(1,100)/100`（2 位小数）+ `Math.round(x*100)/100`（浮点）**全部废弃**
- **顺带修掉一个真 bug**：现有代码重试 200 次失败后会静默退回 `suffix = 0`，即应付金额 = 标准价，**不再唯一**。新方案直接抛错，不静默降级

### 8.2 TXID 唯一

**两层**：

1. `chain_transactions.tx_id UNIQUE` —— 链上事实的唯一锚点
2. `recharges_provider_tx_uidx` —— 已有，保留作第二道防线

结算时：
```sql
INSERT INTO chain_transactions (tx_id, ...) VALUES (...)
ON CONFLICT (tx_id) DO NOTHING RETURNING id
```
返回 0 行 = 这笔交易已被处理过 → **短路返回「已处理」，不报错、不入账**。

### 8.3 重复扫描不重复入账

**幂等锚点是 TXID，不是订单号，也不是扫描时间。**

```
ChainWatcher（可能重复扫到同一笔）
      ↓
SettlementService.settleFromChain(tx)
      ↓
BEGIN
  SELECT * FROM recharges WHERE id=$1 FOR UPDATE     -- 锁单，串行化并发
  校验：地址 / 合约 / 金额 / 确认数 / status=pending / 未过期
  INSERT chain_transactions ... ON CONFLICT DO NOTHING
    └─ 0 行 → 已处理过 → COMMIT 并返回 alreadySettled
  UPDATE recharges SET status=1, chain_tx_id=...
  adjustChars + char_ledger
  audit_logs
COMMIT
```

**为什么这样就不会重复入账：**
- 同一笔交易扫到 N 次 → `chain_transactions` 冲突 N-1 次，全部短路
- 同一订单被两个入口同时结算（链监听 + 用户点「我已付款」）→ `FOR UPDATE` 把并发串行化，第二个进来看到 `status=1` 直接返回
- 任何一步失败 → 整个事务回滚，包括 `chain_transactions` 的插入，下次扫描可以重来

**补扫机制**：
- `chain_scan_cursor` 记 `(address, last_block)`
- 每 1 分钟：从 `last_block` 扫到最新
- 每 10 分钟：从 `last_block - N` 重扫一遍（覆盖链 API 故障、服务重启、短暂分叉）
- 因为 TXID 幂等，**重扫是安全的**，不需要额外的"已扫过"标记

---

## 9. 需要你拍板的五件事

| # | 问题 | 我的建议 |
| --- | --- | --- |
| 1 | 链数据源：TronGrid / Tronscan / 自建节点 | **TronGrid + API Key**。免费额度足够，官方维护 |
| 2 | 确认条件：1 确认 vs solidified（约 19 块 ≈ 57 秒） | **solidified**。多等 1 分钟换掉分叉回滚风险 |
| 3 | 订单有效期多久？ | **30 分钟**。太短用户来不及转，太长尾数池被占满 |
| 4 | 金额精度改造：`numeric(14,3)` vs 存整数 milli-USDT | **`numeric(14,3)`**。改动小，且 DB 仍可直接读 |
| 5 | 异常池要不要发邮件告警？ | **要**，走已接通的 Resend。少付/多付不告警等于丢钱没人知道 |

---

## 10. 明确不做（与你的要求一致）

- ❌ 服务器不保存钱包私钥
- ❌ 不做自动提现
- ❌ 不做自动转账
- ❌ 链监听器**不直接改余额** —— 只能通过 `RechargeSettlementService`
- ❌ 本轮不顺手加任何充值以外的功能

---

## 附：审计依据

所有结论来自以下实测，不是推测：

- 生产库 `information_schema.columns` / `pg_constraint` / `pg_indexes` 实查
- `SELECT 35.427::numeric(14,2)` 实测精度截断
- `migrations/001_initial_schema.js:219` `recharges` 建表语句
- `migrations/003_support_core_api.js:51` `character_transfers` 建表语句
- `server/routes/production.js:167` `/userRecharge/create`
- `server/routes/production.js:820` `/admin/recharges/status`
- `server/routes/production.js:1303-1345` `PAYMENT_DEFAULTS` / `readSettings`
- `server/repositories/production-repository.js:388` `adjustChars`
- `server/lib/tron-address.js` 全文
- 全库 grep `tronscan|tronweb|txid|confirmations|watcher` → 零命中
- `/etc/cron.d/hello-pix-ops` 实查
