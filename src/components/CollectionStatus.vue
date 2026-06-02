<template>
  <div v-if="collectionStore.collectionList.length > 0" class="w-full">
    <div class="bg-white rounded-lg shadow-sm border border-gray-200">
      <div class="border-b border-gray-200 p-4 sm:p-6">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-xl font-semibold text-gray-900">收集状态</h2>
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-sm text-gray-500">
              进度: {{ progress.percentage }}%
            </span>
            <button
              @click="collectionStore.clearCollection()"
              class="text-red-600 hover:text-red-900 text-sm font-medium"
            >
              清空列表
            </button>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="mt-4">
          <div class="mb-2 grid grid-cols-2 gap-2 text-sm text-gray-600 sm:flex sm:justify-between">
            <span>总文件: {{ progress.total }}</span>
            <span>已收集: {{ progress.collected }}</span>
            <span>待收集: {{ progress.pending }}</span>
            <span>错误: {{ progress.error }}</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2">
            <div
              class="bg-blue-600 h-2 rounded-full transition-all duration-300"
              :style="{ width: progress.percentage + '%' }"
            ></div>
          </div>
        </div>
      </div>

      <!-- 文件列表 -->
      <div class="p-4 sm:p-6">
        <div class="space-y-3">
          <div
            v-for="item in collectionStore.collectionList"
            :key="item.id"
            class="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 hover:bg-gray-50 sm:flex-row sm:items-center sm:justify-between"
          >
            <div class="flex min-w-0 items-start space-x-3 sm:items-center">
              <div class="flex-shrink-0">
                <div
                  class="w-3 h-3 rounded-full"
                  :class="{
                    'bg-green-500': item.status === 'collected',
                    'bg-yellow-500': item.status === 'pending',
                    'bg-red-500': item.status === 'error'
                  }"
                ></div>
              </div>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-900 truncate">{{ item.name }}</p>
                <p class="text-xs text-gray-500">{{ item.description }}</p>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2 sm:justify-end">
              <span
                class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                :class="{
                  'bg-green-100 text-green-800': item.status === 'collected',
                  'bg-yellow-100 text-yellow-800': item.status === 'pending',
                  'bg-red-100 text-red-800': item.status === 'error'
                }"
              >
                {{ getStatusText(item.status) }}
              </span>
              <span v-if="item.submittedAt" class="text-xs text-gray-500">
                {{ formatDate(item.submittedAt) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useCollectionStore } from '../stores/collection'

const collectionStore = useCollectionStore()

const progress = computed(() => collectionStore.getProgress())

const getStatusText = (status: string) => {
  switch (status) {
    case 'collected': return '已收集'
    case 'pending': return '待收集'
    case 'error': return '错误'
    default: return '未知'
  }
}

const formatDate = (date: Date) => {
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>
