/**
 * 价格判断结果的「展示层」格式化（V3-alpha P3）
 *
 * 重要：本模块不做任何价格计算与状态判断 ——
 * 目标价 / 参考区间 / 折扣 / pricing_status 全部由后端
 * backend/utils/creatorPricing.js 确定性给出，前端只负责展示。
 */

/** 金额：整数不带小数，有小数最多 2 位；null → '-' */
export function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-'
  const num = Number(value)
  const isInteger = Math.abs(num - Math.round(num)) < 1e-9
  return `¥${num.toLocaleString('zh-CN', {
    minimumFractionDigits: isInteger ? 0 : 2,
    maximumFractionDigits: 2
  })}`
}

/** 折扣（rate*10 的结果）：整数显示 7折，否则 5.2折；null → '-' */
export function formatZhe(zhe) {
  if (zhe === null || zhe === undefined || !Number.isFinite(Number(zhe))) return '-'
  const num = Number(zhe)
  const isInteger = Math.abs(num - Math.round(num)) < 1e-9
  return `${isInteger ? Math.round(num) : num.toFixed(1)}折`
}

/**
 * 进入参考区间的展示文案：
 * - 刊例价本就不高于参考区间上限 → 明确说明无需为进入区间议价（不显示 >10折）
 * - 否则显示「≤X折」
 */
export function formatEntryDiscount(pricing) {
  if (!pricing) return '-'
  if (pricing.quote_at_or_below_reference_high) {
    return '当前刊例价已不高于参考区间上限，无需为了进入区间继续议价'
  }
  if (pricing.entry_discount_zhe === null || pricing.entry_discount_zhe === undefined) return '-'
  return `≤${formatZhe(pricing.entry_discount_zhe)}`
}

/**
 * 目标成交折扣展示文案：
 * - 刊例价已不高于目标价 → 无需继续议价
 * - 否则显示「约X折」，并在低于业务最低参考边界（2折）时如实提示，不做 clamp
 */
export function formatTargetDiscount(pricing) {
  if (!pricing) return '-'
  if (pricing.quote_at_or_below_target) {
    return '当前刊例价已不高于 CPM30目标价，无需继续议价'
  }
  if (pricing.target_discount_zhe === null || pricing.target_discount_zhe === undefined) return '-'
  const base = `约${formatZhe(pricing.target_discount_zhe)}`
  return pricing.target_discount_below_min_reference ? `${base}（低于当前2折参考边界）` : base
}

/** Popover「价格核算」行（纯展示映射，不含计算） */
export function buildPricingRows(pricing) {
  if (!pricing) return []
  const rows = [
    { label: 'CPM30目标价', value: formatPrice(pricing.target_price) },
    {
      label: 'CPM30参考区间',
      value:
        pricing.reference_low === null || pricing.reference_high === null
          ? '-'
          : `${formatPrice(pricing.reference_low)}～${formatPrice(pricing.reference_high)}`
    }
  ]
  if (pricing.pricing_status === 'stats_insufficient') return rows
  rows.push({
    label: '星图刊例价',
    value:
      pricing.xingtu_price === null || pricing.xingtu_price === undefined
        ? '待确认 / 未识别'
        : formatPrice(pricing.xingtu_price)
  })
  if (pricing.pricing_status !== 'quote_missing') {
    rows.push({ label: '常规7折参考', value: formatPrice(pricing.regular_70_price) })
    rows.push({ label: '最低2折参考', value: formatPrice(pricing.min_20_price) })
    rows.push({ label: '进入参考区间', value: formatEntryDiscount(pricing) })
    rows.push({ label: '目标成交', value: formatTargetDiscount(pricing) })
  }
  return rows
}
