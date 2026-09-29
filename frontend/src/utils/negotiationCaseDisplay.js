/**
 * 谈判结果展示（V3-alpha.2 A4，纯函数，只做事实呈现）
 *
 * 原则：
 *   · 没有星图价就显示「暂无」，绝不显示 0 折 / 虚假折扣
 *   · 达人报价 null = 没有报价（「暂无」）；达人报价 0 = 明确记录到的 0 元报价（「¥0」）
 *     —— 0 不能当作百分比基准，因此不计算降幅百分比（不产生 Infinity / NaN）
 *   · 谈成价高于初始报价时如实表达「较初始报价增加」，不假设一定降价
 *   · 不评价谈判质量、不评分
 */

import { formatPrice, formatZhe } from './pricingDisplay.js'

// 与 backend/utils/negotiationCase.js 的 allowlist 保持一致（测试有 parity 断言）
export const NEGOTIATION_REASON_TAGS = [
  { value: 'history_performance_plain', label: '历史投放效果一般' },
  { value: 'budget_limited', label: '预算有限' },
  { value: 'long_term_cooperation', label: '长期合作 / 复投预期' },
  { value: 'batch_cooperation', label: '批量合作' },
  { value: 'creator_price_cut', label: '达人主动让价' },
  { value: 'schedule_factor', label: '档期因素' },
  { value: 'other', label: '其他' }
]

export const NEGOTIATION_REASON_TAG_LABELS = Object.fromEntries(
  NEGOTIATION_REASON_TAGS.map((tag) => [tag.value, tag.label])
)

/** 降幅/增幅百分比：0.2667 → 26.7% */
export function formatChangePercent(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return ''
  return `${(Math.abs(Number(rate)) * 100).toFixed(1)}%`
}

/**
 * 相对达人报价的变化文案（可能降价、持平或增加）
 * 只有报价 > 0（可做百分比基准）时才展示变化行；报价为 0 是真实事实但不能做分母，
 * 此时只在上方展示「达人报价 ¥0」，不产生任何百分比 / Infinity / NaN。
 */
export function formatQuoteChange(outcome) {
  if (!outcome?.quote_drop_computable) return ''
  const amount = outcome.quote_drop_amount
  const percent = formatChangePercent(outcome.quote_drop_rate)
  if (outcome.quote_drop_direction === 'increase') {
    return `较初始报价增加 ${formatPrice(Math.abs(amount))}${percent ? ` / ${percent}` : ''}`
  }
  if (outcome.quote_drop_direction === 'flat') return '与初始报价持平'
  return `下降 ${formatPrice(amount)}${percent ? ` / ${percent}` : ''}`
}

/**
 * 达人报价展示：null / undefined = 没有报价（暂无）；0 = 明确记录到的 0 元报价（¥0）
 * 0 不得显示为「暂无」。
 */
export function formatCurrentQuote(caseObj) {
  const quote = caseObj?.current_quote_snapshot
  if (quote === null || quote === undefined) return '暂无'
  return formatPrice(quote)
}

/** 相对星图刊例价的折扣文案（无星图价时为空字符串，调用方直接不展示该行） */
export function formatVsXingtu(outcome) {
  if (!outcome?.has_xingtu) return ''
  return `约 ${formatZhe(outcome.negotiated_vs_xingtu_zhe)}`
}

/** 与 CPM30 目标价 / 参考区间的事实对照（没有就不显示） */
export function formatVsTarget(outcome) {
  if (outcome?.vs_target_status === null || outcome?.vs_target_status === undefined) return ''
  if (outcome.vs_target_status === 'at_or_below_target') return '不高于 CPM30目标价'
  return `高于 CPM30目标价 ${formatPrice(outcome.vs_target_amount)}`
}

export function formatVsReferenceRange(outcome) {
  if (outcome?.within_reference_range === null || outcome?.within_reference_range === undefined) return ''
  return outcome.within_reference_range ? '处于 CPM30参考区间内' : '仍高于 CPM30参考区间上限'
}

/** 谈价结果卡片「价格」区行（事实，不含评价） */
export function buildNegotiationPriceRows(caseObj) {
  if (!caseObj) return []
  const outcome = caseObj.outcome || {}
  const rows = [
    { label: '星图刊例价', value: caseObj.xingtu_price_snapshot === null || caseObj.xingtu_price_snapshot === undefined ? '暂无' : formatPrice(caseObj.xingtu_price_snapshot) },
    { label: '达人报价', value: formatCurrentQuote(caseObj) },
    { label: '最终谈成价', value: formatPrice(caseObj.negotiated_price) },
    { label: '谈成日期', value: caseObj.negotiated_at || '-' }
  ]
  const vsXingtu = formatVsXingtu(outcome)
  if (vsXingtu) rows.push({ label: '相对星图', value: vsXingtu })
  if (outcome.quote_drop_computable) {
    rows.push({ label: '相对达人报价', value: formatQuoteChange(outcome) })
  }
  const vsTarget = formatVsTarget(outcome)
  if (vsTarget) rows.push({ label: '相对 CPM30目标价', value: vsTarget })
  const vsRange = formatVsReferenceRange(outcome)
  if (vsRange) rows.push({ label: '相对 CPM30参考区间', value: vsRange })
  return rows
}

/** 只读上下文行（新建谈价结果时展示「当时看到的事实」） */
export function buildNegotiationContextRows({ xingtuPrice, currentQuote, targetPrice, referenceLow, referenceHigh }) {
  const hasRange = referenceLow !== null && referenceLow !== undefined && referenceHigh !== null && referenceHigh !== undefined
  return [
    { label: '星图刊例价', value: xingtuPrice === null || xingtuPrice === undefined ? '暂无' : formatPrice(xingtuPrice) },
    { label: '达人当前报价', value: currentQuote === null || currentQuote === undefined ? '暂无' : formatPrice(currentQuote) },
    { label: 'CPM30目标价', value: targetPrice === null || targetPrice === undefined ? '暂无' : formatPrice(targetPrice) },
    { label: 'CPM30参考区间', value: hasRange ? `${formatPrice(referenceLow)}～${formatPrice(referenceHigh)}` : '暂无' }
  ]
}
