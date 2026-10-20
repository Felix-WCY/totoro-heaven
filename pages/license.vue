<template>
  <div>
    <!-- 被全局路由守卫拦到这里的说明（`?need=1`）：用户本来想进别的页，被送到这里，
         不解释一句会让人莫名其妙 -->
    <v-alert v-if="blockedHere" type="warning" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-lock-alert</v-icon>需要先完成激活
      </div>
      <div class="text-body-2">
        本程序需要激活才能使用。<b>在店铺购买的话</b>，把订单里收到的<b>卡密</b>填进下面的「输入卡密激活」即可；
        如果发布者直接发了一段授权证书给你，点页面下方「改用授权证书激活」。
      </div>
    </v-alert>

    <!-- 由服务端状态推导的横幅（即将到期 / 宽限期 / 已过期）；与顶栏 chip 同源 -->
    <v-alert v-if="policyBanner" :type="policyBanner.type" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-alert-circle-outline</v-icon>{{ policyBanner.title }}
      </div>
      <div class="text-body-2">{{ policyBanner.text }}</div>
    </v-alert>

    <!-- 开发模式提示：dev 下不校验（生产构建会强制） -->
    <v-alert v-if="status.devBypass" type="info" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-wrench-outline</v-icon>开发模式：授权校验已跳过
      </div>
      <div class="text-body-2">
        当前运行的是开发版（<code>npm run dev</code>），授权<b>不生效</b>；<b>打包后的正式版会强制校验</b>。
        想在本机按正式版口径自测：设环境变量 <code>TOTORO_LICENSE_STRICT=1</code> 再启动。
      </div>
    </v-alert>

    <!-- 公钥未配置：这是「发布方」的配置问题，用户做什么都没用，必须明确指出，避免用户白折腾 -->
    <v-alert v-if="!status.publicKeyConfigured" type="error" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-alert-octagon-outline</v-icon>本程序尚未配置许可证公钥
      </div>
      <div class="text-body-2">
        发布者还没有执行 <code>node tools/license-keygen.ts</code>，因此<b>任何证书都无法通过校验</b>。
        请联系发布者重新打包后再试（这是打包问题，不是你操作错了）。
      </div>
    </v-alert>

    <!-- 机器码未能持久化：必须提前警告，否则用户"下次开机又要重新激活"，会以为是 bug -->
    <v-alert v-if="!status.machineCodeStable" type="warning" variant="tonal" density="comfortable" class="mb-4">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-content-save-alert-outline</v-icon>机器码无法持久保存
      </div>
      <div class="text-body-2">
        本机写不进授权目录（<code>{{ status.dir }}</code>），<b>下次启动机器码会变、授权将失效</b>。
        请检查该目录的写入权限，或换一个可写位置后再激活。
      </div>
    </v-alert>

    <!-- ① 当前状态 -->
    <v-card class="mb-4">
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <v-icon :color="status.licensed ? 'success' : 'warning'" class="mr-1">
          {{ status.licensed ? 'mdi-shield-check-outline' : 'mdi-shield-alert-outline' }}
        </v-icon>
        <span class="text-h6">授权状态</span>
        <v-chip :color="status.licensed ? 'success' : 'warning'" variant="tonal" size="small">
          {{ status.licensed ? '已授权' : '未授权' }}
        </v-chip>
        <v-chip v-if="status.degraded" color="warning" variant="flat" size="small">
          已到期 · 宽限期内
        </v-chip>
      </v-card-title>
      <v-card-text>
        <div class="text-body-2 mb-3">{{ status.message }}</div>

        <v-table v-if="status.licensed" density="compact">
          <tbody>
            <tr><td class="text-medium-emphasis" style="width: 140px">授权对象</td><td>{{ textOr(status.subject) }}</td></tr>
            <tr><td class="text-medium-emphasis">许可证编号</td><td>{{ textOr(status.licenseId) }}</td></tr>
            <tr><td class="text-medium-emphasis">功能位</td><td>{{ status.features.length ? status.features.join('、') : '—' }}</td></tr>
            <tr><td class="text-medium-emphasis">剩余</td><td>{{ daysLeftText }}</td></tr>
            <tr><td class="text-medium-emphasis">正常到期</td><td>{{ fmtTime(status.expiresAt) }}</td></tr>
            <tr><td class="text-medium-emphasis">离线宽限至</td><td>{{ fmtTime(status.graceUntil) }}（超过它一律拒绝）</td></tr>
            <tr><td class="text-medium-emphasis">激活时间</td><td>{{ textOr(status.activatedAt) }}</td></tr>
          </tbody>
        </v-table>

        <div class="d-flex flex-wrap ga-2 mt-4">
          <v-btn variant="tonal" size="small" prepend-icon="mdi-refresh" :loading="loading" @click="refresh">刷新状态</v-btn>
          <v-btn v-if="status.licensed" variant="tonal" size="small" color="primary" prepend-icon="mdi-home-outline" to="/">
            去工作台
          </v-btn>
          <v-btn
            v-if="status.licensed"
            variant="tonal"
            size="small"
            color="error"
            prepend-icon="mdi-link-variant-off"
            :loading="busy"
            @click="doDeactivate"
          >
            解除本机授权
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- ② 卡密激活（买家从店铺拿到的卡密 —— 最常见路径，所以放最前面） -->
    <v-card class="mb-4">
      <v-card-title class="d-flex align-center">
        <v-icon class="mr-1">mdi-ticket-confirmation-outline</v-icon>
        <span class="text-h6">输入卡密激活</span>
      </v-card-title>
      <v-card-text>
        <div class="text-body-2 mb-2">
          在店铺下单后你会收到一张<b>卡密</b>（形如 TH-ABCD-EFGH）。填在下面，程序会自动联网换成本机可用的授权。
        </div>
        <v-text-field
          v-model="cardCode"
          label="卡密"
          placeholder="TH-ABCD-EFGH"
          variant="outlined"
          density="comfortable"
          hide-details
          class="card-code"
          @keyup.enter="doActivateCard"
        />

        <v-alert v-if="cardError" type="error" variant="tonal" density="comfortable" class="mt-3">
          {{ cardError }}
        </v-alert>

        <div class="d-flex flex-wrap ga-2 mt-3">
          <v-btn color="primary" variant="flat" prepend-icon="mdi-cloud-download-outline" :loading="busy" @click="doActivateCard">
            卡密激活
          </v-btn>
          <v-btn variant="text" :disabled="!cardCode" @click="cardCode = ''">清空卡密</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- 通用错误提示：放在折叠区外面，收起时也要能看到（刷新失败 / 复制失败 / 解绑失败都走这里） -->
    <v-alert v-if="errorText" type="error" variant="tonal" density="comfortable" class="mb-4">
      {{ errorText }}
    </v-alert>

    <!-- ③ 手动激活（备用通道：没有卡密、或卡密一直激活不了时用）
         默认收起 —— 绝大多数买家走卡密，这些内容对他们纯属干扰 -->
    <v-card class="mb-4">
      <v-card-text>
        <div class="d-flex align-center justify-space-between flex-wrap ga-2">
          <span class="text-body-2 text-medium-emphasis">
            没有卡密？或者卡密激活一直失败？可以走手动激活。
          </span>
          <v-btn
            variant="tonal"
            size="small"
            :prepend-icon="showCertPanel ? 'mdi-chevron-up' : 'mdi-lifebuoy'"
            @click="showCertPanel = !showCertPanel"
          >
            {{ showCertPanel ? '收起' : '手动激活（选填）' }}
          </v-btn>
        </div>

        <div v-if="showCertPanel" class="mt-4">
          <!-- 机器码：只有手动签发证书时才需要把它发给发布者 -->
          <div class="text-body-2 mb-2">
            需要<b>本机机器码</b>时，把它发给发布者，发布者会为你签发一张绑定本机的授权证书。
            换一台机器要重新签发。
          </div>
          <div class="d-flex align-center flex-wrap ga-2">
            <code class="machine-code">{{ textOr(status.machineCode) }}</code>
            <v-btn variant="tonal" size="small" prepend-icon="mdi-content-copy" @click="copyMachineCode">
              复制机器码
            </v-btn>
          </div>
          <div class="text-caption text-medium-emphasis mt-2">
            数据目录：<code>{{ textOr(status.dir) }}</code>
          </div>

          <v-divider class="my-4" />

          <!-- 证书：发布者直接把证书发给你时用 -->
          <div class="text-body-2 mb-2">
            拿到证书后，把<b>整段证书</b>粘贴到下面 —— 换行、空格都会被自动忽略，不用担心复制多出空行。
          </div>
          <v-textarea
            v-model="certificate"
            label="授权证书"
            placeholder="粘贴形如 xxxxx.xxxxx 的一整段文本"
            rows="4"
            auto-grow
            variant="outlined"
            density="comfortable"
            hide-details
          />

          <div class="d-flex flex-wrap ga-2 mt-3">
            <v-btn color="primary" variant="flat" prepend-icon="mdi-check-decagram" :loading="busy" @click="doActivate">
              激活
            </v-btn>
            <v-btn variant="text" :disabled="!certificate" @click="certificate = ''">清空证书</v-btn>
          </div>
        </div>
      </v-card-text>
    </v-card>

    <!-- ④ 说明 -->
    <v-alert type="info" variant="tonal" density="comfortable">
      <div class="font-weight-bold">
        <v-icon class="mr-1">mdi-information-outline</v-icon>关于授权
      </div>
      <ul class="text-body-2 pl-4 mt-1">
        <li>证书采用<b>非对称签名</b>校验：本程序只内置<b>公钥</b>，私钥始终在发布者本机，因此<b>无法伪造</b>证书；</li>
        <li>卡密激活需要<b>联网一次</b>（向激活服务器换取本机证书）；激活完成后即可<b>离线使用</b>，正常到期后还有一段离线宽限期；</li>
        <li>请勿转发证书或公开分享本软件：证书与本机机器码绑定，转发到别的机器上<b>用不了</b>，只会白费功夫。</li>
      </ul>
    </v-alert>
  </div>
