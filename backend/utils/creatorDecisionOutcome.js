/**
 * 决策 ↔ 真实投放结果 关联（V3-alpha P5，纯函数）
 *
 * 核心原则：
 *   · Decision evidence = frozen（creator_decisions 一旦写入永不回写）
 *   · Outcome result    = live（花费 / 播放 / CPM 一律实时取自 creator_records）
 * 因此本模块只产出「基于当前 creator_record 的实时事实」，不复制、不固化任何结果数值。
 *
 * 播放 / CPM 口径严格复用 V2（backend/routes/records.js）：
 *   first_play       = 7日累计播放量
 *   second_week_play = 最新累计播放量（latest_play）
 *   subsequent_play  = latest - first（仅 latest 有效且 latest >= first 时）
 *   first_cpm        = cost / first  × 1000
 *   latest_cpm       = cost / latest × 1000
 *   latest = null → 待更新（pending）；latest = 0 → 真实观测 0；latest < first → 异常
 *
 * 不写库、不调用 AI、不访问外部网络。P5 只做事实描述，不做决策评价。
 */

import { computePlayMetrics, computeRecordFirstCpm, computeRecordLatestCpm } from '../routes/records.js'
import { TARGET_CPM } from './creatorBusinessRules.js'

// 只有「已拿到报价 且 决定实际投放」的决策才允许关联真实投放结果
export const OUTCOME_ELIGIBLE_STAGES = ['post_quote']
export const OUTCOME_ELIGIBLE_DECISIONS = ['repurchase', 'small_test']

// latest 观测状态（事实，不含评价）
export const LATEST_STATUS = {
  pending: 'pending', // 累计播放未更新
  anomaly: 'anomaly', // latest < first，异常历史数据
  observed: 'observed' // 已填写（含 0）
}

export const LATEST_STATUS_LABELS = {
  [LATEST_STATUS.pending]: '待更新',
  [LATEST_STATUS.anomaly]: '异常',
  [LATEST_STATUS.observed]: '已更新'
}

// 累计 CPM 相对 TARGET_CPM 的事实状态（不是「决策是否成功」）
export const TARGET_CPM_STATUS = {
  pending: 'pending',
  anomaly: 'anomaly',
  zeroPlay: 'zero_play',
  met: 'met',
  notMet: 'not_met'
}

