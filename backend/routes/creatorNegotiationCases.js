import { Router } from 'express'
import db from '../db.js'
import { parsePriceText } from '../utils/screenshotValues.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'
import {
  MAX_NEGOTIATION_NOTE_LENGTH,
  NEGOTIATION_REASON_TAG_VALUES,
  isValidDateOnly,
  toPublicNegotiationCase
} from '../utils/negotiationCase.js'

/**
 * 谈判结果沉淀（V3-alpha.2 A4）
 *
 * 设计原则：
 *   · append-only：只新增，不改写 creator_decisions / creator_recent_snapshots
 *   · 谈判上下文（星图价 / 当前报价 / CPM30 目标价 / 参考区间）在创建时由后端读取并冻结，
 *     前端提交的这些字段一律忽略（禁止伪造历史上下文）
 *   · negotiated_price 与 actual_cost / current_quote / xingtu_price 永久分开，互不同步
 *   · 无 AI、无外部网络
 */
const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

const findDecision = (id) => db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(id)
const findSnapshot = (id) => db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(id)
const findCaseByDecision = (decisionId) =>
  db.prepare('SELECT * FROM creator_negotiation_cases WHERE decision_id = ?').get(decisionId)

/**
 * 批量加载若干 decision 的谈判案例（单条 SQL，决策列表展示用，避免 N+1）
 * @param {Array<{id: number}>} decisionRows
 * @returns {Map<number, Object>} decision_id -> 对外案例对象
 */
export function loadNegotiationCaseSummaries(decisionRows = []) {
  const map = new Map()
  const ids = (Array.isArray(decisionRows) ? decisionRows : [])
    .map((row) => row?.id)
    .filter((id) => Number.isInteger(id) && id > 0)
  if (!ids.length) return map
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT * FROM creator_negotiation_cases WHERE decision_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) map.set(row.decision_id, toPublicNegotiationCase(row))
  return map
}

/** 谈成价：接受数字，也接受「¥2,200 / 2200元 / 2,400」这类文本（复用确定性价格 parser） */
function parseNegotiatedPrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string') {
    const parsed = parsePriceText(value)
    return parsed.value !== null && parsed.value >= 0 ? parsed.value : null
  }
  return null
}

/**
 * POST /api/creator-negotiation-cases
 * body: { decision_id, negotiated_price, negotiated_at, reason_tags?, reason_note?, strategy_note? }
 */
