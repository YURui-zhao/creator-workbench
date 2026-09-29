import { Router } from 'express'
import db from '../db.js'
import { toPublicDecision } from './creatorDecisions.js'
import {
  buildOutcomeCandidates,
  buildOutcomeSummary,
  computeTimingWarning,
  isDecisionEligibleForOutcome
} from '../utils/creatorDecisionOutcome.js'
import { TARGET_CPM } from '../utils/creatorBusinessRules.js'

/**
 * 决策 ↔ 真实投放结果 关联（V3-alpha P5）
 *
 * 本 router 挂载在与 P4 相同的 `/api/creator-decisions` 前缀下（见 backend/server.js），
 * 只新增三个子路径，不修改 P4 router 的任何既有路由：
 *   GET    /api/creator-decisions/:id/outcome-candidates
 *   POST   /api/creator-decisions/:id/outcome
 *   DELETE /api/creator-decisions/:id/outcome
 *
 * 安全边界：
 *   · 只写 creator_decision_outcomes（关联关系），绝不 UPDATE creator_decisions / creator_records
 *   · 花费 / 播放 / CPM / target 状态一律由后端从 creator_records 实时生成，忽略前端提交的任何派生字段
 *   · 无 AI、无外部网络、无 base64 / Key / provider 数据
 */
const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

function parseId(value) {
  const num = Number(value)
  return Number.isInteger(num) && num > 0 ? num : null
}

const findDecision = (id) => db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(id)
const findRecord = (id) => db.prepare('SELECT * FROM creator_records WHERE id = ?').get(id)
const findLinkByDecision = (decisionId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE decision_id = ?').get(decisionId)
const findLinkByRecord = (recordId) =>
  db.prepare('SELECT * FROM creator_decision_outcomes WHERE record_id = ?').get(recordId)

/** 该达人全部投放记录（候选池只含同一 creator，不返回其他达人的记录） */
const listCreatorRecords = (creator) =>
  db
    .prepare(
      `SELECT id, nickname, creator_type, total_cost, publish_date, first_play, second_week_play
       FROM creator_records
       WHERE nickname = ?
       ORDER BY publish_date DESC, id DESC`
    )
    .all(creator)

/** record_id -> decision_id（用于标记 already_linked） */
function loadRecordLinkMap(recordIds = []) {
  const ids = [...new Set(recordIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
  const map = new Map()
  if (!ids.length) return map
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT record_id, decision_id FROM creator_decision_outcomes WHERE record_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) map.set(row.record_id, row.decision_id)
  return map
}

/**
 * 批量加载若干 decision 的 outcome summary（单条 SQL，避免雷达 / 决策列表 N+1）
 * outcome 的花费 / 播放 / CPM 实时取自 creator_records；decision 证据不受影响。
 * @param {Array<{id: number, target_cpm?: number}>} decisionRows
 * @returns {Map<number, Object>} decision_id -> outcome summary
 */
export function loadOutcomeSummaries(decisionRows = []) {
  const map = new Map()
  const decisions = (Array.isArray(decisionRows) ? decisionRows : []).filter((row) => row && row.id)
  if (!decisions.length) return map
  const targetByDecision = new Map(
    decisions.map((row) => [row.id, Number.isFinite(Number(row.target_cpm)) ? Number(row.target_cpm) : TARGET_CPM])
  )
  const ids = decisions.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  // 单条 SQL 直接 JOIN 关联表与投放记录：避免 N+1，也不把结果复制进 link 表
  const rows = db
    .prepare(
      `SELECT o.id AS link_id, o.decision_id AS link_decision_id, o.record_id AS link_record_id,
              o.linked_at AS link_linked_at,
              r.id AS record_id, r.nickname, r.creator_type, r.total_cost, r.publish_date,
              r.first_play, r.second_week_play
       FROM creator_decision_outcomes o
       JOIN creator_records r ON r.id = o.record_id
       WHERE o.decision_id IN (${placeholders})`
    )
    .all(...ids)
  for (const row of rows) {
    const summary = buildOutcomeSummary(
      { id: row.link_id, decision_id: row.link_decision_id, record_id: row.link_record_id, linked_at: row.link_linked_at },
      { ...row, id: row.record_id },
      { targetCpm: targetByDecision.get(row.link_decision_id) ?? TARGET_CPM }
    )
    if (summary) map.set(row.link_decision_id, summary)
  }
  return map
}

/** 单条 decision 的 outcome summary（无关联返回 null） */
export function loadOutcomeSummaryForDecision(decisionRow) {
  if (!decisionRow || !decisionRow.id) return null
  const link = findLinkByDecision(decisionRow.id)
  if (!link) return null
  const record = findRecord(link.record_id)
  return buildOutcomeSummary(link, record, { targetCpm: decisionRow.target_cpm ?? TARGET_CPM })
}

/**
 * GET /api/creator-decisions/:id/outcome-candidates
 * 返回该 decision 所属达人的真实投放记录（按发布日期倒序），供人工选择关联。
 */
router.get('/:id/outcome-candidates', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)

  const eligibility = isDecisionEligibleForOutcome(decision)
  const records = listCreatorRecords(decision.creator)
  const linkMap = loadRecordLinkMap(records.map((row) => row.id))
  const candidates = buildOutcomeCandidates(records, {
    decisionCreatedAt: decision.created_at,
    linkMap
  })
  ok(res, {
    decision_id: decision.id,
    creator: decision.creator,
    eligible: eligibility.eligible,
    eligibility_reason: eligibility.reason,
    candidates
  })
})

