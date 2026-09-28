/**
 * 近期表现统计口径（V3-alpha P2B，纯函数）
 *
 * 三层信息严格区分：
 *   1) 原始识别 / 人工确认结果  -> plays_json（raw_text 等）
 *   2) 最终有效样本            -> valid（excluded=false 且 normalized_play !== null 且 >= 0）
 *   3) 后端统计结果            -> median / p25 / p75 / trend（本模块；同样落库，便于追溯）
 *
 * 冻结口径（stats_version 记录当时的算法，未来改口径不得回写旧快照）：
 *   · 典型区间：valid_count >= 5 时，先去掉 1 个最高、1 个最低观测，再在剩余样本上取 median / P25 / P75
 *   · 趋势：valid_count >= 8 时，最新 5 条为 recent，其余更早的为 prior；ratio = recent/prior - 1
 *   · 阈值：ratio >= +20% → up；<= -20% → down；其余 → stable
 *   · 内部按原始精度计算，只在最终输出 round（播放量取整）
 */

export const STATS_VERSION = 'recent-performance-v1'
// ±20% 阈值唯一来源（不在别处散落 magic number）
export const TREND_THRESHOLD_PERCENT = 20
export const TREND_THRESHOLD = TREND_THRESHOLD_PERCENT / 100
export const RECENT_GROUP_SIZE = 5
export const MIN_VALID_FOR_STATS = 5
export const MIN_VALID_FOR_TREND = 8
export const MAX_PLAYS_PER_SNAPSHOT = 60

export const TREND_LABELS = {
  up: '上升',
  stable: '基本稳定',
  down: '下降',
  insufficient: '样本不足'
}

/**
 * 确定性 quantile（linear interpolation，与 numpy/线性插值定义一致）
 * position = (n - 1) * p；lower = floor(position)；upper = ceil(position)
 * lower === upper 时取 sorted[lower]，否则线性插值
 * @param {number[]} sortedAsc 升序数组
 * @param {number} p 0~1
 */
export function quantile(sortedAsc, p) {
  const list = Array.isArray(sortedAsc) ? sortedAsc : []
  const n = list.length
  if (n === 0) return null
  if (n === 1) return list[0]
  const position = (n - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return list[lower]
  return list[lower] + (list[upper] - list[lower]) * (position - lower)
}

/** 中位数（偶数取中间两项平均；内部不做提前 round） */
export function medianOf(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value))
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  return quantile(sorted, 0.5)
}

/** 最终输出统一取整（播放量展示为整数；内部计算不受影响） */
function roundPlay(value) {
  return value === null || value === undefined ? null : Math.round(value)
}

/**
 * 由「有效且按人工确认顺序（从新到旧）排列」的播放量数组计算统计结果
 * @param {number[]} validPlaysInOrder
 * @returns {{
 *   valid_count: number, analysis_count: number,
 *   median_play: number|null, p25_play: number|null, p75_play: number|null,
 *   recent_median_play: number|null, prior_median_play: number|null,
 *   trend_ratio: number|null, trend_label: 'up'|'stable'|'down'|'insufficient',
 *   stats_status: 'ok'|'insufficient'
 * }}
 */
export function computeRecentPerformanceStats(validPlaysInOrder = []) {
  const valid = (Array.isArray(validPlaysInOrder) ? validPlaysInOrder : []).filter(
    (value) => Number.isFinite(value) && value >= 0
  )
  const validCount = valid.length

  // ---------- 典型表现：去最高最低各 1 个 ----------
  const canComputeTypical = validCount >= MIN_VALID_FOR_STATS
  const sorted = [...valid].sort((a, b) => a - b)
  // 只移除一个最高观测与一个最低观测（即使存在重复值）
  const analysis = canComputeTypical ? sorted.slice(1, sorted.length - 1) : []
  const analysisCount = analysis.length

  const stats = {
    valid_count: validCount,
    analysis_count: analysisCount,
    median_play: canComputeTypical ? roundPlay(quantile(analysis, 0.5)) : null,
    p25_play: canComputeTypical ? roundPlay(quantile(analysis, 0.25)) : null,
    p75_play: canComputeTypical ? roundPlay(quantile(analysis, 0.75)) : null,
    recent_median_play: null,
    prior_median_play: null,
    trend_ratio: null,
    trend_label: 'insufficient',
    stats_status: canComputeTypical ? 'ok' : 'insufficient'
  }

  // ---------- 近期趋势：使用全部有效样本的确认顺序（不做去极值、不重排） ----------
  if (validCount < MIN_VALID_FOR_TREND) return stats

  const recentValues = valid.slice(0, RECENT_GROUP_SIZE)
  const priorValues = valid.slice(RECENT_GROUP_SIZE)
  const recentMedian = medianOf(recentValues)
  const priorMedian = medianOf(priorValues)
  stats.recent_median_play = roundPlay(recentMedian)
  stats.prior_median_play = roundPlay(priorMedian)

  if (priorMedian === 0) {
    // 不除以 0：prior 为 0 时只比较是否增长
    stats.trend_ratio = null
    stats.trend_label = recentMedian > 0 ? 'up' : 'stable'
    return stats
  }

  const ratio = recentMedian / priorMedian - 1
  stats.trend_ratio = Number(ratio.toFixed(4))
  // 阈值判定用「放大 100 倍的整数比较」，避免浮点除法在边界上误判：
  // 例如 12000/10000-1 === 0.19999999999999996，直接与 0.2 比较会判成 stable。
  // 只有 trend_ratio（展示/记录用）保留带误差的除法结果。
  const recentScaled = recentMedian * 100
  if (recentScaled >= priorMedian * (100 + TREND_THRESHOLD_PERCENT)) stats.trend_label = 'up'
  else if (recentScaled <= priorMedian * (100 - TREND_THRESHOLD_PERCENT)) stats.trend_label = 'down'
  else stats.trend_label = 'stable'
  return stats
}
