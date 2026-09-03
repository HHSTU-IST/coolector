<script setup lang="ts">
import { useToasts } from '../composables/useToast'

const toasts = useToasts()
</script>

<template>
    <Teleport to="body">
        <div class="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4">
            <div
                v-for="item in toasts"
                :key="item.id"
                class="pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 text-center text-sm font-medium shadow-sm"
                :class="{
                    'border-green-200 bg-green-50 text-green-800': item.type === 'success',
                    'border-red-200 bg-red-50 text-red-800': item.type === 'error',
                    'border-slate-200 bg-white text-slate-800': item.type === 'info'
                }"
            >
                {{ item.message }}
            </div>
        </div>
    </Teleport>
</template>
