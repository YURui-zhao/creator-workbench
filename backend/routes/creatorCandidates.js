import { Router } from 'express'
import db from '../db.js'
import {
  getLatestSnapshotByCandidate,
  insertRecentSnapshot,
  toPublicSnapshot,
  validateSnapshotPayload
} from './recentSnapshots.js'

/**
 * 候选达人身份层（V3-alpha.3 Playbook Phase 1）
 *
 * 定位：为「从未出现在 creator_records 中的新达人」提供稳定身份，
 *       并允许其保存 / 读取自己的近期表现 snapshot。
 *
 * 边界（本阶段严格不做）：
 *   · 不实现 Playbook 规则计算 / 价格案例 / 谈价案例 / Decision
 *   · 不调用 AI、不访问外部网络
 *   · 不自动创建 creator_record；candidate 数据不进入 Repurchase Radar
 *
 * 稳定身份是 id，不是 name —— name 故意不唯一（允许重名 / 改名）。
 * 状态仅 active / archived；归档只改状态，历史 snapshot 原样保留。
 */
const router = Router()

const NAME_MAX = 100
const CREATOR_TYPE_MAX = 50
const PROFILE_URL_MAX = 500
const XINGTU_URL_MAX = 500
// 星图 ID：字符串存储（不假设纯数字，避免未来格式变化 / 前导 0 丢失）
const XINGTU_ID_MAX = 100
const DESCRIPTION_MAX = 500
// AI 整理文本上限（派生字段，非事实来源）
const DISTILLED_MAX = 4000
const STATUS_VALUES = ['active', 'archived']
// 只要求合法 http / https URL，不强绑固定域名（避免星图 URL 结构变化导致误拦）
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, message) {
  res.status(code).json({ code, data: null, msg: message })
}

/**
 * 显式校验可选文本：nullable；非空则 trim；超长报错（不静默截断）。
 * @returns {string|null}
 */
function readOptionalText(value, field, maxLength, errors) {
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

/** 必填名称：trim 后不允许空；超长报错 */
function readName(value, errors) {
  if (typeof value !== 'string') {
    errors.push('name 必须是字符串')
    return null
  }
  const text = value.trim()
  if (!text) {
    errors.push('name 不能为空')
    return null
  }
  if (text.length > NAME_MAX) {
    errors.push(`name 长度不能超过 ${NAME_MAX}`)
    return null
  }
  return text
}

function readStatus(value, errors) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!STATUS_VALUES.includes(text)) {
    errors.push(`status 只支持 ${STATUS_VALUES.join(' / ')}`)
    return null
  }
  return text
}

/** 可选 URL：nullable；非空时 trim 且必须是 http/https；超长 / 非法 → 明确报错 */
function readOptionalUrl(value, field, maxLength, errors) {
  const text = readOptionalText(value, field, maxLength, errors)
  if (text === null) return null
  if (!HTTP_URL_RE.test(text)) {
    errors.push(`${field} 必须是合法的 http / https 链接`)
    return null
  }
  return text
}

/**
 * 星图 ID：nullable；trim；空串规范为 null；字符串存储（绝不转 number，保留前导 0 / 未来格式）。
 * 宽容接受数字型输入（转为字符串），但绝不反向把字符串当作数字处理。
 */
function readOptionalXingtuId(value, errors) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push('xingtu_id 必须是字符串')
    return null
  }
  const text = String(value).trim()
  if (text === '') return null
  if (text.length > XINGTU_ID_MAX) {
    errors.push(`xingtu_id 长度不能超过 ${XINGTU_ID_MAX}`)
    return null
  }
  return text
}

function findCandidateRow(id) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) return null
  return db.prepare('SELECT * FROM creator_candidates WHERE id = ?').get(numId) || null
}

