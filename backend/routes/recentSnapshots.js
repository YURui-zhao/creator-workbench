import { Router } from 'express'
import db from '../db.js'
import { parsePlayText, parsePriceText } from '../utils/screenshotValues.js'
import {
  MAX_PLAYS_PER_SNAPSHOT,
  STATS_VERSION,
  computeContentTypeBreakdown,
  computeRecentPerformanceStats,
  normalizeContentType
} from '../utils/recentPerformanceStats.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'

const router = Router()

// 字段长度上限（防止滥用；与前端输入限制一致）
const MAX_CREATOR_LENGTH = 100
const MAX_RAW_TEXT_LENGTH = 60
const MAX_PRICE_RAW_LENGTH = 60
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 严格校验 YYYY-MM-DD（含真实日历校验，2026-02-30 一类必须拒绝）
 * observed_at 是用户明确确认的业务事实，不接受 AI 推断、不从截图猜测。
 */
function isValidDateOnly(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!DATE_RE.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  )
}

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

/** 名称比较用的轻量归一化：忽略大小写与空白（不做 fuzzy / AI 身份匹配） */
export function normalizeCreatorNameForCompare(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '')
}

/** 识别昵称与目标达人是否一致（P2B 只做简单明确比较） */
export function isCreatorNameMatched(creator, recognizedNameRaw) {
  const recognized = String(recognizedNameRaw ?? '').trim()
  if (!recognized) return true // 未识别到昵称：不触发不一致确认
  return normalizeCreatorNameForCompare(creator) === normalizeCreatorNameForCompare(recognized)
}

const toOptionalText = (value, maxLength, field, errors) => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    errors.push(`${field} 必须是字符串`)
    return null
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > maxLength) {
    errors.push(`${field} 长度不能超过 ${maxLength}`)
    return null
  }
  return text
}

const toOptionalPositiveInt = (value, field, errors) => {
  if (value === null || value === undefined) return null
  const num = Number(value)
  if (!Number.isInteger(num) || num <= 0) {
    errors.push(`${field} 必须是正整数`)
    return null
  }
  return num
}

/**
 * 校验保存请求（只接受 raw 事实；前端传来的派生值一律忽略并重新计算）
 * @returns {{ ok: true, value: Object } | { ok: false, message: string }}
 */
export function validateSnapshotPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是对象' }
  }
  const errors = []

  const creator = typeof body.creator === 'string' ? body.creator.trim() : ''
  if (!creator) return { ok: false, message: 'creator 不能为空' }
  if (creator.length > MAX_CREATOR_LENGTH) {
    return { ok: false, message: `creator 长度不能超过 ${MAX_CREATOR_LENGTH}` }
  }

  const recognizedRaw = toOptionalText(
    body.recognized_creator_name_raw,
    MAX_CREATOR_LENGTH,
    'recognized_creator_name_raw',
    errors
  )
  const xingtuPriceRaw = toOptionalText(
    body.xingtu_price_raw,
    MAX_PRICE_RAW_LENGTH,
    'xingtu_price_raw',
    errors
  )

  // 名称不一致时必须由用户显式确认，避免静默绑定到错误的达人
  const identityConfirmed = body.identity_confirmed === true
  if (!isCreatorNameMatched(creator, recognizedRaw) && !identityConfirmed) {
    return {
      ok: false,
      message: `截图中的达人昵称「${recognizedRaw}」与当前达人「${creator}」不一致，请确认是否上传了正确截图`
    }
  }

  if (!Array.isArray(body.plays)) return { ok: false, message: 'plays 必须是数组' }
  if (body.plays.length === 0) return { ok: false, message: 'plays 不能为空' }
  if (body.plays.length > MAX_PLAYS_PER_SNAPSHOT) {
    return { ok: false, message: `单次最多保存 ${MAX_PLAYS_PER_SNAPSHOT} 条作品` }
  }

  const plays = body.plays.map((item, index) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    if (row.excluded !== undefined && typeof row.excluded !== 'boolean') {
      errors.push(`第 ${index + 1} 条 excluded 必须是布尔值`)
    }
    return {
      raw_text: toOptionalText(row.raw_text, MAX_RAW_TEXT_LENGTH, `第 ${index + 1} 条 raw_text`, errors),
      excluded: row.excluded === true,
      // Alpha.3-04：内容类型（商单 / 日常 / 未识别）
      // 非法值 / 缺失一律归一为 unknown（旧前端不传该字段时行为不变）
      content_type: normalizeContentType(row.content_type),
      source_image_index: toOptionalPositiveInt(
        row.source_image_index,
        `第 ${index + 1} 条 source_image_index`,
        errors
      ),
      position_index:
        toOptionalPositiveInt(row.position_index, `第 ${index + 1} 条 position_index`, errors) ??
        index + 1
    }
  })

  if (errors.length) return { ok: false, message: errors[0] }

  // Alpha.2：数据观察日期必填（后端独立校验，不信任前端）
  if (body.observed_at === null || body.observed_at === undefined || body.observed_at === '') {
    return { ok: false, message: '数据观察日期（observed_at）不能为空' }
  }
  if (!isValidDateOnly(body.observed_at)) {
    return {
      ok: false,
      message: '数据观察日期（observed_at）必须是真实存在的日期，格式为 YYYY-MM-DD'
    }
  }
  const observedAt = body.observed_at.trim()

  return {
    ok: true,
    value: { creator, recognizedRaw, xingtuPriceRaw, identityConfirmed, plays, observedAt }
  }
}

