import { reactive, readonly } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
    id: number
    message: string
    type: ToastType
}

const toasts = reactive<Toast[]>([])
let seq = 0

/** 弹出一条轻量提示，3 秒后自动消失。用于替换浏览器原生 alert()。 */
export function toast(message: string, type: ToastType = 'info') {
    const id = ++seq
    toasts.push({ id, message, type })

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
