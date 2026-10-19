/**
 * **打包「授权证书签发器」为单文件 EXE**
 *
 * 用法：`node tools/license-issuer/build-issuer.mjs`（或 `npm run build:issuer`）
 * 产物：`dist/license-issuer.exe`
 *
 * 流程与主程序 `pack/sea/build-sea.ps1` 一致（SEA = Node 单可执行文件）：
 *   ① esbuild 把 issuer.mjs（含它引用的 `server/utils/license/*.ts`）打成单个 .cjs；
 *   ② `node --experimental-sea-config` 生成准备块；
 *   ③ 复制 node.exe  →  ④ 写入图标（rcedit，必须在注入前）  →  ⑤ postject 注入数据块。
 *
 * ⚠️ **不把私钥打进 EXE**：这个工具运行时才去读 `license-private.pem`。
 *    若把私钥编译进二进制，EXE 一旦外传就等于把签发权一起送出去了。
 */
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BUILD_DIR = join(ROOT, 'dist', 'issuer-build')
const OUT_EXE = join(ROOT, 'dist', 'license-issuer.exe')
const ENTRY = join(HERE, 'issuer.mjs')
/** SEA 的哨兵 fuse（与主程序一致；值由 Node 内部定义，不能改） */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function log(msg) {
  console.log(msg)
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT })
  if (r.error) throw new Error(`${label} 无法启动：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${label} 失败（退出码 ${r.status}）`)
}

async function main() {
  log('')
  log('=== 打包「授权签发器」 ===')

  // 0. 清掉旧产物（EXE 被占用时要给出明确提示，而不是抛一段晦涩的 EPERM）
  if (existsSync(OUT_EXE)) {
    try {
      rmSync(OUT_EXE, { force: true })
    } catch (err) {
      throw new Error(
        `无法覆盖 ${OUT_EXE} —— 可能它正在运行。请先关掉「授权证书签发器」窗口再重试。原始错误：${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  rmSync(BUILD_DIR, { recursive: true, force: true })
  mkdirSync(BUILD_DIR, { recursive: true })

  // 1. esbuild 打包（把 .ts 依赖一起打进来）
  log('[1/5] esbuild 打包 issuer.mjs …')
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(BUILD_DIR, 'issuer.bundle.cjs'),
    // node 内置模块保持 external（SEA 里运行时从 node 本体取）
    packages: 'bundle',
    logLevel: 'info',
  })

  // 2. SEA 配置 + 生成准备块
  log('[2/5] 生成 SEA 准备块 …')
  const seaConfigPath = join(BUILD_DIR, 'sea-config.json')
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: join(BUILD_DIR, 'issuer.bundle.cjs'),
        output: join(BUILD_DIR, 'sea-prep.blob'),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
    'utf8',
  )
  run(process.execPath, ['--experimental-sea-config', seaConfigPath], 'sea-config')

  // 3. 复制 node.exe 作为基底
  log('[3/5] 复制 node.exe 作为基底 …')
  copyFileSync(process.execPath, OUT_EXE)

  // 4. 图标（必须在 postject 之前：注入后 PE 签名被改，rcedit 会失败或挂起）
  log('[4/5] 写入图标（rcedit）…')
  const rcedit = join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit.exe')
  const ico = join(ROOT, 'logo.ico')
  if (existsSync(rcedit) && existsSync(ico)) {
    const r = spawnSync(rcedit, [OUT_EXE, '--set-icon', ico], { cwd: ROOT })
    if (r.status === 0) log('      ✅ 图标已写入')
    else log('      ⚠️ 图标写入失败（不影响功能，继续）')
  } else {
    log('      ⚠️ 找不到 rcedit 或 logo.ico（跳过图标）')
  }

  // 5. postject 注入 SEA 数据块
  log('[5/5] 注入 SEA 数据块（postject）…')
  const postjectPkgPath = join(ROOT, 'node_modules', 'postject', 'package.json')
  if (!existsSync(postjectPkgPath)) throw new Error('找不到 postject 依赖，请先 npm install')
  const pkg = JSON.parse(readFileSync(postjectPkgPath, 'utf8'))
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.postject
  if (!binRel) throw new Error('postject 的 package.json 里没有可用的 bin 入口')
  const postjectCli = join(ROOT, 'node_modules', 'postject', binRel)
  run(
    process.execPath,
    [postjectCli, OUT_EXE, 'NODE_SEA_BLOB', join(BUILD_DIR, 'sea-prep.blob'), '--sentinel-fuse', SENTINEL_FUSE],
    'postject',
  )

  // 6. 自检产物：SEA 数据块在不在（与主程序同一判据）
  log('')
  const buf = readFileSync(OUT_EXE)
  const hasFuse = buf.includes(Buffer.from(SENTINEL_FUSE))
  const hasBlob = buf.includes(Buffer.from('NODE_SEA_BLOB'))
  log(`产物: ${OUT_EXE}`)
  log(`大小: ${(buf.length / 1024 / 1024).toFixed(2)} MB（${buf.length} 字节）`)
  log(`SEA 数据块: ${hasBlob ? '✅ 已注入' : '❌ 缺失'}   哨兵: ${hasFuse ? '✅' : '❌'}`)
  if (!hasBlob || !hasFuse) throw new Error('产物自检失败：SEA 数据块未正确写入')
  log('')
  log('✅ 打包完成。把这个 exe 发给签发者，并把 license-private.pem 放到它旁边即可。')
}

main().catch((err) => {
  console.error('')
  console.error('❌ 打包失败：' + (err instanceof Error ? err.message : String(err)))
  console.error('')
  process.exit(1)
})
