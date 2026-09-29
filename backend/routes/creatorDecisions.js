import { Router } from 'express'
import db from '../db.js'
import { buildRepurchaseRadar } from './records.js'
import { parsePriceText } from '../utils/screenshotValues.js'
import { computeCreatorPricing } from '../utils/creatorPricing.js'
import { assessCurrentQuote } from '../utils/currentQuoteAssessment.js'
import { PRICING_VERSION, TARGET_CPM } from '../utils/creatorBusinessRules.js'

const router = Router()

export const DECISION_STAGES = ['contact', 'post_quote']
export const CONTACT_DECISIONS = ['contact_now', 'observe', 'skip_for_now']
export const POST_QUOTE_DECISIONS = ['repurchase', 'small_test', 'negotiate', 'pause']
export const IP_JUDGEMENTS = ['strong', 'medium', 'weak', 'unknown']
export const SYSTEM_CONTEXT_VERSION = 'decision-context-v1'
export const MAX_NOTE_LENGTH = 500
export const MAX_QUOTE_RAW_LENGTH = 60

export const HUMAN_DECISION_LABELS = {
  contact_now: '开始建联',
  observe: '继续观察',
  skip_for_now: '暂不联系',
  repurchase: '复投',
  small_test: '小额测试',
  negotiate: '继续议价',
  pause: '暂缓'
}

export const IP_JUDGEMENT_LABELS = {
  strong: '明显',
  medium: '一般',
  weak: '较弱',
  unknown: '未判断'
}

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

const findCreatorRecord = (creator) =>
  db.prepare('SELECT nickname FROM creator_records WHERE nickname = ? LIMIT 1').get(creator)

const DECISION_SUMMARY_COLUMNS =
  'id, creator, created_at, decision_stage, current_quote, ip_judgement, human_decision, pricing_version'

/** 决策轻量 summary（雷达 Popover 用，不含 evidence JSON） */
export function toDecisionSummary(row) {
  if (!row) return null
  return {
    id: row.id,
    created_at: row.created_at,
    decision_stage: row.decision_stage,
    current_quote: row.current_quote ?? null,
    ip_judgement: row.ip_judgement ?? null,
    human_decision: row.human_decision,
    human_decision_label: HUMAN_DECISION_LABELS[row.human_decision] || row.human_decision,
    pricing_version: row.pricing_version
  }
}

/**
 * 批量读取多个达人的最新决策 summary（单条 SQL，radar 一次请求即可展示，无 N+1）
 * @param {string[]} creatorList
 * @returns {Map<string, Object>} creator -> summary
 */
export function loadLatestDecisionSummaries(creatorList = []) {
  const creators = [
    ...new Set(
      (Array.isArray(creatorList) ? creatorList : [])
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
    )
  ]
  const map = new Map()
  if (!creators.length) return map
  const placeholders = creators.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT ${DECISION_SUMMARY_COLUMNS}
       FROM creator_decisions
       WHERE creator IN (${placeholders})
       ORDER BY created_at DESC, id DESC`
    )
    .all(...creators)
  for (const row of rows) {
    if (!map.has(row.creator)) map.set(row.creator, toDecisionSummary(row))
  }
  return map
}

const findSnapshotRow = (snapshotId) =>
  db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapshotId)

/**
 * 固化「当时的历史证据」：复用 P1 完全相同的纯函数与字段定义（不复制任何 P1 逻辑）。
 * 只读取该达人的投放记录 → buildRepurchaseRadar → 取该达人条目。
 */
export function buildHistoricalEvidence(creator, { referenceDate = null } = {}) {
  const rows = db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, total_cost, first_play, second_week_play, publish_date
       FROM creator_records
       WHERE nickname = ?
       ORDER BY time_cycle ASC, id ASC`
    )
    .all(creator)
  if (!rows.length) return null
  const radar = buildRepurchaseRadar(rows, { referenceDate })
  const entry = radar.groups.flatMap((group) => group.creators).find((item) => item.creator === creator)
  if (!entry) return null
  return {
    record_count: entry.record_count,
    valid_cpm_count: entry.valid_cpm_count,
    pass_count: entry.pass_count,
    fail_count: entry.fail_count,
    historical_status: entry.historical_status,
    historical_status_label: entry.historical_status_label,
    median_cpm: entry.median_cpm,
    recent_risk: entry.recent_risk,
    last_collaboration_date: entry.last_collaboration_date,
    days_since_last_collaboration: entry.days_since_last_collaboration,
    target_cpm: entry ? TARGET_CPM : null
  }
}

/** 固化近期证据：完全来自该 snapshot 行，不重新计算 P2B 统计 */
export function buildRecentEvidence(snapshotRow) {
  if (!snapshotRow) return null
  return {
    snapshot_id: snapshotRow.id,
    stats_version: snapshotRow.stats_version,
    created_at: snapshotRow.created_at,
    valid_count: snapshotRow.valid_count,
    median_play: snapshotRow.median_play ?? null,
    p25_play: snapshotRow.p25_play ?? null,
    p75_play: snapshotRow.p75_play ?? null,
    trend_label: snapshotRow.trend_label ?? null,
    xingtu_price: snapshotRow.xingtu_price ?? null
  }
}

