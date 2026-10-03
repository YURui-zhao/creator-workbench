import request from '../utils/request.js'

/**
 * 候选达人身份层接口（V3-alpha.3 Playbook Phase 1）
 * 后端统一返回 { code, data, msg }
 *
 * 边界：候选 latest 严格按 candidate_id 查询，不会因为名称与历史达人重合而串数据。
 */

/** 候选达人列表；可选 status = 'active' | 'archived' */
export function listCreatorCandidates(params = {}) {
  return request.get('/creator-candidates', { params })
}

/** 新建候选达人：{ name, creator_type?, profile_url?, description? } */
export function createCreatorCandidate(payload) {
  return request.post('/creator-candidates', payload)
}

/** 候选达人详情 */
export function getCreatorCandidate(id) {
  return request.get(`/creator-candidates/${id}`)
}

/** 更新候选达人基本信息（含 status=archived 归档） */
export function updateCreatorCandidate(id, payload) {
  return request.patch(`/creator-candidates/${id}`, payload)
}

/**
 * 候选达人保存近期表现快照（append-only）
 * 入参只发 raw 事实；creator 由服务端取自 candidate.name，candidate_id 由服务端落库。
 */
export function saveCandidateRecentSnapshot(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/recent-snapshots`, payload, { timeout: 20000 })
}

/** 候选达人最新快照（按 candidate_id 查）；无快照时后端返回 { candidate_id, creator, snapshot: null } */
export function getCandidateLatestSnapshot(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/recent-snapshots/latest`)
}

/**
 * 历史价格参考（Phase 3B，只读）：后端按 candidate_id 取 latest snapshot 派生 target，
 * 前端不提交 target；返回 { available, reason_code?, target, pool?, summary?, cases? }。
 */
export function getCandidatePriceReference(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/price-reference`)
}

/**
 * candidate_review 人工决定（Phase 4B，append-only）
 * 只提交 { human_decision, decision_note? }；creator / candidate_id / decision_stage 由服务端决定。
 */
export function createCandidateDecision(candidateId, payload) {
  return request.post(`/creator-candidates/${candidateId}/decisions`, payload)
}

/** 候选达人的 append-only 决定历史（created_at DESC, id DESC） */
export function listCandidateDecisions(candidateId) {
  return request.get(`/creator-candidates/${candidateId}/decisions`)
}
