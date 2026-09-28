<template>
  <div v-if="fileStore.selectedFile" class="w-full">
    <div class="bg-white rounded-lg shadow-sm border border-gray-200">
      <div class="border-b border-gray-200 p-4 sm:p-6">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="break-words text-lg font-semibold text-gray-900 sm:text-xl">{{ fileStore.selectedFile.name }}
            </h2>
            <p class="text-sm text-gray-500 mt-1">
              大小: {{ formatFileSize(fileStore.selectedFile.size) }} •
              类型: {{ fileStore.selectedFile.type || '文本文件' }} •
              修改时间: {{ formatDate(fileStore.selectedFile.lastModified) }}
            </p>
            <p class="mt-2 text-sm"
              :class="fileStore.selectedFile.filenameValidation.isValid ? 'text-green-600' : 'text-red-600'">
              {{ fileStore.selectedFile.filenameValidation.message }}
            </p>
          </div>
          <button type="button" aria-label="关闭文件预览" @click="fileStore.clearSelection()"
            class="shrink-0 rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="p-4 sm:p-6">
        <div class="mb-4">
          <div class="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 class="text-sm font-medium text-gray-900">文件内容</h3>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" @click="copyContent"
                class="rounded-md px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-900">
                复制内容
              </button>
              <button v-if="collectionItem" type="button" @click="markAsCollected"
                class="rounded-md px-2 py-1 text-sm font-medium text-green-600 hover:bg-green-50 hover:text-green-900"
                :disabled="collectionItem.status === 'collected'">
                {{ collectionItem.status === 'collected' ? '已收集' : '标记为已收集' }}
              </button>
            </div>
          </div>
        </div>

        <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div v-for="item in metadataItems" :key="item.label"
            class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <p class="text-xs text-gray-500">{{ item.label }}</p>
            <p class="mt-1 break-words text-sm font-medium text-gray-900">{{ item.value }}</p>
          </div>
        </div>

        <div class="max-h-80 overflow-auto rounded-lg bg-gray-50 p-3 sm:max-h-96 sm:p-4">
          <pre class="whitespace-pre-wrap break-words text-sm"
            :class="fileStore.selectedFile.hasTextContent ? 'text-gray-800 font-mono' : 'text-gray-600'">{{ fileStore.selectedFile.content }}</pre>
        </div>

        <div class="mt-6 border-t border-gray-200 pt-6">
          <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div class="grid gap-3 sm:grid-cols-2 flex-1">
              <div>
                <label for="relay-upload-base-url" class="block text-xs font-medium text-gray-500 mb-1">Relay 地址</label>
                <input id="relay-upload-base-url" v-model="relayUploadBaseUrl" type="url" autocomplete="off"
                  spellcheck="false"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
                  placeholder="http://127.0.0.1:8787">
              </div>
              <div>
                <label for="relay-upload-room-id" class="block text-xs font-medium text-gray-500 mb-1">房间 ID</label>
                <input id="relay-upload-room-id" v-model="relayUploadRoomId" type="text" autocomplete="off"
                  spellcheck="false"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus-visible:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/20"
                  placeholder="由接收端提供的房间号…">
                <p v-if="roomIdHint" class="mt-1 text-xs text-amber-600">{{ roomIdHint }}</p>
              </div>
            </div>

            <button type="button" @click="uploadSelectedFileToRelay" :disabled="isRelayUploading"
              class="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 md:w-auto">
              {{ isRelayUploading ? '上传中…' : 'HTTP 上传到 Relay' }}
            </button>
          </div>

          <p class="mt-3 text-sm text-gray-600">
            通过标准 HTTP `POST` 把当前文件发送到 Relay Server，接收端长连接会自动收到这次上传。
            房间需由接收端先创建；发送方无需持有任何密钥。
          </p>
          <p v-if="relayUploadMessage" role="status" aria-live="polite" class="mt-2 text-sm"
            :class="relayUploadError ? 'text-red-600' : 'text-green-600'">
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
import { toast } from '../composables/useToast'
import { formatDate, formatFileSize } from '../utils/format'
import { DEFAULT_RELAY_URL, looksWeakRoomId, normalizeRelayUrl, validateRelayUrl, validateRoomId } from '../utils/relay'
import { buildRelayUploadRequest } from '../utils/relay-upload'

const fileStore = useFileStore()
const collectionStore = useCollectionStore()
const relayUploadBaseUrl = ref(DEFAULT_RELAY_URL)
// 不再硬编码 demo-room：发送方公开写模型下房间 ID 就是能力凭据，必须由接收端提供
const relayUploadRoomId = ref('')
const isRelayUploading = ref(false)
const relayUploadMessage = ref('')
const relayUploadError = ref(false)

