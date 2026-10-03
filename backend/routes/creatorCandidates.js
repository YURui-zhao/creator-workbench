import { Router } from 'express'
import db from '../db.js'
import {
  getLatestSnapshotByCandidate,
  insertRecentSnapshot,
  toPublicSnapshot,
  validateSnapshotPayload
} from './recentSnapshots.js'
// 复用既有内容类型分组统计（sponsored / organic / unknown 中位数），不复制第二套算法
import { meanOf, medianOf } from '../utils/recentPerformanceStats.js'
import { TARGET_CPM } from '../utils/creatorBusinessRules.js'
// Phase 4B：candidate_review 阶段枚举 / 版本标识 / 公开映射（单一来源在 decision 模块）
import {
  CANDIDATE_POST_QUOTE_DECISIONS,
  CANDIDATE_POST_QUOTE_PRICING_VERSION,
  CANDIDATE_POST_QUOTE_SYSTEM_CONTEXT_VERSION,
  CANDIDATE_REVIEW_DECISIONS,
  CANDIDATE_REVIEW_PRICING_VERSION,
  CANDIDATE_REVIEW_STAGE,
  CANDIDATE_REVIEW_SYSTEM_CONTEXT_VERSION,
  MAX_NOTE_LENGTH,
  toPublicDecision
} from './creatorDecisions.js'
// 复用既有报价原文解析器（不复制第二套解析逻辑）
import { parsePriceText } from '../utils/screenshotValues.js'
// Phase 4E：候选决策历史附带 outcome（live 事实；无关联为 null）
import { loadOutcomeSummaries } from './creatorDecisionOutcomes.js'
// Phase 4F-B：候选决策历史附带谈价结果（按 decision_id 关联，绝不按名称查询）
import { loadNegotiationCaseSummaries } from './creatorNegotiationCases.js'

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

// Price Reference V0.1（Phase 3B）冻结参数
const PRICE_REF_MAX_CASES = 5
const PRICE_REF_MIN_CASES_FOR_SUMMARY = 3
const PRICE_REF_BASE_SCALE_MAX = 100000

// Phase 4B：Playbook 估价锚点（与前端 creatorPlaybookRules.js 的常量对应）。
// 这里是「简单确定性价格事实」，后端可独立计算；不复制 Rule Engine 的量级 / 稳定性 / 高播放判断。
const PLAYBOOK_ESTIMATE_CPM_LOW = 15
const PLAYBOOK_ESTIMATE_CPM_HIGH = 20
const PLAYBOOK_HIGH_AMOUNT_THRESHOLD = 10000
const PLAYBOOK_RULE_VERSION = 'creator-playbook-v0.1'

const round2 = (value) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 100) / 100

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

/**
 * GET /api/creator-candidates/:id/price-reference
 * 历史价格参考（Phase 3B，只读）：
 *   · target 由后端从 candidate latest snapshot 的 sponsored_median_play 派生，前端不能提交 target
 *   · 历史案例是 record-level（每条真实投放 = 1 个案例），按 |累计播放 - target| 升序 + record_id 稳定排序
 *   · 只返回历史事实（成交价 / 累计播放 / final CPM），不含推荐价 / 评分 / 是否投放结论
 *   · final_cpm 只用 second_week_play（累计播放），绝不用 first_play
 */
