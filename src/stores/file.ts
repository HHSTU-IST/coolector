import { defineStore } from 'pinia'
import { ref } from 'vue'
import { formatFileSize } from '../utils/format'
import { extractStudentId, getFileBaseName, getFileExtension } from '../utils/filename'

export interface FileInfo {
    id: string
    name: string
    content: string
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
    downloadUrl?: string
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

/** 单个文件体积上限（10 MB，与 Relay 默认 MAX_BODY_BYTES 对齐） */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

/** 文件总数上限，控制整体内存占用 */
export const MAX_FILES = 200

/** 嵌套量词（如 (a+)+、(a*)*、(a{2,})+），不匹配输入时指数级回溯 */
const UNSAFE_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})\)\s*(?:[+*]|\{\d+,?\d*\})/

/** 带量词的重叠分支（如 (a|a)+、(a|ab)+），同样指数级回溯 */
const UNSAFE_ALTERNATION = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/

export const useFileStore = defineStore('file', () => {
    const files = ref<FileInfo[]>([])
    const selectedFile = ref<FileInfo | null>(null)
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
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()

        return cleaned || null
    }

    const extractStudentInfo = (fileName: string) => {
        const baseName = getFileBaseName(fileName)
        const normalized = baseName.replace(/[()[\]{}【】（）]/g, ' ')

        const idFirstMatch = normalized.match(/(?<studentId>\d{6,12})[\s_-]+(?<studentName>[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\s_-]{1,40})/)
        if (idFirstMatch?.groups) {
            return {
                studentId: idFirstMatch.groups.studentId,
                studentName: cleanStudentName(idFirstMatch.groups.studentName)
            }
        }

        const nameFirstMatch = normalized.match(/(?<studentName>[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z\s_-]{1,40})[\s_-]+(?<studentId>\d{6,12})/)
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

    const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
        const bytes = new Uint8Array(buffer)
        // 8KB 分块低于各引擎实参上限，避免一次性展开过多参数
        const chunkSize = 0x2000
        let binary = ''

        for (let index = 0; index < bytes.length; index += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
        }

        return btoa(binary)
    }

    const addFile = (file: File) => {
        if (file.size > MAX_FILE_SIZE) {
            return Promise.reject(new Error(`文件超过 ${formatFileSize(MAX_FILE_SIZE)} 上限：${file.name}`))
        }

        if (files.value.length >= MAX_FILES) {
            return Promise.reject(new Error(`文件数量已达上限（${MAX_FILES} 个）：${file.name}`))
        }

        return file.arrayBuffer().then((buffer) => {
            const hasTextContent = isTextFile(file)
            const content = hasTextContent
                ? new TextDecoder('utf-8').decode(buffer)
                : `此文件为二进制格式（${file.name}），已上传但暂不支持内容预览。`
            const fileInfo: FileInfo = {
                id: createFileId(),
                name: file.name,
                content,
                contentBase64: arrayBufferToBase64(buffer),
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
        downloadUrl?: string
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
            existing.size = file.size
            existing.type = file.type
            existing.lastModified = normalizedLastModified
            existing.source = 'relay'
            existing.relayRoomId = file.roomId
            existing.relayUploadId = file.uploadId
            existing.downloadUrl = file.downloadUrl
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
            downloadUrl: file.downloadUrl,
            receivedAt
        }

        files.value.unshift(fileInfo)
        return fileInfo
    }

    const removeFileById = (id: string) => {
        const index = files.value.findIndex((item) => item.id === id)
        if (index === -1) return

        files.value.splice(index, 1)
        if (selectedFile.value?.id === id) {
            selectedFile.value = null
        }
    }

    const selectFile = (file: FileInfo | null) => {
        selectedFile.value = file
    }

    const clearFiles = () => {
        files.value = []
        selectedFile.value = null
    }

    return {
        files,
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
        clearFiles
    }
})
