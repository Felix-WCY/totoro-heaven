# 授权激活服务 · Windows 服务器启动脚本
#
# 用法（在 Windows 云服务器上）：
#   ① 装 Node.js 18+：https://nodejs.org/zh-cn/download  （选 LTS，一路下一步）
#   ② 把 server.mjs 和 license-private.pem 放到本文件同一目录
#   ③ 右键本文件 →「使用 PowerShell 运行」
#
# 脚本会：检查 Node 和私钥 → 生成/复用管理密钥 → 打印对外地址 → 启动服务。
# 窗口关掉服务就停了；要让它在后台常驻，见 README「Windows 开机自启」。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host '==== 授权激活服务 · Windows 启动 ====' -ForegroundColor Cyan

# ① Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '❌ 没有找到 Node.js' -ForegroundColor Red
  Write-Host '   请先安装：https://nodejs.org/zh-cn/download （选 LTS 版本，一路下一步）'
  Write-Host '   安装完关掉本窗口，重新运行本脚本。'
  Write-Host ''
  Read-Host '按回车退出'
  exit 1
}
$ver = (& node -p "process.versions.node") -join ''
$major = [int](($ver -split '\.')[0])
Write-Host "  Node.js : v$ver"
if ($major -lt 18) {
  Write-Host '❌ Node 版本太低，需要 18 或更高' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

# ② 私钥
$pem = Join-Path $PSScriptRoot 'license-private.pem'
if (-not (Test-Path $pem)) {
  Write-Host ''
  Write-Host '❌ 缺少 license-private.pem（私钥）' -ForegroundColor Red
  Write-Host "   请把它放到：$PSScriptRoot"
  Write-Host '   没有私钥就签不出证书，服务起来了也没用。'
  Read-Host '按回车退出'
  exit 1
}
if (-not (Select-String -Path $pem -Pattern 'BEGIN PRIVATE KEY' -Quiet)) {
  Write-Host '❌ license-private.pem 内容不对，不像是 PEM 私钥' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
Write-Host '  私钥   : ✅ 已找到'

# ③ 管理密钥（发卡接口用）
$tokenFile = Join-Path $PSScriptRoot 'admin-token.txt'
if (Test-Path $tokenFile) {
  $adminToken = (Get-Content $tokenFile -Raw).Trim()
  Write-Host '  管理密钥: 复用已有的 admin-token.txt'
} else {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $adminToken = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  [System.IO.File]::WriteAllText($tokenFile, $adminToken, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '  管理密钥: 已生成并保存到 admin-token.txt'
}

# ④ 端口
$port = $env:PORT
if (-not $port) { $port = '8787' }

# ⑤ 放行防火墙（本机入站）
try {
  $ruleName = "Totoro Activation $port"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    Write-Host "  防火墙 : 已放行 TCP $port"
  } else {
    Write-Host "  防火墙 : 已存在规则"
  }
} catch {
  Write-Host "  防火墙 : 自动放行失败（需要管理员）。请手动在云控制台安全组放行 TCP $port" -ForegroundColor Yellow
}

# ⑥ 启动
$env:LICENSE_KEY_FILE = $pem
$env:ADMIN_TOKEN = $adminToken
$env:PORT = $port
$env:DATA_DIR = Join-Path $PSScriptRoot 'data'

Write-Host ''
Write-Host '──── 访问信息 ────' -ForegroundColor Green
Write-Host "  本机测试 : http://127.0.0.1:$port/health"
Write-Host "  对外地址 : http://<这台服务器的公网IP>:$port"
Write-Host "  管理密钥 : $adminToken"
Write-Host ''
Write-Host '  发卡示例（在你自己的电脑上执行）：'
Write-Host "    curl -X POST http://<IP>:$port/admin/cards -H `"Authorization: Bearer $adminToken`" -H `"Content-Type: application/json`" -d '{`"count`":50,`"days`":365}'"
Write-Host ''
Write-Host '  提示：云服务器还要在「安全组」里放行 TCP 端口，否则外面连不上。'
Write-Host '  关掉本窗口 = 停止服务。'
Write-Host '──────────────────' -ForegroundColor Green
Write-Host ''

& node (Join-Path $PSScriptRoot 'server.mjs')