/** 房间号偏弱时给出非阻断提示（房间号会被分享给发送方，过易猜则可能被灌文件） */
const roomIdHint = computed(() => {
  const id = relayUploadRoomId.value.trim()
  if (!id || !looksWeakRoomId(id)) return ''
  return '该房间号看起来不是接收端生成的随机房间号，建议向接收端确认'
})

interface RelayUploadResponse {
  error?: string
}

const collectionItem = computed(() => {
  if (!fileStore.selectedFile) return null
  return collectionStore.checkFileStatus(fileStore.selectedFile.name)
})

const describeContent = () => {
  if (!fileStore.selectedFile) return ''
  if (fileStore.selectedFile.metadata.isTextContent) return '文本，可预览'
  if (fileStore.selectedFile.metadata.isExtractedText) return '文档，已提取正文'
  return '二进制，仅保留内容'
}

const metadataItems = computed(() => {
  if (!fileStore.selectedFile) return []

  const { metadata } = fileStore.selectedFile

  return [
    { label: '文件大小', value: formatFileSize(metadata.size) },
    { label: '文件类型', value: metadata.mimeType },
    { label: '扩展名', value: metadata.extension ? `.${metadata.extension}` : '无' },
    { label: '应用记录时间', value: formatDate(metadata.createdAt) },
    { label: '修改时间', value: formatDate(metadata.lastModified) },
    { label: '内容类型', value: describeContent() },
    { label: '学号', value: metadata.studentId ?? '未识别' },
    { label: '姓名', value: metadata.studentName ?? '未识别' },
    { label: '文件来源', value: fileStore.selectedFile.source === 'relay' ? 'Relay 接收' : '本地上传' }
  ]
})

const uploadSelectedFileToRelay = async () => {
  if (!fileStore.selectedFile) {
    relayUploadError.value = true
    relayUploadMessage.value = '请先选择一个文件'
    return
  }

  // 发送方这边原先只归一、不校验：写错的地址会被原样拼进请求 URL，
  // 请求最终打到静态站自己身上而不是 relay，表现为「上传成功」却谁也收不到。
  const relayUrlError = validateRelayUrl(relayUploadBaseUrl.value)
  if (relayUrlError) {
    relayUploadError.value = true
    relayUploadMessage.value = relayUrlError
    return
  }

  const baseUrl = normalizeRelayUrl(relayUploadBaseUrl.value)
  const targetRoomId = relayUploadRoomId.value.trim()
  const roomIdError = validateRoomId(targetRoomId)

  if (roomIdError) {
    relayUploadError.value = true
    relayUploadMessage.value = roomIdError
    return
  }

  try {
    isRelayUploading.value = true
    relayUploadError.value = false
    relayUploadMessage.value = '正在通过 HTTP 上传到 Relay…'

    const selectedFile = fileStore.selectedFile

    // 传输形态的选择与请求构造都在 relay-upload.ts（纯函数，可单测断言请求形状）。
    // 默认走裸 body：不做 base64、不拼 JSON，带宽 −33% 且无主线程阻塞。
    const { url, init } = await buildRelayUploadRequest({
      baseUrl,
      roomId: targetRoomId,
      name: selectedFile.name,
      mimeType: selectedFile.type,
      lastModified: selectedFile.lastModified,
      blob: selectedFile.blob,
      contentBase64: selectedFile.contentBase64,
      // docx 的提取正文没有裸 body 的位置可放，只能随信封一起走
      extractedText: selectedFile.metadata.isExtractedText ? selectedFile.content : null
    })

    // 发送方（学生）不持有接收端管理密钥：房间 ID 本身即能力凭据，故不发送 Authorization
    const response = await fetch(url, init)

    const payload = await response.json().catch(() => null) as RelayUploadResponse | null
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('房间不存在或已过期，请向接收端确认房间号')
      }
      if (response.status === 413) {
        throw new Error('文件超过接收端允许的体积上限')
      }
      if (response.status === 507) {
        throw new Error('接收端存储配额已满，请联系收集人清理')
      }
      if (response.status === 429) {
        throw new Error('该房间上传过于频繁或文件数已达上限，请稍后再试')
      }
      throw new Error(payload?.error ?? `HTTP 上传失败（${response.status}）`)
    }

    // 不再展示 downloadUrl：该端点需要接收端凭据，发送方打开只会得到 401
    relayUploadMessage.value = `已发送到房间 ${targetRoomId}，接收端会实时收到该文件`
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
      toast('内容已复制到剪贴板', 'success')
    } catch (error) {
      console.error('复制失败:', error)
      toast('复制失败，请手动复制', 'error')
    }
  }
}

const markAsCollected = () => {
  if (collectionItem.value) {
    collectionStore.updateItemStatus(collectionItem.value.id, 'collected')
    toast('已标记为已收集', 'success')
  }
}
</script>
