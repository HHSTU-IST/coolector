/** 取小写扩展名，无扩展名时返回空串 */
export function getFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.')
    return lastDotIndex === -1 ? '' : fileName.slice(lastDotIndex + 1).toLowerCase()
}

/** 去掉扩展名后的主文件名，用于按「文件名」而非「带后缀文件名」比较 */
export function getFileBaseName(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.')
    return lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex)
}

/** 抽取 6–12 位连续数字作为学号，找不到返回 null */
export function extractStudentId(text: string): string | null {
    return text.match(/\d{6,12}/)?.[0] ?? null
}

/**
 * 归一化用于比较的文件名：去扩展名、分隔符折叠为单个空格、小写。
 * 这样 `12345678_张三.md`、`12345678 张三`、`12345678-张三.docx` 都能对齐。
 */
export function normalizeComparableName(fileName: string): string {
    return getFileBaseName(fileName)
        .replace(/[()[\]{}【】（）]+/g, ' ')
        .replace(/[_\-\s]+/g, ' ')
        .trim()
        .toLowerCase()
}
