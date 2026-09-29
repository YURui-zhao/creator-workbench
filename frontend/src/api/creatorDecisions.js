import request from '../utils/request.js'

/**
 * 决策记录接口（V3-alpha P4）
 * 后端统一返回 { code, data, msg }
 *
 * 注意：前端只提交「人的输入」（阶段 / IP 判断 / 人的决定 / 备注 / 实际报价原文），
 * 历史证据、近期证据、价格证据、target_cpm、pricing_version 全部由后端重建并固化。
 */

/** 创建一条 append-only 决策记录 */
export function createCreatorDecision(payload) {
  return request.post('/creator-decisions', payload, { timeout: 20000 })
}

/** 查询某位达人的决策历史（时间倒序） */
export function getCreatorDecisions(creator) {
  return request.get('/creator-decisions', { params: { creator } })
}

/** 只读预览：用实际报价重跑 P3 规则（不写库、无 AI） */
export function previewCreatorDecisionQuote({ creator, snapshotId, currentQuoteRaw }) {
  return request.post(
    '/creator-decisions/preview',
    { creator, snapshot_id: snapshotId, current_quote_raw: currentQuoteRaw },
    { timeout: 20000 }
  )
}

/**
 * P5：取该决策可关联的真实投放记录候选（只含同一达人，按发布日期倒序）
 * 候选里的花费 / 播放 / CPM 全部由后端复用 V2 口径生成，前端不重新计算。
 */
export function getDecisionOutcomeCandidates(decisionId) {
  return request.get(`/creator-decisions/${decisionId}/outcome-candidates`)
}

/** P5：把一条真实投放记录关联到决策（只提交关联关系，不提交任何派生指标） */
export function linkDecisionOutcome(decisionId, { recordId, timingConfirmed = false }) {
  return request.post(
    `/creator-decisions/${decisionId}/outcome`,
    { record_id: recordId, timing_confirmed: timingConfirmed === true },
    { timeout: 20000 }
  )
}

/** P5：解除关联（只删除 mapping，不删除任何投放数据或决策记录） */
export function unlinkDecisionOutcome(decisionId) {
  return request.delete(`/creator-decisions/${decisionId}/outcome`)
}
