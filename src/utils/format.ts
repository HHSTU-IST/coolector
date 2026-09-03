const UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB'] as const

/** 把字节数格式化为可读文本，例如 `1.5 MB` */
export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes'

    const unitBase = 1024
    const unitIndex = Math.min(
        Math.floor(Math.log(bytes) / Math.log(unitBase)),
        UNITS.length - 1
    )
    const value = bytes / Math.pow(unitBase, unitIndex)

    // 整数单位（Bytes）不需要小数位
    const formatted = unitIndex === 0 ? String(value) : value.toFixed(2)

    return `${formatted} ${UNITS[unitIndex]}`
}

/** 按 zh-CN 本地化格式化时间，非法日期回退为占位符 */
export function formatDate(date: Date | string | number | undefined | null): string {
    if (date === undefined || date === null) return '未知'

    const parsed = date instanceof Date ? date : new Date(date)
    if (Number.isNaN(parsed.getTime())) return '未知'

    return parsed.toLocaleString('zh-CN')
}
