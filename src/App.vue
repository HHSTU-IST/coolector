<script setup lang="ts">
import FileUploader from './components/FileUploader.vue'
import CollectionStatus from './components/CollectionStatus.vue'
import FileViewer from './components/FileViewer.vue'
import RelayReceiver from './components/RelayReceiver.vue'
</script>

<template>
  <div id="app" class="min-h-screen bg-slate-50 text-slate-900">
    <header class="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div class="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
        <div class="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between sm:h-16 sm:py-0">
          <div class="flex items-center gap-3">
            <span class="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-slate-900 text-white">
              <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <use href="/icons.svg#documentation-icon"></use>
              </svg>
            </span>
            <div class="leading-tight">
              <h1 class="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Coolector</h1>
              <p class="text-sm text-slate-500">文件收集器</p>
            </div>
          </div>
          <nav class="grid grid-cols-3 gap-2 text-center text-sm font-medium text-slate-600 sm:flex sm:flex-wrap sm:items-center">
            <a href="#upload" class="rounded-md border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900">上传</a>
            <a href="#status" class="rounded-md border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900">状态</a>
            <a href="#preview" class="rounded-md border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900">预览</a>
          </nav>
        </div>
      </div>
    </header>

    <main class="py-5 sm:py-8 lg:py-10">
      <div class="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
        <section class="mb-5 border-b border-slate-200 pb-5 sm:mb-8 sm:pb-6">
          <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div class="max-w-3xl">
              <p class="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600 sm:text-sm">Web File Collection</p>
              <h2 class="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-4xl">欢迎使用 Coolector</h2>
              <p class="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                一个轻量文件收集工作台，支持上传、校验、收集名单和 Relay 长连接。
              </p>
            </div>
            <div class="flex flex-wrap gap-2 text-xs font-medium text-slate-600">
              <span class="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5">上传</span>
              <span class="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5">校验</span>
              <span class="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5">Relay</span>
            </div>
          </div>
        </section>

        <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
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

    <footer class="mt-16 border-t border-slate-200 bg-white">
      <div class="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div class="text-center text-sm text-slate-500">
          <p>&copy; 2024 Coolector. 基于 Vue.js 3.5 + TypeScript 5.7 + Vite 构建</p>
        </div>
      </div>
    </footer>
  </div>
</template>
