import { Router } from 'express'
import db from '../db.js'
import {
  getCycleInfo,
  getNextWeek,
  getPrevWeek,
  normalizeWeekCode,
  parseTimeCycleToWeekCode
} from '../utils/dateCycle.js'
import { buildXlsx } from '../utils/xlsx.js'

const router = Router()

// 字段白名单：仅允许写入以下列，杜绝 SQL 注入
const FIELDS = {
  time_cycle: { type: 'string', max: 20, required: true },
  nickname: { type: 'string', max: 100, required: true },
  homepage: { type: 'string', max: 500 },
  creator_type: { type: 'string', max: 50 },
  content_link: { type: 'string', max: 500 },
  total_cost: { type: 'number', min: 0 },
  publish_date: { type: 'date' },
  video_link: { type: 'string', max: 500 },
  first_play: { type: 'int', min: 0 },
  second_week_play: { type: 'int', min: 0 }
}

const COLUMNS = Object.keys(FIELDS)
// 输出列（不含已废弃的 cpm_quote）
const SELECT_COLUMNS = [
  'id',
  'time_cycle',
  'nickname',
  'homepage',
  'creator_type',
  'content_link',
  'total_cost',
  'publish_date',
  'video_link',
  'first_play',
  'second_week_play',
  'created_at'
]
const SELECT_SQL = `SELECT ${SELECT_COLUMNS.join(', ')} FROM creator_records`
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------- 统一响应格式 { code, data, msg } ----------
function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// ---------- 参数校验 ----------
function validate(data, { partial = false } = {}) {
  const errors = []
  const clean = {}

  for (const [field, spec] of Object.entries(FIELDS)) {
    const value = data[field]
    const provided = value !== undefined && value !== null && value !== ''

    if (!provided) {
      if (spec.required && !partial) {
        errors.push(`${field} 不能为空`)
      } else if (!partial && spec.type === 'string') {
        clean[field] = ''
      }
      continue
    }

    if (spec.type === 'string') {
      const text = String(value).trim()
      if (text.length > spec.max) {
        errors.push(`${field} 长度不能超过 ${spec.max}`)
        continue
      }
      clean[field] = text
    } else if (spec.type === 'number' || spec.type === 'int') {
      const num = Number(value)
      if (
        !Number.isFinite(num) ||
        (spec.type === 'int' && !Number.isInteger(num)) ||
        num < spec.min
      ) {
        errors.push(
          `${field} 必须为${spec.type === 'int' ? '整数' : '数字'}且不小于 ${spec.min}`
        )
        continue
      }
      clean[field] = num
    } else if (spec.type === 'date') {
      const text = String(value)
      if (!DATE_RE.test(text)) {
        errors.push(`${field} 格式必须为 YYYY-MM-DD`)
        continue
      }
      clean[field] = text
    }
  }

  return { clean, errors }
}

// 完整行：缺失字段补 null，统一插入列顺序
function toRow(clean) {
  const row = {}
  for (const field of COLUMNS) {
    row[field] = clean[field] === undefined ? null : clean[field]
  }
  return row
}

const INSERT_SQL = `INSERT INTO creator_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(
  () => '?'
).join(', ')})`

// 删除投放记录时同步清理导入批次映射（import_batch_records 只做「批次 ↔ 记录」关联）
// 目的：避免记录删除后残留指向不存在 record_id 的孤儿 mapping，让批次详情统计与记录列表保持一致
const DELETE_RECORD_MAPPING_SQL = 'DELETE FROM import_batch_records WHERE record_id = ?'

function escapeLike(text) {
  // 转义 LIKE 通配符，配合 ESCAPE '\' 使用
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

// 找出周日期范围与 [cycleStart, cycleEnd] 有重叠（含边界）的周码
// 支持只传一端：cycleStart（周结束日 >= 开始日）或 cycleEnd（周开始日 <= 结束日）
function getOverlappingWeekCodes(cycleStart, cycleEnd) {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''`
    )
    .all()
  const codes = []
  for (const row of rows) {
    const info = getCycleInfo(row.time_cycle)
    if (!info) continue
    // 重叠条件：周起止日期与所选范围存在交集（含边界日期）
    const startOk = cycleStart ? info.endDate >= cycleStart : true
    const endOk = cycleEnd ? info.startDate <= cycleEnd : true
    if (startOk && endOk) {
      codes.push(info.weekCode)
    }
  }
  return codes
}

// ---------- 1. 分页查询（支持多条件组合筛选） ----------
router.get('/', (req, res) => {
  const page = Number(req.query.page)
  const pageSize = Number(req.query.pageSize)
  const validPage = Number.isInteger(page) && page > 0
  const validSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100

  if (req.query.page !== undefined && !validPage) {
    return fail(res, 400, 'page 必须为正整数')
  }
  if (req.query.pageSize !== undefined && !validSize) {
    return fail(res, 400, 'pageSize 必须为 1-100 的整数')
  }

  const finalPage = validPage ? page : 1
  const finalSize = validSize ? pageSize : 10

  const conditions = []
  const params = []
  const {
    timeCycle,
    weekCode: rawWeekCode,
    creatorType,
    keyword,
    date,
    startDate,
    endDate,
    cycleStart,
    cycleEnd,
    publishDate,
    batch_id: rawBatchId,
    batchId: rawBatchIdCamel
  } = req.query

  // 按周码筛选：兼容 weekCode（新）与 timeCycle（旧），内部自动归一化零填充
  const weekCode = normalizeWeekCode(rawWeekCode || timeCycle)
  if (rawWeekCode || timeCycle) {
    if (!weekCode) {
      return fail(res, 400, '时间周期格式必须为 YYYY-Wxx')
    }
    conditions.push('time_cycle = ?')
    params.push(weekCode)
  }
  // 按周日期范围筛选：time_cycle 对应周的起止日期与所选范围有重叠（含边界）
  // 支持只传 cycleStart 或只传 cycleEnd
  if (cycleStart || cycleEnd) {
    if (cycleStart && !DATE_RE.test(String(cycleStart))) {
      return fail(res, 400, 'cycleStart 格式必须为 YYYY-MM-DD')
    }
    if (cycleEnd && !DATE_RE.test(String(cycleEnd))) {
      return fail(res, 400, 'cycleEnd 格式必须为 YYYY-MM-DD')
    }
    if (cycleStart && cycleEnd && String(cycleStart) > String(cycleEnd)) {
      return fail(res, 400, 'cycleStart 不能晚于 cycleEnd')
    }
    const overlappingCodes = getOverlappingWeekCodes(
      cycleStart ? String(cycleStart) : null,
      cycleEnd ? String(cycleEnd) : null
    )
    if (overlappingCodes.length === 0) {
      // 没有任何周与所选范围重叠，直接返回空结果
      return ok(res, { list: [], total: 0 })
    }
    const placeholders = overlappingCodes.map(() => '?').join(', ')
    conditions.push(`time_cycle IN (${placeholders})`)
    params.push(...overlappingCodes)
  }
  if (creatorType) {
    // 前缀匹配：兼容选项粒度与库中实际值不一致（如「数码」匹配「数码测评」），
    // 传入完整类型时等价于精确匹配
    conditions.push("creator_type LIKE ? ESCAPE '\\'")
    params.push(`${escapeLike(String(creatorType))}%`)
  }
  // 按导入批次筛选：仅返回该批次导入的投放记录（关联表来自导入日志，未改 creator_records 表结构）
  const batchIdParam = rawBatchId !== undefined && rawBatchId !== '' ? rawBatchId : rawBatchIdCamel
  if (batchIdParam !== undefined && batchIdParam !== '') {
    const batchId = parseId(batchIdParam)
    if (!batchId) return fail(res, 400, 'batch_id 必须为正整数')
    conditions.push('id IN (SELECT record_id FROM import_batch_records WHERE batch_id = ?)')
    params.push(batchId)
  }
  if (keyword) {
    conditions.push("nickname LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(String(keyword))}%`)
  }
  // 发布日期精确筛选（前端筛选区使用；兼容历史 date 参数）
  const publishDateValue = publishDate || date
  if (publishDateValue) {
    if (!DATE_RE.test(String(publishDateValue))) {
      return fail(res, 400, 'publishDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date = ?')
    params.push(String(publishDateValue))
  }
  // 日期区间筛选（历史兼容参数）
  if (startDate) {
    if (!DATE_RE.test(String(startDate))) {
      return fail(res, 400, 'startDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date >= ?')
    params.push(String(startDate))
  }
  if (endDate) {
    if (!DATE_RE.test(String(endDate))) {
      return fail(res, 400, 'endDate 格式必须为 YYYY-MM-DD')
    }
    conditions.push('publish_date <= ?')
    params.push(String(endDate))
  }
  if (startDate && endDate && String(startDate) > String(endDate)) {
    return fail(res, 400, 'startDate 不能晚于 endDate')
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS n FROM creator_records${where}`).get(...params).n
  const list = db
    .prepare(`${SELECT_SQL}${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, finalSize, (finalPage - 1) * finalSize)

  ok(res, { list, total })
})

// 时间周期选项（去重，用于前端筛选下拉）
router.get('/time-cycles', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''
       ORDER BY time_cycle DESC`
    )
    .all()
  ok(res, rows.map((row) => row.time_cycle))
})

// 时间周期选项（含起止日期与展示标签，时间计算统一在后端）
router.get('/cycles', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT time_cycle
       FROM creator_records
       WHERE time_cycle IS NOT NULL AND time_cycle != ''`
    )
    .all()
  const list = rows
    .map((row) => getCycleInfo(row.time_cycle))
    .filter(Boolean)
    .sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
  ok(res, list)
})