/** snapshot 的 P3 星图 pricing（同一套 P3 函数） */
export function buildXingtuPricing(snapshotRow) {
  if (!snapshotRow) return null
  return computeCreatorPricing({
    stats_status: snapshotRow.stats_status,
    median_play: snapshotRow.median_play,
    p25_play: snapshotRow.p25_play,
    p75_play: snapshotRow.p75_play,
    xingtu_price: snapshotRow.xingtu_price ?? null
  })
}

/**
 * 实际报价评估：只做「事实折扣 + 与 CPM30 的差额 + 状态」，
 * 不再把 current_quote 当成新的折扣基准重新跑 P3 谈价区间。
 */
export function buildCurrentQuoteAssessment(snapshotRow, currentQuote) {
  const xingtuPricing = buildXingtuPricing(snapshotRow)
  return assessCurrentQuote({
    currentQuote,
    xingtuPrice: snapshotRow?.xingtu_price ?? null,
    targetPrice: xingtuPricing?.target_price ?? null,
    referenceHigh: xingtuPricing?.reference_high ?? null
  })
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

/**
 * 校验决策请求：只接受「人的输入」，authoritative 证据一律由后端重建
 * @returns {{ok: true, value: Object} | {ok: false, message: string}}
 */
export function validateDecisionPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是对象' }
  }
  const errors = []

  const creator = typeof body.creator === 'string' ? body.creator.trim() : ''
  if (!creator) return { ok: false, message: 'creator 不能为空' }
  if (creator.length > 100) return { ok: false, message: 'creator 长度不能超过 100' }

  const decisionStage = String(body.decision_stage ?? '').trim()
  if (!DECISION_STAGES.includes(decisionStage)) {
    return { ok: false, message: `decision_stage 必须为：${DECISION_STAGES.join(' / ')}` }
  }

  const ipJudgementRaw = body.ip_judgement === null || body.ip_judgement === undefined
    ? 'unknown'
    : String(body.ip_judgement).trim()
  if (!IP_JUDGEMENTS.includes(ipJudgementRaw)) {
    return { ok: false, message: `ip_judgement 必须为：${IP_JUDGEMENTS.join(' / ')}` }
  }

  const humanDecision = String(body.human_decision ?? '').trim()
  const allowedDecisions =
    decisionStage === 'contact' ? CONTACT_DECISIONS : POST_QUOTE_DECISIONS
  if (!allowedDecisions.includes(humanDecision)) {
    return {
      ok: false,
      message: `${decisionStage} 阶段的 human_decision 必须为：${allowedDecisions.join(' / ')}`
    }
  }

  const decisionNote = toOptionalText(body.decision_note, MAX_NOTE_LENGTH, 'decision_note', errors)
  const currentQuoteRaw = toOptionalText(
    body.current_quote_raw,
    MAX_QUOTE_RAW_LENGTH,
    'current_quote_raw',
    errors
  )
  if (errors.length) return { ok: false, message: errors[0] }

  let snapshotId = null
  if (body.snapshot_id !== null && body.snapshot_id !== undefined && body.snapshot_id !== '') {
    const num = Number(body.snapshot_id)
    if (!Number.isInteger(num) || num <= 0) {
      return { ok: false, message: 'snapshot_id 必须是正整数' }
    }
    snapshotId = num
  }

  // contact 阶段不允许带入实际报价（避免把商务报价混进联系前决策）
  if (decisionStage === 'contact' && currentQuoteRaw !== null) {
    return { ok: false, message: 'contact 阶段不允许填写实际报价' }
  }
  if (decisionStage === 'post_quote') {
    if (snapshotId === null) {
      return { ok: false, message: 'post_quote 阶段必须提供 snapshot_id（需要近期表现作为价格判断基础）' }
    }
    if (currentQuoteRaw === null) {
      return { ok: false, message: 'post_quote 阶段必须填写实际报价（current_quote_raw）' }
    }
  }

  return {
    ok: true,
    value: {
      creator,
      decisionStage,
      snapshotId,
      currentQuoteRaw,
      ipJudgement: ipJudgementRaw,
      humanDecision,
      decisionNote
    }
  }
}

