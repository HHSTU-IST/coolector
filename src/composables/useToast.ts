import { reactive, readonly } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
    id: number
    message: string
    type: ToastType
}

const toasts = reactive<Toast[]>([])
let seq = 0

/** 同时可见的提示上限：突发（如批量上传失败）时不让提示刷屏，超出即挤掉最旧的一条。 */
const MAX_VISIBLE_TOASTS = 5

/** 弹出一条轻量提示，3 秒后自动消失。用于替换浏览器原生 alert()。 */
export function toast(message: string, type: ToastType = 'info') {
    const id = ++seq
    toasts.push({ id, message, type })

    // 超出上限就从最旧端丢弃；被丢弃项的 setTimeout 稍后会 findIndex 到 -1，成为无害的空转
    while (toasts.length > MAX_VISIBLE_TOASTS) {
        toasts.shift()
    }

    setTimeout(() => {
        const index = toasts.findIndex((item) => item.id === id)
        if (index !== -1) {
            toasts.splice(index, 1)
        }
    }, 3000)
}

/** 供 ToastHost 组件读取当前的提示列表（只读） */
export function useToasts() {
    return readonly(toasts)
}