// ---------- 周度聚合辅助（单周 / 周范围共用，口径逻辑完全一致） ----------
// 逗号分隔的多值参数（creatorTypes / nicknames），空值返回空数组表示不筛选
function parseCsvParam(raw) {
  return String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

// 组装「维度筛选 + 周码范围」的 WHERE 条件（记录级筛选，与列表筛选口径一致）
function buildRecordFilter({
  startWeek,
  endWeek,
  creatorTypes = [],
  nicknames = [],
  keyword = ''
} = {}) {
  const conditions = []
  const params = []
  if (startWeek) {
    conditions.push('time_cycle >= ?')
    params.push(startWeek)
  }
  if (endWeek) {
    conditions.push('time_cycle <= ?')
    params.push(endWeek)
  }
  if (creatorTypes.length) {
    conditions.push(`creator_type IN (${creatorTypes.map(() => '?').join(', ')})`)
    params.push(...creatorTypes)
  }
  if (nicknames.length) {
    conditions.push(`nickname IN (${nicknames.map(() => '?').join(', ')})`)
    params.push(...nicknames)
  }
  // 达人昵称模糊搜索（可选新增参数；不传时行为与原来完全一致）
  const keywordText = String(keyword || '').trim()
  if (keywordText) {
    conditions.push("nickname LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(keywordText)}%`)
  }
  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params }
}

// 聚合所需字段（周度聚合只用到这几列）
function queryAggregateRows(filters = {}) {
  const { where, params } = buildRecordFilter(filters)
  return db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, total_cost, first_play, second_week_play
       FROM creator_records${where}`
    )
    .all(...params)
}

// 明细导出所需字段（与前端导出列一致）
function queryDetailRows(filters = {}) {
  const { where, params } = buildRecordFilter(filters)
  return db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, homepage, content_link, video_link,
              total_cost, first_play, second_week_play, publish_date
       FROM creator_records${where}
       ORDER BY time_cycle ASC, id ASC`
    )
    .all(...params)
}

/**
 * 按周聚合播放量/花费：同时产出投放周（campaign）与发生周（occurrence）两套口径
 * @param {Array<Object>} rows 投放记录（已按筛选条件过滤）
 * @returns {{ campaignMap: Map, occurrenceMap: Map }}
 */
// ---------- 播放口径核心（产品已冻结的新定义；纯函数，便于单测） ----------
//   first_play       = 7日累计播放量（内容发布约 7 天时的累计值，不是「首周新增」）
//   second_week_play = 最新累计播放量（最近一次更新时的累计总播放，不限于第 2 周）
//   latest_play      = second_week_play
//   post_7d_growth   = second_week_play - first_play（仅当 latest 有值且 latest >= first）
//   latest_cpm       = cost / latest_play × 1000（主 CPM）
//   cpm_7d           = cost / first_play  × 1000（first 无有效值时返回 null）
// 注意：total_play 不再是 first_play + second_week_play —— 两个字段都是累计值，相加会重复计数。
export const HOT_PLAY_THRESHOLD = 100000 // 爆款阈值（沿用现有系统阈值，本轮不改）

