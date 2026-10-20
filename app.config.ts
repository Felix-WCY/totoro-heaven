import { version } from './package.json'

export default defineAppConfig({
  /** 本机版本号（唯一来源 = package.json，界面上的「当前 vX.Y.Z」都用它） */
  version,
  /**
   * 「检查新版本」要查哪个仓库（2026-10-19 用户要求：远端检测改成查**自己的**仓库）。
   *
   * ⚠️ 必须写成 `owner/repo`，且**这个仓库要能被匿名访问**：
   *    - 私有仓库匿名调用 GitHub API 一律返回 404（GitHub 不暴露私有仓库是否存在），
   *      端用户就会一直看到「查不到远端版本」；
   *    - 所以这里默认填的是公开的那个（`1hao-ui/totoro-heaven`）。
   *      以后换仓库 / 换账号，**只改这一行**即可，`releasesUrl`、`repoUrl`、
   *      检测请求三处会一起跟着变（见 `composables/useUpdateCheck.ts`）。
   */
  updateRepo: '1hao-ui/totoro-heaven',
})
