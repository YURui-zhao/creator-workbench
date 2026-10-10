#!/usr/bin/env node
/**
 * Creator Identity V1 — migration 001（schema + backfill）
 *
 * 运行方式：
 *   node backend/migrations/001_creator_identity.js --dry-run --db /tmp/<copy>/workbench.db
 *   node backend/migrations/001_creator_identity.js --commit  --db /tmp/<copy>/workbench.db
 *   （或设置 WORKBENCH_DB_PATH 指向副本）
 *
 * 安全边界（硬约束）：
 *   · 真实库 backend/workbench.db 一律拒绝（dry-run 与 commit 都拒绝）→ 必须使用副本
 *   · --dry-run：BEGIN → schema + backfill → reconciliation → invariant → ROLLBACK（副本 schema / 数据不变）
 *   · --commit：仅允许指向临时库（test-only commit mode）
 *
 * 本轮只做「身份层」：additive columns + 新表 + 归属回填。
 * 不修改任何业务事实（records / decisions evidence / cases / outcomes / import audit 逐字节不变）。
 *
 * 设计冻结（Design Revision）：
 *   · Creator = 人；Candidate = 一次 workflow；Record = 一次投放事实；Decision = 业务判断
 *   · Work State 从 creator_decisions 拆出到 candidate_work_state_events（旧行一律保留，不删不改）
 *   · creator_id 是归属锚，绝不替代 decision_id / record_id；禁止 UNIQUE(creator_id) 于事件表
 *   · alias：UNIQUE(creator_id, alias_normalized) + 非唯一 INDEX(alias_normalized)；strict resolve 0/1/N
 *   · 同一 Creator 同时最多一个 active Candidate（partial unique index）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import {
  CREATOR_LINK_SOURCES,
  LEGACY_WORK_STATE_MAP,
  WORK_STATE_STATES,
  buildSeedGroups,
  decideAttribution,
  normalizeAliasStrict,
  seedGroupKey,
  strongerLinkSource,
  workStateFromLegacy
} from '../utils/creatorIdentity.js'

export const MIGRATION_NAME = '001_creator_identity'
export const SCHEMA_VERSION = 'creator-identity-v1'

// 真实基线（冻结；仅当 pre-state 形状匹配真实库时才强制核对）
export const FROZEN_BASELINE = {
  records: 75,
  candidates: 5,
  snapshots: 14,
  decisions: 10,
  legacy_work_state_rows: 5,
  cases: 2,
  outcomes: 1,
  creators: 76,
  aliases: 76,
  ambiguous_alias_groups: 0,
  unresolved_attributions: 0
}

// 迁移新增的列（业务事实逐行比较时排除它们）
const ADDED_COLUMNS = [
  ['creator_candidates', 'creator_id', 'INTEGER REFERENCES creators(id)'],
  ['creator_records', 'creator_id', 'INTEGER REFERENCES creators(id)'],
  ['creator_records', 'creator_link_source', 'TEXT'],
  ['creator_recent_snapshots', 'creator_id', 'INTEGER REFERENCES creators(id)'],
  ['creator_decisions', 'creator_id', 'INTEGER REFERENCES creators(id)'],
  ['creator_negotiation_cases', 'creator_id', 'INTEGER REFERENCES creators(id)']
]

const BUSINESS_TABLES = [
  'creator_records',
  'creator_candidates',
  'creator_recent_snapshots',
  'creator_decisions',
  'creator_decision_outcomes',
  'creator_negotiation_cases',
  'import_batches',
  'import_batch_items',
  'import_batch_records',
  'import_batch_record_updates',
  'projects'
]

const SCHEMA_STATEMENTS = [
  // ① 身份锚 + Profile（V1 内联）
  `CREATE TABLE IF NOT EXISTS creators (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     canonical_name         TEXT    NOT NULL,
     creator_type           TEXT,
     identity_status        TEXT    NOT NULL DEFAULT 'provisional',
     merged_into_creator_id INTEGER REFERENCES creators(id),
     description            TEXT,
     distilled_description  TEXT,
     profile_url            TEXT,
     xingtu_id              TEXT,
     xingtu_url             TEXT,
     created_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_creators_name     ON creators(canonical_name)`,
  `CREATE INDEX IF NOT EXISTS idx_creators_identity ON creators(identity_status)`,
  `CREATE INDEX IF NOT EXISTS idx_creators_merged   ON creators(merged_into_creator_id)`,

  // ② 别名：同名跨达人合法（UNIQUE(creator_id, normalized)）+ 非唯一反查索引
  `CREATE TABLE IF NOT EXISTS creator_aliases (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     creator_id       INTEGER NOT NULL REFERENCES creators(id),
     alias            TEXT    NOT NULL,
     alias_normalized TEXT    NOT NULL,
     source           TEXT    NOT NULL DEFAULT 'seed',
     created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     UNIQUE(creator_id, alias_normalized)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_creator_aliases_norm    ON creator_aliases(alias_normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_creator_aliases_creator ON creator_aliases(creator_id)`,

  // ③ 合并审计
  `CREATE TABLE IF NOT EXISTS creator_merges (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     source_creator_id INTEGER NOT NULL REFERENCES creators(id),
     target_creator_id INTEGER NOT NULL REFERENCES creators(id),
     reason            TEXT,
     evidence_json     TEXT,
     created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_creator_merges_source ON creator_merges(source_creator_id)`,

  // ④ Work State（从 creator_decisions 拆出；不冗余 creator_id，按冻结设计）
  `CREATE TABLE IF NOT EXISTS candidate_work_state_events (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     candidate_id INTEGER NOT NULL REFERENCES creator_candidates(id),
     state        TEXT    NOT NULL,
     legacy_state TEXT,
     note         TEXT,
     created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cwse_candidate_created ON candidate_work_state_events(candidate_id, created_at, id)`,

  // ⑤ 迁移标记
  `CREATE TABLE IF NOT EXISTS _migrations (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     name       TEXT NOT NULL UNIQUE,
     applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
     checksum   TEXT
   )`
]

// 依赖 creator_id 列，必须在 ADD COLUMN 之后执行
const OWNERSHIP_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_candidates_creator_status  ON creator_candidates(creator_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_records_creator_publish    ON creator_records(creator_id, publish_date)`,
  `CREATE INDEX IF NOT EXISTS idx_records_creator_source     ON creator_records(creator_id, creator_link_source)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_creator_observed ON creator_recent_snapshots(creator_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_creator_created  ON creator_decisions(creator_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cases_creator_created      ON creator_negotiation_cases(creator_id, created_at)`,
  // 同一 Creator 同时最多一个 active Candidate（archived 不参与；NULL creator_id 的迁移过渡行互不冲突）
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_candidates_active_per_creator
     ON creator_candidates(creator_id) WHERE status = 'active'`
]

// ============================================================
// 读取 pre-state（只读）
// ============================================================
export function readPreState(db) {
  const all = (sql) => db.prepare(sql).all()
  return {
    records: all('SELECT id, nickname, creator_type, homepage FROM creator_records ORDER BY id'),
    candidates: all(
      `SELECT id, name, creator_type, profile_url, xingtu_url, xingtu_id, description,
              distilled_description, status, created_at, updated_at
       FROM creator_candidates ORDER BY id`
    ),
    snapshots: all('SELECT id, creator, candidate_id FROM creator_recent_snapshots ORDER BY id'),
    decisions: all(
      `SELECT id, creator, candidate_id, decision_stage, human_decision, decision_note, created_at
       FROM creator_decisions ORDER BY id`
    ),
    cases: all('SELECT id, decision_id, record_id, source_type FROM creator_negotiation_cases ORDER BY id'),
    outcomes: all('SELECT id, decision_id, record_id FROM creator_decision_outcomes ORDER BY id')
  }
}

// ============================================================
// Backfill 计划（纯函数）
// ============================================================
export function buildPlan(preState) {
  const records = Array.isArray(preState.records) ? preState.records : []
  const candidates = Array.isArray(preState.candidates) ? preState.candidates : []
  const snapshots = Array.isArray(preState.snapshots) ? preState.snapshots : []
  const decisions = Array.isArray(preState.decisions) ? preState.decisions : []
  const cases = Array.isArray(preState.cases) ? preState.cases : []
  const outcomes = Array.isArray(preState.outcomes) ? preState.outcomes : []

  const creators = []
  const aliases = []
  const identityReview = []

  // ① historical seed groups（SEED GROUPING；一律 provisional）
  for (const group of buildSeedGroups(records)) {
    creators.push({
      key: group.key,
      canonical_name: group.label,
      creator_type: group.creatorType,
      identity_status: 'provisional',
      origin: 'historical_seed',
      profile: { description: null, distilled_description: null, profile_url: null, xingtu_id: null, xingtu_url: null }
    })
    aliases.push({ creatorKey: group.key, alias: group.label, alias_normalized: group.normalized, source: 'seed' })
  }

  // ② 播种解析用的 alias 行（占位 creator_id，仅供 strict resolve 判断 0/1/N）
  const seedAliasRows = aliases.map((row, index) => ({
    creator_id: index + 1,
    alias_normalized: row.alias_normalized
  }))
  const creatorKeyById = new Map(aliases.map((row, index) => [index + 1, row.creatorKey]))
  const seedKeyByLabel = new Map(
    creators.filter((c) => c.origin === 'historical_seed').map((c) => [c.canonical_name, c.key])
  )

  // ③ outcome 桥（candidate decision → record）→ 作为唯一允许的「强身份证据」
  const recordById = new Map(records.map((row) => [Number(row.id), row]))
  const outcomeByDecision = new Map(outcomes.map((row) => [Number(row.decision_id), row]))
  const outcomeCreatorKeys = new Map() // candidateId -> Set(creatorKey)
  const outcomeRecordIds = new Set()
  for (const decision of decisions) {
    if (decision.candidate_id === null || decision.candidate_id === undefined) continue
    const link = outcomeByDecision.get(Number(decision.id))
    if (!link) continue
    const record = recordById.get(Number(link.record_id))
    if (!record) continue
    outcomeRecordIds.add(Number(link.record_id))
    const key = seedKeyByLabel.get(seedGroupKey(record.nickname))
    if (!key) continue
    const candidateId = Number(decision.candidate_id)
    if (!outcomeCreatorKeys.has(candidateId)) outcomeCreatorKeys.set(candidateId, new Set())
    outcomeCreatorKeys.get(candidateId).add(key)
  }

  // ④ candidate → creator
  const candidateLinks = []
  for (const candidate of [...candidates].sort((a, b) => Number(a.id) - Number(b.id))) {
    const candidateId = Number(candidate.id)
    const evidenceKeys = outcomeCreatorKeys.get(candidateId)
    if (evidenceKeys && evidenceKeys.size === 1) {
      candidateLinks.push({ candidateId, creatorKey: [...evidenceKeys][0] })
      continue
    }
    if (evidenceKeys && evidenceKeys.size > 1) {
      candidateLinks.push({ candidateId, creatorKey: null })
      identityReview.push({
        kind: 'candidate_outcome_ambiguous',
        candidateId,
        detail: '该 candidate 的 outcome 指向多个不同历史达人'
      })
      continue
    }
    // 无 outcome 证据：严格规则 —— 名称相同不构成 candidate ↔ historical 的身份确认
    const decision = decideAttribution({
      aliasRows: seedAliasRows,
      rawName: candidate.name,
      creatorKeyByCreatorId: creatorKeyById
    })
    if (decision.reason === 'ambiguous') {
      candidateLinks.push({ candidateId, creatorKey: null })
      identityReview.push({
        kind: 'candidate_name_ambiguous',
        candidateId,
        detail: `名称 strict 归一化命中 ${decision.normalized} 的多个历史达人，不猜`
      })
      continue
    }
    const key = `cand:${candidateId}`
    creators.push({
      key,
      canonical_name: String(candidate.name),
      creator_type: candidate.creator_type ?? null,
      identity_status: 'provisional',
      origin: 'candidate_seed',
      profile: { description: null, distilled_description: null, profile_url: null, xingtu_id: null, xingtu_url: null }
    })
    aliases.push({
      creatorKey: key,
      alias: String(candidate.name),
      alias_normalized: normalizeAliasStrict(candidate.name),
      source: 'seed'
    })
    candidateLinks.push({ candidateId, creatorKey: key })
    if (decision.reason === 'unique_alias') {
      // 只作为 review suggestion：绝不自动并入历史达人
      identityReview.push({
        kind: 'candidate_name_matches_existing_creator',
        candidateId,
        detail: `名称与历史达人「${decision.creatorKey}」strict 相同，但缺少 outcome 身份证据，需人工确认`
      })
    }
  }
  const creatorKeyByCandidateId = new Map(candidateLinks.map((row) => [row.candidateId, row.creatorKey]))

  // ⑤ profile ownership：candidate 是长期画像的权威来源（多 workflow 时取最新 updated_at）
  const candidatesByCreatorKey = new Map()
  for (const candidate of candidates) {
    const key = creatorKeyByCandidateId.get(Number(candidate.id))
    if (!key) continue
    if (!candidatesByCreatorKey.has(key)) candidatesByCreatorKey.set(key, [])
    candidatesByCreatorKey.get(key).push(candidate)
  }
  for (const creator of creators) {
    const rows = (candidatesByCreatorKey.get(creator.key) || []).slice().sort((a, b) => {
      const left = String(a.updated_at ?? '')
      const right = String(b.updated_at ?? '')
      if (left !== right) return left < right ? 1 : -1
      return Number(b.id) - Number(a.id)
    })
    if (!rows.length) continue
    const latest = rows[0]
    const description = latest.description ?? null
    creator.profile = {
      description,
      // provenance：description 为空时派生文本必须失效，绝不保留孤儿派生
      distilled_description: description ? latest.distilled_description ?? null : null,
      profile_url: latest.profile_url ?? null,
      xingtu_id: latest.xingtu_id ?? null,
      xingtu_url: latest.xingtu_url ?? null
    }
    if (!creator.creator_type) creator.creator_type = latest.creator_type ?? null
  }

  // ⑥ records 归属 + link_source（outcome 证据可升级）
  const recordLinks = records.map((record) => ({
    recordId: Number(record.id),
    creatorKey: seedKeyByLabel.get(seedGroupKey(record.nickname)) ?? null,
    source: outcomeRecordIds.has(Number(record.id))
      ? 'outcome_link'
      : seedKeyByLabel.has(seedGroupKey(record.nickname))
        ? 'seed_grouping'
        : null
  }))
  const recordKeyByRecordId = new Map(recordLinks.map((row) => [row.recordId, row.creatorKey]))

  // ⑦ snapshots：candidate 采集 → candidate.creator_id；历史 → strict 唯一解析（不唯一则为 NULL，不猜）
  const snapshotLinks = snapshots.map((snapshot) => {
    if (snapshot.candidate_id !== null && snapshot.candidate_id !== undefined) {
      return { snapshotId: Number(snapshot.id), creatorKey: creatorKeyByCandidateId.get(Number(snapshot.candidate_id)) ?? null }
    }
    const decision = decideAttribution({
      aliasRows: seedAliasRows,
      rawName: snapshot.creator,
      creatorKeyByCreatorId: creatorKeyById
    })
    if (decision.reason !== 'unique_alias') {
      identityReview.push({
        kind: 'snapshot_unresolved',
        snapshotId: Number(snapshot.id),
        detail: `历史 snapshot 的 creator「${snapshot.creator}」无法 strict 唯一解析（${decision.reason}）`
      })
    }
    return { snapshotId: Number(snapshot.id), creatorKey: decision.reason === 'unique_alias' ? decision.creatorKey : null }
  })

  // ⑧ decisions：candidate decision → candidate.creator_id；legacy → strict 唯一解析
  const decisionLinks = decisions.map((decision) => {
    if (decision.candidate_id !== null && decision.candidate_id !== undefined) {
      return { decisionId: Number(decision.id), creatorKey: creatorKeyByCandidateId.get(Number(decision.candidate_id)) ?? null }
    }
    const resolved = decideAttribution({
      aliasRows: seedAliasRows,
      rawName: decision.creator,
      creatorKeyByCreatorId: creatorKeyById
    })
    if (resolved.reason !== 'unique_alias') {
      identityReview.push({
        kind: 'legacy_decision_unresolved',
        decisionId: Number(decision.id),
        detail: `legacy decision 的 creator「${decision.creator}」无法 strict 唯一解析（${resolved.reason}）`
      })
    }
    return { decisionId: Number(decision.id), creatorKey: resolved.reason === 'unique_alias' ? resolved.creatorKey : null }
  })
  const creatorKeyByDecisionId = new Map(decisionLinks.map((row) => [row.decisionId, row.creatorKey]))

  // ⑨ negotiation cases：live → decision；historical_backfill → record（事件身份不变）
  const caseLinks = cases.map((row) => {
    const isLive = String(row.source_type) === 'live'
    const creatorKey = isLive
      ? row.decision_id === null || row.decision_id === undefined
        ? null
        : creatorKeyByDecisionId.get(Number(row.decision_id)) ?? null
      : row.record_id === null || row.record_id === undefined
        ? null
        : recordKeyByRecordId.get(Number(row.record_id)) ?? null
    if (!creatorKey) {
      identityReview.push({ kind: 'case_unresolved', caseId: Number(row.id), detail: `case 无法通过 ${isLive ? 'decision_id' : 'record_id'} 归属` })
    }
    return { caseId: Number(row.id), creatorKey }
  })

  // ⑩ Work State：legacy candidate_review → candidate_work_state_events（复制，不删旧行）
  const workStateEvents = []
  for (const decision of decisions) {
    if (String(decision.decision_stage) !== 'candidate_review') continue
    const state = workStateFromLegacy(decision.human_decision)
    if (!state || decision.candidate_id === null || decision.candidate_id === undefined) {
      identityReview.push({
        kind: 'work_state_unmapped',
        decisionId: Number(decision.id),
        detail: `candidate_review 值「${decision.human_decision}」无法映射到 workflow state`
      })
      continue
    }
    workStateEvents.push({
      candidateId: Number(decision.candidate_id),
      state,
      legacy_state: String(decision.human_decision),
      note: decision.decision_note ?? null,
      created_at: decision.created_at
    })
  }

  // ⑪ ambiguous alias groups（strict 归一化命中多个 creator）
  const aliasGroups = new Map()
  for (const row of aliases) {
    if (!aliasGroups.has(row.alias_normalized)) aliasGroups.set(row.alias_normalized, new Set())
    aliasGroups.get(row.alias_normalized).add(row.creatorKey)
  }
  const ambiguousAliasGroups = [...aliasGroups.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([normalized, keys]) => ({ normalized, creatorKeys: [...keys].sort() }))

  return {
    creators,
    aliases,
    recordLinks,
    candidateLinks,
    snapshotLinks,
    decisionLinks,
    caseLinks,
    workStateEvents,
    identityReview,
    ambiguousAliasGroups
  }
}

// ============================================================
// Schema
// ============================================================
function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
}

export function applySchema(db) {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  for (const [table, column, declaration] of ADDED_COLUMNS) {
    if (!columnNames(db, table).includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
    }
  }
  for (const statement of OWNERSHIP_INDEX_STATEMENTS) db.exec(statement)
}

// ============================================================
// Backfill
// ============================================================
export function applyPlan(db, plan) {
  const creatorIdByKey = new Map()
  const insertCreator = db.prepare(
    `INSERT INTO creators (canonical_name, creator_type, identity_status, description,
                           distilled_description, profile_url, xingtu_id, xingtu_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const creator of plan.creators) {
    const info = insertCreator.run(
      creator.canonical_name,
      creator.creator_type ?? null,
      creator.identity_status ?? 'provisional',
      creator.profile?.description ?? null,
      creator.profile?.distilled_description ?? null,
      creator.profile?.profile_url ?? null,
      creator.profile?.xingtu_id ?? null,
      creator.profile?.xingtu_url ?? null
    )
    creatorIdByKey.set(creator.key, Number(info.lastInsertRowid))
  }

  const insertAlias = db.prepare(
    'INSERT OR IGNORE INTO creator_aliases (creator_id, alias, alias_normalized, source) VALUES (?, ?, ?, ?)'
  )
  for (const alias of plan.aliases) {
    const creatorId = creatorIdByKey.get(alias.creatorKey)
    if (!creatorId) continue
    insertAlias.run(creatorId, alias.alias, alias.alias_normalized, alias.source ?? 'seed')
  }

  const updateRecord = db.prepare('UPDATE creator_records SET creator_id = ?, creator_link_source = ? WHERE id = ?')
  for (const link of plan.recordLinks) {
    updateRecord.run(creatorIdByKey.get(link.creatorKey) ?? null, link.source ?? null, link.recordId)
  }

  const updateCandidate = db.prepare('UPDATE creator_candidates SET creator_id = ? WHERE id = ?')
  for (const link of plan.candidateLinks) {
    updateCandidate.run(creatorIdByKey.get(link.creatorKey) ?? null, link.candidateId)
  }

  const updateSnapshot = db.prepare('UPDATE creator_recent_snapshots SET creator_id = ? WHERE id = ?')
  for (const link of plan.snapshotLinks) {
    updateSnapshot.run(creatorIdByKey.get(link.creatorKey) ?? null, link.snapshotId)
  }

  const updateDecision = db.prepare('UPDATE creator_decisions SET creator_id = ? WHERE id = ?')
  for (const link of plan.decisionLinks) {
    updateDecision.run(creatorIdByKey.get(link.creatorKey) ?? null, link.decisionId)
  }

  const updateCase = db.prepare('UPDATE creator_negotiation_cases SET creator_id = ? WHERE id = ?')
  for (const link of plan.caseLinks) {
    updateCase.run(creatorIdByKey.get(link.creatorKey) ?? null, link.caseId)
  }

  const insertWorkState = db.prepare(
    `INSERT INTO candidate_work_state_events (candidate_id, state, legacy_state, note, created_at)
     VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
  )
  for (const event of plan.workStateEvents) {
    insertWorkState.run(event.candidateId, event.state, event.legacy_state, event.note, event.created_at)
  }

  db.prepare('INSERT OR IGNORE INTO _migrations (name, checksum) VALUES (?, ?)').run(MIGRATION_NAME, SCHEMA_VERSION)
  return creatorIdByKey
}

// ============================================================
// Reconciliation / Invariants
// ============================================================
export function reconcile(db) {
  const scalar = (sql) => Number(db.prepare(sql).get()?.n ?? 0)
  const legacyWorkStateRows = scalar("SELECT COUNT(*) n FROM creator_decisions WHERE decision_stage = 'candidate_review'")
  const workStateEvents = scalar('SELECT COUNT(*) n FROM candidate_work_state_events')
  const mappingDiff = scalar(
    `SELECT COUNT(*) n FROM candidate_work_state_events e
     WHERE e.legacy_state IS NULL
        OR e.state <> CASE e.legacy_state WHEN 'contact' THEN 'advancing' WHEN 'observe' THEN 'observing' WHEN 'hold' THEN 'paused' ELSE '' END`
  )
  const ambiguousAliasGroups = scalar(
    `SELECT COUNT(*) n FROM (
       SELECT alias_normalized FROM creator_aliases GROUP BY alias_normalized HAVING COUNT(DISTINCT creator_id) > 1
     )`
  )
  const bySource = db
    .prepare('SELECT creator_link_source AS source, COUNT(*) AS n FROM creator_records GROUP BY creator_link_source ORDER BY source')
    .all()
    .map((row) => ({ source: row.source, n: Number(row.n) }))

  const recordsTotal = scalar('SELECT COUNT(*) n FROM creator_records')
  const recordsAttributed = scalar('SELECT COUNT(*) n FROM creator_records WHERE creator_id IS NOT NULL')
  const candidatesTotal = scalar('SELECT COUNT(*) n FROM creator_candidates')
  const candidatesAttributed = scalar('SELECT COUNT(*) n FROM creator_candidates WHERE creator_id IS NOT NULL')
  const snapshotsTotal = scalar('SELECT COUNT(*) n FROM creator_recent_snapshots')
  const snapshotsAttributed = scalar('SELECT COUNT(*) n FROM creator_recent_snapshots WHERE creator_id IS NOT NULL')
  const decisionsTotal = scalar('SELECT COUNT(*) n FROM creator_decisions')
  const decisionsAttributed = scalar('SELECT COUNT(*) n FROM creator_decisions WHERE creator_id IS NOT NULL')
  const casesTotal = scalar('SELECT COUNT(*) n FROM creator_negotiation_cases')
  const casesAttributed = scalar('SELECT COUNT(*) n FROM creator_negotiation_cases WHERE creator_id IS NOT NULL')
  const unresolved =
    (recordsTotal - recordsAttributed) +
    (snapshotsTotal - snapshotsAttributed) +
    (decisionsTotal - decisionsAttributed) +
    (casesTotal - casesAttributed)

  return {
    creators: scalar('SELECT COUNT(*) n FROM creators'),
    aliases: scalar('SELECT COUNT(*) n FROM creator_aliases'),
    records_total: recordsTotal,
    records_attributed: recordsAttributed,
    records_unattributed: recordsTotal - recordsAttributed,
    records_by_source: bySource,
    candidates_total: candidatesTotal,
    candidates_attributed: candidatesAttributed,
    candidates_unattributed: candidatesTotal - candidatesAttributed,
    snapshots_total: snapshotsTotal,
    snapshots_attributed: snapshotsAttributed,
    snapshots_unattributed: snapshotsTotal - snapshotsAttributed,
    decisions_total: decisionsTotal,
    decisions_attributed: decisionsAttributed,
    decisions_unattributed: decisionsTotal - decisionsAttributed,
    work_state_legacy: legacyWorkStateRows,
    work_state_events: workStateEvents,
    work_state_mapping_diff: mappingDiff,
    cases_total: casesTotal,
    cases_attributed: casesAttributed,
    cases_unattributed: casesTotal - casesAttributed,
    outcomes: scalar('SELECT COUNT(*) n FROM creator_decision_outcomes'),
    ambiguous_alias_groups: ambiguousAliasGroups,
    unresolved_attributions: unresolved,
    merges: scalar('SELECT COUNT(*) n FROM creator_merges')
  }
}

/** 业务事实快照（排除迁移新增列；含 0 / NULL 语义） */
export function snapshotBusinessData(db) {
  const out = {}
  for (const table of BUSINESS_TABLES) {
    const columns = columnNames(db, table).filter((name) => !ADDED_COLUMNS.some(([t, c]) => t === table && c === name))
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all()
    out[table] = {
      count: rows.length,
      hash: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    }
  }
  return out
}