</template>

<script setup lang="ts">
/**
 * 「授权」页 —— 展示本机机器码 + 录入/解除授权证书 + 状态提示。
 *
 * ## 状态从哪来
 * 统一走 `composables/useLicenseState.ts`（与**路由守卫、顶栏状态 chip 共用同一份缓存**）。
 * 页面不再自己维护一份 DTO —— 三处各存一份，迟早会出现"顶栏说已授权、页面还在拦"的自相矛盾。
 *
 * ## 本页**不做任何业务判断**
 * "能不能用"由服务端中间件决定（`server/middleware/license.ts`）。本页只负责展示与录入 ——
 * 前端说了不算，改前端也绕不过去（这正是闸门放在服务端的意义）。
 *
 * ## 为什么状态用**非空默认值**
 * `emptyLicenseStatus()` 字段齐全，`ui` 由纯函数推导恒为完整对象 ⇒ 模板不必到处写 `?.`
 * （也避开了仓库 R7 守卫对可空状态的检查）。
 */
import { useLicenseState } from '~/composables/useLicenseState'
import { useNotice } from '~/composables/useNotice'
import type { LicenseStatusView } from '~/utils/mp/licensePolicy'

const route = useRoute()
const showSnackbar = useNotice()

const { status, ui, loading, refresh: refreshState, applyStatus } = useLicenseState()

