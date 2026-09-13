<template>
  <div class="w-full">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <div class="border-b border-gray-200 p-4 sm:p-6">
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-500">Receiver Long Connection</p>
            <h2 class="text-xl font-semibold text-gray-900 mt-1">公网接收长连接</h2>
            <p class="text-sm text-gray-500 mt-2">
              通过 SSE 保持和 Relay Server 的长连接，自动接收远端上传并灌入本地文件列表。
            </p>
          </div>

          <div class="text-left md:text-right">
            <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium"
              :class="statusBadgeClass">
              {{ statusLabel }}
            </span>
            <p class="text-xs text-gray-500 mt-2" aria-live="polite">{{ statusMessage }}</p>
          </div>
        </div>
      </div>

      <div class="grid gap-5 p-4 sm:p-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-6">
        <form class="space-y-4" @submit.prevent="() => connect()">
          <div>
            <label for="relay-base-url" class="block text-sm font-medium text-gray-700 mb-2">Relay 地址</label>
            <input id="relay-base-url" v-model="relayBaseUrl" type="url" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
              placeholder="http://127.0.0.1:8787">
          </div>

          <div>
            <label for="relay-token" class="block text-sm font-medium text-gray-700 mb-2">
              接收端密钥 <span class="font-normal text-gray-400">（可选）</span>
            </label>
            <input id="relay-token" v-model="relayToken" type="password" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
              placeholder="Relay 的 RELAY_TOKEN，仅保存在本机浏览器…">
            <p class="mt-1 text-xs text-gray-500">
              密钥不再随页面分发，只保存在本机 localStorage。若 Relay 未配置 RELAY_TOKEN 可留空。
            </p>
          </div>

          <div>
            <label for="relay-room-id" class="block text-sm font-medium text-gray-700 mb-2">房间 ID</label>
            <input id="relay-room-id" v-model="roomId" type="text" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
              placeholder="留空则由服务端生成随机房间号…">
            <p v-if="roomIdHint" class="mt-1 text-xs text-amber-600">{{ roomIdHint }}</p>
          </div>

          <div class="grid gap-3 sm:flex sm:flex-wrap">
            <button type="submit" :disabled="connectionState === 'connecting'"
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
              {{ connectionState === 'connected' ? '重新连接' : '建立长连接' }}
            </button>
            <button type="button" @click="disconnect" :disabled="!eventSource"
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60">
              断开连接
            </button>
          </div>

          <div class="rounded-xl bg-indigo-50 border border-indigo-100 p-4 text-sm text-indigo-900">
            <p class="font-medium">连接说明</p>
            <p class="mt-1">
              连接后会创建或进入房间，然后打开 `/events` 的 SSE 通道，接收到 `upload.created` 后自动拉取文件内容。
              房间号需先在此创建、再分享给发送方 —— 发送方无需任何密钥。
            </p>
          </div>
        </form>

        <div class="space-y-4">
          <div class="rounded-xl border border-gray-200 p-4">
            <div class="grid grid-cols-2 gap-3 text-sm tabular-nums">
              <div>
                <p class="text-gray-500">房间</p>
                <p class="font-medium text-gray-900 truncate">{{ roomState?.roomId ?? '未连接' }}</p>
              </div>
              <div>
                <p class="text-gray-500">上传数</p>
                <p class="font-medium text-gray-900">{{ roomState?.uploadCount ?? 0 }}</p>
              </div>
              <div>
                <p class="text-gray-500">存储用量</p>
                <p class="font-medium" :class="storageUsageRatio >= 0.9 ? 'text-red-600' : 'text-gray-900'">
                  {{ storageUsageLabel }}
                </p>
              </div>
              <div>
                <p class="text-gray-500">接收端连接</p>
                <p class="font-medium text-gray-900">{{ roomState?.stats.receiverConnections ?? 0 }}</p>
              </div>
              <div>
                <p class="text-gray-500">已转发事件</p>
                <p class="font-medium text-gray-900">{{ roomState?.stats.eventsDelivered ?? 0 }}</p>
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-gray-200 p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-900">最近事件</h3>
              <span class="text-xs text-gray-500">{{ recentEvents.length }} 条</span>
            </div>
            <div class="space-y-2 max-h-56 overflow-auto pr-1">
              <div v-for="event in recentEvents" :key="event.id"
                class="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <p class="font-medium text-gray-900">{{ event.type }}</p>
                <p class="mt-1 text-gray-500">{{ event.message }}</p>
              </div>
              <p v-if="recentEvents.length === 0" class="text-xs text-gray-500">
                连接后这里会显示 receiver.ready 和上传事件。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRelayReceiver } from '../composables/useRelayReceiver'

const {
  relayToken,
  roomId,
  roomIdHint,
  relayBaseUrl,
  connectionState,
  statusLabel,
  statusBadgeClass,
  statusMessage,
  roomState,
  recentEvents,
  eventSource,
  storageUsageRatio,
  storageUsageLabel,
  connect,
  disconnect
} = useRelayReceiver()
</script>
