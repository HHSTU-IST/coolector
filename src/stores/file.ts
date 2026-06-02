import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface FileInfo {
    id: string
    name: string
    content: string
    contentBase64?: string
    hasTextContent: boolean
    filenameValidation: FileNameValidation
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

    const getFileExtension = (fileName: string) => {
        const lastDotIndex = fileName.lastIndexOf('.')
        return lastDotIndex === -1 ? '' : fileName.slice(lastDotIndex + 1).toLowerCase()
    }

    const isTextFile = (file: File) => {
        return file.type.startsWith('text/') || textFileExtensions.has(getFileExtension(file.name))
    }

    const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
        const bytes = new Uint8Array(buffer)
        const chunkSize = 0x8000
        let binary = ''

        for (let index = 0; index < bytes.length; index += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
        }

        return btoa(binary)
    }

    const addFile = (file: File) => {
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

        if (existing) {
            existing.name = file.name
            existing.content = file.content
            existing.contentBase64 = file.contentBase64
            existing.hasTextContent = file.hasTextContent ?? true
            existing.filenameValidation = validateFileName(file.name)
            existing.size = file.size
            existing.type = file.type
            existing.lastModified = normalizedLastModified
            existing.source = 'relay'
            existing.relayRoomId = file.roomId
            existing.relayUploadId = file.uploadId
            existing.downloadUrl = file.downloadUrl
            existing.receivedAt = new Date()
            return existing
        }

        const fileInfo: FileInfo = {
            id: createFileId(),
            name: file.name,
            content: file.content,
            contentBase64: file.contentBase64,
            hasTextContent: file.hasTextContent ?? true,
            filenameValidation: validateFileName(file.name),
            size: file.size,
            type: file.type,
            lastModified: normalizedLastModified,
            source: 'relay',
            relayRoomId: file.roomId,
            relayUploadId: file.uploadId,
            downloadUrl: file.downloadUrl,
            receivedAt: new Date()
        }

        files.value.unshift(fileInfo)
        return fileInfo
    }

    const removeFile = (index: number) => {
        const removed = files.value[index]
        files.value.splice(index, 1)
        if (removed && selectedFile.value?.id === removed.id) {
            selectedFile.value = null
        }
    }

    const selectFile = (file: FileInfo) => {
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
        removeFile,
        selectFile,
        clearFiles
    }
})
