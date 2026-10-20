# 授权激活服务 · Cloudflare Pages 版（零成本）

> 用 Cloudflare Pages Functions 跑激活服务。**不用买服务器、不用电脑常开、永久免费**。
> 代价：国内访问**不稳定**、延迟 2~4 秒、KV 每天 1000 次写入上限。

---

## 0. 和另外两种方案的对比

| | Cloudflare Pages（本方案） | 云服务器 | 花生壳内网穿透 |
| --- | --- | --- | --- |
| 花钱 | **0 元** | ¥30~60/月 | 0 元 |
| 要电脑常开 | ❌ 不用 | ❌ 不用 | ✅ 必须 7×24 |
| 延迟 | **2~4 秒** | < 1 秒 | 看家宽 |
| 稳定性 | ⚠️ 国内时通时不通 | ✅ 最稳 | ⚠️ 断电断网就挂 |
| 部署难度 | 中（要连 GitHub） | 中 | 中（要装客户端） |
| 额度 | 10 万请求/天、KV 1000 写/天 | 无限 | 1GB 流量/月 |

**建议**：先用这个验证能不能卖动；量起来后搬去云服务器（同一个功能的 Node 版在 `../activation-server/`）。

---

## 1. 免费额度（够不够）

| 项目 | 免费上限 | 我们怎么用 |
| --- | --- | --- |
| 请求次数 | 10 万次/天 | 一次激活 = 1 次 |
| KV 读取 | 10 万次/天 | 一次激活 = 1~2 次 |
| **KV 写入** | **1000 次/天** | 一次激活 = 1 次写 ⇒ **一天最多 1000 单** |
| 存储 | 1 GB | 一张卡记录约 200 字节，能存 500 万张 |

> 1000 单/天对起步完全够；真到那个量级，收入足够买服务器了。

---

## 2. 部署步骤

### 2.1 准备一个 GitHub 仓库

新建一个仓库（公开/私有都行），把本目录下的两个文件传进去：

```
index.html
functions/[[path]].js
```

结构必须是这样：

```
你的仓库/
├── index.html
└── functions/
    └── [[path]].js
```

### 2.2 建 Pages 项目

1. 打开 <https://dash.cloudflare.com/> → 注册/登录（免费，**不用绑卡**）
2. 左侧 **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 选你刚建的仓库 → **Begin setup**
4. 构建配置这里关键：

| 字段 | 填什么 |
| --- | --- |
| Framework preset | **None** |
| Build command | **留空**（什么都不填） |
| Build output directory | **留空**或填 `/` |

5. **Save and Deploy**

部署完成后会给你一个地址，形如：

```
https://你的项目名.pages.dev
```

### 2.3 建 KV 命名空间（存卡密用）

1. Cloudflare 左侧 **Workers & Pages** → **KV**
2. **Create a namespace** → 名字填 `totoro-cards` → Create
3. 回到你的 Pages 项目 → **Settings** → **Functions** → **KV namespace bindings**
4. **Add binding**：
   - Variable name：**`CARDS`**（必须一字不差）
   - KV namespace：选刚建的 `totoro-cards`
5. **Save**

### 2.4 设两个 Secret（私钥 + 管理密钥）

Pages 项目 → **Settings** → **Environment variables** → 在 **Production** 下逐个添加，
**类型选 Secret（加密）**：

| 变量名 | 值 |
| --- | --- |
| `LICENSE_PEM` | 你的 `license-private.pem` **文件的全部内容**（含 `-----BEGIN PRIVATE KEY-----` 那两行） |
| `ADMIN_TOKEN` | 自己定一个 ≥24 位的随机串，例如用 <https://www.random.org/strings/> 生成 |

> `LICENSE_PEM` 怎么填：用记事本打开 `license-private.pem`，**全选 → 复制 → 整段粘进去**。
> 三行内容，一个字都不能漏。

加完点 **Save**，然后**重新部署一次**让变量生效：
Deployments → 最新那次 → 右上角「⋯」→ **Retry deployment**