export const TARGET_CPM_STATUS_LABELS = {
  [TARGET_CPM_STATUS.pending]: '待更新',
  [TARGET_CPM_STATUS.anomaly]: '异常',
  [TARGET_CPM_STATUS.zeroPlay]: '累计播放为0，无法计算CPM',
  [TARGET_CPM_STATUS.met]: '已达标',
  [TARGET_CPM_STATUS.notMet]: '未达标'
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round2 = (value) => (isFiniteNumber(value) ? Number(value.toFixed(2)) : null)

/** 判断一条 decision 是否具备关联 outcome 的资格（事实判定，不做任何业务评价） */
export function isDecisionEligibleForOutcome(decision) {
  if (!decision) return { eligible: false, reason: '决策记录不存在' }
  if (!OUTCOME_ELIGIBLE_STAGES.includes(decision.decision_stage)) {
    return { eligible: false, reason: '该决策未进入实际投放阶段' }
  }
  if (!OUTCOME_ELIGIBLE_DECISIONS.includes(decision.human_decision)) {
    return { eligible: false, reason: '该决策未进入实际投放阶段' }
  }
  return { eligible: true, reason: null }
}

/** 解析 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' 的日期部分 */
export function dateOnlyOf(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

/**
 * 时间提示：投放记录发布日期「明显早于」决策创建日期时提示确认（不自动禁止）。
 * 只做日期粒度比较，避免用 timestamp 误判同一天。
 */
export function computeTimingWarning(publishDate, decisionCreatedAt) {
  const publish = dateOnlyOf(publishDate)
  const created = dateOnlyOf(decisionCreatedAt)
  if (!publish || !created) return false
  return publish < created
}

/**
 * 单条 creator_record 的播放 / CPM 事实（实时计算，复用 V2 口径）
 * @param {Object} row creator_records 行
 */
export function buildRecordPlayFacts(row = {}) {
  const metrics = computePlayMetrics(row)
  const firstCpmRaw = computeRecordFirstCpm(row)
  const latestCpmRaw = computeRecordLatestCpm(row)

  let latestStatus = LATEST_STATUS.pending
  if (metrics.latestAnomaly) latestStatus = LATEST_STATUS.anomaly
  else if (metrics.hasLatest) latestStatus = LATEST_STATUS.observed

  return {
    total_cost: isFiniteNumber(metrics.cost) ? metrics.cost : null,
    first_play: metrics.hasFirst ? metrics.first : null,
    latest_play: metrics.hasLatest ? metrics.latest : null,
    subsequent_play: metrics.post7dGrowth,
    first_cpm: round2(firstCpmRaw),
    latest_cpm: round2(latestCpmRaw),
    latest_status: latestStatus,
    latest_status_label: LATEST_STATUS_LABELS[latestStatus]
  }
}

/**
 * 累计 CPM 相对目标值的事实状态
 * @param {Object} row creator_records 行
 * @param {number} targetCpm 目标 CPM（默认取 decision 固化的 target_cpm）
 */
export function computeTargetCpmStatus(row = {}, targetCpm = TARGET_CPM) {
  const metrics = computePlayMetrics(row)
  if (!metrics.hasLatest) return TARGET_CPM_STATUS.pending
  if (metrics.latestAnomaly) return TARGET_CPM_STATUS.anomaly
  const cpmRaw = computeRecordLatestCpm(row)
  if (cpmRaw === null) return TARGET_CPM_STATUS.zeroPlay
  return cpmRaw <= targetCpm ? TARGET_CPM_STATUS.met : TARGET_CPM_STATUS.notMet
}

/**
 * 对外 outcome summary：link 关系 + 实时 record 事实
 * @param {Object|null} linkRow creator_decision_outcomes 行
 * @param {Object|null} recordRow creator_records 行（关联的投放记录）
 * @param {{targetCpm?: number}} [options]
 */
export function buildOutcomeSummary(linkRow, recordRow, { targetCpm = TARGET_CPM } = {}) {
  if (!linkRow || !recordRow) return null
  const facts = buildRecordPlayFacts(recordRow)
  const status = computeTargetCpmStatus(recordRow, targetCpm)
  return {
    link_id: linkRow.id,
    linked_at: linkRow.linked_at ?? null,
    record_id: recordRow.id,
    publish_date: recordRow.publish_date ?? null,
    creator_type: recordRow.creator_type ?? null,
    total_cost: facts.total_cost,
    first_play: facts.first_play,
    latest_play: facts.latest_play,
    subsequent_play: facts.subsequent_play,
    first_cpm: facts.first_cpm,
    latest_cpm: facts.latest_cpm,
    latest_status: facts.latest_status,
    latest_status_label: facts.latest_status_label,
    target_cpm: targetCpm,
    target_cpm_status: status,
    target_cpm_status_label: TARGET_CPM_STATUS_LABELS[status]
  }
}

/**
 * 候选投放记录（只含同一达人，按 publish_date DESC / id DESC；不返回其他达人的记录）
 * @param {Array<Object>} recordRows 该达人的全部 creator_records
 * @param {{ decisionCreatedAt?: string, linkMap?: Map<number, number> }} [options]
 *        linkMap: record_id -> decision_id（已建立的关联，用于标记 already_linked）
 */
export function buildOutcomeCandidates(recordRows = [], { decisionCreatedAt = null, linkMap = new Map() } = {}) {
  return [...recordRows]
    .sort((left, right) => {
      const leftDate = String(left?.publish_date ?? '')
      const rightDate = String(right?.publish_date ?? '')
      if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1
      return Number(right?.id ?? 0) - Number(left?.id ?? 0)
    })
    .map((row) => {
      const facts = buildRecordPlayFacts(row)
      const linkedDecisionId = linkMap.get(row.id) ?? null
      return {
        record_id: row.id,
        creator: row.nickname ?? null,
        creator_type: row.creator_type ?? null,
        publish_date: row.publish_date ?? null,
        total_cost: facts.total_cost,
        first_play: facts.first_play,
        latest_play: facts.latest_play,
        first_cpm: facts.first_cpm,
        latest_cpm: facts.latest_cpm,
        latest_status: facts.latest_status,
        latest_status_label: facts.latest_status_label,
        already_linked: linkedDecisionId !== null,
        linked_decision_id: linkedDecisionId,
        timing_warning: computeTimingWarning(row.publish_date, decisionCreatedAt)
      }
    })
}