/**
 * POST /api/creator-decisions/:id/outcome
 * body: { record_id, timing_confirmed? }
 * 只接受关联关系；花费 / 播放 / CPM / target 状态全部由后端实时生成。
 */
router.post('/:id/outcome', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const recordId = parseId(body.record_id)
  if (recordId === null) return fail(res, 400, 'record_id 必须是正整数')

  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)

  const eligibility = isDecisionEligibleForOutcome(decision)
  if (!eligibility.eligible) return fail(res, 400, eligibility.reason)

  const record = findRecord(recordId)
  if (!record) return fail(res, 404, `投放记录 #${recordId} 不存在`)

  const recordCreator = String(record.nickname ?? '').trim()
  if (recordCreator !== decision.creator) {
    return fail(
      res,
      400,
      `投放记录 #${recordId} 属于「${recordCreator || '未命名'}」，不能关联给达人「${decision.creator}」的决策`
    )
  }

  const existingForDecision = findLinkByDecision(id)
  if (existingForDecision) {
    return fail(res, 409, `决策 #${id} 已关联投放记录 #${existingForDecision.record_id}，请先解除关联`)
  }
  const existingForRecord = findLinkByRecord(recordId)
  if (existingForRecord) {
    return fail(res, 409, `投放记录 #${recordId} 已关联决策 #${existingForRecord.decision_id}，不能重复关联`)
  }

  const timingWarning = computeTimingWarning(record.publish_date, decision.created_at)
  if (timingWarning && body.timing_confirmed !== true) {
    return fail(
      res,
      400,
      '该投放记录的发布日期早于本次决策记录，请确认是否关联正确（需 timing_confirmed=true）'
    )
  }

  // 校验 + INSERT 放在同一事务，避免检查后状态变化；UNIQUE 约束是并发下的最终保护。
  let link
  try {
    link = db.transaction(() => {
      if (findLinkByDecision(id)) {
        const error = new Error('decision-already-linked')
        error.code = 'DECISION_LINKED'
        throw error
      }
      if (findLinkByRecord(recordId)) {
        const error = new Error('record-already-linked')
        error.code = 'RECORD_LINKED'
        throw error
      }
      const info = db
        .prepare('INSERT INTO creator_decision_outcomes (decision_id, record_id) VALUES (?, ?)')
        .run(id, recordId)
      return db.prepare('SELECT * FROM creator_decision_outcomes WHERE id = ?').get(info.lastInsertRowid)
    })()
  } catch (error) {
    if (error?.code === 'DECISION_LINKED' || error?.code === 'RECORD_LINKED') {
      return fail(res, 409, '该决策或该投放记录已被关联，请刷新后重试')
    }
    if (String(error?.message || '').includes('UNIQUE')) {
      return fail(res, 409, '该决策或该投放记录已被关联，请刷新后重试')
    }
    throw error
  }

  const freshDecision = findDecision(id)
  ok(res, {
    decision: toPublicDecision(freshDecision, loadOutcomeSummaryForDecision(freshDecision)),
    outcome: loadOutcomeSummaryForDecision(freshDecision)
  })
})

/**
 * DELETE /api/creator-decisions/:id/outcome
 * 只删除 creator_decision_outcomes 中的一条映射；不触碰 creator_decisions / creator_records。
 */
router.delete('/:id/outcome', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) return fail(res, 400, '非法的决策 ID')
  const decision = findDecision(id)
  if (!decision) return fail(res, 404, `决策 #${id} 不存在`)
  const link = findLinkByDecision(id)
  if (!link) return fail(res, 404, `决策 #${id} 尚未关联投放结果`)

  db.prepare('DELETE FROM creator_decision_outcomes WHERE id = ?').run(link.id)

  const freshDecision = findDecision(id)
  ok(res, {
    decision: toPublicDecision(freshDecision, null),
    outcome: null,
    unlinked_record_id: link.record_id
  })
})

export default router