// null / undefined / '' 表示「未填写/待更新」；0 是真实记录值。两者不可混为一谈。
function toOptionalPlayNumber(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function round2(value) {
  return Number(value.toFixed(2))
}

function round1(value) {
  return Number(value.toFixed(1))
}

/**
 * 解析单条记录的播放口径
 * @param {Object} row 记录（含 total_cost / first_play / second_week_play）
 */
export function computePlayMetrics(row = {}) {
  const cost = Number(row.total_cost) || 0
  const first = toOptionalPlayNumber(row.first_play)
  const latest = toOptionalPlayNumber(row.second_week_play)
  const hasFirst = first !== null
  const hasLatest = latest !== null
  // latest < first 属于异常历史数据：不产生负增长，只计入 anomaly
  const latestAnomaly = hasFirst && hasLatest && latest < first
  const post7dGrowth = hasFirst && hasLatest && !latestAnomaly ? latest - first : null
  return {
    cost,
    first,
    latest,
    hasFirst,
    hasLatest,
    firstPositive: hasFirst && first > 0,
    post7dGrowth,
    latestAnomaly
  }
}

/** 播放口径累计器（周 / 范围 / 达人三级共用） */
export function createPlayAccumulator() {
  return {
    total_cost: 0, // 全部记录花费
    record_count: 0, // 全部记录数（真实投放次数，不因 latest 缺失而减少）
    creatorSet: new Set(),
    creatorPlay: new Map(), // 达人 -> Σ有效 latest（播放占比图使用最新累计口径）
    first_play_total: 0, // Σ 7日累计
    latest_play_total: 0, // Σ 有效 latest
    post_7d_growth_total: 0, // Σ 有效(latest - first)
    first_sample_count: 0, // 有有效 first（含 0）的记录数 → 7日爆款率分母 / 7日CPM 样本
    first_positive_sample_count: 0, // first > 0 的记录数（仅统计参考，不参与分子口径）
    // 有效 latest 样本：latest 已填写 **且 latest >= first**（latest < first 视为异常、不可信，不计入）
    latest_sample_count: 0,
    // 7日CPM 分子：只要 first_play 是「已填写」的有效观察值（含 0）就计入其花费
    // （0 是真实表现，不是缺失；缺失 = null/undefined/空字符串，其花费不进分子）
    first_valid_cost: 0,
    latest_valid_cost: 0, // 有有效 latest 的记录花费 → 最新平均CPM 分子
    hit_7d_count: 0, // 7日爆款：first >= 阈值
    hit_latest_count: 0, // 累计爆款：latest >= 阈值（仅有效 latest 样本）
    anomaly_count: 0 // latest < first 的异常记录数（不参与任何 latest 指标）
  }
}

/** 把一条记录的播放口径累加进累计器 */
export function accumulatePlay(acc, metrics, nickname = '') {
  const name = String(nickname || '').trim()
  acc.total_cost += metrics.cost
  acc.record_count += 1
  if (name) acc.creatorSet.add(name)

  if (metrics.hasFirst) {
    acc.first_play_total += metrics.first
    acc.first_sample_count += 1
    // first_play 已填写（含 0）即视为有效观察值：其花费进入 7日CPM 分子
    acc.first_valid_cost += metrics.cost
    if (metrics.first > 0) acc.first_positive_sample_count += 1
    if (metrics.first >= HOT_PLAY_THRESHOLD) acc.hit_7d_count += 1
  }

  // latest 只有「已填写且 latest >= first」才算有效观察值。
  // latest < first 判定为异常、不可信：不参与 total_play / avg_cpm / 累计爆款 / 7日后新增 / 播放占比，
  // 但仍然参与 total_cost / 投放次数 / 达人数 / 7日累计 / 7日CPM / 7日爆款等不依赖 latest 的指标。
  const latestUsable = metrics.hasLatest && !metrics.latestAnomaly
  if (latestUsable) {
    acc.latest_play_total += metrics.latest
    acc.latest_sample_count += 1
    acc.latest_valid_cost += metrics.cost
    if (metrics.latest >= HOT_PLAY_THRESHOLD) acc.hit_latest_count += 1
    if (name && metrics.latest > 0) {
      acc.creatorPlay.set(name, (acc.creatorPlay.get(name) || 0) + metrics.latest)
    }
  }

  if (metrics.post7dGrowth !== null) acc.post_7d_growth_total += metrics.post7dGrowth
  if (metrics.latestAnomaly) acc.anomaly_count += 1
  return acc
}

/**
 * 累计器 → 对外汇总字段
 * - total_play 采用「最新累计播放量」口径（Σ有效 latest）
 * - 分子只统计与分母同一样本的记录花费，避免把「最新累计待更新」记录的花费算进 CPM
 * - 无有效样本时 CPM / 爆款率返回 null，绝不返回 0 / NaN / Infinity
 */
export function finalizePlayAccumulator(acc) {
  const avgCpm =
    acc.latest_play_total > 0 ? round2((acc.latest_valid_cost / acc.latest_play_total) * 1000) : null
  // 7日CPM：分母 = Σ所有「已填写」first_play（含 0）；分子 = 这些记录的花费（含 first=0 的记录）
  // Σfirst = 0（全部观察值都是 0）时返回 null，不返回 Infinity / 0
  const cpm7d =
    acc.first_play_total > 0 ? round2((acc.first_valid_cost / acc.first_play_total) * 1000) : null
  const hitRateLatest =
    acc.latest_sample_count > 0
      ? round1((acc.hit_latest_count / acc.latest_sample_count) * 100)
      : null
  const hitRate7d =
    acc.first_sample_count > 0 ? round1((acc.hit_7d_count / acc.first_sample_count) * 100) : null

  return {
    total_cost: round2(acc.total_cost),
    record_count: acc.record_count,
    creator_count: acc.creatorSet.size,
    total_play: acc.latest_play_total,
    latest_play_total: acc.latest_play_total,
    first_play_total: acc.first_play_total,
    post_7d_growth_total: acc.post_7d_growth_total,
    avg_cpm: avgCpm,
    cpm_7d: cpm7d,
    hit_7d_count: acc.hit_7d_count,
    hit_latest_count: acc.hit_latest_count,
    // 兼容旧字段：hit_count / hit_rate 暂时等于「累计爆款 / 累计爆款率」（主爆款）
    hit_count: acc.hit_latest_count,
    hit_rate_latest: hitRateLatest,
    hit_rate_7d: hitRate7d,
    hit_rate: hitRateLatest,
    first_sample_count: acc.first_sample_count,
    first_positive_sample_count: acc.first_positive_sample_count,
    latest_sample_count: acc.latest_sample_count,
    // 最新累计「待更新」投放数（null / undefined / 空字符串）；
    // 异常记录（latest < first）单独计入 anomaly_count，不算「待更新」
    latest_pending_count: acc.record_count - acc.latest_sample_count - acc.anomaly_count,
    anomaly_count: acc.anomaly_count
  }
}

/** 一组记录的播放口径汇总（纯函数，供单测与聚合复用） */
export function summarizePlayRecords(rows = []) {
  const acc = createPlayAccumulator()
  for (const row of rows) {
    accumulatePlay(acc, computePlayMetrics(row), row?.nickname)
  }
  return finalizePlayAccumulator(acc)
}

/**
 * 按周聚合播放量/花费，同时产出两套口径：
 * - campaign（投放周，主口径）：按新定义聚合，latest 归投放周
 * - occurrence（发生周）：**保持旧的迁移实现**（把 second_week_play 当作「下一周新增」）
 *
 * TODO(occurrence): 现有 occurrence 建立在「second_week_play = 下一周新增播放」的旧假设上，
 * 与新产品定义（second_week_play = 最新累计播放量）不兼容；当前库里只有「7日累计 + 最新累计」
 * 两个快照，没有周级 snapshot，无法还原每周新增。本轮不重构 occurrence、不发明替代算法，
 * 待后续 snapshot Batch 处理；同时保证 campaign 新逻辑不再依赖 first + second。
 *
 * @param {Array<Object>} rows 投放记录（已按筛选条件过滤）
 * @returns {{ campaignMap: Map, occurrenceMap: Map }}
 */
function aggregateWeekly(rows) {

  // campaign（投放周，主口径）：新定义累计器（latest 归投放周）
  const createCampaignBucket = (weekCode) => ({ weekCode, play: createPlayAccumulator() })
  // occurrence（发生周）：旧口径结构，保持原实现（TODO(occurrence)：待 snapshot Batch 重构）
  const createLegacyBucket = (weekCode) => ({
    weekCode,
    total_play: 0,
    first_play_total: 0,
    second_week_play_total: 0,
    total_cost: 0,
    record_count: 0,
    creators: new Map(),
    creatorSet: new Set()
  })
  const campaignMap = new Map()
  const occurrenceMap = new Map()
  const getCampaignBucket = (weekCode) => {
    if (!campaignMap.has(weekCode)) campaignMap.set(weekCode, createCampaignBucket(weekCode))
    return campaignMap.get(weekCode)
  }
  const getLegacyBucket = (weekCode) => {
    if (!occurrenceMap.has(weekCode)) occurrenceMap.set(weekCode, createLegacyBucket(weekCode))
    return occurrenceMap.get(weekCode)
  }

  for (const row of rows) {
    const weekCode = normalizeWeekCode(row.time_cycle)
    if (!weekCode) continue

    const nickname = String(row.nickname || '').trim()

    // 投放周口径（新定义）：latest（最新累计播放）归投放周；不再使用 first + second
    const campaign = getCampaignBucket(weekCode)
    accumulatePlay(campaign.play, computePlayMetrics(row), nickname)

    // ---- 以下为 occurrence 旧口径（TODO(occurrence)：与新产品定义不兼容，待 snapshot Batch 重构）----
    const cost = Number(row.total_cost) || 0
    const firstPlay = Number(row.first_play) || 0
    const secondPlay = Number(row.second_week_play) || 0

    // 发生周口径：首发归投放周；次周播放量归投放周的下一周（空值/0 不产生事件；跨年自动正确）
    const occurrence = getLegacyBucket(weekCode)
    occurrence.total_cost += cost
    occurrence.record_count += 1
    if (nickname) occurrence.creatorSet.add(nickname)
    occurrence.first_play_total += firstPlay
    occurrence.total_play += firstPlay
    if (nickname && firstPlay > 0) {
      occurrence.creators.set(nickname, (occurrence.creators.get(nickname) || 0) + firstPlay)
    }

    if (secondPlay > 0) {
      const nextWeekCode = getNextWeek(weekCode)
      if (nextWeekCode) {
        const nextBucket = getLegacyBucket(nextWeekCode)
        nextBucket.second_week_play_total += secondPlay
        nextBucket.total_play += secondPlay
        if (nickname) {
          nextBucket.creators.set(
            nickname,
            (nextBucket.creators.get(nickname) || 0) + secondPlay
          )
        }
      }
    }
  }

  return { campaignMap, occurrenceMap }
}

// 周度结果序列化（额外提供 week_code 别名，便于 BI 侧使用）
// - campaign：新口径字段（total_play = Σ有效最新累计播放）
// - occurrence：旧字段保持不变，新口径字段显式返回 null（TODO(occurrence)）
function serializeBucket(bucket, caliber) {
  if (caliber === 'campaign') {
    const summary = finalizePlayAccumulator(bucket.play)
    return {
      weekCode: bucket.weekCode,
      week_code: bucket.weekCode,
      caliber,
      ...summary,
      // 兼容旧字段命名：second_week_play_total / second_play_total = Σ最新累计播放
      second_week_play_total: summary.latest_play_total,
      second_play_total: summary.latest_play_total,
      creators: [...bucket.play.creatorPlay.entries()]
        .map(([nickname, play]) => ({ nickname, play }))
        .sort((a, b) => b.play - a.play)
    }
  }

  return {
    weekCode: bucket.weekCode,
    week_code: bucket.weekCode,
    caliber,
    total_play: bucket.total_play,
    first_play_total: bucket.first_play_total,
    second_week_play_total: bucket.second_week_play_total,
    // 兼容需求字段命名：second_play_total 与 second_week_play_total 同值
    second_play_total: bucket.second_week_play_total,
    total_cost: Number(bucket.total_cost.toFixed(2)),
    creator_count: bucket.creatorSet.size,
    record_count: bucket.record_count,
    creators: [...bucket.creators.entries()]
      .map(([nickname, play]) => ({ nickname, play }))
      .sort((a, b) => b.play - a.play),
    // 新口径字段在 occurrence 下暂不可用（TODO(occurrence)）：显式 null，避免被当成 0
    latest_play_total: null,
    post_7d_growth_total: null,
    avg_cpm: null,
    cpm_7d: null,
    hit_7d_count: null,
    hit_latest_count: null,
    hit_count: null,
    hit_rate_7d: null,
    hit_rate_latest: null,
    hit_rate: null,
    first_sample_count: null,
    first_positive_sample_count: null,
    latest_sample_count: null,
    latest_pending_count: null,
    anomaly_count: null
  }
}

// 空周结构（无数据周补零，保证趋势图连续）
function emptyBucket(weekCode, caliber = 'campaign') {
  if (caliber === 'campaign') {
    return { weekCode, play: createPlayAccumulator() }
  }
  return {
    weekCode,
    total_play: 0,
    first_play_total: 0,
    second_week_play_total: 0,
    total_cost: 0,
    record_count: 0,
    creators: new Map(),
    creatorSet: new Set()
  }
}

// 周码区间展开（升序、含空周；最多 300 周，防止异常参数造成超大循环）
function expandWeekRange(startWeek, endWeek) {
  const list = []
  let current = normalizeWeekCode(startWeek)
  const end = normalizeWeekCode(endWeek)
  if (!current || !end || current > end) return list
  while (current && current <= end && list.length < 300) {
    list.push(current)
    current = getNextWeek(current)
  }
  return list
}

// ---------- 周度播放量聚合（caliber：campaign 投放周 / occurrence 发生周，默认 occurrence） ----------
router.get('/week-stats', (req, res) => {
  const rawWeekCode = req.query.weekCode
  // 默认主口径 = campaign（投放周）；occurrence 仍支持显式传入（TODO(occurrence)：待 snapshot Batch 重构）
  const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
  if (!['campaign', 'occurrence'].includes(caliber)) {
    return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
  }
  let targetWeekCode = null
  if (rawWeekCode !== undefined && rawWeekCode !== '') {
    targetWeekCode = normalizeWeekCode(rawWeekCode)
    if (!targetWeekCode) {
      return fail(res, 400, 'weekCode 格式必须为 YYYY-Wxx')
    }
  }

  // 新增可选筛选参数（不传时与原有行为完全一致）
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  const nicknames = parseCsvParam(req.query.nicknames)
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const hasRange =
    (rawStartWeek !== undefined && rawStartWeek !== '') ||
    (rawEndWeek !== undefined && rawEndWeek !== '')

  // ---------- 原有单周 / 全量列表分支（向下兼容，逻辑与修改前一致） ----------
  if (!hasRange) {
    const rows = queryAggregateRows({ creatorTypes, nicknames })
    const { campaignMap, occurrenceMap } = aggregateWeekly(rows)
    const activeMap = caliber === 'campaign' ? campaignMap : occurrenceMap

    // 指定周：返回该周统计（无数据返回零值结构，便于前端展示）
    if (targetWeekCode) {
      const bucket = activeMap.get(targetWeekCode)
      return ok(
        res,
        bucket
          ? serializeBucket(bucket, caliber)
          : {
              weekCode: targetWeekCode,
              week_code: targetWeekCode,
              caliber,
              total_play: 0,
              latest_play_total: 0,
              first_play_total: 0,
              second_week_play_total: 0,
              second_play_total: 0,
              post_7d_growth_total: 0,
              total_cost: 0,
              creator_count: 0,
              record_count: 0,
              creators: [],
              avg_cpm: null,
              cpm_7d: null,
              hit_7d_count: 0,
              hit_latest_count: 0,
              hit_count: 0,
              hit_rate_7d: null,
              hit_rate_latest: null,
              hit_rate: null,
              first_sample_count: 0,
              first_positive_sample_count: 0,
              latest_sample_count: 0,
              latest_pending_count: 0,
              anomaly_count: 0
            }
      )
    }

    const weeks = [...activeMap.values()]
      .map((bucket) => serializeBucket(bucket, caliber))
      .sort((a, b) => (a.weekCode < b.weekCode ? 1 : -1))
    return ok(res, {
      caliber,
      weeks,
      earliestWeek: weeks.length ? weeks[weeks.length - 1].weekCode : null,
      latestWeek: weeks.length ? weeks[0].weekCode : null
    })
  }

  // ---------- 周范围分支（BI 趋势：按周升序返回 + 范围汇总） ----------
  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }

  // 发生周口径：起始周的前一周也要参与聚合（它的「次周播放量」发生在起始周）
  const baseStartWeek =
    caliber === 'occurrence' && startWeek ? getPrevWeek(startWeek) : startWeek
  const rows = queryAggregateRows({
    startWeek: baseStartWeek,
    endWeek,
    creatorTypes,
    nicknames
  })
  const { campaignMap, occurrenceMap } = aggregateWeekly(rows)
  const activeMap = caliber === 'campaign' ? campaignMap : occurrenceMap

  const allCodes = [...activeMap.keys()].sort()
  const rangeStart = startWeek || allCodes[0] || null
  const rangeEnd = endWeek || allCodes[allCodes.length - 1] || null
  const weekCodes = rangeStart && rangeEnd ? expandWeekRange(rangeStart, rangeEnd) : []

  // 空数据周补零，保证趋势图连续无断点
  const weeks = weekCodes.map((code) => {
    const bucket = activeMap.get(code)
    return serializeBucket(bucket || emptyBucket(code, caliber), caliber)
  })

  // 范围汇总：花费/达人/记录数按投放周统计（落在所选周范围内的记录）
  const inRangeRecords = rows.filter((row) => {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) return false
    if (rangeStart && code < rangeStart) return false
    if (rangeEnd && code > rangeEnd) return false
    return true
  })

  let totalSummary
  if (caliber === 'campaign') {
    // 新口径：total_play = Σ有效最新累计播放；CPM 分子只统计与分母同一样本记录的花费
    const summary = summarizePlayRecords(inRangeRecords)
    totalSummary = {
      startWeek: rangeStart,
      endWeek: rangeEnd,
      weekCount: weeks.length,
      ...summary,
      // 兼容旧字段命名：second_play_total = Σ最新累计播放
      second_play_total: summary.latest_play_total
    }
  } else {
    // TODO(occurrence): 保持旧实现（second_week_play 视为下一周新增），与新产品定义不兼容，
    // 待 snapshot Batch 重构；新口径字段在 occurrence 下显式返回 null，避免被当成 0。
    const rangeCreatorSet = new Set()
    let summaryCost = 0
    for (const row of inRangeRecords) {
      summaryCost += Number(row.total_cost) || 0
      const nickname = String(row.nickname || '').trim()
      if (nickname) rangeCreatorSet.add(nickname)
    }
    const totalPlay = weeks.reduce((sum, week) => sum + week.total_play, 0)
    totalSummary = {
      startWeek: rangeStart,
      endWeek: rangeEnd,
      weekCount: weeks.length,
      total_play: totalPlay,
      first_play_total: weeks.reduce((sum, week) => sum + week.first_play_total, 0),
      second_play_total: weeks.reduce((sum, week) => sum + week.second_play_total, 0),
      total_cost: Number(summaryCost.toFixed(2)),
      avg_cpm: totalPlay > 0 ? Number(((summaryCost / totalPlay) * 1000).toFixed(2)) : null,
      creator_count: rangeCreatorSet.size,
      record_count: inRangeRecords.length,
      latest_play_total: null,
      post_7d_growth_total: null,
      cpm_7d: null,
      hit_7d_count: null,
      hit_latest_count: null,
      hit_count: null,
      hit_rate_7d: null,
      hit_rate_latest: null,
      hit_rate: null,
      first_sample_count: null,
      latest_sample_count: null
    }
  }

  return ok(res, {
    caliber,
    range: { startWeek: rangeStart, endWeek: rangeEnd },
    weeks,
    total_summary: totalSummary,
    filters: { creatorTypes, nicknames }
  })
})

