import { Router } from 'express'
import db from '../db.js'
import { parsePriceText } from '../utils/screenshotValues.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'
import {
  MAX_NEGOTIATION_NOTE_LENGTH,
  MAX_SOURCE_NOTE_LENGTH,
  NEGOTIATION_REASON_TAG_VALUES,
  NEGOTIATION_SOURCE_TYPES,
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
const findRecord = (id) => db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
const findHistoricalCaseByRecord = (recordId) =>
  db
    .prepare(
      `SELECT * FROM creator_negotiation_cases
       WHERE record_id = ? AND source_type = 'historical_backfill'`
    )
    .get(recordId)

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

/** 可选价格（星图刊例 / 初始报价）：空值 → null；非法文本 / 负数 → 报错 */
function parseOptionalPrice(value, label) {
  if (value === null || value === undefined) return { value: null }
  if (typeof value === 'string' && value.trim() === '') return { value: null }
  const parsed = parseNegotiatedPrice(value)
  if (parsed === null) return { error: `${label}必须是非负数字或「¥2,200」这类可解析文本` }
  return { value: parsed }
}

/**
 * 收集「人的输入」并做确定性校验（live 与 historical_backfill 共用）
 * @returns {{ error?: string, negotiatedPrice?: number, negotiatedAt?: string, reasonTags?: string[],
 *             reasonNote?: string|null, strategyNote?: string|null, sourceNote?: string|null,
 *             xingtuPriceSnapshot?: number|null, currentQuoteSnapshot?: number|null }}
 */
function collectCaseFields(body, { withHistoricalFields = false } = {}) {
  const negotiatedPrice = parseNegotiatedPrice(body.negotiated_price)
  if (negotiatedPrice === null) {
    return {
      error: '最终谈成价（negotiated_price）必填，且必须是非负数字或「¥2,200」这类可解析文本'
    }
  }

  const negotiatedAt = typeof body.negotiated_at === 'string' ? body.negotiated_at.trim() : ''
  if (!negotiatedAt) return { error: '谈成日期（negotiated_at）不能为空' }
  if (!isValidDateOnly(negotiatedAt)) {
    return { error: '谈成日期（negotiated_at）必须是真实存在的日期，格式为 YYYY-MM-DD' }
  }

  const rawTags = body.reason_tags === undefined || body.reason_tags === null ? [] : body.reason_tags
  if (!Array.isArray(rawTags)) return { error: 'reason_tags 必须是数组' }
  const reasonTags = [...new Set(rawTags.map((tag) => String(tag ?? '').trim()).filter(Boolean))]
  const unknownTag = reasonTags.find((tag) => !NEGOTIATION_REASON_TAG_VALUES.includes(tag))
  if (unknownTag) return { error: `谈价原因标签「${unknownTag}」不在允许范围内` }

  const reasonNote =
    body.reason_note === null || body.reason_note === undefined ? null : String(body.reason_note).trim()
  const strategyNote =
    body.strategy_note === null || body.strategy_note === undefined ? null : String(body.strategy_note).trim()
  for (const [field, value] of [['reason_note', reasonNote], ['strategy_note', strategyNote]]) {
    if (value && value.length > MAX_NEGOTIATION_NOTE_LENGTH) {
      return { error: `${field} 长度不能超过 ${MAX_NEGOTIATION_NOTE_LENGTH}` }
    }
  }

  const result = { negotiatedPrice, negotiatedAt, reasonTags, reasonNote, strategyNote }

  if (withHistoricalFields) {
    // 历史回填：星图刊例 / 初始报价都是「用户确认过的历史价格事实」，可空但不可伪造
    const xingtu = parseOptionalPrice(body.xingtu_price_snapshot, '历史星图刊例价（xingtu_price_snapshot）')
    if (xingtu.error) return { error: xingtu.error }
    const quote = parseOptionalPrice(body.current_quote_snapshot, '历史初始报价（current_quote_snapshot）')
    if (quote.error) return { error: quote.error }
    result.xingtuPriceSnapshot = xingtu.value
    result.currentQuoteSnapshot = quote.value

    const sourceNote =
      body.source_note === null || body.source_note === undefined
        ? null
        : String(body.source_note).trim()
    if (sourceNote && sourceNote.length > MAX_SOURCE_NOTE_LENGTH) {
      return { error: `历史谈价原始备注（source_note）长度不能超过 ${MAX_SOURCE_NOTE_LENGTH}` }
    }
    result.sourceNote = sourceNote || null
  }

  return result
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
  // Phase 4F-B：candidate 决策必须来自「继续议价」这一条（candidate 的 proceed / small_test / pause 不可记录谈价）
  // 说明：legacy（candidate_id = NULL）保持既有宽松行为（只校验 stage），本阶段不收紧旧契约，
  //      也兼容 historically「post_quote + repurchase/small_test 也记录谈价」的旧用法。
  const isCandidateDecision = decision.candidate_id !== null && decision.candidate_id !== undefined
  if (isCandidateDecision && decision.human_decision !== 'negotiate') {
    return fail(res, 400, '候选达人只有「继续议价」的报价阶段决策才能记录谈价结果')
  }

  const fields = collectCaseFields(body)
  if (fields.error) return fail(res, 400, fields.error)
  const { negotiatedPrice, negotiatedAt, reasonTags, reasonNote, strategyNote } = fields

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
           , source_type, record_id, source_note
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        referenceHighSnapshot,
        'live',
        null,
        null
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
 * POST /api/creator-negotiation-cases/historical-backfill
 * Historical Negotiation Backfill V0.1：
 *   把「过去真实发生过、且已经有真实 creator_record 的谈价案例」安全回填。
 *
 * 关键边界：
 *   · 稳定身份是 record_id（不是 creator 名称），不依赖 decision_id
 *   · **绝不创建假的 decision / outcome**（历史没有发生过的系统流程不会被制造出来）
 *   · creator = record.nickname 的服务端快照（改名后仍通过 record_id 追溯）
 *   · negotiated_at = 当时真实谈价时间；created_at = 现在录入时间（不篡改）
 *   · historical_backfill 不写 CPM30 legacy 快照（target_cpm / target_price / reference_* 全为 NULL）
 *   · negotiated_price 与 creator_record.total_cost 永久分开，绝不互相同步
 *   · append-only：同一条 record 最多一条 historical_backfill（重复 → 409）
 *
 * body: { record_id, negotiated_price, negotiated_at,
 *         xingtu_price_snapshot?, current_quote_snapshot?, source_note?,
 *         reason_tags?, reason_note?, strategy_note? }
 */
router.post('/historical-backfill', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}

  const recordId = Number(body.record_id)
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return fail(res, 400, 'record_id 必须是正整数（历史回填必须绑定真实投放记录）')
  }
  const record = findRecord(recordId)
  if (!record) return fail(res, 404, `投放记录 #${recordId} 不存在`)

  const fields = collectCaseFields(body, { withHistoricalFields: true })
  if (fields.error) return fail(res, 400, fields.error)

  if (findHistoricalCaseByRecord(recordId)) {
    return fail(res, 409, `投放记录 #${recordId} 已经补录过历史谈价，不能重复补录`)
  }

  let saved
  try {
    const info = db
      .prepare(
        `INSERT INTO creator_negotiation_cases (
           creator, decision_id, snapshot_id, xingtu_price_snapshot, current_quote_snapshot,
           negotiated_price, negotiated_at, reason_tags_json, reason_note, strategy_note,
           target_cpm, target_price_snapshot, reference_low_snapshot, reference_high_snapshot,
           source_type, record_id, source_note
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        // creator 使用 record.nickname 的服务端快照（前端提交的同名字段一律忽略）
        record.nickname ?? null,
        null,
        null,
        fields.xingtuPriceSnapshot,
        fields.currentQuoteSnapshot,
        fields.negotiatedPrice,
        fields.negotiatedAt,
        JSON.stringify(fields.reasonTags),
        fields.reasonNote || null,
        fields.strategyNote || null,
        // Historical Backfill V0.1：不用今天的系统规则反推历史当时不存在的 pricing evidence
        null,
        null,
        null,
        null,
        'historical_backfill',
        recordId,
        fields.sourceNote
      )
    saved = db.prepare('SELECT * FROM creator_negotiation_cases WHERE id = ?').get(info.lastInsertRowid)
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, `投放记录 #${recordId} 已经补录过历史谈价，不能重复补录`)
    }
    throw error
  }
  ok(res, toPublicNegotiationCase(saved))
})

