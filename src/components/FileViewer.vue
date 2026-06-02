<template>
  <div v-if="fileStore.selectedFile" class="w-full max-w-4xl mx-auto p-6">
    <div class="bg-white rounded-lg shadow-sm border border-gray-200">
      <div class="p-6 border-b border-gray-200">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-xl font-semibold text-gray-900">{{ fileStore.selectedFile.name }}</h2>
            <p class="text-sm text-gray-500 mt-1">
              大小: {{ formatFileSize(fileStore.selectedFile.size) }} •
              类型: {{ fileStore.selectedFile.type || '文本文件' }} •
              修改时间: {{ formatDate(fileStore.selectedFile.lastModified) }}
            </p>
            <p
              class="mt-2 text-sm"
              :class="fileStore.selectedFile.filenameValidation.isValid ? 'text-green-600' : 'text-red-600'"
            >
              {{ fileStore.selectedFile.filenameValidation.message }}
            </p>
          </div>
          <button
            @click="fileStore.selectedFile = null"
            class="text-gray-400 hover:text-gray-600"
          >
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="p-6">
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-medium text-gray-900">文件内容</h3>
            <div class="flex items-center space-x-2">
              <button
                @click="copyContent"
                class="text-sm text-indigo-600 hover:text-indigo-900 font-medium"
              >
                复制内容
              </button>
              <button
                v-if="collectionItem"
                @click="markAsCollected"
                class="text-sm text-green-600 hover:text-green-900 font-medium"
                :disabled="collectionItem.status === 'collected'"
              >
                {{ collectionItem.status === 'collected' ? '已收集' : '标记为已收集' }}
              </button>
            </div>
          </div>
        </div>

        <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="item in metadataItems"
            :key="item.label"
            class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
          >
            <p class="text-xs text-gray-500">{{ item.label }}</p>
            <p class="mt-1 truncate text-sm font-medium text-gray-900">{{ item.value }}</p>
          </div>
        </div>

        <div class="bg-gray-50 rounded-lg p-4 max-h-96 overflow-auto">
          <pre
            class="text-sm whitespace-pre-wrap"
            :class="fileStore.selectedFile.hasTextContent ? 'text-gray-800 font-mono' : 'text-gray-600'"
          >{{ fileStore.selectedFile.content }}</pre>
        </div>

        <div class="mt-6 border-t border-gray-200 pt-6">
          <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div class="grid gap-3 sm:grid-cols-2 flex-1">
              <div>
                <label class="block text-xs font-medium text-gray-500 mb-1">Relay 地址</label>
                <input
                  v-model="relayUploadBaseUrl"
                  type="url"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  placeholder="http://127.0.0.1:8787"
                >
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-500 mb-1">房间 ID</label>
                <input
                  v-model="relayUploadRoomId"
                  type="text"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  placeholder="demo-room"
                >
              </div>
            </div>

            <button
              @click="uploadSelectedFileToRelay"
              :disabled="isRelayUploading"
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ isRelayUploading ? '上传中' : 'HTTP 上传到 Relay' }}
            </button>
          </div>

          <p class="mt-3 text-sm text-gray-600">
            通过标准 HTTP `POST` 把当前文件发送到 Relay Server，接收端长连接会自动收到这次上传。
          </p>
          <p v-if="relayUploadMessage" class="mt-2 text-sm" :class="relayUploadError ? 'text-red-600' : 'text-green-600'">
            {{ relayUploadMessage }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useFileStore } from '../stores/file'
import { useCollectionStore } from '../stores/collection'

const fileStore = useFileStore()
const collectionStore = useCollectionStore()
const relayUploadBaseUrl = ref(import.meta.env.VITE_RELAY_URL ?? 'http://127.0.0.1:8787')
const relayUploadRoomId = ref('demo-room')
const isRelayUploading = ref(false)
const relayUploadMessage = ref('')
const relayUploadError = ref(false)

const collectionItem = computed(() => {
  if (!fileStore.selectedFile) return null
  return collectionStore.checkFileStatus(fileStore.selectedFile.name)
})

const metadataItems = computed(() => {
  if (!fileStore.selectedFile) return []

  const { metadata } = fileStore.selectedFile

  return [
    { label: '文件大小', value: formatFileSize(metadata.size) },
    { label: '文件类型', value: metadata.mimeType },
    { label: '扩展名', value: metadata.extension ? `.${metadata.extension}` : '无' },
    { label: '应用记录时间', value: formatDate(metadata.createdAt) },
    { label: '修改时间', value: formatDate(metadata.lastModified) },
    { label: '内容类型', value: metadata.isTextContent ? '文本，可预览' : '二进制，仅保留内容' },
    { label: '学号', value: metadata.studentId ?? '未识别' },
    { label: '姓名', value: metadata.studentName ?? '未识别' },
    { label: '文件来源', value: fileStore.selectedFile.source === 'relay' ? 'Relay 接收' : '本地上传' }
  ]
})

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatDate = (date: Date): string => {
  return date.toLocaleString('zh-CN')
}

const normalizeRelayUrl = (value: string) => value.trim().replace(/\/+$/, '')

const uploadSelectedFileToRelay = async () => {
  if (!fileStore.selectedFile) {
    relayUploadError.value = true
    relayUploadMessage.value = '请先选择一个文件'
    return
  }

  const baseUrl = normalizeRelayUrl(relayUploadBaseUrl.value)
  const targetRoomId = relayUploadRoomId.value.trim()

  if (!targetRoomId) {
    relayUploadError.value = true
    relayUploadMessage.value = '房间 ID 不能为空'
    return
  }

  try {
    isRelayUploading.value = true
    relayUploadError.value = false
    relayUploadMessage.value = '正在通过 HTTP 上传到 Relay...'

    const selectedFile = fileStore.selectedFile
    const requestBody = selectedFile.hasTextContent
      ? selectedFile.content
      : JSON.stringify({
        name: selectedFile.name,
        mimeType: selectedFile.type || 'application/octet-stream',
        lastModified: selectedFile.lastModified.toISOString(),
        contentBase64: selectedFile.contentBase64
      })

    const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(targetRoomId)}/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': selectedFile.hasTextContent ? selectedFile.type || 'text/plain' : 'application/json',
        'X-Relay-Filename': selectedFile.name,
        'X-Relay-Mime-Type': selectedFile.type || 'application/octet-stream',
        'X-Relay-Last-Modified': selectedFile.lastModified.toISOString()
      },
      body: requestBody
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(payload?.error ?? 'HTTP 上传失败')
    }

    relayUploadMessage.value = `已发送到房间 ${targetRoomId}`
  } catch (error) {
    relayUploadError.value = true
    relayUploadMessage.value = error instanceof Error ? error.message : 'HTTP 上传失败'
  } finally {
    isRelayUploading.value = false
  }
}

const copyContent = async () => {
  if (fileStore.selectedFile) {
    try {
      await navigator.clipboard.writeText(fileStore.selectedFile.content)
      alert('内容已复制到剪贴板')
    } catch (error) {
      console.error('复制失败:', error)
      alert('复制失败，请手动复制')
    }
  }
}

const markAsCollected = () => {
  if (collectionItem.value) {
    collectionStore.updateItemStatus(collectionItem.value.id, 'collected')
    alert('已标记为已收集')
  }
}
</script>