// 数据覆盖的周范围（发生周口径包含「有次周播放量的下一周」，与筛选元数据一致）
function resolveDataWeekRange(caliber = 'campaign') {
  const rows = db
    .prepare(
      `SELECT time_cycle, second_week_play
       FROM creator_records`
    )
    .all()
  let earliest = null
  let latest = null
  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (!earliest || code < earliest) earliest = code
    if (!latest || code > latest) latest = code
  }
  if (caliber === 'occurrence') {
    for (const row of rows) {
      const code = normalizeWeekCode(row.time_cycle)
      if (!code || (Number(row.second_week_play) || 0) <= 0) continue
      const nextCode = getNextWeek(code)
      if (nextCode && (!latest || nextCode > latest)) latest = nextCode
    }
  }
  return { earliestWeek: earliest, latestWeek: latest }
}

/**
 * 达人维度汇总（按昵称横向聚合，口径与看板一致）
 * - 总花费 / 投放次数：按投放周统计（记录归属周落在筛选范围内）
 * - 播放量：campaign = 范围内记录的首发+次周；occurrence = 范围内记录的首发 + 落到范围内的上一周投放的次周
 */
// 爆款阈值统一定义在文件上方的「播放口径核心」处（7日爆款 = first_play >= 阈值；累计爆款 = second_week_play >= 阈值）
// 达人汇总可排序字段（白名单，避免注入）
const CREATOR_SORT_FIELDS = [
  'total_cost',
  'total_play',
  'total_campaigns',
  'avg_cpm',
  'hit_count',
  'avg_play',
  'repeat_count',
  'first_play_sum',
  'second_play_sum',
  // 新口径字段（Batch 1 新增）
  'latest_play_total',
  'post_7d_growth_total',
  'cpm_7d',
  'hit_7d_count',
  'hit_latest_count',
  'hit_rate_7d',
  'hit_rate_latest',
  'latest_sample_count',
  'latest_pending_count'
]

/**
 * 达人维度汇总统一入口
 * - campaign（投放周，主口径）：新定义（second_week_play = 最新累计播放量）
 * - occurrence：保持旧实现（TODO(occurrence)：与新产品定义不兼容，待 snapshot Batch 重构）
 */
function buildCreatorSummary(options = {}) {
  const caliber = String(options?.caliber || 'campaign').trim().toLowerCase()
  if (caliber === 'occurrence') return buildCreatorSummaryLegacyOccurrence(options)
  return buildCreatorSummaryLatest(options)
}

/**
 * 达人维度汇总（新口径 / campaign 投放周）
 * - 每条记录：latest（最新累计播放）归投放周；total_play = Σ有效 latest（不再用 first + second）
 * - 最新平均CPM = 有 latest 记录的花费 ÷ 这些记录的 latest 总和 × 1000
 * - 7日平均CPM = first>0 记录的花费 ÷ 这些记录 first 总和 × 1000
 * - 累计爆款 = latest >= 阈值（主爆款）；7日爆款 = first >= 阈值
 * - total_campaigns / total_cost 统计范围内全部记录，不因 latest 缺失而减少
 */
