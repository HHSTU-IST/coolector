import { defineStore } from 'pinia'
import { ref } from 'vue'
import { formatFileSize } from '../utils/format'
import { extractStudentId, getFileBaseName, getFileExtension } from '../utils/filename'
import { binaryPlaceholder } from '../utils/relay-content'

export interface FileInfo {
    id: string
    name: string
    content: string
    /**
     * 原始字节句柄（本地新增的文件才有）。
     *
     * 上传时直接把它当请求体 —— 不再预先转 base64。这不是单纯的省内存：
     * `File` 由浏览器持有、底层通常是磁盘上的文件，而 base64 字符串是实打实的 JS 堆内存，
     * 10MB 文件要吃掉 13.3MB 且生成时阻塞主线程。
     *
     * 中继接收来的文件没有这个字段（服务端只回传 base64），上传时在本地做一次
     * base64 → Blob 的**懒**转换（见 `buildRelayUploadRequest`）—— 只有真要重传时才付这个代价。
     */
    blob?: Blob
    contentBase64?: string
    hasTextContent: boolean
    filenameValidation: FileNameValidation
    metadata: FileMetadata
    size: number
    type: string
    lastModified: Date
    source: 'local' | 'relay'
    relayRoomId?: string
    relayUploadId?: string
    receivedAt?: Date
}

export interface FileNameValidation {
    isValid: boolean
    pattern: string
    message: string
}

export interface FileMetadata {
    baseName: string
    extension: string
    size: number
    mimeType: string
    createdAt: Date
    lastModified: Date
    isTextContent: boolean
    studentId: string | null
    studentName: string | null
}

/** 文件名范式最大长度，防止超长正则拖慢校验 */
const MAX_PATTERN_LENGTH = 200

/** 单个文件体积上限（10 MB，与 Relay 默认 MAX_FILE_BYTES 对齐） */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 文件总数上限，控制整体内存占用 */
export const MAX_FILES = 200

/**
 * 全部文件体积之和上限。
 *
 * 单条 10MB × 200 条 ⇒ 理论上限 2GB，全部常驻前端堆（文本文件的 `content` 是解码后的
 * 字符串、中继文件还有 `contentBase64`），足以让标签页直接 OOM。条数上限拦不住这种情形：
 * 200 个 10MB 文件合法通过 `MAX_FILES`，却要吃掉 2GB。
 *
 * 取值与服务端 `MAX_ROOM_UPLOAD_BYTES` 的默认值（全局配额 1GB 的 1/8）一致 —— 本地装得下
 * 的量本来也传不进一个房间，提前在本地拦下比上传到一半被 507 拒绝更友好。
 *
 * 记账口径是各文件的 `size`（原始字节）。它与真实堆占用有两处偏差，均偏向安全：
 * ① 容器类文档（docx）在本地只留一句占位文案，按 `size` 计会**高估**；
 * ② 中继接收来的文件以 base64 常驻（≈1.33×），按 `size` 计会**低估 33%**，
 *    但该方向另有服务端房间配额逐房间兜底（见 `upsertRelayFile`）。
 */
export const MAX_TOTAL_SIZE = 128 * 1024 * 1024

/** 嵌套量词（如 (a+)+、(a*)*、(a?)*、(a{2,})+），不匹配输入时指数级回溯；`?` 也计入内层量词 */
const UNSAFE_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*?]|\{\d+,?\d*\})\)\s*(?:[+*]|\{\d+,?\d*\})/u

/** 带量词的重叠分支（如 (a|a)+、(a|ab)+），同样指数级回溯 */
const UNSAFE_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/u