/**
 * GET /api/creator-negotiation-cases?creator=... 或 ?decision_id=... 或 ?record_id=...
 *   或 ?source_type=historical_backfill（只读列出历史回填，供 Records 页面标记「已补录谈价」）
 * 时间倒序（created_at DESC, id DESC）
 */
router.get('/', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  const decisionIdRaw = req.query?.decision_id
  const recordIdRaw = req.query?.record_id
  const sourceTypeRaw = String(req.query?.source_type ?? '').trim()
  if (
    !creator &&
    (decisionIdRaw === undefined || decisionIdRaw === '') &&
    (recordIdRaw === undefined || recordIdRaw === '') &&
    !sourceTypeRaw
  ) {
    return fail(res, 400, 'creator / decision_id / record_id / source_type 至少提供一个')
  }
  let rows
  if (sourceTypeRaw) {
    if (!NEGOTIATION_SOURCE_TYPES.includes(sourceTypeRaw)) {
      return fail(res, 400, 'source_type 只能是 live 或 historical_backfill')
    }
    rows = db
      .prepare(
        `SELECT * FROM creator_negotiation_cases
         WHERE source_type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 500`
      )
      .all(sourceTypeRaw)
  } else if (recordIdRaw !== undefined && recordIdRaw !== '') {
    const recordId = Number(recordIdRaw)
    if (!Number.isInteger(recordId) || recordId <= 0) {
      return fail(res, 400, 'record_id 必须是正整数')
    }
    rows = db
      .prepare(
        `SELECT * FROM creator_negotiation_cases
         WHERE record_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(recordId)
  } else if (decisionIdRaw !== undefined && decisionIdRaw !== '') {
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