function buildCreatorSummaryLatest({
  startWeek,
  endWeek,
  creatorTypes = [],
  keyword = '',
  minCampaigns = 0,
  sortBy = 'total_cost',
  sortOrder = 'desc'
} = {}) {
  const rows = queryAggregateRows({ startWeek, endWeek, creatorTypes, keyword })
  const creatorMap = new Map()
  const getCreator = (nickname, creatorType) => {
    if (!creatorMap.has(nickname)) {
      creatorMap.set(nickname, {
        nickname,
        creator_type: creatorType,
        acc: createPlayAccumulator()
      })
    }
    const entry = creatorMap.get(nickname)
    // 同一昵称出现多个类型时，保留首个非空类型
    if (!entry.creator_type && creatorType) entry.creator_type = creatorType
    return entry
  }

  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (startWeek && code < startWeek) continue
    if (endWeek && code > endWeek) continue
    const nickname = String(row.nickname || '').trim() || '未命名达人'
    const creatorType = String(row.creator_type || '').trim() || '未分类'
    const entry = getCreator(nickname, creatorType)
    accumulatePlay(entry.acc, computePlayMetrics(row), nickname)
  }

  const serializeCreator = (entry) => {
    const summary = finalizePlayAccumulator(entry.acc)
    return {
      nickname: entry.nickname,
      creator_type: entry.creator_type,
      total_campaigns: summary.record_count,
      total_cost: summary.total_cost,
      // 主口径：总播放 = Σ有效最新累计播放（字段名保持兼容，语义已更新）
      total_play: summary.total_play,
      latest_play_total: summary.latest_play_total,
      // 兼容旧字段名：first_play_sum = Σ7日累计；second_play_sum = Σ最新累计
      first_play_sum: summary.first_play_total,
      second_play_sum: summary.latest_play_total,
      post_7d_growth_total: summary.post_7d_growth_total,
      avg_cpm: summary.avg_cpm,
      cpm_7d: summary.cpm_7d,
      hit_count: summary.hit_count,
      hit_7d_count: summary.hit_7d_count,
      hit_latest_count: summary.hit_latest_count,
      hit_rate_7d: summary.hit_rate_7d,
      hit_rate_latest: summary.hit_rate_latest,
      first_sample_count: summary.first_sample_count,
      latest_sample_count: summary.latest_sample_count,
      latest_pending_count: summary.latest_pending_count,
      anomaly_count: summary.anomaly_count,
      // 平均单条播放：按「已更新最新累计」的样本平均
      // （旧定义除以全部投放次数，会把「最新累计待更新」的记录当成 0 拉低均值）
      avg_play:
        summary.latest_sample_count > 0
          ? round1(summary.latest_play_total / summary.latest_sample_count)
          : null,
      repeat_count: summary.record_count > 0 ? summary.record_count - 1 : 0,
      // 供分组聚合精确计算组级 CPM 使用（分子必须与分母同一样本）
      latest_valid_cost: round2(entry.acc.latest_valid_cost),
      first_valid_cost: round2(entry.acc.first_valid_cost)
    }
  }

  const minCampaignsValue = Number(minCampaigns) > 0 ? Math.floor(Number(minCampaigns)) : 0
  const sortField = CREATOR_SORT_FIELDS.includes(sortBy) ? sortBy : 'total_cost'
  const sortDirection = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc'

  const creators = [...creatorMap.values()]
    .map(serializeCreator)
    // 最小投放次数过滤（默认不限）
    .filter((item) => item.total_campaigns >= minCampaignsValue)
    .sort((a, b) => {
      const left = a[sortField]
      const right = b[sortField]
      // 空值（如无有效 latest 时的 avg_cpm / cpm_7d / 爆款率）始终排在最后
      const leftNull = left === null || left === undefined
      const rightNull = right === null || right === undefined
      if (leftNull && rightNull) return 0
      if (leftNull) return 1
      if (rightNull) return -1
      if (left === right) {
        return b.total_cost - a.total_cost || b.total_play - a.total_play
      }
      return sortDirection === 'asc' ? left - right : right - left
    })

  // 总汇总：与达人明细同一套口径（成本/次数按全部记录，播放/CPM/爆款按有效样本）
  const totalSummary = {
    creator_count: creators.length,
    record_count: creators.reduce((sum, item) => sum + item.total_campaigns, 0),
    total_cost: round2(creators.reduce((sum, item) => sum + item.total_cost, 0)),
    first_play_total: creators.reduce((sum, item) => sum + item.first_play_sum, 0),
    latest_play_total: creators.reduce((sum, item) => sum + item.latest_play_total, 0),
    post_7d_growth_total: creators.reduce((sum, item) => sum + item.post_7d_growth_total, 0),
    first_sample_count: creators.reduce((sum, item) => sum + item.first_sample_count, 0),
    latest_sample_count: creators.reduce((sum, item) => sum + item.latest_sample_count, 0),
    hit_7d_count: creators.reduce((sum, item) => sum + item.hit_7d_count, 0),
    hit_latest_count: creators.reduce((sum, item) => sum + item.hit_latest_count, 0),
    anomaly_count: creators.reduce((sum, item) => sum + item.anomaly_count, 0),
    latest_valid_cost: round2(creators.reduce((sum, item) => sum + item.latest_valid_cost, 0)),
    first_valid_cost: round2(creators.reduce((sum, item) => sum + item.first_valid_cost, 0))
  }
  totalSummary.total_play = totalSummary.latest_play_total
  totalSummary.total_campaigns = totalSummary.record_count
  // 兼容旧字段名
  totalSummary.first_play_sum = totalSummary.first_play_total
  totalSummary.second_play_sum = totalSummary.latest_play_total
  totalSummary.avg_cpm =
    totalSummary.latest_play_total > 0
      ? round2((totalSummary.latest_valid_cost / totalSummary.latest_play_total) * 1000)
      : null
  totalSummary.cpm_7d =
    totalSummary.first_play_total > 0
      ? round2((totalSummary.first_valid_cost / totalSummary.first_play_total) * 1000)
      : null
  totalSummary.hit_count = totalSummary.hit_latest_count
  totalSummary.total_hits = totalSummary.hit_latest_count
  totalSummary.hit_rate_latest =
    totalSummary.latest_sample_count > 0
      ? round1((totalSummary.hit_latest_count / totalSummary.latest_sample_count) * 100)
      : null
  totalSummary.hit_rate_7d =
    totalSummary.first_sample_count > 0
      ? round1((totalSummary.hit_7d_count / totalSummary.first_sample_count) * 100)
      : null
  totalSummary.hit_rate = totalSummary.hit_rate_latest
  totalSummary.latest_pending_count =
    totalSummary.record_count - totalSummary.latest_sample_count

  return {
    range: { startWeek: startWeek || null, endWeek: endWeek || null },
    creatorTypes,
    keyword,
    minCampaigns: minCampaignsValue,
    sort: { sortBy: sortField, sortOrder: sortDirection },
    creators,
    total_summary: totalSummary
  }
}

/**
 * 达人维度汇总（旧实现 / occurrence 发生周）
 * TODO(occurrence): 该实现把 second_week_play 当作「下一周新增播放」并跨周搬移，
 * 与新产品定义（second_week_play = 最新累计播放量）不兼容；本轮保留以维持既有接口可用性，
 * 待后续 snapshot Batch 重构（不发明替代算法）。
 */