export const useFileStore = defineStore('file', () => {
    const files = ref<FileInfo[]>([])
    const selectedFile = ref<FileInfo | null>(null)

    /**
     * 已入列文件的体积之和（字节），与 `files` 严格同步。
     *
     * 本变量是**唯一**允许改动客户端体积计数的地方（对应服务端的 `relay-state.js`）。
     * 它必须与 `files` 的增删同步更新，且**增量的检查与扣减之间不能插入 `await`** ——
     * 否则并发 `addFile` 会同时读到旧值而击穿 `MAX_TOTAL_SIZE`（铁律 14，服务端曾因此
     * 把 4MB 配额打到 8.39×）。
     */
    const usedBytes = ref(0)
    const filenamePattern = ref('^.+\\.(md|ipynb|docx)$')
    const filenamePatternError = ref('')
    const textFileExtensions = new Set([
        'csv',
        'css',
        'env',
        'htm',
        'html',
        'ini',
        'ipynb',
        'js',
        'json',
        'jsx',
        'log',
        'md',
        'scss',
        'sql',
        'toml',
        'ts',
        'tsx',
        'txt',
        'xml',
        'yaml',
        'yml'
    ])

    const createFileId = () => {
        return globalThis.crypto?.randomUUID?.() ?? `file-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }

    const validateFileName = (fileName: string): FileNameValidation => {
        const pattern = filenamePattern.value.trim()

        if (!pattern) {
            return {
                isValid: true,
                pattern,
                message: '未设置文件名范式'
            }
        }

        if (pattern.length > MAX_PATTERN_LENGTH) {
            filenamePatternError.value = `文件名范式过长（上限 ${MAX_PATTERN_LENGTH} 个字符）`

            return {
                isValid: false,
                pattern,
                message: filenamePatternError.value
            }
        }

        if (UNSAFE_QUANTIFIER.test(pattern) || UNSAFE_ALTERNATION.test(pattern)) {
            filenamePatternError.value = '文件名范式存在灾难性回溯风险，请避免嵌套量词或重叠分支'

            return {
                isValid: false,
                pattern,
                message: filenamePatternError.value
            }
        }

        try {
            // 用户在 UI 自定义的范式，不强制加 u 标志，以免改变其输入正则的语义
            // eslint-disable-next-line require-unicode-regexp
            const regex = new RegExp(pattern)
            const isValid = regex.test(fileName)
            filenamePatternError.value = ''

            return {
                isValid,
                pattern,
                message: isValid ? '文件名符合要求' : `文件名不符合范式 /${pattern}/`
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '正则表达式无效'
            filenamePatternError.value = `文件名范式无效: ${message}`

            return {
                isValid: false,
                pattern,
                message: filenamePatternError.value
            }
        }
    }

    const revalidateFiles = () => {
        files.value.forEach((file) => {
            file.filenameValidation = validateFileName(file.name)
        })
    }

    const setFilenamePattern = (pattern: string) => {
        filenamePattern.value = pattern
        revalidateFiles()
    }

    const cleanStudentName = (value: string | undefined) => {
        if (!value) return null

        const cleaned = value
            .replace(/[_-]+/gu, ' ')
            .replace(/\s+/gu, ' ')
            .trim()

        return cleaned || null
    }

    const extractStudentInfo = (fileName: string) => {
        const baseName = getFileBaseName(fileName)
        const normalized = baseName.replace(/[()[\]{}【】（）]/gu, ' ')

        const idFirstMatch = normalized.match(/(?<studentId>\d{6,12})[\s_-]+(?<studentName>[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\s_-]{1,40})/u)
        if (idFirstMatch?.groups) {
            return {
                studentId: idFirstMatch.groups.studentId,
                studentName: cleanStudentName(idFirstMatch.groups.studentName)
            }
        }

        const nameFirstMatch = normalized.match(/(?<studentName>[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z\s_-]{1,40})[\s_-]+(?<studentId>\d{6,12})/u)
        if (nameFirstMatch?.groups) {
            return {
                studentId: nameFirstMatch.groups.studentId,
                studentName: cleanStudentName(nameFirstMatch.groups.studentName)
            }
        }

        return {
            studentId: extractStudentId(normalized),
            studentName: null
        }
    }

    const isTextFile = (file: File) => {
        return file.type.startsWith('text/') || textFileExtensions.has(getFileExtension(file.name))
    }

    const extractFileMetadata = (file: {
        name: string
        size: number
        type: string
        lastModified: Date
        hasTextContent: boolean
        createdAt?: Date
    }): FileMetadata => {
        const studentInfo = extractStudentInfo(file.name)

        return {
            baseName: getFileBaseName(file.name),
            extension: getFileExtension(file.name),
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
            createdAt: file.createdAt ?? new Date(),
            lastModified: file.lastModified,
            isTextContent: file.hasTextContent,
            studentId: studentInfo.studentId,
            studentName: studentInfo.studentName
        }
    }

    const addFile = (file: File) => {
        if (file.size > MAX_FILE_SIZE) {
            return Promise.reject(new Error(`文件超过 ${formatFileSize(MAX_FILE_SIZE)} 上限：${file.name}`))
        }

        if (files.value.length >= MAX_FILES) {
            return Promise.reject(new Error(`文件数量已达上限（${MAX_FILES} 个）：${file.name}`))
        }

        if (usedBytes.value + file.size > MAX_TOTAL_SIZE) {
            return Promise.reject(
                new Error(`全部文件体积将超过 ${formatFileSize(MAX_TOTAL_SIZE)} 上限，请先删除部分文件：${file.name}`)
            )
        }

        // 同步预占：`file.size` 无需读取内容即可得到，因此检查与扣减能完整落在 `await` 之前。
        // 下面的 `arrayBuffer()` 一旦让出控制权，并发的第二个 `addFile` 就会看到已扣减的计数。
        usedBytes.value += file.size

        return file.arrayBuffer().then((buffer) => {
            const hasTextContent = isTextFile(file)
            // 正文只在**文本类**文件上解码。二进制（含 docx）只留一句占位文案 ——
            // 不为预览去解压别人的文件：docx 的提取已移到服务端（见 server/relay-docx.js），
            // 那里收到的本来就是原件字节，解出来的正文同时供接收端使用（铁律 20：一份实现）。
            const content = hasTextContent
                ? new TextDecoder('utf-8').decode(buffer)
                : binaryPlaceholder(file.name)
            const fileInfo: FileInfo = {
                id: createFileId(),
                name: file.name,
                content,
                // 只保留句柄，不做任何编码：base64 只在「本地确实没有字节」时才需要（见 relay-upload.ts）
                blob: file,
                hasTextContent,
                filenameValidation: validateFileName(file.name),
                metadata: extractFileMetadata({
                    name: file.name,
                    size: file.size,
                    type: file.type || 'application/octet-stream',
                    lastModified: new Date(file.lastModified),
                    hasTextContent
                }),
                size: file.size,
                type: file.type || 'application/octet-stream',
                lastModified: new Date(file.lastModified),
                source: 'local'
            }

            files.value.push(fileInfo)
            return fileInfo
        }).catch((error: unknown) => {
            // 入列失败须回滚预占，否则计数会随失败次数单调偏离真实占用（铁律 14 的回滚要求）
            usedBytes.value -= file.size
            throw error
        })
    }

    const upsertRelayFile = (file: {
        name: string
        content: string
        size: number
        type: string
        contentBase64?: string
        hasTextContent?: boolean
        lastModified: string | Date
        roomId: string
        uploadId: string
    }) => {
        const existing = files.value.find(item => item.relayUploadId === file.uploadId)
        const normalizedLastModified = file.lastModified instanceof Date ? file.lastModified : new Date(file.lastModified)
        const receivedAt = new Date()
        const hasTextContent = file.hasTextContent ?? true

        if (existing) {
            existing.name = file.name
            existing.content = file.content
            existing.contentBase64 = file.contentBase64
            existing.hasTextContent = hasTextContent
            existing.filenameValidation = validateFileName(file.name)
            existing.metadata = extractFileMetadata({
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: normalizedLastModified,
                hasTextContent,
                createdAt: existing.metadata.createdAt
            })
            // 同一 uploadId 可能被重复 upsert（SSE 重连补发），按差值调整而非重复累加
            usedBytes.value += file.size - existing.size
            existing.size = file.size
            existing.type = file.type
            existing.lastModified = normalizedLastModified
            existing.source = 'relay'
            existing.relayRoomId = file.roomId
            existing.relayUploadId = file.uploadId
            existing.receivedAt = receivedAt
            return existing
        }

        const fileInfo: FileInfo = {
            id: createFileId(),
            name: file.name,
            content: file.content,
            contentBase64: file.contentBase64,
            hasTextContent,
            filenameValidation: validateFileName(file.name),
            metadata: extractFileMetadata({
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: normalizedLastModified,
                hasTextContent,
                createdAt: receivedAt
            }),
            size: file.size,
            type: file.type,
            lastModified: normalizedLastModified,
            source: 'relay',
            relayRoomId: file.roomId,
            relayUploadId: file.uploadId,
            receivedAt
        }

        // 中继侧刻意不设 `MAX_TOTAL_SIZE` 硬闸：单房间体积已由服务端 `MAX_ROOM_UPLOAD_BYTES`
        // 约束，此处再加一道会在接收热路径上引入「可被中断的失败」。但仍参与记账，
        // 因此中继文件会一并挤占本地收集的额度（总量口径统一）。
        usedBytes.value += file.size
        files.value.unshift(fileInfo)
        return fileInfo
    }

    const removeFileById = (id: string) => {
        const index = files.value.findIndex((item) => item.id === id)
        if (index === -1) return

        const [removed] = files.value.splice(index, 1)
        // clamp 到 0：并发的启动回收等路径万一重复释放，也不至于把计数打成负数
        usedBytes.value = Math.max(usedBytes.value - removed.size, 0)
        if (selectedFile.value?.id === id) {
            selectedFile.value = null
        }
    }

    const selectFile = (file: FileInfo | null) => {
        selectedFile.value = file
    }

    const clearSelection = () => {
        selectedFile.value = null
    }

    return {
        files,
        usedBytes,
        selectedFile,
        filenamePattern,
        filenamePatternError,
        addFile,
        upsertRelayFile,
        setFilenamePattern,
        validateFileName,
        extractFileMetadata,
        removeFileById,
        selectFile,
        clearSelection
    }
})
