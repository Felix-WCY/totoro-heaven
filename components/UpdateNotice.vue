<template>
  <!-- ① 发现新版本：黄色报警 -->
  <v-alert
    v-if="hasUpdate"
    type="warning"
    variant="flat"
    density="comfortable"
    :class="compact ? 'mt-3' : 'mb-4'"
  >
    <div class="font-weight-bold">
      <v-icon class="mr-1">mdi-update</v-icon>发现新版本 v{{ latest }}（你正在用 v{{ appVersion }}）
    </div>
    <div class="text-body-2">
      <b>请下载并使用最新版本</b>：旧版本可能无法使用（校方接口 / 小程序会变），甚至可能产生<b>无效记录</b>。
    </div>
    <div class="d-flex flex-wrap ga-2 mt-2">
      <v-btn size="small" color="warning" variant="flat" prepend-icon="mdi-download" :href="releasesUrl" target="_blank" rel="noopener">
        去下载最新版
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="checking" @click="checkNow">立即检测</v-btn>
      <v-btn v-if="!compact" size="small" variant="text" prepend-icon="mdi-close" @click="dismissUpdate()">
        忽略本次（24 小时）
      </v-btn>
    </div>
  </v-alert>

  <!--
    ② 平时：只有一行状态（当前版本 + 与远端发布版的关系 + 何时检测过）+ 立即检测。
    🗑️ 2026-10-19（用户要求「干脆删了」）：原「无法连接到 GitHub（HTTP 403）…打开仓库页确认 / 直接看 RELEASES」
    那一整块橙色报警已删除：
      · 国内网络访问 GitHub 本来就不稳，每次启动都在顶部挂一条"无法连接"只会制造焦虑，
        而它不影响任何功能（检查是纯只读、失败静默）；
      · 现在查不到远端版本就什么都不显示（整块 v-alert 不渲染），
        只有真的拿到远端版本号时才出现下面这一行。
    ⚠️ 本段注释刻意不用 markdown 星号：`tests/mp/uiText.test.ts` 会扫模板注释里「包住中文的成对星号」，
       而注释里的写法最容易被复制进真实文案（Vue 不渲染 markdown，用户会看到字面星号）。
  -->
  <v-alert v-else-if="latest" type="info" variant="tonal" density="compact" :class="compact ? 'mt-3' : 'mb-4'">
    <span class="text-body-2">
      <v-icon size="small" class="mr-1">mdi-check-decagram-outline</v-icon>
      当前 <b>v{{ appVersion }}</b>
      <span v-if="checking" class="text-medium-emphasis"> · 正在检测…</span>
      <template v-else>
        <!-- 远端更新但用户点了「忽略本次」：不能说"已是最新"（那是假话） -->
        <span v-if="isNewerVersion(latest, appVersion)" class="text-medium-emphasis">
          · 本次提醒已忽略（远端 v{{ latest }}）
        </span>
        <!-- 本机版本更新（开发中的构建）⇒ 如实说"本机比远端发布版新"，而不是含糊地讲"已是最新" -->
        <span v-else-if="localAheadOfRemote" class="text-medium-emphasis">
          · 本机版本比远端发布版新（远端 v{{ latest }}）
        </span>
        <span v-else class="text-medium-emphasis"> · 已是最新（远端 v{{ latest }}）</span>
        <!-- 检测时间单独一段：避免和上面那些「（…）」叠成括号套括号 -->
        <span class="text-medium-emphasis"> · {{ checkedText }}</span>
      </template>
      <v-btn size="x-small" variant="text" class="ml-2" prepend-icon="mdi-refresh" :loading="checking" @click="checkNow">
        立即检测
      </v-btn>
    </span>
  </v-alert>
</template>

<script setup lang="ts">
/** 版本比较（判断"远端是不是真的更新" / "本机是不是比远端新"）—— 措辞必须按它来说 */
import { compareVersions, isNewerVersion } from '~/utils/mp/version'

/**
 * 「版本状态」一行 + 「立即检测」（2026-09-16 用户要求；2026-10-19 两次调整）
 *
 * - 工作台顶部（`compact=false`）：只有两种情况会渲染 ——
 *   ① 远端**真的**比本机新 → 黄色报警 + 下载按钮；
 *   ② 其余（查到了远端版本且不比本机新）→ 一行「当前 v1.3.2 · 本机版本比远端发布版新（远端 v1.3.1）」+ 立即检测。
 *   **连不上 GitHub 就什么都不渲染**（2026-10-19 用户要求删掉那条橙色报警）。
 * - 「关于」对话框（`compact=true`）：同样内容，但紧凑些、不显示"忽略本次"。
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const showSnackbar = useNotice()
// ⚠️ `repoUrl` 不再需要（原来只给已删除的"打开仓库页确认"按钮用）；`error` 只用来决定手动检测后的提示语
const { latest, hasUpdate, checking, error, checkedAt, fromCache, appVersion, releasesUrl, checkForUpdate, forceCheck, dismissUpdate } =
  useUpdateCheck()

/** 手动「立即检测」：强制重新请求，并把结果直接反馈给用户 */
const checkNow = async () => {
  await forceCheck()
  if (error.value) showSnackbar('这次没查到远端版本（GitHub 连不上 / 仓库查不到），不影响任何功能', 'info')
  else if (hasUpdate.value) showSnackbar(`发现新版本 v${latest.value}，请下载最新版使用`, 'warning')
  // 2026-10-19：本机版本更新时**别再说"已是最新"**（容易被读成"远端有更新的"），如实说明两者关系
  else if (localAheadOfRemote.value)
    showSnackbar(`本机 v${appVersion.value} 比远端发布版 v${latest.value} 新（本机已是最新）`, 'success')
  else showSnackbar(`已是最新版本（v${appVersion.value}）${latest.value ? ` · 远端 v${latest.value}` : ''}`, 'success')
}

/** 本机版本**比远端发布版更新**（开发中的构建）—— 界面据此避免"劝升级"的矛盾措辞 */
const localAheadOfRemote = computed(() => Boolean(latest.value) && compareVersions(appVersion.value, latest.value) > 0)

/**
 * 上次检测时间的相对文案。
 * ⚠️ 用缓存时明确标注"本地缓存"，避免看起来像刚查过；措辞里**不再自带括号**，
 *    因为它直接接在「（远端 vX）」后面，再套一层就变成"（…（…））"了。
 */
const checkedText = computed(() => {
  if (!checkedAt.value) return '还没检测过'
  const sec = Math.max(0, Math.round((Date.now() - checkedAt.value) / 1000))
  const age = sec < 60 ? '刚刚' : sec < 3600 ? `${Math.floor(sec / 60)} 分钟前` : `${Math.floor(sec / 3600)} 小时前`
  return fromCache.value ? `${age}的缓存结果，点「立即检测」刷新` : `${age}检测`
})

onMounted(() => void checkForUpdate())
</script>
