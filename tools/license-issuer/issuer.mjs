/**
 * **授权证书签发器**（给签发者用的单文件小工具）
 *
 * 双击运行 → 本地起一个网页 → 填「机器码 + 授权对象 + 有效天数」→ 点签发 → 出激活码。
 *
 * ## 为什么做成"本地网页"而不是命令行
 * 签发者可能不熟悉命令行。网页表单能：自动校验机器码格式、一键复制证书、把失败原因说清楚。
 * 而且和主程序同一套做法（本机 127.0.0.1 + 自动开浏览器），没有额外的学习成本。
 *
 * ## 🔒 私钥从哪来（**不内置**）
 * 私钥**不会**被打进这个 EXE（否则 EXE 一旦外传，等于把签发权一起送出去了）。
 * 运行时会按顺序在这些位置找 `license-private.pem`：
 *   ① 环境变量 `TOTORO_ISSUER_KEY` 指定的路径
 *   ② 本 EXE 同目录
 *   ③ 本 EXE 同目录下的 `keys/`
 *   ④ `%LOCALAPPDATA%\totoro-heaven`
 *   ⑤ `~/.totoro-heaven`
 * 找不到时页面上会直接告诉你"把文件放哪"。
 *
 * ## ✅ 签发后**立刻自检**
 * 用程序内置的**公钥**验证刚签出来的证书：
 * - 验得过 ⇒ 这张证书用户一定能激活（机器码/签名都对）；
 * - 验不过 ⇒ **说明这把私钥和程序的公钥不是一对**，签出来的证书用户全部用不了 —— 必须立刻停下。
 */
import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { formatMachineCode, issueCertificate, normalizeMachineCode, verifyCertificate } from '../../server/utils/license/certificate.ts'
import { LICENSE_PUBLIC_KEY_PEM } from '../../server/utils/license/publicKey.ts'

const APP_NAME = '龙猫天堂 · 授权证书签发器'
const PREFERRED_PORT = 3210
const KEY_FILE_NAME = 'license-private.pem'

/** EXE 所在目录（SEA 下 `process.execPath` 就是本 exe；开发时是 node 可执行文件，回退到 cwd） */
const APP_DIR = (() => {
  try {
    const d = dirname(process.execPath)
    // 开发时 process.execPath 是 node.exe，此时用 cwd 更合理
    return /node(\.exe)?$/i.test(process.execPath) ? process.cwd() : d
  } catch {
    return process.cwd()
  }
})()

/** 私钥候选路径（见文件头） */
const KEY_CANDIDATES = [
  process.env.TOTORO_ISSUER_KEY?.trim(),
  join(APP_DIR, KEY_FILE_NAME),
  join(APP_DIR, 'keys', KEY_FILE_NAME),
  join(process.env.LOCALAPPDATA?.trim() || homedir(), 'totoro-heaven', KEY_FILE_NAME),
  join(homedir(), '.totoro-heaven', KEY_FILE_NAME),
].filter(Boolean)

/** 读取私钥（找到第一个存在的即可） */
function loadPrivateKey() {
  for (const p of KEY_CANDIDATES) {
    try {
      if (!existsSync(p)) continue
      const pem = readFileSync(p, 'utf8')
      if (!pem.includes('BEGIN PRIVATE KEY')) continue
      return { ok: true, pem, path: p }
    } catch {
      // 读失败（权限/占用）⇒ 试下一个候选
    }
  }
  return { ok: false, pem: '', path: '' }
}

