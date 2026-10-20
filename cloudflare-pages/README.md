# 授权激活服务 · Cloudflare Pages（高级模式 `_worker.js`）

> **已部署上线**：<https://totoro-license.pages.dev>
> 项目名 `totoro-license` ｜ KV 命名空间 `totoro-cards`（绑定名 `CARDS`）
> 状态：私钥 ✅ 已加载 ｜ 卡密库 ✅ 已绑定 ｜ 线上激活实测通过

---

## 0. 这是什么

用 Cloudflare Pages 的**高级模式 Worker** 跑激活服务。买家输卡密 → 程序请求本服务 →
服务用私钥现签一张绑定该机器的证书返回。

- **免费**：10 万请求/天、KV 1000 写/天
- **不用电脑常开**、不用租服务器
- 代价：国内访问不稳、延迟 2~4 秒

---

## 1. 为什么是 `_worker.js` 而不是 `functions/`

⚠️ **实测踩坑**：`wrangler pages deploy <dir>` 对 `<dir>/functions/` 目录**不会**编译成
Worker，而是当**静态文件**上传。表现是：

```
GET  /health        → 返回静态页 HTML（不是接口 JSON）
POST /activate      → 405（Pages 静态层拒绝 POST）
```

换成高级模式后日志里出现 `✨ Compiled Worker successfully`，才真正生效：

```
cloudflare-pages/
├── _worker.js     ← 一个文件接管所有请求
└── README.md
```

---

## 2. 部署步骤（重建或迁移时看）

### 2.1 建 KV

Cloudflare → Workers & Pages → KV → Create namespace → `totoro-cards`

### 2.2 建 Pages 项目并绑定

Cloudflare → Workers & Pages → Pages → Create → **Direct Upload**（不是连 Git）
项目名：`totoro-license`

然后 **Settings → Functions → KV namespace bindings**：

| Variable name | KV namespace |
| --- | --- |
| **`CARDS`** | `totoro-cards` |

### 2.3 设两个 Secret

**Settings → Environment variables**（Production 与 Preview 都要设）：

| 变量名 | 值 |
| --- | --- |
| `LICENSE_PEM` | `license-private.pem` 的**完整内容**（三行，含首尾横线） |
| `ADMIN_TOKEN` | ≥24 位随机串，发卡用 |

### 2.4 部署

```bash
npx wrangler pages deploy cloudflare-pages \
  --project-name=totoro-license --branch=main --commit-dirty=true
```

需要环境变量：

```bash
export CLOUDFLARE_API_TOKEN=<有 Pages:Edit 与 Workers KV Storage:Edit 的 token>
export CLOUDFLARE_ACCOUNT_ID=<账号 ID>
```

### 2.5 验证

```bash
curl https://totoro-license.pages.dev/health
```

必须：

```json
{"ok":true,"keyLoaded":true,"kvBound":true,"cardsTotal":0}
```

`keyLoaded` 为 false → `LICENSE_PEM` 没设对
`kvBound` 为 false → KV 没绑或变量名不是 `CARDS`

---

## 3. 发卡

```powershell
$URL   = "https://totoro-license.pages.dev"
$TOKEN = "你的 ADMIN_TOKEN"

Invoke-RestMethod -Method Post -Uri "$URL/admin/cards" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body '{"count":50,"days":365,"sub":"闲鱼订单"}'
```

```powershell
# 查库存
Invoke-RestMethod -Uri "$URL/admin/cards?limit=100" -Headers @{ Authorization = "Bearer $TOKEN" }
```

> ⚠️ **KV 是最终一致性**：刚发的卡**最多 60 秒后**才会出现在库存列表里。
> 这不影响激活（按 key 读是准的），只是列表有延迟。

---

## 4. 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 无 | 状态页（私钥/KV 是否就绪） |
| GET | `/health` | 无 | 健康检查 JSON |
| POST | `/activate` | 无 | `{card, machineCode}` → `{ok, certificate, lic, exp, grace}` |
| POST | `/admin/cards` | Bearer | `{count, days, sub}` → 批量发卡 |
| GET | `/admin/cards` | Bearer | 库存与使用明细 |

错误码：`400` 参数错 / `401` 管理密钥错 / `404` 卡密不存在 /
`409` 卡密已使用 / `500` 服务端异常（含未绑 KV、台账写失败）。

---

## 5. 额度与限制

| 项目 | 免费上限 | 实际影响 |
| --- | --- | --- |
| 请求 | 10 万次/天 | 一次激活 = 1 次 |
| KV 写入 | **1000 次/天** | **一天最多 1000 单** |
| KV 读取 | 10 万次/天 | 一次激活 = 1~2 次 |
| 存储 | 1 GB | 一张卡约 200 字节 |

---

## 6. ⚠️ 上线前必须测国内可达性

`*.pages.dev` 在国内**时通时不通**。找 3~5 个不同地区/运营商的朋友，
用**手机流量**打开 `/health`，全部能开才敢卖。

大面积不通时换方案：
- 有预算 → 云服务器（`../tools/activation-server/`，同一个 Node 版实现）
- 没预算 → 花生壳内网穿透（`../tools/activation-server/README.md` §4.5）

