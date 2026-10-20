# 在线激活服务 · 部署与使用

> 目的：让买家**付款后立刻收到卡密**（自动发货），在程序里输一次就**自动激活**（自动激活）。
> 本服务收到「卡密 + 机器码」，验卡密未用过，用私钥**现签**一张绑定该机器的证书返回。

---

## 0. 它解决的核心矛盾

```
证书必须绑机器码
机器码要等买家运行程序才知道
⇒ 付款那一刻发不出证书
```

所以拆成两步：

```
付款  → 店铺自动发「卡密」（卡密可预生成，与机器码无关）
激活  → 程序把「卡密 + 本机机器码」发给本服务
      → 本服务签发一张绑定该机器的证书
      → 程序本地验签后落盘，激活完成
```

---

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | **18 或更高**（用了 `fetch`/`AbortSignal.timeout`） |
| 一台服务器 | **国内云服务器最稳**（阿里云/腾讯云轻量，最低配即可） |
| 依赖 | **零依赖**，不需要 `npm install` |
| 内存 | 几十 MB 足够 |

> ⚠️ **不要用 Cloudflare Workers / Vercel 这类境外免费服务做主选**：
> 国内买家访问 `*.workers.dev` 经常不通，激活会失败。
> 如果确实想用，请绑定自己的域名并实测线路。

---

## 1.5 最快部署（用脚本，别手打命令）

### 租什么

| 项目 | 建议 |
| --- | --- |
| 厂商 | 阿里云 / 腾讯云轻量应用服务器（都行） |
| 配置 | **最低配就够**（1 核 1G，够几万次激活） |
| 系统 | Ubuntu 22.04 或 Debian 12（Linux 最省事）；也可用 Windows Server |
| 必须 | **带公网 IP** |
| 不需要 | 域名、HTTPS 证书（先用 `http://公网IP:8787` 就能跑起来） |
| 成本 | 约 ¥30~60/月 |

### Linux（Ubuntu / Debian）

把 `server.mjs` 和 `license-private.pem` 上传到服务器同一目录，然后：

```bash
sudo bash install-ubuntu.sh
```

脚本会自动完成：装 Node（如缺）→ 建目录 → 私钥 `chmod 600` →
配置 systemd **开机自启** → 生成管理密钥 → 自检 → 打印对外地址和发卡命令。

### Windows 服务器

