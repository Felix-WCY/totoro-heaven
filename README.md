可随意学习使用

> ⚠️ **区分两件事**：「可随意学习使用」指**源码可自由学习与研究**；
> 而**用本仓库构建 / 打包出的程序需要授权证书才能运行**（详见下方「授权说明」）。
> 源码可读 ≠ 构建产物可免费使用 —— 请以实际的授权说明为准。

## 授权说明

⚠️ **从本仓库构建 / 打包的版本需要授权证书才能使用。**

软件内「**授权**」页会显示本机的**机器码**。首次使用时：

1. 打开「授权」页，复制**本机机器码**（形如 `A1B2-C3D4-E5F6-0718`）；
2. 把机器码发给**授权证书的签发者**，换取一张**授权证书**；
3. 把证书**整段**粘贴回「授权」页（换行与空格会被自动忽略），点「激活」。

激活一次后可**离线使用**：证书含「正常有效期 + 离线宽限期」，验签完全在本机完成，不联网。
到期前重新获取一张新证书粘回即可续期；换机器需要用**新机器码**重新签发。

> **未授权时不会让你在功能页里瞎点**：程序会自动把你带到「授权」页并说明原因。
> 顶栏常驻授权状态标识；到期前 7 天起显示「剩 N 天」，进入离线宽限期时显示「宽限期」并提示续期。

### 开发与打包的差异（⚠️ 最容易踩的坑）

| 场景 | 是否校验授权 |
| --- | --- |
| `npm run dev` | **不校验**（开发旁路，便于调试） |
| `npm run sea` 打包出的 EXE | **强制校验** |

想在本机按正式版口径自测：设 `TOTORO_LICENSE_STRICT=1` 后再启动。

### 🔑 关于私钥（只与签发者有关）

签发证书需要**私钥** `tools/keys/license-private.pem`，它**不在本仓库中**（已被 `.gitignore` 排除），
由签发者单独保管。因此要注意两点：

- **没有私钥的人可以开发、可以跑测试，但无法为自己打包出的版本生成可用授权** ——
  打包发布前请先确认授权来源；
- **整个项目只应存在一把密钥对**。重跑 `node tools/license-keygen.ts --force` 会更换公钥，
  **已发出的所有证书立即作废**；也不要为了"自己也能签发"而各生成一把 ——
  两把密钥会互相签出对方验不过的证书。

完整流程（签发参数、签发台账、排查表）见 [`tools/README-授权使用.md`](tools/README-授权使用.md)；
**使用 / 签发 / 维护 / 排错的完整手册（含十条红线、数据目录说明、给 AI 助手的硬约束）见
[`docs/授权门禁-完整说明.md`](docs/授权门禁-完整说明.md)。**

需要**自动发货**（买家付款后立刻收到卡密、在程序里输一次就自动激活）时，见
[`tools/activation-server/README.md`](tools/activation-server/README.md) —— 需要一个可自行部署的激活服务
（零依赖单文件，国内云服务器即可）。

## 桌面端与打包（Windows x64）

项目有两条交付线，**功能相同、共用同一份 `.output` 生产产物**：

| 形态 | 命令 | 产物 | 启动方式 |
| --- | --- | --- | --- |
| **桌面端（Electron，推荐）** | `npm run electron:build` | `dist\electron\totoro-heaven-<版本>-portable.exe`（单文件 portable） | 双击 = 独立窗口（无浏览器、无控制台黑框） |
| 浏览器版（Node SEA，兜底） | `npm run sea` | `dist\totoro-heaven.exe`（约 92 MB） | 双击 = 起本地服务 + 自动打开浏览器 |

### 桌面端（Electron）

前置：`npm ci`（会安装 `electron` / `electron-builder`）。

> 国内网络：`electron` 的安装脚本默认从 GitHub 下载运行时，github.com 不可达时先设镜像再安装：
> `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（或 huaweicloud：
> `https://mirrors.huaweicloud.com/electron/`）。打包脚本本身也会在未显式配置时默认用 npmmirror。

