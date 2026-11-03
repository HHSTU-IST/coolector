import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
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

/** 名单里每条预计算好的匹配字段，避免「每个上传文件 × 每条名单」反复归一化 */
interface RosterEntry {
    item: CollectionItem
    candidateName: string
    candidateStudentId: string | null
}

export const useCollectionStore = defineStore('collection', () => {
    const collectionList = ref<CollectionItem[]>([])
    const isLoading = ref(false)

    /**
     * 反应式派生的名册索引：把原先 checkFileStatus 每次都对整份名单跑
     * normalizeComparableName + 两次正则抽取的 O(N×M) 开销，降为「名单变动时一次性 O(N)」。
     * 刻意用 computed 从 collectionList.value 派生，而非只在 loadCollectionList 里手工建 ——
     * 否则任何直接给 collectionList 赋值的用法（测试就是这么写的）都会读到空索引而漏配。
     */
    const rosterIndex = computed<RosterEntry[]>(() => collectionList.value
        .map(item => ({
            item,
            candidateName: normalizeComparableName(item.filePattern),
            candidateStudentId: extractStudentId(item.filePattern)
        }))
        .filter(entry => entry.candidateName.length > 0))

    /**
     * 文件名 → 匹配结果的记忆化。依赖只来自「名单内容 + 文件名」，故名单引用一变即失效：
     * 下面按 rosterIndex.value 的引用变化同步清空，不依赖 watch 的异步 flush，杜绝脏读。
     */
    const matchCache = new Map<string, CollectionItem | null>()
    let cacheRosterRef: RosterEntry[] | null = null

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
        // 名单引用一变（loadCollectionList / clearCollection / 直接赋值）即失效，同步判定不依赖 watch flush
        const roster = rosterIndex.value
        if (roster !== cacheRosterRef) {
            matchCache.clear()
            cacheRosterRef = roster
        } else if (matchCache.has(fileName)) {
            return matchCache.get(fileName) ?? null
        }

        const targetName = normalizeComparableName(fileName)
        if (!targetName) return null

        const targetStudentId = extractStudentId(fileName)
        let fuzzyMatch: CollectionItem | null = null

        for (const entry of roster) {
            if (entry.candidateName === targetName) {
                matchCache.set(fileName, entry.item)
                return entry.item
            }

            if (targetStudentId && entry.candidateStudentId === targetStudentId) {
                matchCache.set(fileName, entry.item)
                return entry.item
            }

            const [shorter, longer] = entry.candidateName.length <= targetName.length
                ? [entry.candidateName, targetName]
                : [targetName, entry.candidateName]

            if (shorter.length >= FUZZY_MIN_LENGTH && longer.includes(shorter)) {
                fuzzyMatch ??= entry.item
            }
        }

        matchCache.set(fileName, fuzzyMatch)
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