router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

  const decisionId = Number(body.decision_id)
  if (!Number.isInteger(decisionId) || decisionId <= 0) {
    return fail(res, 400, 'decision_id 必须是正整数')
  }
  const decision = findDecision(decisionId)
  if (!decision) return fail(res, 404, `决策 #${decisionId} 不存在`)
  if (decision.decision_stage !== 'post_quote') {
    return fail(res, 400, '只有「已拿到报价」阶段的决策才能记录谈价结果')
  }

  const negotiatedPrice = parseNegotiatedPrice(body.negotiated_price)
  if (negotiatedPrice === null) {
    return fail(res, 400, '最终谈成价（negotiated_price）必填，且必须是非负数字或「¥2,200」这类可解析文本')
  }

  const negotiatedAt = typeof body.negotiated_at === 'string' ? body.negotiated_at.trim() : ''
  if (!negotiatedAt) return fail(res, 400, '谈成日期（negotiated_at）不能为空')
  if (!isValidDateOnly(negotiatedAt)) {
    return fail(res, 400, '谈成日期（negotiated_at）必须是真实存在的日期，格式为 YYYY-MM-DD')
  }

  const rawTags = body.reason_tags === undefined || body.reason_tags === null ? [] : body.reason_tags
  if (!Array.isArray(rawTags)) return fail(res, 400, 'reason_tags 必须是数组')
  const reasonTags = [...new Set(rawTags.map((tag) => String(tag ?? '').trim()).filter(Boolean))]
  const unknownTag = reasonTags.find((tag) => !NEGOTIATION_REASON_TAG_VALUES.includes(tag))
  if (unknownTag) return fail(res, 400, `谈价原因标签「${unknownTag}」不在允许范围内`)

  const reasonNote = body.reason_note === null || body.reason_note === undefined ? null : String(body.reason_note).trim()
  const strategyNote =
    body.strategy_note === null || body.strategy_note === undefined ? null : String(body.strategy_note).trim()
  for (const [field, value] of [['reason_note', reasonNote], ['strategy_note', strategyNote]]) {
    if (value && value.length > MAX_NEGOTIATION_NOTE_LENGTH) {
      return fail(res, 400, `${field} 长度不能超过 ${MAX_NEGOTIATION_NOTE_LENGTH}`)
    }
  }

  if (findCaseByDecision(decisionId)) {
    return fail(res, 409, `决策 #${decisionId} 已经有谈价结果，不能重复记录`)
  }

  // ---- 冻结「当时」的谈判上下文（全部由后端重新读取，忽略前端提交的同名字段）----
  const snapshotRow = decision.snapshot_id ? findSnapshot(decision.snapshot_id) : null
  const snapshotPricing = snapshotRow
    ? computeCreatorPricing({
        stats_status: snapshotRow.stats_status,
        median_play: snapshotRow.median_play,
        p25_play: snapshotRow.p25_play,
        p75_play: snapshotRow.p75_play,
        xingtu_price: snapshotRow.xingtu_price ?? null
      })
    : null
  const xingtuPriceSnapshot = snapshotRow?.xingtu_price ?? null
  const currentQuoteSnapshot = decision.current_quote ?? null
  const targetPriceSnapshot = snapshotPricing?.target_price ?? null
  const referenceLowSnapshot = snapshotPricing?.reference_low ?? null
  const referenceHighSnapshot = snapshotPricing?.reference_high ?? null
  const targetCpm = decision.target_cpm ?? null

  let saved
  try {
    const info = db
      .prepare(
        `INSERT INTO creator_negotiation_cases (
           creator, decision_id, snapshot_id, xingtu_price_snapshot, current_quote_snapshot,
           negotiated_price, negotiated_at, reason_tags_json, reason_note, strategy_note,
           target_cpm, target_price_snapshot, reference_low_snapshot, reference_high_snapshot
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.creator,
        decisionId,
        decision.snapshot_id ?? null,
        xingtuPriceSnapshot,
        currentQuoteSnapshot,
        negotiatedPrice,
        negotiatedAt,
        JSON.stringify(reasonTags),
        reasonNote || null,
        strategyNote || null,
        targetCpm,
        targetPriceSnapshot,
        referenceLowSnapshot,
        referenceHighSnapshot
      )
    saved = db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(info.lastInsertRowid)
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, `决策 #${decisionId} 已经有谈价结果，不能重复记录`)
    }
    throw error
  }
  ok(res, toPublicNegotiationCase(saved))
})

/**
 * GET /api/creator-negotiation-cases?creator=...  或  ?decision_id=...
 * 时间倒序（created_at DESC, id DESC）
 */
router.get('/', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  const decisionIdRaw = req.query?.decision_id
  if (!creator && (decisionIdRaw === undefined || decisionIdRaw === '')) {
    return fail(res, 400, 'creator 或 decision_id 至少提供一个')
  }
  let rows
  if (decisionIdRaw !== undefined && decisionIdRaw !== '') {
    const decisionId = Number(decisionIdRaw)
    if (!Number.isInteger(decisionId) || decisionId <= 0) {
      return fail(res, 400, 'decision_id 必须是正整数')
    }
    rows = db
      .prepare(
        `SELECT * FROM creator_negotiation_cases
         WHERE decision_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(decisionId)
  } else {
    rows = db
      .prepare(
        `SELECT * FROM creator_negotiation_cases
         WHERE creator = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(creator)
  }
  ok(res, { creator: creator || null, cases: rows.map(toPublicNegotiationCase) })
})

export default router