/**
 * raw -> 有效样本：
 * - 后端重新解析每条 raw_text（不信任前端 normalized_play / median 等派生值）
 * - excluded 不计入有效样本；解析失败计为 unresolved（未排除但无法确定性解析）
 * - 0 是真实播放观测，属于有效样本
 */
export function normalizeSnapshotPlays(plays = []) {
  const rows = plays.map((item, index) => {
    const parsed = parsePlayText(item?.raw_text)
    return {
      raw_text: parsed.raw_text,
      normalized_play: parsed.value,
      needs_review: parsed.needs_review,
      excluded: item?.excluded === true,
      // Alpha.3-04：内容类型随条目持久化（旧数据没有该字段 → 读取时归一为 unknown）
      content_type: normalizeContentType(item?.content_type),
      source_image_index: item?.source_image_index ?? null,
      position_index: item?.position_index ?? index + 1
    }
  })

  const valid = rows.filter(
    (row) => !row.excluded && row.normalized_play !== null && row.normalized_play >= 0
  )

  return {
    plays: rows,
    recognized_count: rows.length,
    excluded_count: rows.filter((row) => row.excluded).length,
    unresolved_count: rows.filter((row) => !row.excluded && row.normalized_play === null).length,
    valid_count: valid.length,
    // 保持人工确认顺序（从新到旧），趋势不重排
    validPlaysInOrder: valid.map((row) => row.normalized_play)
  }
}

/** 数据库行 -> 对外公开快照（plays_json 还原为数组；不含任何敏感字段） */
export function toPublicSnapshot(row) {
  if (!row) return null
  let plays = []
  try {
    const parsed = JSON.parse(row.plays_json)
    // Alpha.3-04：读取时把每条内容类型归一化（旧数据没有该字段 → unknown），不回写数据库
    plays = Array.isArray(parsed)
      ? parsed.map((play) => ({ ...play, content_type: normalizeContentType(play?.content_type) }))
      : []
  } catch {
    plays = []
  }
  return {
    id: row.id,
    creator: row.creator,
    recognized_creator_name_raw: row.recognized_creator_name_raw ?? null,
    source_type: row.source_type,
    xingtu_price_raw: row.xingtu_price_raw ?? null,
    xingtu_price: row.xingtu_price ?? null,
    plays,
    recognized_count: row.recognized_count,
    valid_count: row.valid_count,
    excluded_count: row.excluded_count,
    unresolved_count: row.unresolved_count,
    analysis_count: row.analysis_count,
    median_play: row.median_play ?? null,
    p25_play: row.p25_play ?? null,
    p75_play: row.p75_play ?? null,
    recent_median_play: row.recent_median_play ?? null,
    prior_median_play: row.prior_median_play ?? null,
    trend_ratio: row.trend_ratio ?? null,
    trend_label: row.trend_label ?? null,
    stats_status: row.stats_status ?? null,
    stats_version: row.stats_version,
    // Alpha.3-04：内容类型分组统计（由 plays_json 确定性派生，不落库、不迁移旧数据）
    // 旧快照没有 content_type → 全部计入 unknown_count，sponsored / organic 均为 0 / null
    ...computeContentTypeBreakdown(plays),
    created_at: row.created_at,
    // Alpha.2：业务观察日期（旧数据为 NULL → 「观察日期未知」）
    observed_at: row.observed_at ?? null,
    // P3 价格判断层：只消费本快照的统计字段，确定性派生（不写库）
    pricing: computeCreatorPricing({
      stats_status: row.stats_status,
      median_play: row.median_play,
      p25_play: row.p25_play,
      p75_play: row.p75_play,
      xingtu_price: row.xingtu_price
    })
  }
}

/** 雷达列表用的轻量 summary（不返回 plays_json，避免响应膨胀） */
export function toSnapshotSummary(row) {
  if (!row) return null
  // Alpha.3-04：Radar / latest 只带内容类型分组统计；旧快照（无类型）→ 全部 unknown
  let playsForBreakdown = []
  try {
    const parsed = JSON.parse(row.plays_json)
    playsForBreakdown = Array.isArray(parsed) ? parsed : []
  } catch {
    playsForBreakdown = []
  }
  return {
    id: row.id,
    created_at: row.created_at,
    observed_at: row.observed_at ?? null,
    valid_count: row.valid_count,
    analysis_count: row.analysis_count,
    median_play: row.median_play ?? null,
    p25_play: row.p25_play ?? null,
    p75_play: row.p75_play ?? null,
    trend_label: row.trend_label ?? null,
    xingtu_price: row.xingtu_price ?? null,
    stats_status: row.stats_status ?? null,
    stats_version: row.stats_version,
    ...computeContentTypeBreakdown(playsForBreakdown),
    // P3：radar 一次请求即带价格判断，避免前端 N+1（同一行数据派生，无需额外查询）
    pricing: computeCreatorPricing({
      stats_status: row.stats_status,
      median_play: row.median_play,
      p25_play: row.p25_play,
      p75_play: row.p75_play,
      xingtu_price: row.xingtu_price
    })
  }
}

