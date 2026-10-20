import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

export default defineNuxtPlugin((nuxtApp) => {
  const vuetify = createVuetify({
    components,
    directives,
    theme: {
      /**
       * 🎨 2026-10-19 换肤（用户要求「把原先的黑色背景改一下」）：
       * 默认主题由 `dark`（#121212 纯黑底 / #1E1E1E 卡片）改为 `light`（米白绿灰底 / 纯白卡片），
       * 主色仍是同一抹「龙猫绿」，只是从「亮色绿」压深到 `green-800` 以保证**白底上的对比度**
       * （浅色主题下 tonal 按钮 = 浅绿底 + 深绿字，`#4CAF50` 做文字会偏灰、看不清）。
       *
       * 深色主题**没有删除**：`themes.dark` 原样保留（色值同步调深一档），
       * 以后要加「夜间模式」开关只需 `theme.global.name.value = 'dark'`，
       * 前提是各组件里写死的深色值都走 `--v-theme-*` 变量 —— 本轮已把
       * 日志框 / JSON 预览框 / 地图底图 / 版本图占位框等 7 处写死的 `#0b1220`、`#1e1e1e`、
       * `rgba(255,255,255,…)` 全部改成主题变量，切主题不会再出现「暗框洞」。
       */
      defaultTheme: 'light',
      themes: {
        light: {
          dark: false,
          colors: {
            primary: '#2E7D32',
            secondary: '#00897B',
            accent: '#F57C00',
            error: '#C62828',
            info: '#1565C0',
            success: '#388E3C',
            warning: '#EF6C00',
            background: '#F4F7F2',
            surface: '#FFFFFF',
          },
        },
        dark: {
          dark: true,
          colors: {
            primary: '#4CAF50',
            secondary: '#26A69A',
            accent: '#FFB74D',
            error: '#EF5350',
            info: '#42A5F5',
            success: '#66BB6A',
            warning: '#FFA726',
            background: '#121212',
            surface: '#1E1E1E',
          },
        },
      },
    },
    defaults: {
      VBtn: { variant: 'tonal' },
      VCard: { variant: 'elevated' },
    },
  })
  nuxtApp.vueApp.use(vuetify)
})
