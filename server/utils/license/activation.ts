/**
 * **在线激活（卡密）配置** —— 激活服务地址从哪来。
 *
 * ## 为什么需要它
 * 证书是**绑机器码**的，而机器码要等买家运行程序才知道 ⇒ 没法在付款瞬间把证书发出去。
 * 在线激活把这一步拆开：卖家先发**卡密**（一张短随机串，可预生成），
 * 买家在程序里输入卡密，程序带着本机机器码去服务器换一张绑定本机的证书。
 *
 * ## 地址解析顺序
 * ① 环境变量 `TOTORO_ACTIVATION_URL`（开发/自测）
 * ② 数据目录下的 `activation-url.txt`（临时改地址，不用重新打包）
 * ③ 编译期常量 `ACTIVATION_URL_BUILTIN`（正式发布时填）
 *
 * 全都没有 ⇒ 界面显示"未启用在线激活"，买家仍可让发布者直接发证书手动粘贴。
 *
 * ## ⚠️ 安全边界（重要）
 * 服务端返回的证书**不会被无条件信任**：拿到之后仍然走本地 `activateLicense()` 验签 ——
 * 所以即使有人把地址改到一个伪造服务器，他也拿不到能用的授权（他没有私钥，签不出来）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LICENSE_DIR_CANDIDATES } from './instance'

/** 正式发布时把部署好的激活服务地址填在这里（例如 `https://activate.example.com`） */
export const ACTIVATION_URL_BUILTIN = 'https://totoro-license.pages.dev'

/** 允许在数据目录里放一个文件临时指定地址（省掉一次重新打包） */
const URL_FILE_NAME = 'activation-url.txt'

/** 解析当前的激活服务地址；未配置返回空串 */
export function activationUrl(): string {
  const fromEnv = String(process.env.TOTORO_ACTIVATION_URL ?? '').trim()
  if (fromEnv) return fromEnv

  for (const dir of LICENSE_DIR_CANDIDATES) {
    try {
      const p = join(dir, URL_FILE_NAME)
      if (!existsSync(p)) continue
      const value = readFileSync(p, 'utf8').trim()
      // 只认 http(s)，防止写进奇怪的值
      if (/^https?:\/\//i.test(value)) return value
    } catch {
      // 这个候选目录读不到 ⇒ 试下一个
    }
  }

  return ACTIVATION_URL_BUILTIN
}