/** 签发台账（追加式；写不进去也不影响签发） */
function appendLedger(entry) {
  try {
    appendFileSync(join(APP_DIR, 'issued.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // 台账是加分项：目录只读或磁盘满时静默跳过，绝不影响签发本身
  }
}

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${APP_NAME}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 15px/1.6 "Microsoft YaHei", system-ui, sans-serif;
         background: #f5f6f8; color: #1f2328; }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input, textarea { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px;
                    font: inherit; }
  input:focus, textarea:focus { outline: 2px solid #86efac; border-color: #4ade80; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 160px; }
  .hint { color: #6b7280; font-size: 12px; margin-top: 4px; }
  button { font: inherit; font-weight: 600; padding: 10px 20px; border-radius: 8px; border: 0;
           background: #16a34a; color: #fff; cursor: pointer; }
  button:hover { background: #15803d; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  button.ghost { background: #eef2f7; color: #1f2328; }
  button.ghost:hover { background: #e2e8f0; }
  .cert { font-family: Consolas, monospace; font-size: 12px; word-break: break-all; background: #f8fafc;
          height: 150px; resize: vertical; }
  .msg { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 14px; white-space: pre-wrap; }
  .ok { background: #ecfdf5; border: 1px solid #86efac; color: #14532d; }
  .err { background: #fef2f2; border: 1px solid #fca5a5; color: #7f1d1d; }
  .warn { background: #fffbeb; border: 1px solid #fcd34d; color: #78350f; }
  .kv { display: flex; gap: 10px; font-size: 13px; margin-top: 6px; }
  .kv b { min-width: 72px; color: #6b7280; font-weight: 600; }
  code { background: #eef2f7; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .big { font-family: Consolas, monospace; font-size: 17px; letter-spacing: .06em; font-weight: 700; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🔑 ${APP_NAME}</h1>
  <div class="sub">给「龙猫天堂」签授权证书。填对方的机器码和有效天数，点签发，把证书发给他即可。</div>

  <div class="card" id="statusCard">
    <div class="kv"><b>私钥</b><span id="keyStatus">检查中…</span></div>
    <div class="kv"><b>公钥</b><span id="pubStatus">检查中…</span></div>
    <div class="kv"><b>程序目录</b><span><code id="appDir"></code></span></div>
  </div>

  <div class="card">
    <label>对方的机器码 <span style="color:#dc2626">*</span></label>
    <input id="machine" placeholder="例如 A76A-1BA9-553D-BB21" autocomplete="off" spellcheck="false" />
    <div class="hint">让对方在「授权」页点「复制机器码」发给你。大小写、连字符都不用管，会自动整理。</div>

    <div class="row">
      <div>
        <label>授权对象</label>
        <input id="sub" placeholder="例如 张三" autocomplete="off" />
        <div class="hint">会显示在对方的授权页上</div>
      </div>
      <div>
        <label>有效天数</label>
        <input id="days" type="number" value="365" min="1" max="3650" />
        <div class="hint">默认 365 天，到期后再给 14 天离线宽限</div>
      </div>
    </div>

    <div style="margin-top:18px">
      <button id="btn">签发授权证书</button>
    </div>

    <div id="msg" class="msg" style="display:none"></div>

    <div id="resultBox" style="display:none; margin-top:16px">
      <label>激活码（整段复制，发给对方）</label>
      <textarea id="cert" class="cert" readonly></textarea>
      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap">
        <button class="ghost" id="copy">📋 复制激活码</button>
        <button class="ghost" id="again">再签一张</button>
      </div>
      <div class="kv" style="margin-top:14px"><b>许可证编号</b><span id="licId"></span></div>
      <div class="kv"><b>机器码</b><span class="big" id="mcOut"></span></div>
      <div class="kv"><b>正常到期</b><span id="exp"></span></div>
      <div class="kv"><b>离线宽限至</b><span id="grace"></span></div>
    </div>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const fmt = (s) => new Date(s * 1000).toLocaleString('zh-CN', { hour12: false });
  function showMsg(text, kind) {
    const m = $('msg');
    m.className = 'msg ' + kind;
    m.textContent = text;
    m.style.display = 'block';
  }
  function hideMsg() { $('msg').style.display = 'none'; }

  fetch('/api/status').then(r => r.json()).then(s => {
    $('keyStatus').innerHTML = s.keyOk
      ? '<span style="color:#16a34a">✅ 已加载</span> &nbsp;<code>' + s.keyPath + '</code>'
      : '<span style="color:#dc2626">❌ 未找到</span>';
    $('pubStatus').innerHTML = s.pubOk
      ? '<span style="color:#16a34a">✅ 已内置（签发后会自动自检）</span>'
      : '<span style="color:#dc2626">❌ 程序未内置公钥，签出的证书用户无法激活</span>';
    $('appDir').textContent = s.appDir;
    if (!s.keyOk) showMsg('找不到私钥文件 license-private.pem。\\n请把它放到下面任一位置：\\n' + s.keyCandidates.map(p => '  · ' + p).join('\\n'), 'warn');
    else if (!s.pubOk) showMsg('本工具没有内置公钥（打包时 publicKey.ts 是空的）—— 签出来的证书用户激活不了，请让开发者重新打包本工具。', 'err');
  });

  $('btn').addEventListener('click', async () => {
    hideMsg();
    $('resultBox').style.display = 'none';
    const payload = { machine: $('machine').value, sub: $('sub').value, days: Number($('days').value) };
    if (!payload.machine.trim()) { showMsg('请先填对方的机器码', 'err'); return; }
    $('btn').disabled = true;
    $('btn').textContent = '签发中…';
    try {
      const res = await fetch('/api/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const j = await res.json();
      if (!j.ok) { showMsg(j.error || '签发失败', 'err'); return; }
      $('cert').value = j.certificate;
      $('licId').textContent = j.licenseId;
      $('mcOut').textContent = j.machineCode;
      $('exp').textContent = fmt(j.expiresAt);
      $('grace').textContent = fmt(j.graceUntil);
      $('resultBox').style.display = 'block';
      if (j.selfCheckOk) showMsg('✅ 已签发，并且用程序内置公钥自检通过 —— 对方粘贴后一定能激活。', 'ok');
      else showMsg('⚠️ 证书已签发，但**用程序内置公钥验不过**！\\n说明你这把私钥和程序里的公钥不是一对 —— 这张证书对方激活不了。\\n请开发者核对密钥，不要把它发出去。', 'err');
    } catch (e) {
      showMsg('请求失败：' + e.message, 'err');
    } finally {
      $('btn').disabled = false;
      $('btn').textContent = '签发授权证书';
    }
  });

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('cert').value);
      $('copy').textContent = '✅ 已复制';
      setTimeout(() => { $('copy').textContent = '📋 复制激活码'; }, 1500);
    } catch { $('cert').select(); showMsg('复制失败，已帮你全选，按 Ctrl+C 复制即可。', 'warn'); }
  });

  $('again').addEventListener('click', () => {
    hideMsg();
    $('resultBox').style.display = 'none';
    $('machine').value = '';
    $('machine').focus();
  });

  $('machine').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn').click(); });
</script>
</body>
</html>`

/** 极简 JSON 请求体读取 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) req.destroy() // 1MB 上限：这个工具只收三个短字段
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/** 处理签发请求 */
function handleIssue(body) {
  const key = loadPrivateKey()
  if (!key.ok) {
    return { ok: false, error: '找不到私钥文件 license-private.pem，无法签发。位置见页面顶部提示。' }
  }
  if (!LICENSE_PUBLIC_KEY_PEM.trim()) {
    return { ok: false, error: '本工具未内置公钥（打包时 publicKey.ts 为空），签出来的证书用户无法激活。请联系开发者重新打包。' }
  }
  const fingerprint = normalizeMachineCode(body.machine)
  if (!fingerprint) {
    return { ok: false, error: `机器码不合法：「${String(body.machine ?? '')}」\n应为 16 位十六进制（形如 A76A-1BA9-553D-BB21）。请让对方从「授权」页直接复制，不要手抄。` }
  }
  const days = Number(body.days)
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 365
  const subject = String(body.sub ?? '').trim() || '用户'
  const licenseId = 'TH-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase()

  let issued
  try {
    issued = issueCertificate({ lic: licenseId, sub: subject, fingerprint, days: safeDays }, key.pem)
  } catch (err) {
    return { ok: false, error: '签发失败：' + (err instanceof Error ? err.message : String(err)) }
  }

  // ✅ 用**程序内置公钥**自检：验不过说明私钥与程序不匹配，必须明确告诉签发者
  const check = verifyCertificate(issued.certificate, LICENSE_PUBLIC_KEY_PEM, { fingerprint })
  const selfCheckOk = check.ok

  appendLedger({
    at: new Date().toISOString(),
    lic: issued.payload.lic,
    sub: issued.payload.sub,
    fp: issued.payload.fp,
    days: safeDays,
    exp: issued.payload.exp,
    selfCheckOk,
  })

  return {
    ok: true,
    certificate: issued.certificate,
    licenseId: issued.payload.lic,
    machineCode: formatMachineCode(issued.payload.fp),
    expiresAt: issued.payload.exp,
    graceUntil: issued.payload.grace,
    selfCheckOk,
  }
}

/** 端口顺延：3210 被占就试下一个 */
async function pickPort() {
  for (let p = PREFERRED_PORT; p <= PREFERRED_PORT + 20; p++) {
    const free = await new Promise((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  return null
}

async function main() {
  const port = await pickPort()
  if (!port) {
    console.error(`启动失败：端口 ${PREFERRED_PORT}~${PREFERRED_PORT + 20} 都被占用了。请关掉占用端口的程序后重试。`)
    exec('pause')
    process.exit(1)
  }

  const key = loadPrivateKey()
  console.log('')
  console.log('  ' + APP_NAME)
  console.log('  ────────────────────────────────────────')
  console.log('  私钥      : ' + (key.ok ? key.path : '❌ 未找到（页面里会提示放哪）'))
  console.log('  内置公钥  : ' + (LICENSE_PUBLIC_KEY_PEM.trim() ? '✅ 有（签发后自动自检）' : '❌ 无'))
  console.log('  程序目录  : ' + APP_DIR)
  console.log('  ────────────────────────────────────────')
  console.log('  正在打开浏览器 → http://localhost:' + port + '/')
  console.log('  （关掉这个黑窗口 = 关掉本工具）')
  console.log('')

  const server = createServer(async (req, res) => {
    const url = String(req.url || '/')
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(PAGE_HTML)
      return
    }
    if (req.method === 'GET' && url.startsWith('/api/status')) {
      const k = loadPrivateKey()
      sendJson(res, 200, {
        keyOk: k.ok,
        keyPath: k.path,
        keyCandidates: KEY_CANDIDATES,
        pubOk: Boolean(LICENSE_PUBLIC_KEY_PEM.trim()),
        appDir: APP_DIR,
      })
      return
    }
    if (req.method === 'POST' && url.startsWith('/api/issue')) {
      const body = await readJsonBody(req)
      let result
      try {
        result = handleIssue(body)
      } catch (err) {
        result = { ok: false, error: '签发过程出错：' + (err instanceof Error ? err.message : String(err)) }
      }
      sendJson(res, 200, result)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  })

  server.listen(port, '127.0.0.1', () => {
    exec(`start http://localhost:${port}/`)
  })
}

main().catch((e) => {
  console.error('启动失败:', e)
  exec('pause')
  process.exit(1)
})