const MAKE_SUMMARY_COLUMNS =
  'id, creator, created_at, observed_at, valid_count, analysis_count, median_play, p25_play, p75_play, trend_label, xingtu_price, stats_status, stats_version, plays_json'

/**
 * 「latest snapshot」排序（Alpha.2 起为唯一口径，GET /latest 与 radar 批量合并共用）：
 *   1) 有 observed_at 的快照优先（NULL 不得覆盖已有明确观察日期的快照）
 *   2) observed_at DESC
 *   3) created_at DESC
 *   4) id DESC
 * 若某达人所有快照 observed_at 皆为 NULL，则退化为原 created_at / id 逻辑（兼容 Alpha.1 数据）。
 */
const LATEST_SNAPSHOT_ORDER_SQL = 'ORDER BY observed_at IS NULL ASC, observed_at DESC, created_at DESC, id DESC'

/**
 * 批量读取多个达人的最新快照 summary（单条 SQL，避免前端 N+1）
 * @param {string[]} creatorList
 * @returns {Map<string, Object>} creator -> summary
 */
export function loadLatestSnapshotSummaries(creatorList = []) {
  const creators = [...new Set((Array.isArray(creatorList) ? creatorList : []).map((item) => String(item ?? '').trim()).filter(Boolean))]
  const map = new Map()
  if (!creators.length) return map
  const placeholders = creators.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ${MAKE_SUMMARY_COLUMNS}
       FROM creator_recent_snapshots
       WHERE creator IN (${placeholders})
       ${LATEST_SNAPSHOT_ORDER_SQL}`
    )
    .all(...creators)
  for (const row of rows) {
    if (!map.has(row.creator)) map.set(row.creator, toSnapshotSummary(row))
  }
  return map
}

function findCreatorRecord(creator) {
  return db.prepare('SELECT nickname FROM creator_records WHERE nickname = ? LIMIT 1').get(creator)
}

/**
 * POST /api/recent-snapshots
 * append-only 保存一条近期表现快照：
 * - 只接受 raw 事实，后端重新解析并计算全部统计值（前端派生值一律忽略）
 * - 不写 creator_records，不调用 AI，不访问外部网络
 */
router.post('/', (req, res) => {
  const validated = validateSnapshotPayload(req.body)
  if (!validated.ok) return fail(res, 400, validated.message)

  const { creator, recognizedRaw, xingtuPriceRaw, plays, observedAt } = validated.value

  // creator 必须存在于历史投放记录中（P2B 不引入 creator master）
  if (!findCreatorRecord(creator)) {
    return fail(res, 400, `达人「${creator}」不存在于当前投放记录中，无法保存近期表现快照`)
  }

  const price = parsePriceText(xingtuPriceRaw)
  const normalized = normalizeSnapshotPlays(plays)
  const stats = computeRecentPerformanceStats(normalized.validPlaysInOrder)

  const info = db
    .prepare(
      `INSERT INTO creator_recent_snapshots (
         creator, recognized_creator_name_raw, source_type, xingtu_price_raw, xingtu_price, plays_json,
         recognized_count, valid_count, excluded_count, unresolved_count, analysis_count,
         median_play, p25_play, p75_play, recent_median_play, prior_median_play,
         trend_ratio, trend_label, stats_status, stats_version, observed_at
       ) VALUES (?, ?, 'screenshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      creator,
      recognizedRaw,
      price.raw_text,
      price.value,
      JSON.stringify(normalized.plays),
      normalized.recognized_count,
      normalized.valid_count,
      normalized.excluded_count,
      normalized.unresolved_count,
      stats.analysis_count,
      stats.median_play,
      stats.p25_play,
      stats.p75_play,
      stats.recent_median_play,
      stats.prior_median_play,
      stats.trend_ratio,
      stats.trend_label,
      stats.stats_status,
      STATS_VERSION,
      observedAt
    )

  const saved = db
    .prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?')
    .get(info.lastInsertRowid)
  ok(res, toPublicSnapshot(saved))
})

/**
 * GET /api/recent-snapshots/latest?creator=...
 * 无快照时返回 { creator, snapshot: null }（不是错误）
 */
router.get('/latest', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  if (!creator) return fail(res, 400, 'creator 不能为空')
  if (creator.length > MAX_CREATOR_LENGTH) {
    return fail(res, 400, `creator 长度不能超过 ${MAX_CREATOR_LENGTH}`)
  }
  const row = db
    .prepare(
      `SELECT * FROM creator_recent_snapshots
       WHERE creator = ?
       ${LATEST_SNAPSHOT_ORDER_SQL}
       LIMIT 1`
    )
    .get(creator)
  ok(res, { creator, snapshot: row ? toPublicSnapshot(row) : null })
})

export default router
