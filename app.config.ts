import { version } from './package.json'

export default defineAppConfig({
  /** 本机版本号（唯一来源 = package.json，界面上的「当前 vX.Y.Z」都用它） */
  version,
  /**
   * 「检查新版本」要查哪个仓库。
   *
   * **商用分发包留空 = 关闭更新检查**（`useUpdateCheck.runCheck` 遇到空值直接返回，
   * 界面不显示任何更新提示，也不会报错）。
   *
   * 留空的两条理由：
   * ① 填仓库名会让买家顺着链接看到源码仓库，商用分发没必要暴露；
   * ② 国内网络访问 `api.github.com` 不稳，会反复弹「无法连接 GitHub」，反而像程序坏了。
   *
   * 需要恢复时：填成 `owner/repo`（**必须能被匿名访问**，私有仓库匿名调用一律 404），
   * `releasesUrl`、`repoUrl`、检测请求三处会一起跟着变。
   */
  updateRepo: '',
})
