#!/usr/bin/env bash
#
# 一键部署「授权激活服务」（Ubuntu / Debian）
#
# 用法：
#   ① 把两个文件上传到服务器同一目录：
#        server.mjs
#        license-private.pem
#   ② 在该目录执行：
#        sudo bash install-ubuntu.sh
#   ③ 脚本会自动装 Node（如缺）、建目录、配 systemd、开机自启、并打印
#      对外地址 + 管理密钥
#
# 可选环境变量：
#   PORT=8787               监听端口
#   ADMIN_TOKEN=xxxx        自己指定管理密钥（不给就自动生成）
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/totoro-activation}"
PORT="${PORT:-8787}"
TOKEN_FILE="$APP_DIR/admin-token.txt"

say() { printf '\n\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash install-ubuntu.sh"
[ -f server.mjs ] || die "当前目录找不到 server.mjs —— 请先 cd 到放文件的目录再执行"
[ -f license-private.pem ] || die "当前目录找不到 license-private.pem（私钥），没有它签不出证书"
grep -q "BEGIN PRIVATE KEY" license-private.pem || die "license-private.pem 内容不对，不像是 PEM 私钥"

say "== 1/6 检查 Node =="
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  echo "  已安装 Node $(node -v)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "  Node 版本低于 18，需要升级"
    NEED_NODE=1
  else
    NEED_NODE=0
  fi
else
  echo "  未安装 Node，开始安装…"
  NEED_NODE=1
fi

if [ "${NEED_NODE:-0}" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    # 用 NodeSource 装 Node 20（Debian/Ubuntu 自带源版本往往太旧）
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    die "非 apt 系统，请手动安装 Node 18+ 后再运行本脚本"
  fi
  echo "  已安装 Node $(node -v)"
fi

say "== 2/6 准备目录 =="
mkdir -p "$APP_DIR"
cp -f server.mjs "$APP_DIR/server.mjs"
cp -f license-private.pem "$APP_DIR/license-private.pem"
chmod 600 "$APP_DIR/license-private.pem"
chmod 644 "$APP_DIR/server.mjs"
echo "  $APP_DIR/server.mjs"
echo "  $APP_DIR/license-private.pem （权限 600）"

say "== 3/6 管理密钥 =="
if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "${ADMIN_TOKEN}" > "$TOKEN_FILE"
  echo "  使用你指定的 ADMIN_TOKEN"
elif [ -s "$TOKEN_FILE" ]; then
  echo "  复用已有的 ADMIN_TOKEN"
else
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > "$TOKEN_FILE"
  echo "  已生成新的 ADMIN_TOKEN"
fi
chmod 600 "$TOKEN_FILE"
ADMIN_TOKEN="$(cat "$TOKEN_FILE")"

say "== 4/6 配置 systemd（开机自启）=="
cat > /etc/systemd/system/totoro-activation.service <<EOF
[Unit]
Description=Totoro License Activation Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=LICENSE_KEY_FILE=$APP_DIR/license-private.pem
Environment=ADMIN_TOKEN=$ADMIN_TOKEN
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable totoro-activation >/dev/null 2>&1 || true
systemctl restart totoro-activation
echo "  服务已启动"

say "== 5/6 自检 =="
sleep 2
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -fsS "http://127.0.0.1:$PORT/health" || true)"
  if [ -z "$HEALTH" ]; then
    warn "  本地自检失败，服务可能没起来。查看日志：journalctl -u totoro-activation -n 50 --no-pager"
  else
    echo "  $HEALTH"
    case "$HEALTH" in
      *'"keyLoaded":true'*) echo "  ✅ 私钥已加载，可以签发" ;;
      *) warn "  ⚠️ keyLoaded 不是 true —— 私钥没读到，签出来的证书无效，请检查" ;;
    esac
  fi
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
[ -n "$IP" ] || IP="<这台服务器的公网IP>"

say "== 6/6 完成 =="
cat <<EOF

  ┌──────────────────────────────────────────────────────────┐
  │  部署完成                                                 │
  └──────────────────────────────────────────────────────────┘

  对外地址（填进程序）：
      http://$IP:$PORT

  管理密钥（发卡用，保密）：
      $ADMIN_TOKEN
      也保存在：$TOKEN_FILE

  ⚠️ 别忘了在云服务器的「安全组 / 防火墙」里放行 TCP $PORT，
     否则外面访问不到。

  验证对外可达（在你自己的电脑上执行）：
      curl http://$IP:$PORT/health

  发一批卡密（50 张、365 天）：
      curl -X POST http://$IP:$PORT/admin/cards \\
        -H "Authorization: Bearer $ADMIN_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"count":50,"days":365,"sub":"闲鱼订单"}'

  常用命令：
      systemctl status totoro-activation
      journalctl -u totoro-activation -f
      systemctl restart totoro-activation

EOF
