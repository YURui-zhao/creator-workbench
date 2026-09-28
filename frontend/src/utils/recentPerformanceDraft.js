/**
 * 近期表现助手 · 识别结果草稿（V3-alpha P2A，纯函数）
 *
 * 职责：
 * - 把 AI 返回的「可见事实」转成可人工编辑的草稿（数值一律由确定性解析器换算）
 * - 人工修改 raw_text 时用同一套解析规则即时重算（不重新请求 AI）
 * - 排除 / 恢复条目的状态与统计
 * - P2A 只产出前端 confirmed draft：不写库、不估价、不给复投建议
 */

import { parsePlayText, parsePriceText, normalizeRawText } from './screenshotValues.js'

export const MAX_DRAFT_PLAYS = 60

const toRawText = normalizeRawText

/**
 * AI 识别结果 -> 草稿
 * 只保留 AI 真正返回的条目：不补足 15 条、不猜日期、不跨图去重
 */
export function buildDraftFromExtraction(data = {}) {
  const rawPlays = Array.isArray(data?.plays) ? data.plays.slice(0, MAX_DRAFT_PLAYS) : []
  const plays = rawPlays.map((item, index) => {
    const rawText = toRawText(item?.raw_text)
    const parsed = parsePlayText(rawText)
    return {
      id: `play-${index + 1}`,
      raw_text: parsed.raw_text,
      normalized_play: parsed.value,
      needs_review: parsed.needs_review,
      reason: parsed.reason,
      excluded: false,
      source_image_index: Number.isInteger(item?.source_image_index) ? item.source_image_index : null,
      position_index: Number.isInteger(item?.position_index) ? item.position_index : index + 1
    }
  })

  const priceRaw = toRawText(data?.xingtu_price_raw)
  const price = parsePriceText(priceRaw)

  return {
    provider: data?.provider || null,
    model: data?.model || null,
    creator_name: toRawText(data?.creator_name_raw) || '',
    xingtu_price_raw: price.raw_text || '',
    xingtu_price: price.value,
    xingtu_price_needs_review: price.needs_review,
    xingtu_price_reason: price.reason,
    plays,
    warnings: (Array.isArray(data?.warnings) ? data.warnings : []).filter(
      (item) => typeof item === 'string' && item.trim()
    )
  }
}

export function updateCreatorName(draft, value) {
  return { ...draft, creator_name: String(value ?? '') }
}

/** 人工修改星图刊例价原文 -> 立即按确定性规则重新换算 */
export function updatePriceRawText(draft, rawText) {
  const text = String(rawText ?? '')
  const parsed = parsePriceText(text)
  return {
    ...draft,
    xingtu_price_raw: text,
    xingtu_price: parsed.value,
    xingtu_price_needs_review: parsed.needs_review,
    xingtu_price_reason: parsed.reason
  }
}

/** 人工修改某条播放量原文 -> 只重算该条 */
export function updatePlayRawText(draft, playId, rawText) {
  const text = String(rawText ?? '')
  return {
    ...draft,
    plays: draft.plays.map((play) => {
      if (play.id !== playId) return play
      const parsed = parsePlayText(text)
      return {
        ...play,
        raw_text: text,
        normalized_play: parsed.value,
        needs_review: parsed.needs_review,
        reason: parsed.reason
      }
    })
  }
}

/** 排除 / 恢复某条（不需要用户填写理由） */
export function togglePlayExcluded(draft, playId) {
  return {
    ...draft,
    plays: draft.plays.map((play) =>
      play.id === playId ? { ...play, excluded: !play.excluded } : play
    )
  }
}

export function setPlayExcluded(draft, playId, excluded) {
  return {
    ...draft,
    plays: draft.plays.map((play) => (play.id === playId ? { ...play, excluded: Boolean(excluded) } : play))
  }
}

/** 汇总：识别作品 / 有效作品 / 排除 / 星图价 */
export function summarizeDraft(draft) {
  const plays = Array.isArray(draft?.plays) ? draft.plays : []
  const excludedCount = plays.filter((play) => play.excluded).length
  return {
    identified_count: plays.length,
    excluded_count: excludedCount,
    valid_count: plays.length - excludedCount,
    needs_review_count: plays.filter((play) => play.needs_review && !play.excluded).length,
    xingtu_price: draft?.xingtu_price ?? null
  }
}

/**
 * 确认后的草稿（P2A 终点）：只在前端存在，不写数据库
 * 保留 raw_text / 归一化值 / 排除标记 / 图片来源顺序，供后续 Phase 使用
 */
export function buildConfirmedDraft(draft) {
  return {
    creator_name: String(draft?.creator_name ?? '').trim(),
    xingtu_price: draft?.xingtu_price ?? null,
    xingtu_price_raw: draft?.xingtu_price_raw ?? '',
    provider: draft?.provider || null,
    model: draft?.model || null,
    plays: (draft?.plays || []).map((play) => ({
      raw_text: play.raw_text,
      normalized_play: play.normalized_play,
      excluded: Boolean(play.excluded),
      needs_review: Boolean(play.needs_review),
      source_image_index: play.source_image_index,
      position_index: play.position_index
    })),
    summary: summarizeDraft(draft)
  }
}
