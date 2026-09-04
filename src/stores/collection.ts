import { defineStore } from 'pinia'
import { ref } from 'vue'
import { extractStudentId, normalizeComparableName } from '../utils/filename'

export interface CollectionItem {
    id: string
    name: string
    description: string
    filePattern: string
    status: 'pending' | 'collected' | 'error'
    submittedAt?: Date
}

/** 允许走子串包含匹配的最短长度，避免单字或 2–3 字的名单条目误匹配 */
const FUZZY_MIN_LENGTH = 4

export const useCollectionStore = defineStore('collection', () => {
    const collectionList = ref<CollectionItem[]>([])
    const isLoading = ref(false)

    const loadCollectionList = async (file: File) => {
        isLoading.value = true
        try {
            const text = await file.text()
            const lines = text.split('\n').filter(line => line.trim())

            collectionList.value = lines.map((line, index) => ({
                id: `item-${index}`,
                name: line.trim(),
                description: `待收集的文件: ${line.trim()}`,
                filePattern: line.trim(),
                status: 'pending' as const
            }))
        } catch (error) {
            console.error('读取收集名单失败:', error)
            throw error
        } finally {
            isLoading.value = false
        }
    }

    const updateItemStatus = (id: string, status: CollectionItem['status']) => {
        const item = collectionList.value.find(item => item.id === id)
        if (item) {
            item.status = status
            if (status === 'collected') {
                item.submittedAt = new Date()
            }
        }
    }

    /** 分级匹配：完全相等 > 学号相等 > 子串包含，避免名单里「张」误匹配所有含张的文件名 */
    const checkFileStatus = (fileName: string): CollectionItem | null => {
        const targetName = normalizeComparableName(fileName)
        if (!targetName) return null

        const targetStudentId = extractStudentId(fileName)
        let fuzzyMatch: CollectionItem | null = null

        for (const item of collectionList.value) {
            const candidateName = normalizeComparableName(item.filePattern)
            if (!candidateName) continue

            if (candidateName === targetName) {
                return item
            }

            const candidateStudentId = extractStudentId(item.filePattern)
            if (targetStudentId && candidateStudentId === targetStudentId) {
                return item
            }

            const [shorter, longer] = candidateName.length <= targetName.length
                ? [candidateName, targetName]
                : [targetName, candidateName]

            if (shorter.length >= FUZZY_MIN_LENGTH && longer.includes(shorter)) {
                fuzzyMatch ??= item
            }
        }

        return fuzzyMatch
    }

    const clearCollection = () => {
        collectionList.value = []
    }

    const getProgress = () => {
        const total = collectionList.value.length
        if (total === 0) return { total: 0, collected: 0, pending: 0, error: 0, percentage: 0 }

        const collected = collectionList.value.filter(item => item.status === 'collected').length
        const pending = collectionList.value.filter(item => item.status === 'pending').length
        const error = collectionList.value.filter(item => item.status === 'error').length

        return {
            total,
            collected,
            pending,
            error,
            percentage: Math.round((collected / total) * 100)
        }
    }

    return {
        collectionList,
        isLoading,
        loadCollectionList,
        updateItemStatus,
        checkFileStatus,
        clearCollection,
        getProgress
    }
})