export function diffBusinessData(before, after) {
  const diffs = []
  for (const table of Object.keys(before)) {
    if (!after[table]) {
      diffs.push({ table, reason: 'missing_after' })
      continue
    }
    if (before[table].count !== after[table].count) {
      diffs.push({ table, reason: 'row_count', before: before[table].count, after: after[table].count })
      continue
    }
    if (before[table].hash !== after[table].hash) diffs.push({ table, reason: 'content_hash' })
  }
  return diffs
}

/** 禁止出现的约束（事件身份绝不能被 UNIQUE(creator_id) 降级） */
export function assertForbiddenConstraints(db) {
  const violations = []
  for (const table of ['creator_records', 'creator_decisions', 'creator_negotiation_cases', 'creator_decision_outcomes']) {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all()
    for (const index of indexes) {
      if (index.unique !== 1) continue
      const columns = db.prepare(`PRAGMA index_info(${index.name})`).all().map((row) => row.name)
      if (columns.length === 1 && columns[0] === 'creator_id') {
        violations.push({ table, index: index.name, columns })
      }
    }
  }
  return violations
}

// ============================================================
// 期望值（EXPECTED）—— 由 pre-state 确定性推导 + 真实基线冻结核对
// ============================================================
export function buildExpectations(preState, plan) {
  const attributed = (rows) => rows.filter((row) => row.creatorKey).length
  const sourceCounts = {}
  for (const link of plan.recordLinks) {
    const key = link.source ?? 'NULL'
    sourceCounts[key] = (sourceCounts[key] ?? 0) + 1
  }
  const legacyRows = preState.decisions.filter((row) => String(row.decision_stage) === 'candidate_review').length
  return {
    creators: plan.creators.length,
    aliases: plan.aliases.length,
    records_total: preState.records.length,
    records_attributed: attributed(plan.recordLinks),
    records_unattributed: plan.recordLinks.length - attributed(plan.recordLinks),
    records_by_source: Object.entries(sourceCounts)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([source, n]) => ({ source: source === 'NULL' ? null : source, n })),
    candidates_total: preState.candidates.length,
    candidates_attributed: attributed(plan.candidateLinks),
    candidates_unattributed: plan.candidateLinks.length - attributed(plan.candidateLinks),
    snapshots_total: preState.snapshots.length,
    snapshots_attributed: attributed(plan.snapshotLinks),
    snapshots_unattributed: plan.snapshotLinks.length - attributed(plan.snapshotLinks),
    decisions_total: preState.decisions.length,
    decisions_attributed: attributed(plan.decisionLinks),
    decisions_unattributed: plan.decisionLinks.length - attributed(plan.decisionLinks),
    work_state_legacy: legacyRows,
    work_state_events: plan.workStateEvents.length,
    work_state_mapping_diff: 0,
    cases_total: preState.cases.length,
    cases_attributed: attributed(plan.caseLinks),
    cases_unattributed: plan.caseLinks.length - attributed(plan.caseLinks),
    outcomes: preState.outcomes.length,
    ambiguous_alias_groups: plan.ambiguousAliasGroups.length,
    unresolved_attributions:
      (plan.recordLinks.length - attributed(plan.recordLinks)) +
      (plan.snapshotLinks.length - attributed(plan.snapshotLinks)) +
      (plan.decisionLinks.length - attributed(plan.decisionLinks)) +
      (plan.caseLinks.length - attributed(plan.caseLinks)),
    merges: 0,
    identity_review_items: plan.identityReview.length
  }
}