```powershell
npm run build           # 生成 .output（已有干净产物时 build-electron.ps1 会自动判断并跳过）
npm run electron:build  # = powershell -File pack/electron/build-electron.ps1
```

产出 **`dist\electron\totoro-heaven-<版本>-portable.exe`**：单个 exe，双击即用，
不需要安装 Node / Electron，也不会解出 `runtime\` 目录（portable 会自动解压到临时目录运行）。

- 主进程内 `import()` 加载 `.output/server/index.mjs`（与 SEA 的 `launcher.mjs` 同一条路），
  **不 spawn 子进程** ⇒ 没有控制台黑框、退出不用回收子进程；
- 窗口：标题固定「龙猫天堂」、无菜单栏、图标取 `logo.ico`，默认 1280x880；
- 服务只绑 `127.0.0.1`：端口默认 3000，被占用会自动顺延；Chromium 强制 `--no-proxy-server`
  （国内代理/加速器会把 loopback 也劫持，SEA 版的 `--app` 窗口踩过这个坑）；
- 用户数据与 Chromium 缓存落在 **`%APPDATA%\龙猫天堂`**（与参考应用 AI讲学 同构），
  token / 登录态关掉再开仍在；若该目录不可写（受限令牌/企业策略），启动器会回退到
  `%TEMP%\龙猫天堂-electron`（见下一条）；
- **portable 启动器做了两处兼容处理**（`pack/electron/patch-portable-nsis.mjs`）：
  ① 启动前探测可写 profile（优先 `%APPDATA%\龙猫天堂`，写不进就回退 `%TEMP%`），
  ② 设置 `ELECTRON_DISABLE_SANDBOX=1` —— 本机 Windows 11 26H2 上 Chromium 沙箱初始化失败会
  导致 Electron 启动即崩（`STATUS_BREAKPOINT`），而窗口只加载自己的 `127.0.0.1` 页面。
  ⚠️ electron-builder 的 `nsis.include` 对 portable 目标不生效，所以打包脚本会在构建前给
  `portable.nsi` 模板打补丁（幂等，可重复构建）；
- 授权目录规则不变（见 `server/utils/license/instance.ts`，老用户的机器码不会被 Electron 版改掉）；
  旧 SEA 版把授权放在 **EXE 旁边的 `totoro-heaven-data\license.json`** 或 `%TEMP%\totoro-heaven-data`
  时，新桌面端首次启动会自动识别并**迁移到 userData**（`%APPDATA%\龙猫天堂\data`，机器码不变，
  已发证书继续有效），不需要重新激活；
- 启动失败（端口全占、`.output` 缺失、安全软件拦截）会**弹窗说明**而不是闪退，
  日志在 `%TEMP%\totoro-heaven-electron.log`。
- 开发态直接跑：`npm run build && npm run electron`（加载仓库里的 `.output`，不打包）。
- 无人值守自检（CI/排障用，不创建窗口，只验证「打包后的内嵌 Nitro 服务」）：
  ```powershell
  $env:TOTORO_SMOKE = '1'
  $env:TOTORO_SMOKE_OUT = 'dist\smoke.txt'
  .\dist\electron\totoro-heaven-1.3.2-portable.exe   # 退出码 0 = 通过，smoke.txt 里有 url/ok/bytes
  ```
- **Electron 版本刻意 pin 在 `43.3.0`**：45.0.0 在 Windows 11 26H2 上启动即崩（`electron.exe`
  内 `0xc0000005`，2026-10-27 实测），44.7.0 同样崩；43.3.0 与本机可正常运行的 Obsidian
  桌面端一致（同为 43.3.0）。升级前务必实际打开一次窗口验证。

> 国内网络：`pack/electron/build-electron.ps1` 在未显式设置 `ELECTRON_MIRROR` 时默认使用 npmmirror；
> GitHub 可达的机器可清空该变量（`set ELECTRON_MIRROR=`）走官方源。

### 浏览器版（Node SEA，兜底）

```powershell
npm ci
npm run sea          # = powershell -File pack/sea/build-sea.ps1
```

约 90 秒后产出 **`dist\totoro-heaven.exe`（约 92 MB）**：单文件、自带 Node 运行时，
用的人不需要装 Node 或任何依赖。启动器逻辑（选可写运行目录、解包 `.output`、端口顺延、
三重兜底打开浏览器）仍在 `pack/sea/launcher.mjs`，Electron 版出问题时可以随时退回这条线。

- GitHub Actions：仓库 → **Actions** → **Build Windows exe** → 某次成功运行的页面底部
  **Artifacts → `totoro-heaven-exe`**（保留 14 天）；
- 打包细节：脚本先确认 `.output` 是**干净的生产构建**（缺失/被污染/源码比产物新时自动 `npm run build`），
  再校验 `src/mp/releaseArt.ts` 里有当前版本条目、裁剪版本图、剥掉 `.map`，最后
  esbuild 打 launcher → tar 打 `.output` → `node --experimental-sea-config` 生成 blob →
  复制 `node.exe` → rcedit 设图标 → postject 注入（图标会从最终产物里复核两次）。
  缺版本条目或 `public/version-art/<版本>.png` 时会**直接失败**，不是 CI 的问题。
  （Electron 版复用了同一套 `.output` 准备步骤：`build-sea.ps1 -PrepareOnly`。）

### ⚠️ EXE 放在哪个盘很重要（实测）

**建议放在非系统盘的普通目录**，例如 `D:\totoro-heaven\`。

| 位置 | 实测结果 |
| --- | --- |
| `D:\任意文件夹\` | ✅ 正常，双击即用 |
| `C:\Program Files\…` | ⚠️ 解包/写文件容易因权限失败（启动器的"可写运行目录"探测就是为这类机器兜底的） |
| `C:\Users\<你>\Documents\…` 等用户目录 | ⚠️ 实测会被拦（Windows「受控文件夹访问」/杀软/目录权限），表现为「Windows 已保护你的电脑」或启动后异常；**同一个 EXE 挪到 D 盘就正常** |

### 首次运行

**桌面端（Electron portable）**：

1. 双击 `totoro-heaven-<版本>-portable.exe`；
2. 若弹出「**Windows 已保护你的电脑**」→ 点「**更多信息**」→「**仍要运行**」。
   EXE 未做代码签名（每次重新打包都是全新二进制、在微软那边没有任何声誉），
   这是 Windows 对"没签名的陌生程序"的常规拦截，**不是报毒**，也没有病毒检测记录；
3. 直接出现**独立窗口**（无控制台黑框、无浏览器地址栏）；端口被占用会自动顺延，
   也可 `set TOTORO_PORT=4000` 指定；
4. 数据在 `%APPDATA%\龙猫天堂`；退出 = 关掉窗口。

**浏览器版（Node SEA）**：

1. 双击 `totoro-heaven.exe`；
2. 同上，SmartScreen 提示时点「更多信息」→「仍要运行」；
3. 黑色控制台窗口会打印地址并**自动打开浏览器**：默认 `http://127.0.0.1:3000/`，
   端口被占用会自动顺延（窗口里显示实际端口），也可 `set TOTORO_PORT=4000` 指定；
4. 首次运行会在 **EXE 同级的 `runtime\`** 目录解包运行所需文件（该目录不可写时回退
   `%TEMP%\totoro-heaven-runtime` → `%LOCALAPPDATA%\totoro-heaven\runtime`）；
5. 退出 = 直接关掉那个黑色窗口（只关浏览器标签页不算退出）。

## 许可

本仓库以 MIT 许可发布，具体以 `LICENSE` 文件为准。

早期版本包含来源于 Totoro Paradise（AGPL-3.0）的衍生内容。进行修改或分发时，应核对实际代码来源、
第三方依赖及适用的许可条件（详见 `NOTICE`）。
