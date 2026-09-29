import request from '../utils/request.js'

/**
 * 谈判结果沉淀接口（V3-alpha.2 A4）
 * 前端只提交「人的输入」：decision_id / 最终谈成价 / 谈成日期 / 原因标签 / 备注。
 * 星图价、达人报价、CPM30 目标价、参考区间一律由后端根据当时的 decision / snapshot 重新读取并冻结。
 */

/** 创建一条 append-only 谈价结果（同一 decision 只能有一条） */
export function createNegotiationCase(payload) {
  return request.post('/creator-negotiation-cases', payload, { timeout: 20000 })
}

/** 查询某位达人的谈价结果（时间倒序） */
export function getNegotiationCasesByCreator(creator) {
  return request.get('/creator-negotiation-cases', { params: { creator } })
}

/** 查询某个决策的谈价结果 */
export function getNegotiationCaseByDecision(decisionId) {
  return request.get('/creator-negotiation-cases', { params: { decision_id: decisionId } })
}