---

## 7. 安全

- 私钥在 Cloudflare 加密 Secret 里 —— 能签发就必然持有私钥，这是固有代价
- **Cloudflare 账号务必开两步验证**（账号被盗 = 签发权被盗）
- `ADMIN_TOKEN` 别写进代码或群里
- Token 权限最小化：只需要 `Cloudflare Pages: Edit` + `Workers KV Storage: Edit`
- 用完可随时在 API Tokens 页面删除 token

---

## 8. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/health` 返回 HTML | `_worker.js` 没生效（可能在用 `functions/`） | 用 `_worker.js` 高级模式重新部署，看日志有没有 `Compiled Worker successfully` |
| `POST /activate` 返回 405 | 同上 | 同上 |
| `keyLoaded:false` | `LICENSE_PEM` 没设/不完整 | 重新粘，含 `-----BEGIN PRIVATE KEY-----` 与结尾横线 |
| `kvBound:false` | KV 没绑或变量名不是 `CARDS` | Settings → Functions → KV 绑定 |
| 发卡 401 | `ADMIN_TOKEN` 不匹配 | 检查 Bearer 后的值，前后无空格 |
| 激活 500「未绑定 KV」 | 同上 | 绑 KV |
| 激活 500「台账写入失败」 | 当天 KV 写入超 1000 | 次日恢复，或换服务器方案 |
| 库存列表空 | KV 最终一致性 | 等 60 秒再查 |
| 客户端「无法连接激活服务器」 | 国内访问不通 | 见第 6 节 |
---

## 9. 有效期与离线宽限

发卡时用 `days` 指定有效期，签发时再自动加一段**离线宽限**：

| 字段 | 含义 | 由谁决定 |
| --- | --- | --- |
| `exp` | 正常到期 | 发卡时的 `days` |
| `grace` | 宽限截止（= `exp` + **12 小时**） | Worker 里的 `GRACE_S` |

- 宽限期内仍可使用，界面提示「宽限期，请尽快续期」；
- 超过 `grace` + 1 小时（时钟容差）⇒ 判定 `grace_expired`，停止服务。

⚠️ `grace` 写在**证书里**，改 `GRACE_S` 只影响**之后新激活**的证书，
已签发的证书仍按原值走。

---

## 10. 时钟回拨防护

客户端会记录「历史见过的最晚时间」（存在 `license.json` 里，带 HMAC 校验码），
判定有效期时用 `max(当前时钟, 历史最大)`：

- 把系统时间调回去 ⇒ 累计时间不倒退，到期照常触发；
- 回拨超过 24 小时 ⇒ 直接判定为改时间并拒绝使用（结果码 `clock_rollback`）。

这是**客户端**逻辑（`utils/mp/clockGuard.ts`），与激活服务无关；
服务端只负责在签发时写入正确的 `iat` / `exp` / `grace`。

> 想彻底防住只能靠在线校验（每次启动问服务器）。离线授权的上限就是这样。
---

## 11. 撞库防护（限流）

`/activate` 是唯一能探测「某张卡密是否存在」的接口，已加两层限流：

| 限制 | 阈值 | 目的 |
| --- | --- | --- |
| 每 IP 每分钟请求数 | 20 次 | 挡住原始洪泛 |
| 每 IP 每 10 分钟**失败**次数 | 6 次 | 挡住稳定爆破 |

超限返回 **HTTP 429**：

```json
{ "ok": false, "error": "尝试失败次数过多，请 10 分钟后再试；卡密可向店铺客服核对" }
```

**计数走 Cache API，不占 KV 写入额度** —— 这一点很关键：KV 免费档只有 1000 写/天，
若用 KV 记失败次数，攻击者一天就能打光配额，让所有正常买家激活失败。
Cache API 异常时降级到进程内计数（只在本 isolate 有效）。

卡密空间 32^8 ≈ 1.1 万亿，配合上面的阈值，爆破在数学上不可行。
### 全站熔断（硬上限）

单 IP 限流挡不住"换一大把代理 IP"。再叠一层**全局**上限：

| 条件 | 动作 |
| --- | --- |
| 任一数据中心 1 小时内累计失败 ≥ **100** 次 | 写 KV 熔断标记 → **所有 IP** 的 `/activate` 返回 **503**，持续 1 小时后自动恢复 |

**手动解除**（卖家自己放行，比如误触发）：

```powershell
Invoke-RestMethod -Method Post -Uri "https://totoro-license.pages.dev/admin/unblock" `
  -Headers @{ Authorization = "Bearer <管理密钥>" }
```

**为什么熔断标记才写 KV**：KV 每日只有 1000 次写入。失败计数走 Cache API（不占配额），
只有触发熔断那一刻才写 1 次 KV ⇒ 最多 1 次写入/小时，不会把配额打光。

> 注意：熔断期间**正常买家也激活不了**。这是"宁可停服也不让撞库成功"的取舍；
> 阈值 100 次/小时远高于正常业务量（正常一小时 0~2 次失败）。