// 价格参考核心（纯查询 + 确定性计算）：GET 路由与 candidate decision 证据冻结共用同一实现，
// 避免出现第二套历史案例查询。
export function buildPriceReference(row) {
  const unavailable = (reasonCode, message, target = null) => ({
    available: false,
    reason_code: reasonCode,
    message,
    target
  })

  // 1) candidate latest snapshot（沿用既有 candidate latest 语义，绝不按名称匹配）
  const snapshotRow = getLatestSnapshotByCandidate(row.id)
  if (!snapshotRow) {
    return unavailable('no_snapshot', '先录入近期表现后，才能生成历史价格参考。')
  }
  // 复用 toPublicSnapshot 里的内容类型分组统计（sponsored_count / sponsored_median_play）
  const snapshot = toPublicSnapshot(snapshotRow)
  const sponsoredCount = Number(snapshot?.sponsored_count ?? 0)
  const sponsoredMedian = snapshot?.sponsored_median_play
  const target = {
    sponsored_median_play: sponsoredMedian ?? null,
    sponsored_count: sponsoredCount
  }
  const NO_SPONSORED_MESSAGE =
    '暂无商单样本，暂不生成历史价格参考。日常播放仅作为辅助，不直接换算商单价格。'

  // 2) 启用条件：必须有商单样本且商单中位有效（绝不用 organic / overall / mean 替代 target）
  if (sponsoredCount < 1) return unavailable('no_sponsored_sample', NO_SPONSORED_MESSAGE, target)
  if (
    sponsoredMedian === null ||
    sponsoredMedian === undefined ||
    !Number.isFinite(Number(sponsoredMedian))
  ) {
    return unavailable('no_sponsored_sample', NO_SPONSORED_MESSAGE, target)
  }
  // 3) 高量级 V0.1 不支持（不做 10-20w / 20-50w / 50w+ 细分）
  if (Number(sponsoredMedian) >= PRICE_REF_BASE_SCALE_MAX) {
    return unavailable(
      'high_scale_not_supported',
      '当前属于高量级达人。现有高量级历史样本较少，V0.1 暂不生成历史价格参考。',
      target
    )
  }
  const targetPlay = Number(sponsoredMedian)

  // 4) 历史 case pool（record-level，每条 creator_record = 1 个案例）
  const records = db
    .prepare(
      'SELECT id, nickname, creator_type, total_cost, first_play, second_week_play FROM creator_records'
    )
    .all()
  const candidateType = row.creator_type ?? null

  const cases = records
    .filter((r) => {
      const sw = r.second_week_play
      if (sw === null || sw === undefined || Number(sw) <= 0) return false
      // latest < first = anomaly（仅当 first 有有效观测时判定）
      if (r.first_play !== null && r.first_play !== undefined && Number(sw) < Number(r.first_play)) {
        return false
      }
      if (r.total_cost === null || r.total_cost === undefined) return false
      // 基础量级池（>=10w 留给后续阶段）
      return Number(sw) < PRICE_REF_BASE_SCALE_MAX
    })
    .map((r) => {
      const cumulative = Number(r.second_week_play)
      const cost = Number(r.total_cost)
      return {
        record_id: r.id,
        creator: r.nickname,
        creator_type: r.creator_type ?? null,
        cumulative_play: cumulative,
        actual_cost: cost,
        final_cpm: round2((cost / cumulative) * 1000),
        play_distance: Math.abs(cumulative - targetPlay),
        // 仅展示元数据，不参与排序
        same_creator_type: Boolean(candidateType) && r.creator_type === candidateType
      }
    })
    .sort((a, b) => a.play_distance - b.play_distance || a.record_id - b.record_id)

  const selected = cases.slice(0, PRICE_REF_MAX_CASES)

  // 5) 历史事实摘要：只基于「当前选中的案例」，不是整个基础池；不足 3 条不给区间
  let summary = null
  if (selected.length >= PRICE_REF_MIN_CASES_FOR_SUMMARY) {
    const costs = selected.map((c) => c.actual_cost)
    const cpms = selected.map((c) => c.final_cpm)
    summary = {
      cost_median: round2(medianOf(costs)),
      cost_min: Math.min(...costs),
      cost_max: Math.max(...costs),
      final_cpm_median: round2(medianOf(cpms))
    }
  }

  return {
    available: true,
    target: { sponsored_median_play: targetPlay, sponsored_count: sponsoredCount },
    pool: { eligible_case_count: cases.length, selected_case_count: selected.length },
    summary,
    insufficient_for_range: summary === null,
    cases: selected
  }
}

router.get('/:id/price-reference', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  ok(res, buildPriceReference(row))
})