function buildCreatorSummaryLegacyOccurrence({
  startWeek,
  endWeek,
  caliber = 'occurrence',
  creatorTypes = [],
  keyword = '',
  minCampaigns = 0,
  sortBy = 'total_cost',
  sortOrder = 'desc'
} = {}) {
  const dataRange = resolveDataWeekRange(caliber)
  const rangeStart = startWeek || dataRange.earliestWeek
  const rangeEnd = endWeek || dataRange.latestWeek

  // 发生周口径：起始周的前一周记录，其次周播放发生在范围内，需要一并取出
  const baseStartWeek =
    caliber === 'occurrence' && rangeStart ? getPrevWeek(rangeStart) : rangeStart
  const rows = queryAggregateRows({
    startWeek: baseStartWeek,
    endWeek: rangeEnd,
    creatorTypes,
    keyword
  })

  const creatorMap = new Map()
  const getCreator = (nickname, creatorType) => {
    if (!creatorMap.has(nickname)) {
      creatorMap.set(nickname, {
        nickname,
        creator_type: creatorType,
        total_campaigns: 0,
        total_cost: 0,
        first_play_sum: 0,
        second_play_sum: 0,
        total_play: 0,
        // 爆款数（范围内首发播放量 >= 10 万的记录条数）
        hit_count: 0
      })
    }
    const agg = creatorMap.get(nickname)
    // 同一昵称出现多个类型时，保留出现次数更多的类型（此处按首个非空类型记录）
    if (!agg.creator_type && creatorType) agg.creator_type = creatorType
    return agg
  }

  for (const row of rows) {
    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    const nickname = String(row.nickname || '').trim() || '未命名达人'
    const creatorType = String(row.creator_type || '').trim() || '未分类'
    const inRange = (!rangeStart || code >= rangeStart) && (!rangeEnd || code <= rangeEnd)
    const nextCode = getNextWeek(code)
    const nextInRange =
      caliber === 'occurrence' &&
      nextCode &&
      (!rangeStart || nextCode >= rangeStart) &&
      (!rangeEnd || nextCode <= rangeEnd)
    if (!inRange && !nextInRange) continue

    const cost = Number(row.total_cost) || 0
    const firstPlay = Number(row.first_play) || 0
    const secondPlay = Number(row.second_week_play) || 0
    const agg = getCreator(nickname, creatorType)

    if (inRange) {
      agg.total_campaigns += 1
      agg.total_cost += cost
      agg.first_play_sum += firstPlay
      // 爆款按投放周首发播放量判定（与看板口径一致，不随口径切换）
      if (firstPlay >= HOT_PLAY_THRESHOLD) agg.hit_count += 1
      if (caliber === 'campaign') {
        agg.second_play_sum += secondPlay
        agg.total_play += firstPlay + secondPlay
      } else {
        agg.total_play += firstPlay
      }
    }
    // 发生周口径：次周播放量归属投放周的下一周
    if (nextInRange && secondPlay > 0) {
      agg.second_play_sum += secondPlay
      agg.total_play += secondPlay
    }
  }

  const serializeCreator = (agg) => ({
    nickname: agg.nickname,
    creator_type: agg.creator_type,
    total_campaigns: agg.total_campaigns,
    total_cost: Number(agg.total_cost.toFixed(2)),
    first_play_sum: agg.first_play_sum,
    second_play_sum: agg.second_play_sum,
    total_play: agg.total_play,
    avg_cpm: agg.total_play > 0 ? Number(((agg.total_cost / agg.total_play) * 1000).toFixed(2)) : null,
    // 新增：爆款数 / 平均单条播放（保留 1 位小数）/ 复投次数（0 表示首次投放）
    hit_count: agg.hit_count,
    avg_play:
      agg.total_campaigns > 0
        ? Number((agg.total_play / agg.total_campaigns).toFixed(1))
        : null,
    repeat_count: agg.total_campaigns > 0 ? agg.total_campaigns - 1 : 0
  })

  const minCampaignsValue = Number(minCampaigns) > 0 ? Math.floor(Number(minCampaigns)) : 0
  const sortField = CREATOR_SORT_FIELDS.includes(sortBy) ? sortBy : 'total_cost'
  const sortDirection = String(sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc'

  const creators = [...creatorMap.values()]
    .map(serializeCreator)
    // 最小投放次数过滤（默认不限）
    .filter((item) => item.total_campaigns >= minCampaignsValue)
    .sort((a, b) => {
      const left = a[sortField]
      const right = b[sortField]
      // 空值（如无播放时的 avg_cpm/avg_play）始终排在最后
      const leftNull = left === null || left === undefined
      const rightNull = right === null || right === undefined
      if (leftNull && rightNull) return 0
      if (leftNull) return 1
      if (rightNull) return -1
      if (left === right) {
        // 同值时按总花费、总播放兜底排序，保证结果稳定
        return b.total_cost - a.total_cost || b.total_play - a.total_play
      }
      return sortDirection === 'asc' ? left - right : right - left
    })

  const totalSummary = {
    creator_count: creators.length,
    total_campaigns: creators.reduce((sum, item) => sum + item.total_campaigns, 0),
    total_cost: Number(creators.reduce((sum, item) => sum + item.total_cost, 0).toFixed(2)),
    first_play_sum: creators.reduce((sum, item) => sum + item.first_play_sum, 0),
    second_play_sum: creators.reduce((sum, item) => sum + item.second_play_sum, 0),
    total_play: creators.reduce((sum, item) => sum + item.total_play, 0),
    // 新增：爆款总数 / 爆款率（爆款总数 ÷ 记录总数 × 100，1 位小数）
    total_hits: creators.reduce((sum, item) => sum + item.hit_count, 0),
    record_count: creators.reduce((sum, item) => sum + item.total_campaigns, 0)
  }
  totalSummary.avg_cpm =
    totalSummary.total_play > 0
      ? Number(((totalSummary.total_cost / totalSummary.total_play) * 1000).toFixed(2))
      : null
  totalSummary.hit_rate =
    totalSummary.record_count > 0
      ? Number(((totalSummary.total_hits / totalSummary.record_count) * 100).toFixed(1))
      : null

  return {
    range: { startWeek: rangeStart, endWeek: rangeEnd },
    creatorTypes,
    keyword,
    minCampaigns: minCampaignsValue,
    sort: { sortBy: sortField, sortOrder: sortDirection },
    creators,
    total_summary: totalSummary
  }
}

/**
 * 博主类型分组汇总：与达人明细 / 总汇总使用同一套口径
 * - campaign：总播放 = Σ有效最新累计播放；最新平均CPM 的分子只含同一样本记录的花费
 * - occurrence：保持旧实现（TODO(occurrence)：待 snapshot Batch 重构）
 */
function buildGroupSummary(creatorType, list, caliber = 'campaign') {
  const totalCost = round2(list.reduce((sum, item) => sum + item.total_cost, 0))
  const totalCampaigns = list.reduce((sum, item) => sum + item.total_campaigns, 0)

  if (caliber !== 'campaign') {
    const totalPlay = list.reduce((sum, item) => sum + item.total_play, 0)
    return {
      creator_type: creatorType,
      creator_count: list.length,
      total_campaigns: totalCampaigns,
      total_cost: totalCost,
      first_play_sum: list.reduce((sum, item) => sum + item.first_play_sum, 0),
      second_play_sum: list.reduce((sum, item) => sum + item.second_play_sum, 0),
      total_play: totalPlay,
      avg_cpm: totalPlay > 0 ? round2((totalCost / totalPlay) * 1000) : null,
      total_hits: list.reduce((sum, item) => sum + item.hit_count, 0),
      creators: list
    }
  }

  const latestPlayTotal = list.reduce((sum, item) => sum + item.latest_play_total, 0)
  const firstPlayTotal = list.reduce((sum, item) => sum + item.first_play_sum, 0)
  const latestValidCost = list.reduce((sum, item) => sum + (item.latest_valid_cost || 0), 0)
  const firstValidCost = list.reduce((sum, item) => sum + (item.first_valid_cost || 0), 0)
  const latestSampleCount = list.reduce((sum, item) => sum + item.latest_sample_count, 0)
  const firstSampleCount = list.reduce((sum, item) => sum + item.first_sample_count, 0)
  const hitLatestCount = list.reduce((sum, item) => sum + item.hit_latest_count, 0)
  const hit7dCount = list.reduce((sum, item) => sum + item.hit_7d_count, 0)

  return {
    creator_type: creatorType,
    creator_count: list.length,
    total_campaigns: totalCampaigns,
    total_cost: totalCost,
    first_play_sum: firstPlayTotal,
    second_play_sum: latestPlayTotal,
    total_play: latestPlayTotal,
    latest_play_total: latestPlayTotal,
    post_7d_growth_total: list.reduce((sum, item) => sum + item.post_7d_growth_total, 0),
    avg_cpm: latestPlayTotal > 0 ? round2((latestValidCost / latestPlayTotal) * 1000) : null,
    cpm_7d: firstPlayTotal > 0 ? round2((firstValidCost / firstPlayTotal) * 1000) : null,
    hit_count: hitLatestCount,
    total_hits: hitLatestCount,
    hit_latest_count: hitLatestCount,
    hit_7d_count: hit7dCount,
    hit_rate_latest:
      latestSampleCount > 0 ? round1((hitLatestCount / latestSampleCount) * 100) : null,
    hit_rate_7d: firstSampleCount > 0 ? round1((hit7dCount / firstSampleCount) * 100) : null,
    latest_sample_count: latestSampleCount,
    first_sample_count: firstSampleCount,
    creators: list
  }
}

// ---------- 达人维度汇总接口（按博主类型分组，支持周范围/类型筛选/口径） ----------
router.get('/creator-summary', (req, res) => {
  // 默认主口径 = campaign（投放周）；occurrence 仍支持显式传入（TODO(occurrence)：待 snapshot Batch 重构）
  const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
  if (!['campaign', 'occurrence'].includes(caliber)) {
    return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
  }
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  // groupByType=false 时合并为一个「全部达人」分组，前端渲染逻辑保持统一
  const groupByType = String(req.query.groupByType ?? 'true').toLowerCase() !== 'false'

  // 新增可选参数校验（不传时行为与原来完全一致）
  const rawKeyword = req.query.keyword
  const keyword = rawKeyword === undefined ? '' : String(rawKeyword).trim()
  if (keyword.length > 50) {
    return fail(res, 400, 'keyword 长度不能超过 50')
  }
  const rawMinCampaigns = req.query.minCampaigns
  let minCampaigns = 0
  if (rawMinCampaigns !== undefined && rawMinCampaigns !== '') {
    const parsed = Number(rawMinCampaigns)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fail(res, 400, 'minCampaigns 必须为不小于 1 的整数')
    }
    minCampaigns = parsed
  }
  const rawSortBy = req.query.sortBy
  const sortBy = rawSortBy === undefined || rawSortBy === '' ? 'total_cost' : String(rawSortBy).trim()
  if (!CREATOR_SORT_FIELDS.includes(sortBy)) {
    return fail(res, 400, `sortBy 必须为：${CREATOR_SORT_FIELDS.join(' / ')}`)
  }
  const rawSortOrder = req.query.sortOrder
  const sortOrder =
    rawSortOrder === undefined || rawSortOrder === ''
      ? 'desc'
      : String(rawSortOrder).trim().toLowerCase()
  if (!['asc', 'desc'].includes(sortOrder)) {
    return fail(res, 400, 'sortOrder 必须为 asc 或 desc')
  }

  const summary = buildCreatorSummary({
    startWeek,
    endWeek,
    caliber,
    creatorTypes,
    keyword,
    minCampaigns,
    sortBy,
    sortOrder
  })

  let groups = []
  if (groupByType) {
    const typeMap = new Map()
    for (const creator of summary.creators) {
      const type = creator.creator_type || '未分类'
      if (!typeMap.has(type)) typeMap.set(type, [])
      typeMap.get(type).push(creator)
    }
    groups = [...typeMap.entries()]
      .map(([creatorType, list]) => buildGroupSummary(creatorType, list, caliber))
      .sort((a, b) => b.total_cost - a.total_cost || b.total_play - a.total_play)
  } else {
    groups = [buildGroupSummary('全部达人', summary.creators, caliber)]
  }

  ok(res, {
    caliber,
    groupByType,
    range: summary.range,
    filters: { creatorTypes, keyword: summary.keyword, minCampaigns: summary.minCampaigns },
    sort: summary.sort,
    groups,
    // 扁平达人列表（分组数据的全集，便于前端做对比/导出，避免再遍历 groups）
    creators: summary.creators,
    total_summary: summary.total_summary
  })
})