// ============================================================
// 主流程
// ============================================================
export function runMigration(db, { mode = 'dry-run', log = () => {} } = {}) {
  const alreadyApplied = (() => {
    try {
      return Boolean(db.prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?').get(MIGRATION_NAME))
    } catch {
      return false
    }
  })()
  if (alreadyApplied) {
    log(`[skip] ${MIGRATION_NAME} 已应用（${mode}）`)
    return { ok: true, alreadyApplied: true, expected: null, actual: reconcileSafe(db), diffs: [], violations: [] }
  }

  const before = snapshotBusinessData(db)
  const preState = readPreState(db)
  const plan = buildPlan(preState)
  const expected = buildExpectations(preState, plan)

  db.exec('BEGIN')
  let actual = null
  let diffs = []
  let violations = []
  try {
    applySchema(db)
    applyPlan(db, plan)
    actual = reconcile(db)
    const after = snapshotBusinessData(db)
    diffs = diffBusinessData(before, after)
    violations = assertForbiddenConstraints(db)
    if (mode === 'commit') db.exec('COMMIT')
    else db.exec('ROLLBACK')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw error
  }

  const report = { ok: diffs.length === 0 && violations.length === 0 && matchesExpected(expected, actual), expected, actual, diffs, violations }
  return report
}

function reconcileSafe(db) {
  try {
    return reconcile(db)
  } catch {
    return null
  }
}

export function matchesExpected(expected, actual) {
  if (!expected || !actual) return false
  const keys = [
    'creators',
    'aliases',
    'records_total',
    'records_attributed',
    'records_unattributed',
    'candidates_total',
    'candidates_attributed',
    'candidates_unattributed',
    'snapshots_total',
    'snapshots_attributed',
    'snapshots_unattributed',
    'decisions_total',
    'decisions_attributed',
    'decisions_unattributed',
    'work_state_legacy',
    'work_state_events',
    'work_state_mapping_diff',
    'cases_total',
    'cases_attributed',
    'cases_unattributed',
    'outcomes',
    'ambiguous_alias_groups',
    'unresolved_attributions',
    'merges'
  ]
  for (const key of keys) if (expected[key] !== actual[key]) return false
  const sourceKey = (list) => JSON.stringify((list || []).map((row) => ({ source: row.source ?? null, n: row.n })))
  return sourceKey(expected.records_by_source) === sourceKey(actual.records_by_source)
}

/** 真实基线核对（仅当形状匹配真实库时执行） */
export function checkFrozenBaseline(preState, expected) {
  if (preState.records.length !== FROZEN_BASELINE.records || preState.candidates.length !== FROZEN_BASELINE.candidates) {
    return { applicable: false, checks: [] }
  }
  const checks = [
    ['records', preState.records.length, FROZEN_BASELINE.records],
    ['candidates', preState.candidates.length, FROZEN_BASELINE.candidates],
    ['snapshots', preState.snapshots.length, FROZEN_BASELINE.snapshots],
    ['decisions', preState.decisions.length, FROZEN_BASELINE.decisions],
    ['cases', preState.cases.length, FROZEN_BASELINE.cases],
    ['outcomes', preState.outcomes.length, FROZEN_BASELINE.outcomes],
    ['creators', expected.creators, FROZEN_BASELINE.creators],
    ['aliases', expected.aliases, FROZEN_BASELINE.aliases],
    ['ambiguous_alias_groups', expected.ambiguous_alias_groups, FROZEN_BASELINE.ambiguous_alias_groups],
    ['unresolved_attributions', expected.unresolved_attributions, FROZEN_BASELINE.unresolved_attributions]
  ].map(([name, actual, expectedValue]) => ({ name, actual, expected: expectedValue, pass: actual === expectedValue }))
  return { applicable: true, checks, pass: checks.every((row) => row.pass) }
}

// ============================================================
// CLI
// ============================================================
const REAL_DB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workbench.db')

function parseArgs(argv) {
  const args = { mode: 'dry-run', db: null }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') args.mode = 'dry-run'
    else if (token === '--commit') args.mode = 'commit'
    else if (token === '--db') args.db = argv[++i]
    else if (token.startsWith('--db=')) args.db = token.slice(5)
  }
  return args
}