const certificate = ref('')
const busy = ref(false)
const errorText = ref('')
/** 「改用授权证书激活」面板是否展开（默认收起：拿卡密的买家不该被这个干扰） */
const showCertPanel = ref(false)
/** 卡密（在线激活用）。与「粘贴证书」是两条并列的路，各自独立的错误提示，互不覆盖 */
const cardCode = ref('')
const cardError = ref('')

/** 是否是从别的页面被路由守卫拦过来的（`?need=1`） */
const blockedHere = computed(() => route.query.need === '1')

/** 除"开发模式"以外的横幅（开发模式在本页有自己更详细的专用提示，不重复显示） */
const policyBanner = computed(() => (ui.value.kind === 'dev' ? null : ui.value.banner))

/** 空值统一显示为短横线（避免表格里出现空白单元格，看起来像没加载出来） */
const textOr = (s: string): string => (s && s.trim() ? s : '—')

/** Unix 秒 → 本地时间（0/缺失显示短横线） */
const fmtTime = (sec: number): string =>
  sec > 0 ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'

/** 强制重读（缓存与错误处理都在 `useLicenseState()` 里，这里只管页面提示） */
const refresh = async (): Promise<void> => {
  errorText.value = ''
  const ok = await refreshState()
  if (!ok) errorText.value = '读取授权状态失败，请稍后重试'
}

