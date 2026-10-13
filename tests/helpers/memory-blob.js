/** 模拟 Blob JSON 的序列化边界，避免引用共享掩盖遗漏的持久化写入。 */
function copyJson (value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 提供与 getStore 相同的最小接口；种子及每次读写均独立复制。 */
export function createMemoryBlob (seed = {}) {
  const records = new Map(Object.entries(copyJson(seed)))
  return {
    async get (key, { type = 'text' } = {}) {
      if (!records.has(key)) return null
      const value = copyJson(records.get(key))
      return type === 'json' ? value : JSON.stringify(value)
    },
    async setJSON (key, value) {
      records.set(key, copyJson(value))
    },
    async delete (key) {
      records.delete(key)
    },
    async list ({ prefix = '' } = {}) {
      return {
        blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key }))
      }
    }
  }
}