/** 数据库行 -> 对外 decision（evidence 为创建时固化的 JSON） */
export function toPublicDecision(row) {
  if (!row) return null
  const parseJson = (text) => {
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return {
    id: row.id,
    creator: row.creator,
    decision_stage: row.decision_stage,
    snapshot_id: row.snapshot_id ?? null,
    current_quote_raw: row.current_quote_raw ?? null,
    current_quote: row.current_quote ?? null,
    ip_judgement: row.ip_judgement ?? null,
    human_decision: row.human_decision,
    human_decision_label: HUMAN_DECISION_LABELS[row.human_decision] || row.human_decision,
    decision_note: row.decision_note ?? null,
    historical_evidence: parseJson(row.historical_evidence_json),
    recent_evidence: parseJson(row.recent_evidence_json),
    pricing_evidence: parseJson(row.pricing_evidence_json),
    target_cpm: row.target_cpm,
    pricing_version: row.pricing_version,
    system_context_version: row.system_context_version,
    created_at: row.created_at
  }
}

/** 创建时的公共前置校验：creator 存在；snapshot 存在且属于该 creator */
function resolveContext(value) {
  if (!findCreatorRecord(value.creator)) {
    return { ok: false, message: `达人「${value.creator}」不存在于当前投放记录中` }
  }
  let snapshotRow = null
  if (value.snapshotId !== null) {
    snapshotRow = findSnapshotRow(value.snapshotId)
    if (!snapshotRow) {
      return { ok: false, message: `近期表现快照 #${value.snapshotId} 不存在` }
    }
    if (snapshotRow.creator !== value.creator) {
      return {
        ok: false,
        message: `快照 #${value.snapshotId} 属于「${snapshotRow.creator}」，不能绑定给「${value.creator}」`
      }
    }
  }
  return { ok: true, snapshotRow }
}

/**
 * POST /api/creator-decisions/preview（只读、无写库、无 AI）
 * 展示星图 pricing + 实际报价评估（折扣锚定星图刊例价，前端不复制公式）
 */
router.post('/preview', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const creator = String(body.creator ?? '').trim()
  if (!creator) return fail(res, 400, 'creator 不能为空')
  const snapshotId = Number(body.snapshot_id)
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) {
    return fail(res, 400, 'snapshot_id 必须是正整数')
  }
  const context = resolveContext({ creator, snapshotId })
  if (!context.ok) return fail(res, 400, context.message)

  const parsed = parsePriceText(body.current_quote_raw)
  if (parsed.value === null) {
    return fail(res, 400, '实际报价无法确定性解析，请按「¥2400 / 2400元 / 2,400」等形式填写')
  }

  ok(res, {
    creator,
    snapshot_id: snapshotId,
    current_quote_raw: parsed.raw_text,
    current_quote: parsed.value,
    xingtu_price: context.snapshotRow.xingtu_price ?? null,
    xingtu_pricing: buildXingtuPricing(context.snapshotRow),
    current_quote_assessment: buildCurrentQuoteAssessment(context.snapshotRow, parsed.value)
  })
})

/**
 * POST /api/creator-decisions
 * append-only 创建决策：证据 / target_cpm / pricing_version 全部由后端重建并固化
 */
router.post('/', (req, res) => {
  const validated = validateDecisionPayload(req.body)
  if (!validated.ok) return fail(res, 400, validated.message)
  const value = validated.value

  const context = resolveContext(value)
  if (!context.ok) return fail(res, 400, context.message)
  const { snapshotRow } = context

  const historicalEvidence = buildHistoricalEvidence(value.creator)
  if (!historicalEvidence) {
    return fail(res, 400, `达人「${value.creator}」缺少可用于决策的历史投放记录`)
  }

  let currentQuote = null
  let pricingEvidence = null
  if (value.decisionStage === 'post_quote') {
    const parsed = parsePriceText(value.currentQuoteRaw)
    if (parsed.value === null) {
      return fail(res, 400, '实际报价无法确定性解析，请按「¥2400 / 2400元 / 2,400」等形式填写')
    }
    currentQuote = parsed.value
    pricingEvidence = {
      xingtu_pricing: buildXingtuPricing(snapshotRow),
      current_quote_assessment: buildCurrentQuoteAssessment(snapshotRow, currentQuote)
    }
  } else {
    // contact：只固化当时星图 pricing（无 snapshot 时为 null）
    pricingEvidence = {
      xingtu_pricing: buildXingtuPricing(snapshotRow),
      current_quote_assessment: null
    }
  }

  const info = db
    .prepare(
      `INSERT INTO creator_decisions (
         creator, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement,
         human_decision, decision_note, historical_evidence_json, recent_evidence_json,
         pricing_evidence_json, target_cpm, pricing_version, system_context_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      value.creator,
      value.decisionStage,
      value.snapshotId,
      value.currentQuoteRaw,
      currentQuote,
      value.ipJudgement,
      value.humanDecision,
      value.decisionNote,
      JSON.stringify(historicalEvidence),
      snapshotRow ? JSON.stringify(buildRecentEvidence(snapshotRow)) : null,
      pricingEvidence ? JSON.stringify(pricingEvidence) : null,
      TARGET_CPM,
      PRICING_VERSION,
      SYSTEM_CONTEXT_VERSION
    )

  const saved = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(info.lastInsertRowid)
  ok(res, toPublicDecision(saved))
})

/**
 * GET /api/creator-decisions?creator=...
 * 时间倒序（created_at DESC, id DESC），固定返回创建时固化的证据
 */
router.get('/', (req, res) => {
  const creator = String(req.query?.creator ?? '').trim()
  if (!creator) return fail(res, 400, 'creator 不能为空')
  if (creator.length > 100) return fail(res, 400, 'creator 长度不能超过 100')
  const rows = db
    .prepare(
      `SELECT * FROM creator_decisions
       WHERE creator = ?
       ORDER BY created_at DESC, id DESC`
    )
    .all(creator)
  ok(res, { creator, decisions: rows.map(toPublicDecision) })
})

export default router