1. 装 [Node.js LTS](https://nodejs.org/zh-cn/download)（一路下一步）
2. 把 `server.mjs`、`license-private.pem`、`run-windows.ps1` 放同一目录
3. 右键 `run-windows.ps1` →「使用 PowerShell 运行」

脚本会检查 Node 与私钥、生成/复用管理密钥、自动放行本机防火墙、打印访问信息。

### ⚠️ 部署完必须做的两件事

**① 云控制台「安全组」放行 TCP `8787`** —— 不放行，外面永远连不上（这一步最容易忘）。

**② 在你自己的电脑上验证**：

```bash
curl http://<公网IP>:8787/health
```

必须看到 `"keyLoaded":true`。若是 `false`，说明私钥没被读到，签出来的证书全是废的。

## 2. 部署（手工步骤，脚本不好使时看这里）

### 2.1 上传两样东西

```
server.mjs                 ← 本目录下的服务文件
license-private.pem        ← 私钥（签发权！务必只放在服务器上，别的地方不要留副本）
```

放到 `/opt/totoro-activation/` 下。

### 2.2 生成管理密钥

发卡接口靠它保护，**必须设**，随便生成一个长随机串：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

记下来，这是你的 `ADMIN_TOKEN`。

### 2.3 手动试跑一次

```bash
cd /opt/totoro-activation
LICENSE_KEY_FILE=./license-private.pem \
ADMIN_TOKEN=<你生成的串> \
PORT=8787 \
node server.mjs
```

看到下面这样的输出就算成功：

```
  授权激活服务已启动
  监听      : http://0.0.0.0:8787
  私钥指纹  : A1B2C3D4E5F6  ← 记下这个
  台账文件  : /opt/totoro-activation/data/cards.json
```

> 🔑 **私钥指纹要和签发工具显示的一致**，不一致说明服务器上放的是别的私钥，
> 签出来的证书买家全部激活不了。

### 2.4 配成系统服务（开机自启）

`/etc/systemd/system/totoro-activation.service`：

```ini
[Unit]
Description=Totoro License Activation Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/totoro-activation
Environment=LICENSE_KEY_FILE=/opt/totoro-activation/license-private.pem
Environment=ADMIN_TOKEN=换成你的管理密钥
Environment=PORT=8787
Environment=DATA_DIR=/opt/totoro-activation/data
ExecStart=/usr/bin/node /opt/totoro-activation/server.mjs
Restart=always
RestartSec=3

# 私钥只允许 root 读
User=root

[Install]
WantedBy=multi-user.target
```

```bash
chmod 600 /opt/totoro-activation/license-private.pem
systemctl daemon-reload
systemctl enable --now totoro-activation
systemctl status totoro-activation
```

### 2.5 上 HTTPS（强烈建议）

程序里写的是 `https://` 地址最省心。用 Nginx 反代：

```nginx
server {
    listen 443 ssl;
    server_name activate.你的域名.com;

    ssl_certificate     /etc/letsencrypt/live/activate.你的域名.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/activate.你的域名.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host;
    }
}
```

> `X-Forwarded-For` 一定要透传，否则 `/activate` 的限流会把所有请求算成同一个 IP。

### 2.6 验证

```bash
curl https://activate.你的域名.com/health
# {"ok":true,"keyLoaded":true,"cardsTotal":0,...}
```

---

## 3. 发卡（这是"自动发货"的货）

### 3.1 一次发一批

```bash
curl -X POST https://activate.你的域名.com/admin/cards \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"count":50,"days":365,"sub":"闲鱼订单"}'
```

返回：

```json
{
  "ok": true,
  "count": 50,
  "days": 365,
  "sub": "闲鱼订单",
  "cards": ["TH-3N7Q-RG2K", "TH-KMLD-W8GV", ...]
}
```

### 3.2 填进店铺的「自动发货」内容

把 `cards` 里的卡密一条一条填进店铺后台的**自动发货/卡密库存**。

> 卡密是**一次性**的：激活一次后自动置为已用，重复使用会被拒绝（返回"这张卡密已被使用过了"）。
> 所以可以放心把一批卡密放进店铺库存，系统会自动发、用户只能用一次。

### 3.3 查库存与使用情况

```bash
curl "https://activate.你的域名.com/admin/cards?limit=100" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

返回 `unusedCount` / `usedCount` / 明细（含谁在哪个机器码上用的）。

---

## 4. 让程序连上这个服务

程序里有三种方式指定激活服务地址，优先级从高到低：

| 方式 | 用途 | 怎么设 |
| --- | --- | --- |
| ① 环境变量 `TOTORO_ACTIVATION_URL` | 开发/自测 | 启动进程时设置 |
| ② 数据目录下 `activation-url.txt` | **临时改地址，不用重新打包** | 在数据目录放一个文本文件，内容就一行 URL |
| ③ 编译期常量 | **正式发布** | 改 `server/utils/license/activation.ts` 里的 `ACTIVATION_URL_BUILTIN`，然后重新打包 EXE |

**正式发布建议用 ③**，这样用户拿到就自带地址。改完重新 `npm run sea` 即可。

> 数据目录在哪：程序「授权」页底部会显示。EXE 版通常是
> `%LOCALAPPDATA%\totoro-heaven` 或 exe 旁边的 `totoro-heaven-data`。

### 4.1 测试用的地址写法示例

```powershell
$env:TOTORO_ACTIVATION_URL = "http://127.0.0.1:8787"
npm run dev
```

---

## 4.5 零成本方案：自己电脑 + 花生壳内网穿透

**没预算租服务器时走这条。** 服务跑在你自己的电脑上，用**花生壳免费版**映射到公网。
花生壳免费版给的是**固定域名 + 固定外网端口**（`xxx.vicp.net:端口`），地址不会变，可以烧进 EXE。

### 代价（先看能不能接受）

| 项目 | 影响 |
| --- | --- |
| 电脑必须 **7×24 开着** | 关机 / 休眠 / 断网 = 买家激活失败（重试即可，不影响已激活的老用户） |
| 免费版带宽 1Mbps、流量 1GB/月 | 激活请求只有几 KB，够几千次，够用 |
| 免费域名有效期 **1 年** | 到期前免费续一下 |
| 需要**实名认证** | 国内服务的常规要求 |

> 建议：**先这样起步验证**。卖出量后（比如月入过千）花 ¥30 换台云服务器，
> 把同一份 `server.mjs` 搬过去，程序侧只需改一次地址重打包。

### 步骤

**① 申请固定域名**

1. 注册 <https://hsk.oray.com>（贝锐花生壳），完成**实名认证**
2. 控制台 → 域名管理 → 免费域名 → 选后缀（如 `.vicp.net`）→ 填前缀（如 `totoro-lic`）
3. 得到固定域名：`totoro-lic.vicp.net`

**② 装客户端并登录**

<https://hsk.oray.com/download/> → 安装 → 登录同一账号

**③ 添加映射**

客户端右下角「+」→ 添加映射：

| 字段 | 填什么 |
| --- | --- |
| 应用名称 | `totoro激活` |
| 应用类型 | **HTTP** |
| 外网域名 | 选第 ① 步申请的域名 |
| 内网主机 | `127.0.0.1` |
| 内网端口 | `8787`（与 `server.mjs` 的 PORT 一致） |

保存后状态显示**在线**。记下外网地址，形如：`http://totoro-lic.vicp.net:12345`

**④ 启动服务**

双击 `run-windows.ps1`（或 `node server.mjs`）。

**⑤ 验证（关键一步）**

**用手机 4G/5G 流量**（别用家里 WiFi，那样测的是内网）打开：

```
http://totoro-lic.vicp.net:12345/health
```

看到 `{"ok":true,"keyLoaded":true,...}` 才算公网通了。`keyLoaded` 必须是 `true`。

**⑥ 把地址烧进程序**

改 `server/utils/license/activation.ts`：

```ts
export const ACTIVATION_URL_BUILTIN = 'http://totoro-lic.vicp.net:12345'
```

然后 `npm run sea` 重新打包，发给买家。

### 让它常驻

- **开机自启**：`Win + R` → 输入 `shell:startup` → 把 `run-windows.ps1` 的**快捷方式**拖进去
- **关掉休眠**：设置 → 电源 → 屏幕和睡眠 → 「睡眠」设为**从不**（电脑睡了服务就断）
- **花生壳客户端**也勾上开机自启

---

## 5. 买家侧体验

1. 在店铺下单 → 立刻收到卡密（形如 `TH-3N7Q-RG2K`）
2. 打开程序 → 停在「授权」页
3. 在「**输入卡密激活**」里填卡密 → 点「卡密激活」
4. 联网几秒后完成，顶栏变成「已授权 · 365 天」
5. 之后**完全离线**可用

卡密格式容错：大小写、少写连字符都能识别（`th3n7qrg2k` 也认）。

---

## 6. 安全清单（照着核一遍）

- [ ] `license-private.pem` 只在服务器上，**本机那份要不要保留由你决定**（保留=方便离线签发，风险=多一个泄漏点）
- [ ] `chmod 600 license-private.pem`
- [ ] `ADMIN_TOKEN` 足够长（≥24 位随机），**不要**写进代码/文档/聊天记录
- [ ] 服务器时间准确（装 `chrony`/`ntpdate`）—— 证书的 `iat/exp` 都按服务器时间算，时间错了会签出"还没生效"或"已过期"的证书
- [ ] 走 HTTPS
- [ ] `data/cards.json` 定期备份（**丢了已用卡记录 = 卡密可以被重复用**）
- [ ] 防火墙只开 443（和必要的 SSH），8787 不要直接对公网开放

---

## 7. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 程序提示「未启用在线激活」 | 没配地址 | 按 §4 配置 |
| 程序提示「无法连接到激活服务器」 | 地址错 / 服务没起 / 被墙 | 浏览器打开 `<地址>/health` 自测 |
| 提示「卡密不存在」 | 卡密打错 / 还没导入店铺 | 核对卡密；`/admin/cards` 查库存 |
| 提示「这张卡密已被使用过了」 | 该卡已激活过一台机器 | 换新卡（一卡一机是设计如此） |
| 激活成功但重启后要求重新激活 | 授权数据目录不可写 | 见主文档 §6；程序会自动回退到可写目录，检查「授权」页显示的数据目录 |
| 服务端启动就退出 | 没加载到私钥 / ADMIN_TOKEN 太短 | 看控制台报错，按提示补 |

---

## 8. 接口速查

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 健康检查 + 私钥是否加载 + 卡总数 |
| POST | `/activate` | 无（有 IP 限流） | `{card, machineCode}` → `{ok, certificate, lic, exp, grace}` |
| POST | `/admin/cards` | `Bearer ADMIN_TOKEN` | `{count, days, sub}` → 批量发卡 |
| GET | `/admin/cards?limit=N` | `Bearer ADMIN_TOKEN` | 查库存与使用明细 |

**错误码**：`400` 参数格式错 / `401` 管理密钥不对 / `404` 卡密不存在 /
`409` 卡密已使用 / `429` 请求过于频繁 / `500` 服务端异常（含私钥未配置、台账写盘失败）。