/**
 * Phase 4B：candidate_review decision 的近期证据（只冻结产生判断的原始确定性事实）
 * 明确不复制前端 Rule Engine 的文案 / 判断逻辑（量级 / 稳定性 / 强弱商单 / 高播放）。
 * mean_play 从 plays 的有效播放确定性派生（与前端同一口径）。
 */
function buildCandidateRecentEvidence(candidateId, snapshot) {
  const validValues = (snapshot.plays || [])
    .filter(
      (play) =>
        play && play.excluded !== true && Number.isFinite(play.normalized_play) && play.normalized_play >= 0
    )
    .map((play) => play.normalized_play)
  return {
    candidate_id: candidateId,
    snapshot_id: snapshot.id,
    observed_at: snapshot.observed_at ?? null,
    created_at: snapshot.created_at ?? null,
    valid_count: snapshot.valid_count ?? null,
    median_play: snapshot.median_play ?? null,
    mean_play: meanOf(validValues),
    sponsored_count: snapshot.sponsored_count ?? 0,
    sponsored_median_play: snapshot.sponsored_median_play ?? null,
    organic_count: snapshot.organic_count ?? 0,
    organic_median_play: snapshot.organic_median_play ?? null,
    unknown_count: snapshot.unknown_count ?? 0,
    p25_play: snapshot.p25_play ?? null,
    p75_play: snapshot.p75_play ?? null,
    trend_label: snapshot.trend_label ?? null,
    xingtu_price: snapshot.xingtu_price ?? null,
    source_stats_version: snapshot.stats_version ?? null,
    playbook_rule_version: PLAYBOOK_RULE_VERSION
  }
}

/**
 * Phase 4D：报价相对 Playbook 经验区间的位置（纯事实描述，不是推荐结论）
 *   · 区间不存在 -> unavailable
 */
function buildCurrentQuoteAssessment(currentQuote, estimate) {
  const estimateLow = estimate?.estimate_low ?? null
  const estimateHigh = estimate?.estimate_high ?? null
  let position = 'unavailable'
  if (estimateLow !== null && estimateHigh !== null) {
    if (currentQuote < estimateLow) position = 'below_playbook_range'
    else if (currentQuote > estimateHigh) position = 'above_playbook_range'
    else position = 'within_playbook_range'
  }
  return { current_quote: currentQuote, estimate_low: estimateLow, estimate_high: estimateHigh, position }
}

/**
 * Phase 4B / 4D：candidate decision 的价格证据（CPM15-20 与 TARGET_CPM=30 明确分开）
 * historical_price_reference 复用 Phase 3B 的同一实现，只冻结 summary / target / selected record ids。
 * 传入 currentQuote 时追加报价事实（current_quote / 位置 / 星图折扣比例）；不传则保持 Phase 4B 原结构。
 */
function buildCandidatePricingEvidence(snapshot, priceReference, { currentQuote = null } = {}) {
  const sponsoredCount = Number(snapshot.sponsored_count ?? 0)
  const sponsoredMedian = snapshot.sponsored_median_play ?? null
  const estimate = {
    cpm_low: PLAYBOOK_ESTIMATE_CPM_LOW,
    cpm_high: PLAYBOOK_ESTIMATE_CPM_HIGH,
    sponsored_median_play: sponsoredMedian,
    estimate_low: null,
    estimate_high: null,
    confidence: null
  }
  // sponsored_count >= 1 才生成 estimate；0 时保持 null（绝不用 organic 换算商单价格）
  if (sponsoredCount >= 1 && sponsoredMedian !== null && Number.isFinite(Number(sponsoredMedian))) {
    estimate.estimate_low = round2((Number(sponsoredMedian) * PLAYBOOK_ESTIMATE_CPM_LOW) / 1000)
    estimate.estimate_high = round2((Number(sponsoredMedian) * PLAYBOOK_ESTIMATE_CPM_HIGH) / 1000)
    estimate.confidence = sponsoredCount >= 3 ? 'normal' : 'low'
  }
  const xingtuPrice = snapshot.xingtu_price ?? null
  const base = {
    playbook_estimate: estimate,
    xingtu_price: xingtuPrice,
    high_amount_risk: xingtuPrice !== null && Number(xingtuPrice) > PLAYBOOK_HIGH_AMOUNT_THRESHOLD,
    historical_price_reference: {
      available: Boolean(priceReference.available),
      reason_code: priceReference.available ? null : priceReference.reason_code ?? null,
      target_play: priceReference?.target?.sponsored_median_play ?? null,
      selected_case_count: priceReference?.pool?.selected_case_count ?? 0,
      summary: priceReference?.summary ?? null,
      selected_record_ids: (priceReference?.cases || []).map((item) => item.record_id)
    }
  }
  if (currentQuote === null) return base
  return {
    ...base,
    current_quote: currentQuote,
    current_quote_assessment: buildCurrentQuoteAssessment(currentQuote, estimate),
    // 事实比例：当前报价 / 星图刊例价；xingtu_price null 或 0 时为 null（不除 0）
    quote_to_xingtu_ratio:
      xingtuPrice !== null && Number(xingtuPrice) > 0 ? round2(currentQuote / Number(xingtuPrice)) : null
  }
}

