// Count every existing file, including foreign files and other backup domains.
export function gistHistoryBudget({ requested, files, historyNames, newName, indexName, reserve = 1, maxFiles = 200 }) {
  const owned = new Set(historyNames)
  owned.add(newName)
  owned.add(indexName)
  const otherCount = files.filter(name => !owned.has(name)).length
  const capacity = Math.max(0, maxFiles - otherCount - 1 - reserve)
  return Math.min(requested, capacity)
}
