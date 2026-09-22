/**
 * 达人对比工具（纯函数，便于单测）
 * 规则：至少 2 位、最多 5 位达人可对比
 */

export const COMPARE_MIN = 2
export const COMPARE_MAX = 5

/**
 * 是否满足对比条件
 * @param {number} count 已勾选达人数
 * @returns {{ ok: boolean, reason: string }} ok=false 时 reason 为提示文案
 */
export function canCompareCreators(count) {
  const total = Number(count) || 0
  if (total < COMPARE_MIN) {
    return { ok: false, reason: `请至少选择 ${COMPARE_MIN} 位达人进行对比` }
  }
  if (total > COMPARE_MAX) {
    return { ok: false, reason: `最多支持对比 ${COMPARE_MAX} 位达人，请减少选择` }
  }
  return { ok: true, reason: '' }
}

/**
 * 构造对比数据：按勾选顺序取达人，最终按总花费降序排列
 * @param {Array<Object>} creators 全量达人统计（接口返回）
 * @param {string[]} selectedNames 勾选的达人昵称
 * @returns {Array<Object>} 对比用行数据
 */
export function buildCompareRows(creators = [], selectedNames = []) {
  const nameSet = new Set(selectedNames)
  return (Array.isArray(creators) ? creators : [])
    .filter((item) => nameSet.has(item.nickname))
    .map((item, index) => ({ ...item, __index: index }))
    .sort((a, b) => b.total_cost - a.total_cost || a.__index - b.__index)
    .map(({ __index, ...rest }) => rest)
}