/** 剩余天数文案（null = 无期限；负数 = 已过期） */
const daysLeftText = computed((): string => {
  const n = ui.value.daysLeft
  if (n === null) return '—'
  if (n < 0) return `已过期 ${-n} 天`
  if (n === 0) return '今天到期'
  return `${n} 天`
})

const copyMachineCode = async (): Promise<void> => {
  if (!status.value.machineCode) {
    errorText.value = '机器码还没读出来，请先点「刷新状态」'
    return
  }
  try {
    await navigator.clipboard.writeText(status.value.machineCode)
    showSnackbar('机器码已复制，把它发给发布者即可', 'success')
  } catch {
    // 剪贴板可能被浏览器策略拒绝（非 https/无权限）⇒ 降级为"让用户手动选中复制"，不报错打断流程
    errorText.value = '无法自动复制，请手动选中上面的机器码复制'
  }
}

/** 激活：失败时把服务端返回的**具体原因**显示出来（不同原因的处理方式完全不同） */
const doActivate = async (): Promise<void> => {
  if (!certificate.value.trim()) {
    errorText.value = '请先粘贴授权证书'
    return
  }
  busy.value = true
  try {
    const res = await $fetch<{ ok: boolean; error: string; status: LicenseStatusView }>('/api/local/license/activate', {
      method: 'POST',
      body: { certificate: certificate.value },
    })
    applyStatus(res.status)
    if (res.ok) {
      errorText.value = ''
      certificate.value = ''
      showSnackbar('授权激活成功', 'success')
    } else {
      errorText.value = res.error
    }
  } catch (e) {
    errorText.value = `激活请求失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

/**
 * 卡密激活：本机把「卡密 + 机器码」发给激活服务，服务端用私钥现签一张**绑定本机**的证书回来。
 *
 * ⚠️ 服务端返回的证书仍然走**本地验签**（`activateLicense`）—— 服务端说"成功"不算数。
 *    这样即使激活地址被改到一个伪造服务器，对方也签不出能通过校验的证书（他没有私钥）。
 */
const doActivateCard = async (): Promise<void> => {
  if (!cardCode.value.trim()) {
    cardError.value = '请先填写卡密'
    return
  }
  busy.value = true
  cardError.value = ''
  try {
    const res = await $fetch<{ ok: boolean; error: string; status: LicenseStatusView }>(
      '/api/local/license/activate-card',
      { method: 'POST', body: { card: cardCode.value } },
    )
    applyStatus(res.status)
    if (res.ok) {
      cardCode.value = ''
      showSnackbar('卡密激活成功', 'success')
    } else {
      cardError.value = res.error
    }
  } catch (e) {
    cardError.value = `激活请求失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

const doDeactivate = async (): Promise<void> => {
  busy.value = true
  try {
    const res = await $fetch<{ ok: boolean; status: LicenseStatusView }>('/api/local/license/deactivate', { method: 'POST' })
    applyStatus(res.status)
    errorText.value = ''
    showSnackbar('已解除本机授权（如需再次使用请重新激活）', 'info')
  } catch (e) {
    errorText.value = `解除授权失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
useHead({ title: '授权 · 龙猫天堂' })
</script>

<style scoped>
/* 卡密用等宽字体 + 字距：用户要照着输入或核对，等宽更好认 */
.card-code :deep(input) {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  letter-spacing: 0.08em;
}

/* 机器码用等宽字体 + 大字距：用户要一个字符一个字符念给发布者，必须好认 */
.machine-code {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 1.05rem;
  letter-spacing: 0.08em;
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  user-select: all;
}
</style>