### 2.5 验证

浏览器打开：

```
https://你的项目名.pages.dev/health
```

必须看到：

```json
{"ok":true,"keyLoaded":true,"cardsTotal":0,"kvBound":true,...}
```

| 字段 | 含义 |
| --- | --- |
| `keyLoaded: true` | 私钥读到了 ✅ 能签发 |
| `kvBound: true` | KV 绑好了 ✅ 能记卡密 |

**两个都是 true 才算部署成功。** 有 false 的回去检查 2.3 / 2.4。

---

## 3. 发卡

在你自己电脑上（PowerShell 里执行）：

```powershell
$URL   = "https://你的项目名.pages.dev"
$TOKEN = "你的 ADMIN_TOKEN"

Invoke-RestMethod -Method Post -Uri "$URL/admin/cards" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body '{"count":50,"days":365,"sub":"闲鱼订单"}'
```

返回 50 张卡密：

```json
{"ok":true,"count":50,"days":365,"cards":["TH-A8TW-G2RD","TH-K8AR-NJKM", ...]}
```

把这些卡密填进店铺的自动发货内容（一条一张）。

**查库存**：

```powershell
Invoke-RestMethod -Uri "$URL/admin/cards?limit=50" -Headers @{ Authorization = "Bearer $TOKEN" }
```

返回 `total` / `unusedCount` / `usedCount` 和明细（哪张卡在哪个机器码上用的）。

---

## 4. 把地址填进程序

改 `server/utils/license/activation.ts`：

```ts
export const ACTIVATION_URL_BUILTIN = 'https://你的项目名.pages.dev'
```

然后 `npm run sea` 重新打包 EXE。

---

## 5. 买家侧体验

```
下单 → 收到卡密
  ↓
双击 exe → 授权页 → 「输入卡密激活」→ 填卡密 → 点激活
  ↓
等 2~4 秒（Cloudflare 从国内访问偏慢）
  ↓
顶栏「已授权 · 365 天」→ 之后完全离线可用
```

---

## 6. ⚠️ 必须先做的一件事：测国内可达性

`*.pages.dev` **在国内时通时不通**（Cloudflare 的 IP 被干扰过好几轮）。

**上架前务必测试**：找 3~5 个不同地区/不同运营商的朋友，用手机流量打开：

```
https://你的项目名.pages.dev/health
```

**全部都能打开**才敢卖。有一个打不开，那批买家就激活不了。

如果国内大面积不通 → 换方案：
- 有预算：买云服务器（`../activation-server/README.md`）
- 没预算：花生壳内网穿透（同目录 §4.5）

---

## 7. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/health` 返回 404 | `functions/[[path]].js` 路径放错了 | 必须放在仓库根的 `functions/` 下 |
| `keyLoaded: false` | `LICENSE_PEM` 没设或粘贴不全 | 重新粘一遍，包含首尾两行横线 |
| `kvBound: false` | KV 没绑或变量名不是 `CARDS` | Settings → Functions → KV 绑定，名字必须 `CARDS` |
| 发卡返回 401 | `ADMIN_TOKEN` 对不上 | 检查 Bearer 后的字符串，前后别带空格 |
| 发卡返回 500「未绑定 KV」 | 同上 | 绑 KV |
| 激活返回 404「卡密不存在」 | 卡密没发出去 / 输错 | 先 `/admin/cards` 查库存 |
| 激活返回 500「台账写入失败」 | KV 当天写入超 1000 次 | 第二天恢复；或换云服务器方案 |
| 客户端提示「无法连接激活服务器」 | 国内访问不通 | 见第 6 节 |

---

## 8. 安全提醒

- **私钥放在 Cloudflare** 的加密 Secret 里 —— 这是"服务端能签发"的固有代价
- `ADMIN_TOKEN` 别写进代码、别发群里
- Cloudflare 账号开**两步验证**（免费）—— 账号被盗 = 签发权被盗
- 卡密台账存在 KV 里，**定期导出备份**（丢失已用记录 = 卡密可被重复使用）
