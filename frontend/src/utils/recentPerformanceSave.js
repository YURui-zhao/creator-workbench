/**
 * 近期表现快照 · 保存流程纯函数（V3-alpha P2B）
 *
 * 职责：
 * - 达人身份保护：只有识别昵称与当前雷达达人一致时才不要求额外确认
 * - 组装保存 payload：只发送 raw 事实（不含任何前端算出的统计值），统计一律由后端重算
 * - 展示文案：趋势中文标签、典型区间、雷达行内状态
 *
 * 注意：统计口径（去极值 / quantile / ±20% 阈值）全部在后端
 * （backend/utils/recentPerformanceStats.js），前端不重复实现。
 */

import { normalizeRawText } from './screenshotValues.js'
import { formatPlays } from './format.js'

// 与后端 trend_label 一一对应（仅展示用）
export const TREND_LABELS = {
  up: '上升',
  stable: '稳定',
  down: '下降',
  insufficient: '样本不足'
}

export const TREND_LABELS_FULL = {
  up: '上升',
  stable: '基本稳定',
  down: '下降',
  insufficient: '样本不足'
}

/** 名称比较用的轻量归一化（与后端 normalizeCreatorNameForCompare 一致） */
export function normalizeCreatorNameForCompare(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

/** 识别昵称与目标达人是否一致（不做 fuzzy / AI 身份匹配） */
export function isCreatorNameMatched(creator, recognizedNameRaw) {
  const recognized = String(recognizedNameRaw ?? '').trim()
  if (!recognized) return true
  return normalizeCreatorNameForCompare(creator) === normalizeCreatorNameForCompare(recognized)
}

/** 是否需要「我确认本次快照保存到当前达人」二次确认 */
export function needsIdentityConfirmation(creator, recognizedNameRaw) {
  // 尚未选择目标达人时不提示「不一致」——此时由「必须选择达人」这条规则负责拦截
  if (!String(creator ?? '').trim()) return false
  return !isCreatorNameMatched(creator, recognizedNameRaw)
}

/**
 * 组装保存 payload：只包含人工确认后的 raw 事实
 * 明确不发送 normalized_play / median / p25 / p75 等派生值（后端会重新解析与计算）
 */
export function buildSnapshotPayload(draft, { creator, identityConfirmed = false } = {}) {
  return {
    creator: String(creator ?? '').trim(),
    recognized_creator_name_raw: normalizeRawText(draft?.creator_name),
    identity_confirmed: Boolean(identityConfirmed),
    xingtu_price_raw: normalizeRawText(draft?.xingtu_price_raw),
    plays: (draft?.plays || []).map((play) => ({
      raw_text: normalizeRawText(play.raw_text),
      excluded: Boolean(play.excluded),
      source_image_index: Number.isInteger(play.source_image_index) ? play.source_image_index : null,
      position_index: Number.isInteger(play.position_index) ? play.position_index : null
    }))
  }
}

/** 趋势比例展示（+18.5% / -22.0%）；无比例时返回空字符串 */
export function formatTrendRatio(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return ''
  const percent = Number(ratio) * 100
  const sign = percent > 0 ? '+' : ''
  return `${sign}${percent.toFixed(1)}%`
}

/** 典型区间文案：4.3万～6.1万 */
export function formatPlayRange(p25, p75) {
  if (p25 === null || p25 === undefined || p75 === null || p75 === undefined) return ''
  return `${formatPlays(p25)}～${formatPlays(p75)}`
}

/**
 * 雷达行内「近期表现」状态文案（不显示假数据）
 * 无快照 → 尚未更新；样本不足 → 样本不足；否则 → 中位 X · 趋势
 */
export function formatSnapshotStatusText(snapshot) {
  if (!snapshot) return '尚未更新'
  if (
    snapshot.stats_status !== 'ok' ||
    snapshot.median_play === null ||
    snapshot.median_play === undefined
  ) {
    return '样本不足'
  }
  const trend = TREND_LABELS[snapshot.trend_label] || ''
  return `${formatPlays(snapshot.median_play)}${trend ? ` · ${trend}` : ''}`
}

/**
 * 保存闸门（纯函数，便于测试）：只有「已确认 + 已绑定达人 + 需要时已完成名称确认 +
 * 没有正在保存 + 当前草稿尚未保存过」时才允许提交。
 * 已保存过的同一份草稿会被锁定，避免重复点击产生重复快照；
 * 用户修改草稿后（会重置 confirmed / savedSnapshot）可再次确认并保存。
 */
export function canSaveSnapshot({
  confirmed = false,
  creator = '',
  identityNeedsConfirm = false,
  identityConfirmed = false,
  saving = false,
  savedSnapshot = null
} = {}) {
  if (!confirmed) return false
  if (!String(creator ?? '').trim()) return false
  if (identityNeedsConfirm && !identityConfirmed) return false
  if (saving) return false
  if (savedSnapshot) return false
  return true
}
