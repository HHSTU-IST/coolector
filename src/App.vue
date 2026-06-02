<script setup lang="ts">
import FileUploader from './components/FileUploader.vue'
import CollectionStatus from './components/CollectionStatus.vue'
import FileViewer from './components/FileViewer.vue'
import RelayReceiver from './components/RelayReceiver.vue'
</script>

<template>
  <div id="app" class="min-h-screen bg-gray-50">
    <header class="sticky top-0 z-20 bg-white/95 shadow-sm border-b border-gray-200 backdrop-blur">
      <div class="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
        <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:h-16 sm:py-0">
          <div class="flex flex-wrap items-center">
            <h1 class="text-xl font-bold text-gray-900 sm:text-2xl">Coolector</h1>
            <span class="ml-2 text-sm text-gray-500">文件收集器</span>
          </div>
          <nav class="grid grid-cols-3 gap-2 text-center text-sm font-medium text-gray-600 sm:flex sm:flex-wrap sm:items-center">
            <a href="#upload" class="rounded-md bg-gray-50 px-3 py-2 hover:bg-gray-100 hover:text-gray-900 sm:bg-transparent">上传</a>
            <a href="#status" class="rounded-md bg-gray-50 px-3 py-2 hover:bg-gray-100 hover:text-gray-900 sm:bg-transparent">状态</a>
            <a href="#preview" class="rounded-md bg-gray-50 px-3 py-2 hover:bg-gray-100 hover:text-gray-900 sm:bg-transparent">预览</a>
          </nav>
        </div>
      </div>
    </header>

    <main class="py-5 sm:py-8 lg:py-10">
      <div class="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
        <section class="mb-5 rounded-2xl bg-white px-4 py-6 text-left shadow-sm ring-1 ring-gray-200 sm:mb-8 sm:rounded-3xl sm:px-8 sm:py-8 lg:px-10">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600 sm:text-sm sm:tracking-[0.24em]">Web File Collection</p>
          <h2 class="mt-3 text-2xl font-bold text-gray-900 sm:text-4xl">欢迎使用 Coolector</h2>
          <p class="mt-4 max-w-3xl text-base text-gray-600 sm:text-lg">
            一个智能的文件收集器，支持任意格式的文本文件，自动化读取文件信息并检查提交状态
          </p>
        </section>

        <div class="grid items-start gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section id="upload" class="space-y-5">
            <RelayReceiver />
            <FileUploader />
          </section>

          <section id="status" class="space-y-5">
            <CollectionStatus />
            <div id="preview">
              <FileViewer />
            </div>
          </section>
        </div>
      </div>
    </main>

    <footer class="bg-white border-t border-gray-200 mt-16">
      <div class="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div class="text-center text-gray-500 text-sm">
          <p>&copy; 2024 Coolector. 基于 Vue.js 3.5 + TypeScript 5.7 + Vite 构建</p>
        </div>
      </div>
    </footer>
  </div>
</template>
