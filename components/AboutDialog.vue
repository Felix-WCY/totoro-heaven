<template>
  <v-dialog v-model="model" max-width="480">
    <v-card>
      <v-card-title class="d-flex align-center pt-4">
        <v-icon color="primary" size="32" class="mr-2">mdi-weather-sunny</v-icon>
        <span class="text-h6 font-weight-bold">龙猫天堂</span>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">Totoro Heaven</span>
      </v-card-title>
      <v-card-subtitle class="pb-2">阳光跑（乐学/龙猫校园）跑步记录辅助工具 · 微信小程序后端线</v-card-subtitle>

      <v-divider />

      <v-card-text>
        <v-list density="compact" class="pa-0">
          <v-list-item prepend-icon="mdi-tag-outline" title="版本" :subtitle="`v${version}`" />
          <v-list-item prepend-icon="mdi-account-circle-outline" title="发布者" subtitle="龙猫天堂团队" />
        </v-list>

        <UpdateNotice compact />

        <v-alert type="info" variant="tonal" density="compact" class="mt-3">
          请遵守所在学校的规章制度，勿将本工具用于任何违规用途；因违规使用产生的后果由使用者自行承担。
        </v-alert>

        <!-- 授权与使用范围 -->
        <v-alert type="warning" variant="tonal" density="comfortable" class="mt-3">
          <div class="font-weight-bold">
            <v-icon class="mr-1" size="20">mdi-key-variant</v-icon>授权与使用范围
          </div>
          <div class="text-body-2 mt-1">
            本程序需<b>激活</b>后方可使用：到「<b>授权</b>」页输入店铺发给你的<b>卡密</b>，
            联网几秒即可完成激活，之后可<b>离线使用</b>。一份授权<b>绑定一台电脑</b>，换机器需重新购买。
          </div>
          <div class="text-caption mt-1">
            本工具应仅用于<b>本人设备</b>，并遵守所在学校的规章制度。
          </div>
        </v-alert>

      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" variant="tonal" @click="model = false">关闭</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
const model = defineModel<boolean>({ default: false })

const appConfig = useAppConfig()
const version = computed(() => (appConfig.version as string) || 'dev')
</script>