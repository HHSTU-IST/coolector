<template>
  <div class="w-full max-w-2xl mx-auto p-6">
    <div class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-gray-400 transition-colors">
      <div
        class="cursor-pointer"
        @click="triggerFileInput"
        @drop.prevent="handleDrop"
        @dragover.prevent="handleDragOver"
        @dragleave.prevent="handleDragLeave"
      >
        <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
          <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <p class="mt-2 text-sm text-gray-600">
          <span class="font-medium text-indigo-600 hover:text-indigo-500">
            点击上传文件
          </span>
          或拖拽文件到此处
        </p>
        <p class="text-xs text-gray-500 mt-1">
          支持任意格式的文本文件
        </p>
        <input
          ref="fileInput"
          type="file"
          multiple
          class="hidden"
          @click.stop
          @change="handleFileSelect"
        >
      </div>
    </div>

    <!-- 文件列表 -->
    <div v-if="fileStore.files.length > 0" class="mt-6">
      <h3 class="text-lg font-medium text-gray-900 mb-4">已上传的文件</h3>
      <div class="space-y-2">
        <div
          v-for="(file, index) in fileStore.files"
          :key="index"
          class="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <div class="flex items-center space-x-3">
            <div class="flex-shrink-0">
              <svg class="h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-900 truncate">{{ file.name }}</p>
              <p class="text-xs text-gray-500">{{ formatFileSize(file.size) }} • {{ file.type || '文本文件' }}</p>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button
              @click="fileStore.selectFile(file)"
              class="text-indigo-600 hover:text-indigo-900 text-sm font-medium"
            >
              查看
            </button>
            <button
              @click="fileStore.removeFile(index)"
              class="text-red-600 hover:text-red-900 text-sm font-medium"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 收集名单上传 -->
    <div class="mt-8">
      <h3 class="text-lg font-medium text-gray-900 mb-4">收集名单</h3>
      <div class="border-2 border-dashed border-blue-300 rounded-lg p-6 text-center hover:border-blue-400 transition-colors">
        <div
          class="cursor-pointer"
          @click="triggerCollectionInput"
          @drop.prevent="handleCollectionDrop"
          @dragover.prevent="handleDragOver"
          @dragleave.prevent="handleDragLeave"
        >
          <svg class="mx-auto h-10 w-10 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p class="mt-2 text-sm text-gray-600">
            <span class="font-medium text-blue-600 hover:text-blue-500">
              上传收集名单
            </span>
            (每行一个文件名)
          </p>
          <input
            ref="collectionInput"
            type="file"
            class="hidden"
            @click.stop
            @change="handleCollectionSelect"
            accept=".txt,.csv,.list"
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useFileStore } from '../stores/file'
import { useCollectionStore } from '../stores/collection'

const fileStore = useFileStore()
const collectionStore = useCollectionStore()
const fileInput = ref<HTMLInputElement>()
const collectionInput = ref<HTMLInputElement>()

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const markCollectionItemCollected = (fileName: string) => {
  const item = collectionStore.checkFileStatus(fileName)
  if (item && item.status !== 'collected') {
    collectionStore.updateItemStatus(item.id, 'collected')
  }
}

const uploadFiles = async (files: FileList | File[]) => {
  for (const file of Array.from(files)) {
    try {
      const fileInfo = await fileStore.addFile(file)
      markCollectionItemCollected(fileInfo.name)
    } catch (error) {
      console.error('文件上传失败:', error)
      alert(`文件上传失败: ${file.name}`)
    }
  }
}

const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (files) {
    await uploadFiles(files)
    target.value = ''
  }
}

const handleCollectionSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    try {
      await collectionStore.loadCollectionList(file)
      fileStore.files.forEach(fileInfo => {
        markCollectionItemCollected(fileInfo.name)
      })
      console.log('收集名单加载成功')
    } catch (error) {
      console.error('收集名单加载失败:', error)
      alert('收集名单加载失败，请检查文件格式')
    }
    target.value = ''
  }
}

const handleDrop = async (event: DragEvent) => {
  const files = event.dataTransfer?.files
  if (files) {
    await uploadFiles(files)
  }
}

const handleCollectionDrop = async (event: DragEvent) => {
  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    try {
      await collectionStore.loadCollectionList(files[0])
      fileStore.files.forEach(fileInfo => {
        markCollectionItemCollected(fileInfo.name)
      })
    } catch (error) {
      console.error('收集名单加载失败:', error)
      alert('收集名单加载失败，请检查文件格式')
    }
  }
}

const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
}

const handleDragLeave = (event: DragEvent) => {
  event.preventDefault()
}

const triggerFileInput = () => {
  fileInput.value?.click()
}

const triggerCollectionInput = () => {
  collectionInput.value?.click()
}


</script>