// ---------- 筛选元数据（博主类型 / 达人昵称 / 数据周范围，供 BI 筛选面板初始化） ----------
router.get('/filters', (req, res) => {
  const rows = db
    .prepare(
      `SELECT time_cycle, nickname, creator_type, second_week_play
       FROM creator_records`
    )
    .all()

  const typeCount = new Map()
  const nicknameCount = new Map()
  let earliestWeek = null
  let latestWeek = null

  for (const row of rows) {
    const type = String(row.creator_type || '').trim()
    if (type) typeCount.set(type, (typeCount.get(type) || 0) + 1)
    const nickname = String(row.nickname || '').trim()
    if (nickname) nicknameCount.set(nickname, (nicknameCount.get(nickname) || 0) + 1)

    const code = normalizeWeekCode(row.time_cycle)
    if (!code) continue
    if (!earliestWeek || code < earliestWeek) earliestWeek = code
    if (!latestWeek || code > latestWeek) latestWeek = code
    // 发生周口径：最晚周扩展到「有次周播放量的下一周」
    if ((Number(row.second_week_play) || 0) > 0) {
      const nextCode = getNextWeek(code)
      if (nextCode && (!latestWeek || nextCode > latestWeek)) latestWeek = nextCode
    }
  }

  // 按出现次数降序（次数相同按名称排序，保证结果稳定）
  const toSortedList = (map) =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'))

  ok(res, {
    creatorTypes: toSortedList(typeCount),
    nicknames: toSortedList(nicknameCount),
    weekRange: { earliestWeek, latestWeek }
  })
})

// ---------- 明细导出（复用后端 xlsx 工具，筛选参数与周度聚合保持一致） ----------
// 记录明细导出表头（V2 术语，与前端 utils/excel.js 的 EXPORT_COLUMNS 保持一致）
const EXPORT_HEADERS = [
  '时间周期',
  '达人昵称',
  '达人类型',
  '达人主页',
  '植入链接',
  '视频链接',
  '总花费(元)',
  'CPM',
  '7日播放量',
  '累计播放量',
  '后续新增播放量',
  '发布日期'
]

router.get('/export', (req, res) => {
  const rawStartWeek = req.query.startWeek
  const rawEndWeek = req.query.endWeek
  const creatorTypes = parseCsvParam(req.query.creatorTypes)
  const nicknames = parseCsvParam(req.query.nicknames)
  const exportType = String(req.query.type || '').trim().toLowerCase()

  const startWeek = rawStartWeek ? normalizeWeekCode(rawStartWeek) : null
  const endWeek = rawEndWeek ? normalizeWeekCode(rawEndWeek) : null
  if (rawStartWeek && !startWeek) return fail(res, 400, 'startWeek 格式必须为 YYYY-Wxx')
  if (rawEndWeek && !endWeek) return fail(res, 400, 'endWeek 格式必须为 YYYY-Wxx')
  if (startWeek && endWeek && startWeek > endWeek) {
    return fail(res, 400, 'startWeek 不能晚于 endWeek')
  }

  // 达人维度汇总导出：博主类型 / 达人昵称 / 投放次数 / 总花费 / 总播放 / 平均CPM
  if (exportType === 'creator-summary') {
    // 默认主口径 = campaign（投放周），与 creator-summary / week-stats 保持一致
    const caliber = String(req.query.caliber || 'campaign').trim().toLowerCase()
    if (!['campaign', 'occurrence'].includes(caliber)) {
      return fail(res, 400, 'caliber 必须为 campaign 或 occurrence')
    }
    // 兼容新增筛选参数（keyword / minCampaigns），并按页面当前排序导出
    const exportKeyword = String(req.query.keyword || '').trim().slice(0, 50)
    const exportMinCampaigns = Number(req.query.minCampaigns) > 0 ? Math.floor(Number(req.query.minCampaigns)) : 0
    const exportSortBy = CREATOR_SORT_FIELDS.includes(String(req.query.sortBy || ''))
      ? String(req.query.sortBy)
      : 'total_cost'
    const exportSortOrder = String(req.query.sortOrder || '').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const summary = buildCreatorSummary({
      startWeek,
      endWeek,
      caliber,
      creatorTypes,
      keyword: exportKeyword,
      minCampaigns: exportMinCampaigns,
      sortBy: exportSortBy,
      sortOrder: exportSortOrder
    })
    // 达人汇总导出（V2 术语，与前端 exportCreatorStatsToExcel 列名/口径保持一致）
    const summaryHeaders = [
      '达人昵称',
      '达人类型',
      '投放次数',
      '总花费',
      '累计播放量',
      '平均播放量',
      '平均CPM',
      '爆款数',
      '爆款率',
      '复投次数',
      '7日播放量',
      '后续新增播放量',
      '7日CPM',
      '7日爆款数',
      '7日爆款率'
    ]
    const cpmCell = (value) =>
      value === null || value === undefined ? '' : Number(Number(value).toFixed(2))
    const rateCell = (value) => (value === null || value === undefined ? '' : `${value}%`)
    const emptyCell = (value) => (value === null || value === undefined ? '' : value)
    const summaryRows = summary.creators.map((item) => [
      item.nickname,
      item.creator_type || '未分类',
      item.total_campaigns,
      item.total_cost.toFixed(2),
      item.latest_play_total ?? item.total_play ?? 0,
      emptyCell(item.avg_play),
      cpmCell(item.avg_cpm),
      item.hit_latest_count ?? item.hit_count ?? 0,
      rateCell(item.hit_rate_latest),
      item.repeat_count,
      // 达人级字段名为 first_play_sum（summary 层才叫 first_play_total），两者都兼容
      item.first_play_sum ?? item.first_play_total ?? 0,
      item.post_7d_growth_total ?? 0,
      cpmCell(item.cpm_7d),
      item.hit_7d_count ?? 0,
      rateCell(item.hit_rate_7d)
    ])
    const summaryContent = buildXlsx('达人汇总', summaryHeaders, summaryRows)
    const summaryFileName = `达人汇总_${startWeek || summary.range.startWeek || '全部'}_${
      endWeek || summary.range.endWeek || '全部'
    }.xlsx`
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="creator-summary.xlsx"; filename*=UTF-8''${encodeURIComponent(summaryFileName)}`
    )
    return res.send(summaryContent)
  }

  const rows = queryDetailRows({ startWeek, endWeek, creatorTypes, nicknames })

  const data = rows.map((row) => {
    const info = getCycleInfo(row.time_cycle)
    // V2 单条口径：latest 未填写 / 异常（latest < first）→ 不参与 CPM 与后续新增
    const metrics = computePlayMetrics(row)
    const cost = metrics.cost
    const cpm =
      metrics.hasLatest && !metrics.latestAnomaly && metrics.latest > 0
        ? Number(((cost / metrics.latest) * 1000).toFixed(2))
        : ''
    return [
      info ? info.label : row.time_cycle,
      row.nickname || '',
      row.creator_type || '',
      row.homepage || '',
      row.content_link || '',
      row.video_link || '',
      cost.toFixed(2),
      cpm,
      // 0 是真实观察值：保留 0；未填写导出空单元格
      metrics.hasFirst ? metrics.first : '',
      // 异常数据仍导出原始累计播放量（不静默丢值），CPM / 后续新增为空
      metrics.hasLatest ? metrics.latest : '',
      metrics.post7dGrowth !== null ? metrics.post7dGrowth : '',
      row.publish_date || ''
    ]
  })

  const content = buildXlsx('投放明细', EXPORT_HEADERS, data)
  const fileName = `投放明细_${startWeek || '全部'}_${endWeek || '全部'}.xlsx`
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="records.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  )
  res.send(content)
})

/**
 * 写入导入批次日志（仅记录导入结果，不参与业务计算）
 * 注意：以实际入库条数作为 success_count，避免客户端统计与真实入库不一致
 * @param {Object|null} meta 前端传入的批次元数据 { fileName, totalCount, failCount, skipCount, duplicateCount, items }
 * @param {number} successCount 实际入库条数
 * @param {number[]} insertedIds 本次入库的记录 ID
 * @returns {number|null} 批次 ID（无元数据时返回 null，不写日志）
 */
function saveImportBatch(meta, successCount, insertedIds = []) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const toCount = (value) => {
    const num = Number(value)
    return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0
  }
  const fileName = String(meta.fileName || '').trim().slice(0, 255)
  const failCount = toCount(meta.failCount)
  const skipCount = toCount(meta.skipCount)
  const duplicateCount = toCount(meta.duplicateCount)
  const success = toCount(successCount)
  const totalCount = Number.isFinite(Number(meta.totalCount))
    ? toCount(meta.totalCount)
    : success + failCount + skipCount + duplicateCount

  const insertBatch = db.prepare(
    `INSERT INTO import_batches
       (file_name, total_count, success_count, fail_count, skip_count, duplicate_count)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertMapping = db.prepare(
    'INSERT INTO import_batch_records (batch_id, record_id) VALUES (?, ?)'
  )
  const insertItem = db.prepare(
    'INSERT INTO import_batch_items (batch_id, row_index, status, reason) VALUES (?, ?, ?, ?)'
  )
  const ALLOWED_STATUS = ['success', 'fail', 'skip', 'duplicate']
  // 行级明细上限，避免超大文件写入过多日志
  const items = Array.isArray(meta.items) ? meta.items.slice(0, 2000) : []

  const run = db.transaction(() => {
    const info = insertBatch.run(fileName, totalCount, success, failCount, skipCount, duplicateCount)
    const batchId = Number(info.lastInsertRowid)
    for (const recordId of insertedIds) {
      if (Number.isSafeInteger(recordId) && recordId > 0) insertMapping.run(batchId, recordId)
    }
    for (const item of items) {
      const status = String(item?.status || '').toLowerCase()
      const rowIndex = Number(item?.rowIndex)
      insertItem.run(
        batchId,
        Number.isFinite(rowIndex) ? rowIndex : null,
        ALLOWED_STATUS.includes(status) ? status : 'fail',
        String(item?.reason ?? '').slice(0, 500)
      )
    }
    return batchId
  })
  return run()
}

// ---------- 6. 批量导入（必须先于 /:id 注册） ----------
router.post('/batch', (req, res) => {
  // 兼容两种请求体：数组（原有调用）与 { rows, batch }（带导入批次元数据）
  const isWrapped = Boolean(req.body) && !Array.isArray(req.body) && Array.isArray(req.body.rows)
  const list = Array.isArray(req.body) ? req.body : isWrapped ? req.body.rows : null
  if (!Array.isArray(list)) {
    return fail(res, 400, '请求体必须是数组，或 { rows: 数组 }')
  }
  if (list.length === 0) {
    return ok(res, { count: 0 })
  }
  if (list.length > 1000) {
    return fail(res, 400, '单次批量导入不能超过 1000 条')
  }

  const rows = []
  for (let i = 0; i < list.length; i++) {
    const { clean, errors } = validate(list[i] || {})
    if (errors.length) {
      return fail(res, 400, `第 ${i + 1} 条数据校验失败：${errors.join('；')}`)
    }
    rows.push(toRow(clean))
  }

  // 事务批量插入，保证性能与一致性
  const insert = db.prepare(INSERT_SQL)
  const insertedIds = []
  const runAll = db.transaction((items) => {
    for (const item of items) {
      const info = insert.run(...COLUMNS.map((col) => item[col]))
      insertedIds.push(Number(info.lastInsertRowid))
    }
  })
  runAll(rows)

  // 导入完成后写入批次日志（仅当请求体带 batch 元数据时；旧调用方行为保持不变）
  const batchId = isWrapped ? saveImportBatch(req.body.batch, rows.length, insertedIds) : null

  ok(res, { count: rows.length, ids: insertedIds, batchId })
})

// ---------- 批量操作（批量修改 / 批量删除，必须先于 /:id 注册） ----------
// 单次批量操作上限（与批量导入保持一致）
const BATCH_LIMIT = 1000
// 允许批量修改的字段白名单（冻结，仅业务字段可批量修改，避免拼接出任意列）
const BATCH_UPDATE_FIELDS = Object.freeze({
  time_cycle: '时间周期',
  creator_type: '博主类型'
})
// 数据库原生 / 敏感字段：禁止批量修改，命中时返回针对性提示
const BATCH_UPDATE_DENY_FIELDS = Object.freeze([
  'id',
  'created_at',
  'nickname',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'publish_date',
  'first_play',
  'second_week_play'
])
// 允许字段的提示文案（用于非法 field 的报错信息）
const BATCH_UPDATE_ALLOWED_HINT = Object.keys(BATCH_UPDATE_FIELDS)
  .map((key) => `${key}（${BATCH_UPDATE_FIELDS[key]}）`)
  .join('、')

// 解析 id 数组：必须为非空正整数数组，自动去重
function parseBatchIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'ids 必须是非空数组' }
  }
  if (raw.length > BATCH_LIMIT) {
    return { error: `单次最多处理 ${BATCH_LIMIT} 条记录` }
  }
  const ids = []
  for (const item of raw) {
    const id = Number(item)
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { error: 'ids 必须为正整数数组' }
    }
    ids.push(id)
  }
  return { ids: [...new Set(ids)] }
}