function toPublicCandidate(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    creator_type: row.creator_type ?? null,
    profile_url: row.profile_url ?? null,
    xingtu_url: row.xingtu_url ?? null,
    xingtu_id: row.xingtu_id ?? null,
    description: row.description ?? null,
    distilled_description: row.distilled_description ?? null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/**
 * POST /api/creator-candidates
 * body: { name, creator_type?, profile_url?, description?, status? }
 * name 不唯一：允许创建两个同名 candidate（id 不同）。
 */
router.post('/', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '请求体必须是对象')
  }
  const errors = []
  const name = readName(body.name, errors)
  const creatorType = readOptionalText(body.creator_type, 'creator_type', CREATOR_TYPE_MAX, errors)
  const profileUrl = readOptionalText(body.profile_url, 'profile_url', PROFILE_URL_MAX, errors)
  const xingtuUrl = readOptionalUrl(body.xingtu_url, 'xingtu_url', XINGTU_URL_MAX, errors)
  const xingtuId = readOptionalXingtuId(body.xingtu_id, errors)
  const description = readOptionalText(body.description, 'description', DESCRIPTION_MAX, errors)
  const distilled = readOptionalText(
    body.distilled_description,
    'distilled_description',
    DISTILLED_MAX,
    errors
  )
  const status =
    body.status === undefined || body.status === null ? 'active' : readStatus(body.status, errors)
  if (errors.length) return fail(res, 400, errors[0])

  const info = db
    .prepare(
      `INSERT INTO creator_candidates (name, creator_type, profile_url, xingtu_url, xingtu_id, description, distilled_description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, creatorType, profileUrl, xingtuUrl, xingtuId, description, distilled, status)

  ok(res, toPublicCandidate(findCandidateRow(info.lastInsertRowid)))
})

/**
 * GET /api/creator-candidates?status=active|archived
 * 列表（默认返回全部；id DESC，最新在前）。不返回任何 snapshot 统计。
 */
router.get('/', (req, res) => {
  const status = typeof req.query?.status === 'string' ? req.query.status.trim() : ''
  if (status && !STATUS_VALUES.includes(status)) {
    return fail(res, 400, `status 只支持 ${STATUS_VALUES.join(' / ')}`)
  }
  const rows = status
    ? db.prepare('SELECT * FROM creator_candidates WHERE status = ? ORDER BY id DESC').all(status)
    : db.prepare('SELECT * FROM creator_candidates ORDER BY id DESC').all()
  ok(res, { candidates: rows.map(toPublicCandidate) })
})

/**
 * GET /api/creator-candidates/:id
 * 候选达人基本信息（不含 snapshot）。
 */
router.get('/:id', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  ok(res, toPublicCandidate(row))
})

/**
 * PATCH /api/creator-candidates/:id
 * body: { name?, creator_type?, profile_url?, description?, status? }
 * 只更新显式传入的字段；null 表示清空可选字段；状态仅 active / archived。
 */
router.patch('/:id', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '请求体必须是对象')
  }
  const fields = []
  const params = []
  const errors = []
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(body, key)

  if ('name' in body) {
    const name = readName(body.name, errors)
    if (name !== null) {
      fields.push('name = ?')
      params.push(name)
    }
  }
  if ('creator_type' in body) {
    fields.push('creator_type = ?')
    params.push(readOptionalText(body.creator_type, 'creator_type', CREATOR_TYPE_MAX, errors))
  }
  if ('profile_url' in body) {
    fields.push('profile_url = ?')
    params.push(readOptionalText(body.profile_url, 'profile_url', PROFILE_URL_MAX, errors))
  }
  if (hasOwn('xingtu_url')) {
    fields.push('xingtu_url = ?')
    params.push(readOptionalUrl(body.xingtu_url, 'xingtu_url', XINGTU_URL_MAX, errors))
  }
  // 星图 ID（正式字段，字符串；空串规范为 null；与 description 无关，不影响 distilled_description）
  if (hasOwn('xingtu_id')) {
    fields.push('xingtu_id = ?')
    params.push(readOptionalXingtuId(body.xingtu_id, errors))
  }

  // description（人工备注）是唯一事实来源；比较「实际是否变化」用于过期蒸馏清理
  const currentDescription = row.description ?? null
  const hasDescription = hasOwn('description')
  const nextDescription = hasDescription
    ? readOptionalText(body.description, 'description', DESCRIPTION_MAX, errors)
    : currentDescription
  if (hasDescription) {
    fields.push('description = ?')
    params.push(nextDescription)
  }
  const descriptionChanged = hasDescription && nextDescription !== currentDescription

  // distilled_description 是派生字段：显式提供则直接写入
  const hasDistilled = hasOwn('distilled_description')
  if (hasDistilled) {
    fields.push('distilled_description = ?')
    params.push(readOptionalText(body.distilled_description, 'distilled_description', DISTILLED_MAX, errors))
  }

  if ('status' in body) {
    const status = readStatus(body.status, errors)
    if (status !== null) {
      fields.push('status = ?')
      params.push(status)
    }
  }
  if (errors.length) return fail(res, 400, errors[0])

  // 关键一致性：人工备注真正改变、且本次没有提供新的蒸馏结果时，自动清除过期派生文本。
  // 只清派生文本，不删除任何 candidate / snapshot 历史；备注未变化则不清空。
  if (descriptionChanged && !hasDistilled) {
    fields.push('distilled_description = ?')
    params.push(null)
  }
  if (!fields.length) return fail(res, 400, '没有可更新的字段')

  fields.push('updated_at = CURRENT_TIMESTAMP')
  db.prepare(`UPDATE creator_candidates SET ${fields.join(', ')} WHERE id = ?`).run(...params, row.id)
  ok(res, toPublicCandidate(findCandidateRow(row.id)))
})

/**
 * POST /api/creator-candidates/:id/recent-snapshots
 * 候选达人保存近期表现快照（append-only）：
 *   · creator 由服务端取自 candidate.name（不信任前端提交的 creator）
 *   · candidate_id 落库，作为稳定身份
 *   · 复用现有 plays / observed_at / content_type / stats / xingtu 语义
 *   · archived 候选禁止新增（409）；读取（detail / latest）与历史快照不受影响
 */
router.post('/:id/recent-snapshots', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  // archived 冻结写入：只禁止新增，不删除任何历史；detail / latest 读取不受影响
  if (row.status !== 'active') {
    return fail(
      res,
      409,
      `候选达人「${row.name}」已归档（status=${row.status}），需先恢复为 active 才能新增近期表现快照`
    )
  }
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '请求体必须是对象')
  }
  // creator 强制来自服务端 candidate.name（忽略前端值）
  const validated = validateSnapshotPayload({ ...body, creator: row.name })
  if (!validated.ok) return fail(res, 400, validated.message)

  const saved = insertRecentSnapshot(validated.value, { candidateId: row.id })
  ok(res, toPublicSnapshot(saved))
})

/**
 * GET /api/creator-candidates/:id/recent-snapshots/latest
 * 候选达人最新快照：严格按 candidate_id 查询（绝不退回名称匹配）。
 * 无快照时返回 { candidate_id, creator, snapshot: null }（不是错误）。
 */
router.get('/:id/recent-snapshots/latest', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  const snapshot = getLatestSnapshotByCandidate(row.id)
  ok(res, {
    candidate_id: row.id,
    creator: row.name,
    snapshot: snapshot ? toPublicSnapshot(snapshot) : null
  })
})

export default router