/**
 * POST /api/creator-candidates/:id/decisions
 * candidate_review 阶段的人工决定（append-only）：
 *   · creator / candidate_id / decision_stage / snapshot_id 全部由服务端决定，前端不能伪造
 *   · human_decision 只接受 contact / observe / hold，由用户显式选择（系统 / AI / 规则不推断）
 *   · 不要求有 recent snapshot；无快照时 snapshot_id / recent / pricing evidence 均为 NULL
 */
router.post('/:id/decisions', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '请求体必须是对象')
  }
  const humanDecision = String(body.human_decision ?? '').trim()
  if (!CANDIDATE_REVIEW_DECISIONS.includes(humanDecision)) {
    return fail(res, 400, `human_decision 必须为：${CANDIDATE_REVIEW_DECISIONS.join(' / ')}`)
  }
  const errors = []
  const decisionNote = readOptionalText(body.decision_note, 'decision_note', MAX_NOTE_LENGTH, errors)
  if (errors.length) return fail(res, 400, errors[0])

  // snapshot 由服务端按 candidate_id 取 latest（前端不能指定 snapshot_id）
  const snapshotRow = getLatestSnapshotByCandidate(row.id)
  const snapshot = snapshotRow ? toPublicSnapshot(snapshotRow) : null
  const priceReference = buildPriceReference(row)

  const historicalEvidence = { has_prior_collaboration: false }
  const recentEvidence = snapshot ? buildCandidateRecentEvidence(row.id, snapshot) : null
  const pricingEvidence = snapshot ? buildCandidatePricingEvidence(snapshot, priceReference) : null

  const info = db
    .prepare(
      `INSERT INTO creator_decisions (
         creator, candidate_id, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement,
         human_decision, decision_note, historical_evidence_json, recent_evidence_json,
         pricing_evidence_json, target_cpm, pricing_version, system_context_version
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.name,
      row.id,
      CANDIDATE_REVIEW_STAGE,
      snapshotRow ? snapshotRow.id : null,
      humanDecision,
      decisionNote,
      JSON.stringify(historicalEvidence),
      recentEvidence ? JSON.stringify(recentEvidence) : null,
      pricingEvidence ? JSON.stringify(pricingEvidence) : null,
      TARGET_CPM,
      CANDIDATE_REVIEW_PRICING_VERSION,
      CANDIDATE_REVIEW_SYSTEM_CONTEXT_VERSION
    )

  const saved = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(info.lastInsertRowid)
  ok(res, toPublicDecision(saved, null, null))
})

/**
 * POST /api/creator-candidates/:id/post-quote-decisions
 * candidate 报价阶段人工决定（append-only）：
 *   · 必须有 latest snapshot（post_quote 是正式价格判断阶段，需要冻结当时依据）
 *   · current_quote_raw 必填且可确定性解析（0 是真实报价；负数 / 非法文本拒绝）
 *   · human_decision 只接受 proceed / small_test / negotiate / pause（candidate 不允许 repurchase）
 *   · creator / candidate_id / decision_stage / snapshot_id / evidence / 版本全部由服务端决定
 */
router.post('/:id/post-quote-decisions', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, '请求体必须是对象')
  }
  const humanDecision = String(body.human_decision ?? '').trim()
  if (!CANDIDATE_POST_QUOTE_DECISIONS.includes(humanDecision)) {
    return fail(res, 400, `human_decision 必须为：${CANDIDATE_POST_QUOTE_DECISIONS.join(' / ')}`)
  }
  // current_quote：必填；复用既有确定性解析器（不复制第二套）
  const quoteRawInput = typeof body.current_quote_raw === 'string' ? body.current_quote_raw.trim() : ''
  if (!quoteRawInput) return fail(res, 400, '当前报价（current_quote_raw）不能为空')
  const parsedQuote = parsePriceText(quoteRawInput)
  if (parsedQuote.value === null) {
    return fail(res, 400, '当前报价无法确定性解析，请按「¥2400 / 2400元 / 2,400」等形式填写')
  }
  const errors = []
  const decisionNote = readOptionalText(body.decision_note, 'decision_note', MAX_NOTE_LENGTH, errors)
  if (errors.length) return fail(res, 400, errors[0])
  const currentQuote = parsedQuote.value
  const currentQuoteRaw = parsedQuote.raw_text ?? quoteRawInput

  // snapshot 必须存在：由服务端按 candidate_id 取 latest（前端不能提交 snapshot_id）
  const snapshotRow = getLatestSnapshotByCandidate(row.id)
  if (!snapshotRow) {
    return fail(res, 400, '请先录入近期表现，再记录报价阶段决策。')
  }
  const snapshot = toPublicSnapshot(snapshotRow)
  const priceReference = buildPriceReference(row)
  const recentEvidence = buildCandidateRecentEvidence(row.id, snapshot)
  const pricingEvidence = buildCandidatePricingEvidence(snapshot, priceReference, { currentQuote })

  const info = db
    .prepare(
      `INSERT INTO creator_decisions (
         creator, candidate_id, decision_stage, snapshot_id, current_quote_raw, current_quote, ip_judgement,
         human_decision, decision_note, historical_evidence_json, recent_evidence_json,
         pricing_evidence_json, target_cpm, pricing_version, system_context_version
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.name,
      row.id,
      'post_quote',
      snapshotRow.id,
      currentQuoteRaw,
      currentQuote,
      humanDecision,
      decisionNote,
      JSON.stringify({ has_prior_collaboration: false }),
      JSON.stringify(recentEvidence),
      JSON.stringify(pricingEvidence),
      TARGET_CPM,
      CANDIDATE_POST_QUOTE_PRICING_VERSION,
      CANDIDATE_POST_QUOTE_SYSTEM_CONTEXT_VERSION
    )

  const saved = db.prepare('SELECT * FROM creator_decisions WHERE id = ?').get(info.lastInsertRowid)
  ok(res, toPublicDecision(saved, null, null))
})

/**
 * GET /api/creator-candidates/:id/decisions
 * append-only 历史（created_at DESC, id DESC）；严格按 candidate_id 查询，同名 candidate 不串。
 */
router.get('/:id/decisions', (req, res) => {
  const row = findCandidateRow(req.params.id)
  if (!row) return fail(res, 404, `候选达人不存在（id=${req.params.id}）`)
  const rows = db
    .prepare('SELECT * FROM creator_decisions WHERE candidate_id = ? ORDER BY created_at DESC, id DESC')
    .all(row.id)
  const outcomeMap = loadOutcomeSummaries(rows)
  const negotiationMap = loadNegotiationCaseSummaries(rows)
  ok(res, {
    candidate_id: row.id,
    creator: row.name,
    decisions: rows.map((item) =>
      toPublicDecision(item, outcomeMap.get(item.id) || null, negotiationMap.get(item.id) || null)
    )
  })
})

export default router