/**
 * POST /api/records/batch-update
 * 入参：{ ids: number[], field: 'time_cycle'|'creator_type', value: string }
 * 出参：{ successCount, failCount, failList: [{ id, reason }] }
 *      （同时保留 success / failed / errors 兼容字段，供现有前端读取）
 * 逐条更新：不存在的记录计入失败，其余照常更新（失败不影响成功记录）
 */
router.post('/batch-update', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const { ids, error: idsError } = parseBatchIds(body.ids)
  if (idsError) return fail(res, 400, idsError)

  // 字段白名单校验：仅允许业务字段批量修改，禁止数据库原生 / 敏感字段
  if (typeof body.field !== 'string' || body.field.trim() === '') {
    return fail(res, 400, `field 必须为字符串，仅支持批量修改：${BATCH_UPDATE_ALLOWED_HINT}`)
  }
  const field = body.field.trim()
  if (!Object.prototype.hasOwnProperty.call(BATCH_UPDATE_FIELDS, field)) {
    return fail(
      res,
      400,
      BATCH_UPDATE_DENY_FIELDS.includes(field)
        ? `field 不允许批量修改数据库原生/敏感字段「${field}」，仅支持：${BATCH_UPDATE_ALLOWED_HINT}`
        : `field 非法，仅支持批量修改：${BATCH_UPDATE_ALLOWED_HINT}`
    )
  }

  const rawValue = body.value
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fail(res, 400, `${BATCH_UPDATE_FIELDS[field]}不能为空`)
  }

  // 时间周期：与导入解析一致，先走标准周码解析（支持 YYYY-Wxx / 第33周 / 08/17-08/23 等）
  let value = String(rawValue).trim()
  if (field === 'time_cycle') {
    const parsed = parseTimeCycleToWeekCode(value)
    if (!parsed) {
      return fail(
        res,
        400,
        '时间周期格式不正确，需为 YYYY-Wxx 或 MM/DD-MM/DD 等完整自然周写法（周一到周日）'
      )
    }
    value = parsed
  }

  // 复用现有字段校验规则（长度 / 格式），保证与单条新增、编辑完全一致
  const { clean, errors: fieldErrors } = validate({ [field]: value }, { partial: true })
  if (fieldErrors.length) return fail(res, 400, fieldErrors.join('；'))
  const nextValue = clean[field]

  const errors = []
  let success = 0
  // 字段名来自白名单，值走占位符参数化查询
  const update = db.prepare(`UPDATE creator_records SET ${field} = ? WHERE id = ?`)
  const runAll = db.transaction((idList) => {
    for (const id of idList) {
      const info = update.run(nextValue, id)
      if (info.changes > 0) success += 1
      else errors.push({ id, reason: '记录不存在或已被删除' })
    }
  })
  runAll(ids)

  // 执行反馈：新版结构 successCount / failCount / failList；
  // 同时保留 success / failed / errors 兼容字段（现有投放管理页按旧字段读取，避免破坏）
  ok(res, {
    successCount: success,
    failCount: errors.length,
    failList: errors,
    success,
    failed: errors.length,
    errors
  })
})

/**
 * POST /api/records/batch-delete
 * 入参：{ ids: number[] }
 * 出参：{ success, failed, errors: [{ id, reason }] }
 * 与单条删除逻辑一致（物理删除），删除后看板/汇总自动同步
 */
router.post('/batch-delete', (req, res) => {
  const body = req.body && !Array.isArray(req.body) ? req.body : {}
  const { ids, error: idsError } = parseBatchIds(body.ids)
  if (idsError) return fail(res, 400, idsError)

  const errors = []
  let success = 0
  const remove = db.prepare('DELETE FROM creator_records WHERE id = ?')
  const removeMapping = db.prepare(DELETE_RECORD_MAPPING_SQL)
  const runAll = db.transaction((idList) => {
    for (const id of idList) {
      const info = remove.run(id)
      if (info.changes > 0) {
        success += 1
        // 同步清理批次映射，避免删除后留下孤儿 mapping
        removeMapping.run(id)
      } else {
        errors.push({ id, reason: '记录不存在或已被删除' })
      }
    }
  })
  runAll(ids)

  ok(res, { success, failed: errors.length, errors })
})

// ---------- 3. 新增单条 ----------
router.post('/', (req, res) => {
  const body = Array.isArray(req.body) ? {} : req.body || {}
  const { clean, errors } = validate(body)
  if (errors.length) {
    return fail(res, 400, errors.join('；'))
  }

  const row = toRow(clean)
  const info = db.prepare(INSERT_SQL).run(...COLUMNS.map((col) => row[col]))
  const created = db
    .prepare(`${SELECT_SQL} WHERE id = ?`)
    .get(info.lastInsertRowid)
  ok(res, created)
})

// ---------- 2. 查询单条详情 ----------
router.get('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }
  const row = db.prepare(`${SELECT_SQL} WHERE id = ?`).get(id)
  if (!row) {
    return fail(res, 404, '记录不存在')
  }
  ok(res, row)
})

// ---------- 4. 更新记录 ----------
router.put('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }

  const exists = db.prepare('SELECT id FROM creator_records WHERE id = ?').get(id)
  if (!exists) {
    return fail(res, 404, '记录不存在')
  }

  const body = Array.isArray(req.body) ? {} : req.body || {}
  const { clean, errors } = validate(body, { partial: true })
  if (errors.length) {
    return fail(res, 400, errors.join('；'))
  }

  const keys = Object.keys(clean)
  if (keys.length > 0) {
    const sets = keys.map((key) => `${key} = ?`).join(', ')
    db.prepare(`UPDATE creator_records SET ${sets} WHERE id = ?`).run(
      ...keys.map((key) => clean[key]),
      id
    )
  }
  ok(res, db.prepare(`${SELECT_SQL} WHERE id = ?`).get(id))
})

// ---------- 5. 删除记录 ----------
router.delete('/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (id === null) {
    return fail(res, 400, '非法的记录 ID')
  }
  // 删除记录 + 同步清理其导入批次映射（同一事务，避免孤儿 mapping）
  const deleted = db.transaction((recordId) => {
    const info = db.prepare('DELETE FROM creator_records WHERE id = ?').run(recordId)
    if (info.changes === 0) return 0
    db.prepare(DELETE_RECORD_MAPPING_SQL).run(recordId)
    return info.changes
  })(id)
  if (deleted === 0) {
    return fail(res, 404, '记录不存在')
  }
  ok(res, { id })
})

export default router
