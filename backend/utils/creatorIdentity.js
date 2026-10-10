/**
 * Creator Identity V1 —— 纯函数层（deterministic：无时间、无随机、无网络、无 AI、不写库）
 *
 * 冻结边界（来自 Creator Domain V1 Design Revision）：
 *   · Creator = 长期现实达人主实体；Candidate = 某一次拓展 workflow；Record = 一次真实投放事实；
 *     Decision = 真正业务判断；Work State = workflow 注意力状态；Negotiation Case = 某一次谈价事件。
 *   · creator_id 是「归属锚」，绝不替代 decision_id / record_id 这些事件身份。
 *
 * Alias 严格规则（绝不放宽）：
 *   自动归属 normalization 只允许：Unicode NFKC → trim → 连续空白折叠为单个空格 → case fold。
 *   绝不允许：去尾部句点 / 去标点 / 拼音 / 编辑距离 / fuzzy match。
 *   loose（去标点等）只允许出现在 identity-review 的 suggestion 里，绝不据此自动赋 creator_id。
 *
 * Resolver 契约：
 *   0 match → 可以创建 provisional Creator
 *   1 match → 可以自动归属
 *   N match → creator_id = NULL（不猜）→ 进入 identity review
 */

// ---------- Creator 归属来源（可审计） ----------
export const CREATOR_LINK_SOURCES = ['seed_grouping', 'alias_exact', 'outcome_link', 'manual']

/** 归属来源是否合法（NULL 表示「尚未归属」，合法） */
export function isCreatorLinkSource(value) {
  if (value === null || value === undefined) return true
  return CREATOR_LINK_SOURCES.includes(String(value))
}

// ---------- Work State（workflow 注意力状态；已从 creator_decisions 拆出） ----------
export const WORK_STATE_STATES = ['advancing', 'observing', 'paused']

// legacy candidate_review decision → workflow 状态
export const LEGACY_WORK_STATE_MAP = {
  contact: 'advancing',
  observe: 'observing',
  hold: 'paused'
}

// 反向映射（API 兼容：旧客户端仍收到 contact/observe/hold）
export const WORK_STATE_TO_LEGACY = {
  advancing: 'contact',
  observing: 'observe',
  paused: 'hold'
}

/** legacy candidate_review 值 → workflow state；非法值返回 null（不猜） */
export function workStateFromLegacy(value) {
  const key = value === null || value === undefined ? '' : String(value).trim()
  return Object.prototype.hasOwnProperty.call(LEGACY_WORK_STATE_MAP, key)
    ? LEGACY_WORK_STATE_MAP[key]
    : null
}

/** workflow state → legacy 值（仅供旧 API 回映射） */
export function legacyFromWorkState(state) {
  const key = state === null || state === undefined ? '' : String(state).trim()
  return Object.prototype.hasOwnProperty.call(WORK_STATE_TO_LEGACY, key)
    ? WORK_STATE_TO_LEGACY[key]
    : null
}

// ---------- Alias normalization（strict） ----------
/**
 * strict 别名归一化（纯函数，确定性）。
 *   NFKC → trim → 连续空白折叠为单个空格 → toLowerCase()
 * 明确不做：去尾部句点、去标点、拼音、编辑距离、模糊匹配。
 * @returns {string} 归一化结果（空 / 缺失 → ''）
 */
export function normalizeAliasStrict(value) {
  if (value === null || value === undefined) return ''
  const text = String(value).normalize('NFKC').trim().replace(/\s+/g, ' ')
  return text.toLowerCase()
}

/**
 * loose key（**仅供 identity-review suggestion**，绝不用于自动归属）。
 * 去掉空白与常见标点后再比较，用于「看起来可能是同一个人」的提示。
 */
export function looseSuggestionKey(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"`~()（）[\]【】{}<>、。，；：！？“”‘’·・\-_/\\|]/g, '')
}

// ---------- Historical seed grouping ----------
// 说明：SEED GROUPING ≠ 身份确认。
//   creator_records 按 nickname 聚合是当前产品（CreatorSummary / RepurchaseRadar）长期使用的口径，
//   因此可以作为「播种分组」；但由此产生的 Creator 一律 provisional，绝不自动 confirmed。
export const SEED_NAMELESS_LABEL = '未命名达人'

/** 播种分组键：与既有产品口径一致（String(nickname).trim() || '未命名达人'） */
export function seedGroupKey(nickname) {
  const text = nickname === null || nickname === undefined ? '' : String(nickname).trim()
  return text || SEED_NAMELESS_LABEL
}

