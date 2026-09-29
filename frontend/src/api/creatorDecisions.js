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
