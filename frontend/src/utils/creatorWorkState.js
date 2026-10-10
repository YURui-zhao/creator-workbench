// Creator Work State（V3-alpha.3 / 达人拓展信息架构）
//
// 语义边界（非常重要，不要混淆）：
//   · Work State（三个工作盒子）只由「最新一条 candidate_review decision」派生：
//       contact → 推进中 / observe → 观察中 / hold → 暂缓池
//   · 从未有过 candidate_review 的 candidate 默认落在「推进中」：
//       进入当前拓展工作区，默认语义就是准备进一步处理，绝不是「观察中」。
//   · post_quote 的 proceed / small_test / negotiate / pause 属于「本轮谈价结果」，
//     绝不参与 Work State 派生，也绝不自动改变三个工作盒子。
//   · 只有用户显式点击三个状态按钮才会新增 candidate_review decision（append-only，不 UPDATE）。
//
// 本模块是纯函数：无时间 / 无随机 / 无网络 / 无 AI / 不写库，只做确定性派生与视图过滤。

export const WORK_STATE_CANDIDATE_REVIEW_STAGE = 'candidate_review'

// 三个工作盒子（顺序固定：推进中 → 观察中 → 暂缓池）
export const WORK_STATE_VALUES = ['contact', 'observe', 'hold']

export const WORK_STATE_LABELS = {
  contact: '推进中',
  observe: '观察中',
  hold: '暂缓池'
}

export const WORK_STATE_OPTIONS = [
  { value: 'contact', label: WORK_STATE_LABELS.contact },
  { value: 'observe', label: WORK_STATE_LABELS.observe },
  { value: 'hold', label: WORK_STATE_LABELS.hold }
]

// 列表 Tag 颜色（弱化视觉噪音：推进中偏中性蓝，观察中偏黄，暂缓池默认灰）
export const WORK_STATE_TAG_COLORS = { contact: 'blue', observe: 'gold', hold: 'default' }

// 从未有 candidate_review 时的默认 Work State
export const DEFAULT_WORK_STATE = 'contact'

// 列表筛选：全部 + 三个工作盒子（单选，互斥）
export const WORK_STATE_FILTER_ALL = 'all'
export const WORK_STATE_FILTER_OPTIONS = [
  { value: WORK_STATE_FILTER_ALL, label: '全部' },
  ...WORK_STATE_OPTIONS
]

const toText = (value) => (value === null || value === undefined ? '' : String(value))

// decision 的确定顺序：created_at 优先，id 兜底（与后端 created_at DESC, id DESC 一致）
function compareDecisionsDesc(a, b) {
  const aTime = toText(a?.created_at)
  const bTime = toText(b?.created_at)
  if (aTime !== bTime) return aTime < bTime ? 1 : -1
  const aId = Number(a?.id)
  const bId = Number(b?.id)
  if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId
  return 0
}

/**
 * 最新一条 candidate_review decision（无则 null）。
 * post_quote decision 一律忽略——它属于合作阶段结果，不是 Work State。
 */
export function latestCandidateReviewDecision(decisions = []) {
  const rows = (Array.isArray(decisions) ? decisions : []).filter(
    (item) => item && item.decision_stage === WORK_STATE_CANDIDATE_REVIEW_STAGE
  )
  if (!rows.length) return null
  return rows.slice().sort(compareDecisionsDesc)[0] || null
}

/**
 * 当前 Work State（只由最新 candidate_review 派生）。
 * @returns {{ value: string, label: string, note: string|null, decidedAt: string|null, hasReview: boolean }}
 */
export function deriveWorkState(decisions = []) {
  const review = latestCandidateReviewDecision(decisions)
  if (!review) {
    return {
      value: DEFAULT_WORK_STATE,
      label: WORK_STATE_LABELS[DEFAULT_WORK_STATE],
      note: null,
      decidedAt: null,
      hasReview: false
    }
  }
  const raw = toText(review.human_decision)
  const value = WORK_STATE_VALUES.includes(raw) ? raw : DEFAULT_WORK_STATE
  const note = toText(review.decision_note).trim()
  return {
    value,
    label: WORK_STATE_LABELS[value],
    note: note || null,
    decidedAt: review.created_at ?? null,
    hasReview: true
  }
}

/** 单个 candidate 的 Work State（视图层用；map 缺省 / 加载中一律按默认值「推进中」） */
export function workStateOf(workStateByCandidate, candidateId) {
  const raw = workStateByCandidate?.[candidateId]?.value
  const value = WORK_STATE_VALUES.includes(raw) ? raw : DEFAULT_WORK_STATE
  return { value, label: WORK_STATE_LABELS[value] }
}

/**
 * 列表过滤：名称 substring（大小写不敏感） + 三个工作盒子（单选互斥）。
 * 保持输入顺序，不排序、不改写 candidate，也不做任何昵称合并 / 历史达人猜测。
 */
export function filterCandidates({
  candidates = [],
  keyword = '',
  workState = WORK_STATE_FILTER_ALL,
  workStateByCandidate = {}
} = {}) {
  const needle = toText(keyword).trim().toLowerCase()
  const list = Array.isArray(candidates) ? candidates : []
  return list.filter((item) => {
    if (!item) return false
    if (needle && !toText(item.name).toLowerCase().includes(needle)) return false
    if (workState === WORK_STATE_FILTER_ALL || workState === '' || workState === null || workState === undefined) {
      return true
    }
    if (!WORK_STATE_VALUES.includes(workState)) return true
    return workStateOf(workStateByCandidate, item.id).value === workState
  })
}

/** 四个筛选入口的数量（全部 = 输入条数）；只用于按钮计数，不改变筛选语义 */
export function summarizeWorkStates(candidates = [], workStateByCandidate = {}) {
  const counts = { [WORK_STATE_FILTER_ALL]: 0, contact: 0, observe: 0, hold: 0 }
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item) continue
    counts[WORK_STATE_FILTER_ALL] += 1
    counts[workStateOf(workStateByCandidate, item.id).value] += 1
  }
  return counts
}

/**
 * 已关联合作记录：只使用「outcome 显式关联」的 decision，每轮独立展示。
 * 绝不按 nickname / name 猜测，也不自动连接历史 creator_records。
 */
export function buildLinkedCollaborationRecords(decisions = []) {
  const rows = Array.isArray(decisions) ? decisions : []
  return rows
    .filter((item) => item && item.outcome && (item.outcome.record_id ?? item.outcome.record?.id))
    .map((item) => ({
      decision: item,
      record: item.outcome.record ?? item.outcome
    }))
}