/** 同一 nickname 的多条 records：只有全部非空类型一致时才作为 current creator_type，否则 null（不猜） */
export function pickCreatorTypeFromRecords(recordRows = []) {
  const types = new Set()
  for (const row of Array.isArray(recordRows) ? recordRows : []) {
    const value = row?.creator_type === null || row?.creator_type === undefined ? '' : String(row.creator_type).trim()
    if (value) types.add(value)
  }
  return types.size === 1 ? [...types][0] : null
}

/**
 * 把 creator_records 聚成 seed groups（纯函数；保持输入出现顺序以确定性输出）。
 * @param {Array<{id:number,nickname:string,creator_type?:string}>} recordRows
 * @returns {Array<{key:string,label:string,normalized:string,recordIds:number[],creatorType:string|null}>}
 */
export function buildSeedGroups(recordRows = []) {
  const groups = new Map()
  for (const row of Array.isArray(recordRows) ? recordRows : []) {
    if (!row || row.id === null || row.id === undefined) continue
    const label = seedGroupKey(row.nickname)
    if (!groups.has(label)) {
      groups.set(label, {
        key: `seed:${label}`,
        label,
        normalized: normalizeAliasStrict(label),
        recordIds: [],
        rows: []
      })
    }
    const group = groups.get(label)
    group.recordIds.push(Number(row.id))
    group.rows.push(row)
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    label: group.label,
    normalized: group.normalized,
    recordIds: group.recordIds,
    creatorType: pickCreatorTypeFromRecords(group.rows)
  }))
}

// ---------- Alias resolver（纯函数版本：调用方提供 alias 行） ----------
/**
 * 按 strict 归一化在 alias 行集合里解析 creator。
 * @param {Array<{creator_id:number,alias:string,alias_normalized:string}>} aliasRows
 * @param {string} rawAlias
 * @returns {{ normalized:string, count:number, creatorIds:number[] }}
 */
export function resolveAliasFromEntries(aliasRows = [], rawAlias) {
  const normalized = normalizeAliasStrict(rawAlias)
  if (!normalized) return { normalized, count: 0, creatorIds: [] }
  const creatorIds = new Set()
  for (const row of Array.isArray(aliasRows) ? aliasRows : []) {
    if (!row) continue
    if (String(row.alias_normalized ?? '') !== normalized) continue
    const id = Number(row.creator_id)
    if (Number.isInteger(id)) creatorIds.add(id)
  }
  const ids = [...creatorIds].sort((a, b) => a - b)
  return { normalized, count: ids.length, creatorIds: ids }
}

// ---------- 归属决策（纯函数） ----------
/**
 * 单条「事实」的 creator 归属决策。
 * 绝不 fuzzy：只有 strict 0/1/N 三态。
 * @returns {{ creatorKey: string|null, reason: 'unique_alias'|'none'|'ambiguous', normalized: string }}
 */
export function decideAttribution({ aliasRows = [], rawName = '', creatorKeyByCreatorId = {} } = {}) {
  const resolved = resolveAliasFromEntries(aliasRows, rawName)
  // creatorKeyByCreatorId 允许传 Map（迁移计划）或普通对象（调用方自便）
  const keyOf = (id) =>
    creatorKeyByCreatorId instanceof Map
      ? creatorKeyByCreatorId.get(id) ?? null
      : creatorKeyByCreatorId?.[id] ?? null
  if (resolved.count === 1) {
    return {
      creatorKey: keyOf(resolved.creatorIds[0]),
      reason: 'unique_alias',
      normalized: resolved.normalized
    }
  }
  if (resolved.count > 1) return { creatorKey: null, reason: 'ambiguous', normalized: resolved.normalized }
  return { creatorKey: null, reason: 'none', normalized: resolved.normalized }
}

// ---------- 归属来源升级 ----------
// seed_grouping 只是播种口径；已有明确 outcome 身份证据时可升级为 outcome_link。
const LINK_SOURCE_RANK = { seed_grouping: 1, alias_exact: 2, outcome_link: 3, manual: 4 }

/** 取更强（可审计性更高）的归属来源；null/未知视为最低 */
export function strongerLinkSource(a, b) {
  const left = LINK_SOURCE_RANK[a] ?? 0
  const right = LINK_SOURCE_RANK[b] ?? 0
  if (left === 0 && right === 0) return null
  return left >= right ? a : b
}
