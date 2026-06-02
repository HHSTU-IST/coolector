<script setup lang="ts">
import FileUploader from './components/FileUploader.vue'
import CollectionStatus from './components/CollectionStatus.vue'
import FileViewer from './components/FileViewer.vue'
import RelayReceiver from './components/RelayReceiver.vue'
</script>

<template>
  <div id="app" class="min-h-screen bg-gray-50">
    <header class="sticky top-0 z-20 bg-white/95 shadow-sm border-b border-gray-200 backdrop-blur">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:h-16 sm:py-0">
          <div class="flex items-center">
            <h1 class="text-2xl font-bold text-gray-900">Coolector</h1>
            <span class="ml-2 text-sm text-gray-500">文件收集器</span>
          </div>
          <nav class="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-600">
            <a href="#upload" class="rounded-md px-3 py-2 hover:bg-gray-100 hover:text-gray-900">上传</a>
            <a href="#status" class="rounded-md px-3 py-2 hover:bg-gray-100 hover:text-gray-900">状态</a>
            <a href="#preview" class="rounded-md px-3 py-2 hover:bg-gray-100 hover:text-gray-900">预览</a>
          </nav>
        </div>
      </div>
    </header>

    <main class="py-8 lg:py-10">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <section class="mb-8 rounded-3xl bg-white px-6 py-8 text-left shadow-sm ring-1 ring-gray-200 sm:px-8 lg:px-10">
          <p class="text-sm font-semibold uppercase tracking-[0.24em] text-indigo-600">Web File Collection</p>
          <h2 class="mt-3 text-3xl font-bold text-gray-900 sm:text-4xl">欢迎使用 Coolector</h2>
          <p class="mt-4 max-w-3xl text-base text-gray-600 sm:text-lg">
            一个智能的文件收集器，支持任意格式的文本文件，自动化读取文件信息并检查提交状态
          </p>
        </section>

        <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section id="upload" class="space-y-6">
            <RelayReceiver />
            <FileUploader />
          </section>

          <section id="status" class="space-y-6">
            <CollectionStatus />
            <div id="preview">
              <FileViewer />
            </div>
          </section>
        </div>
      </div>
    </main>

    <footer class="bg-white border-t border-gray-200 mt-16">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div class="text-center text-gray-500 text-sm">
          <p>&copy; 2024 Coolector. 基于 Vue.js 3.5 + TypeScript 5.7 + Vite 构建</p>
        </div>
      </div>
    </footer>
  </div>
</template>

<style>
#app {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
}
</style>