function guardDbPath(dbPath, mode) {
  const resolved = path.resolve(dbPath)
  if (resolved === REAL_DB_PATH) {
    throw new Error(
      `拒绝在真实库上执行 migration（${mode}）：${resolved}\n` +
        '请先复制副本：cp 或 SQLite online backup，然后 --db <副本路径>。'
    )
  }
  if (mode === 'commit') {
    const inTemp = resolved.startsWith(os.tmpdir()) || resolved.includes('/tmp/')
    if (!inTemp) throw new Error(`--commit 仅允许用于临时库（当前：${resolved}）`)
  }
  return resolved
}

function printReport(report, baseline) {
  const rows = [
    ['creators', report.expected?.creators, report.actual?.creators],
    ['aliases', report.expected?.aliases, report.actual?.aliases],
    ['records.total', report.expected?.records_total, report.actual?.records_total],
    ['records.attributed', report.expected?.records_attributed, report.actual?.records_attributed],
    ['records.unattributed', report.expected?.records_unattributed, report.actual?.records_unattributed],
    ['candidates.attributed', report.expected?.candidates_attributed, report.actual?.candidates_attributed],
    ['snapshots.attributed', report.expected?.snapshots_attributed, report.actual?.snapshots_attributed],
    ['decisions.attributed', report.expected?.decisions_attributed, report.actual?.decisions_attributed],
    ['work_state.legacy', report.expected?.work_state_legacy, report.actual?.work_state_legacy],
    ['work_state.events', report.expected?.work_state_events, report.actual?.work_state_events],
    ['work_state.mapping_diff', report.expected?.work_state_mapping_diff, report.actual?.work_state_mapping_diff],
    ['cases.attributed', report.expected?.cases_attributed, report.actual?.cases_attributed],
    ['outcomes', report.expected?.outcomes, report.actual?.outcomes],
    ['alias.ambiguous_groups', report.expected?.ambiguous_alias_groups, report.actual?.ambiguous_alias_groups],
    ['identity.unresolved', report.expected?.unresolved_attributions, report.actual?.unresolved_attributions],
    ['merges', report.expected?.merges, report.actual?.merges]
  ]
  console.log('')
  console.log('=== Reconciliation (EXPECTED vs ACTUAL) ===')
  console.log('metric'.padEnd(28), 'EXPECTED'.padStart(10), 'ACTUAL'.padStart(10), '  RESULT')
  for (const [name, exp, act] of rows) {
    const pass = exp === act
    console.log(name.padEnd(28), String(exp ?? '-').padStart(10), String(act ?? '-').padStart(10), pass ? '  PASS' : '  FAIL')
  }
  const expSrc = JSON.stringify(report.expected?.records_by_source ?? [])
  const actSrc = JSON.stringify(report.actual?.records_by_source ?? [])
  console.log('records.by_link_source'.padEnd(28), expSrc.padStart(10), actSrc.padStart(10), expSrc === actSrc ? '  PASS' : '  FAIL')
  console.log('')
  console.log('=== Business facts invariant (逐行/hash 比较，允许变化的仅 creator_id / creator_link_source) ===')
  if (report.diffs.length === 0) console.log('business_data_diff: 0  PASS')
  else for (const diff of report.diffs) console.log('business_data_diff:', JSON.stringify(diff), ' FAIL')
  console.log('forbidden UNIQUE(creator_id) violations:', report.violations.length, report.violations.length ? 'FAIL' : 'PASS')
  if (baseline?.applicable) {
    console.log('')
    console.log('=== Frozen real baseline (Design Revision 冻结数字) ===')
    for (const row of baseline.checks) {
      console.log(`${row.name.padEnd(28)} expected=${String(row.expected).padStart(4)} actual=${String(row.actual).padStart(4)} ${row.pass ? 'PASS' : 'FAIL'}`)
    }
  } else {
    console.log('Frozen baseline: N/A（pre-state 形状与真实库不同）')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const requested = args.db || process.env.WORKBENCH_DB_PATH
  if (!requested) {
    console.error('缺少 --db <副本路径> 或 WORKBENCH_DB_PATH')
    process.exitCode = 1
    return
  }
  const dbPath = guardDbPath(requested, args.mode)
  console.log(`MIGRATION_MODE: ${args.mode}`)
  console.log(`DB_PATH: ${dbPath}`)
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    const preState = readPreState(db)
    const plan = buildPlan(preState)
    const expected = buildExpectations(preState, plan)
    const baseline = checkFrozenBaseline(preState, expected)
    console.log(`pre-state: records=${preState.records.length} candidates=${preState.candidates.length} snapshots=${preState.snapshots.length} decisions=${preState.decisions.length} cases=${preState.cases.length} outcomes=${preState.outcomes.length}`)
    console.log(`plan: creators=${plan.creators.length} aliases=${plan.aliases.length} work_state_events=${plan.workStateEvents.length} identity_review=${plan.identityReview.length} ambiguous_alias_groups=${plan.ambiguousAliasGroups.length}`)
    if (plan.identityReview.length) {
      console.log('identity_review items:')
      for (const item of plan.identityReview) console.log('  -', JSON.stringify(item))
    }
    const report = runMigration(db, { mode: args.mode })
    printReport(report, baseline)
    const pass = report.ok && (baseline.applicable ? baseline.pass : true)
    console.log('')
    console.log(`DRY_RUN_RESULT: ${pass ? 'DRY_RUN_READY' : 'DRY_RUN_FAILED'}`)
    process.exitCode = pass ? 0 : 1
  } catch (error) {
    console.error('MIGRATION ERROR:', error?.message || error)
    console.log('DRY_RUN_RESULT: DRY_RUN_FAILED')
    process.exitCode = 1
  } finally {
    db.close()
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isEntryPoint) {
  main()
}

// 供测试 / 其它脚本复用
export { REAL_DB_PATH, guardDbPath, printReport }
export { WORK_STATE_STATES, CREATOR_LINK_SOURCES, LEGACY_WORK_STATE_MAP, strongerLinkSource, seedGroupKey }
