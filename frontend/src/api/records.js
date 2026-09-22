import request from '../utils/request.js'

/**
 * 投放记录接口
 * 后端统一返回 { code: 200, data, msg: 'success' }
 */

// 分页查询（支持 timeCycle / creatorType / keyword / startDate / endDate 组合筛选）
export function getRecords(params) {
  return request.get('/records', { params })
}

// 时间周期选项（去重）
export function getTimeCycles() {
  return request.get('/records/time-cycles')
}

// 时间周期选项（含起止日期与展示标签，时间计算由后端统一处理）
export function getCycles() {
  return request.get('/records/cycles')
}

/**
 * 周度播放量聚合（播放量按发生周统计；花费/达人数按投放周统计）
 * @param {string} [weekCode] 指定周（YYYY-Wxx）；不传返回全部周 + earliestWeek/latestWeek
 * @param {'campaign'|'occurrence'} [caliber] 口径：投放周口径 / 发生周口径（默认 occurrence）
 */
export function getWeekStats(weekCode, caliber) {
  return request.get('/records/week-stats', { params: { weekCode, caliber } })
}

// 把筛选数组转成后端需要的逗号分隔参数（空数组 -> 不传，等价于不筛选）
function joinCsv(list) {
  return Array.isArray(list) && list.length ? list.join(',') : undefined
}

/**
 * 单周聚合（附带维度筛选，不传筛选时与原有行为一致）
 * @param {string} weekCode 周码 YYYY-Wxx
 * @param {'campaign'|'occurrence'} caliber 口径
 * @param {{ creatorTypes?: string[], nicknames?: string[] }} [filters] 维度筛选
 */
export function getWeekStatsFiltered(weekCode, caliber, filters = {}) {
  return request.get('/records/week-stats', {
    params: {
      weekCode,
      caliber,
      creatorTypes: joinCsv(filters.creatorTypes),
      nicknames: joinCsv(filters.nicknames)
    }
  })
}

/**
 * 周范围聚合（BI 趋势）：返回按周升序的 weeks[] + total_summary
 * @param {{ startWeek: string, endWeek: string, caliber: string, creatorTypes?: string[], nicknames?: string[] }} params
 */
export function getWeekRangeStats({ startWeek, endWeek, caliber, creatorTypes, nicknames }) {
  return request.get('/records/week-stats', {
    params: {
      startWeek,
      endWeek,
      caliber,
      creatorTypes: joinCsv(creatorTypes),
      nicknames: joinCsv(nicknames)
    }
  })
}

// 筛选元数据（博主类型 / 达人昵称 / 数据周范围）
export function getRecordFilters() {
  return request.get('/records/filters')
}

/**
 * 明细导出下载地址（后端生成 xlsx，参数与周度聚合一致）
 * @param {{ startWeek?: string, endWeek?: string, creatorTypes?: string[], nicknames?: string[], caliber?: string, type?: string }} params
 */
export function buildRecordsExportUrl({
  startWeek,
  endWeek,
  creatorTypes,
  nicknames,
  caliber,
  type,
  keyword,
  minCampaigns,
  sortBy,
  sortOrder
} = {}) {
  const query = new URLSearchParams()
  if (startWeek) query.set('startWeek', startWeek)
  if (endWeek) query.set('endWeek', endWeek)
  if (type) query.set('type', type)
  if (caliber) query.set('caliber', caliber)
  if (keyword) query.set('keyword', String(keyword).trim())
  if (minCampaigns) query.set('minCampaigns', String(minCampaigns))
  if (sortBy) query.set('sortBy', sortBy)
  if (sortOrder) query.set('sortOrder', sortOrder)
  const types = joinCsv(creatorTypes)
  const nicks = joinCsv(nicknames)
  if (types) query.set('creatorTypes', types)
  if (nicks) query.set('nicknames', nicks)
  const qs = query.toString()
  return `/api/records/export${qs ? `?${qs}` : ''}`
}

/**
 * 达人维度汇总（按昵称横向聚合，可按博主类型分组）
 * @param {Object} params
 * @param {string} [params.startWeek] 起始周码
 * @param {string} [params.endWeek] 结束周码
 * @param {'campaign'|'occurrence'} [params.caliber] 口径
 * @param {string[]} [params.creatorTypes] 博主类型多选
 * @param {boolean} [params.groupByType] 是否按博主类型分组
 * @param {string} [params.keyword] 达人昵称模糊搜索（≤50 字）
 * @param {number} [params.minCampaigns] 最小投放次数
 * @param {string} [params.sortBy] 排序字段
 * @param {'asc'|'desc'} [params.sortOrder] 排序方向
 */
export function getCreatorSummary({
  startWeek,
  endWeek,
  caliber,
  creatorTypes,
  groupByType = true,
  keyword,
  minCampaigns,
  sortBy,
  sortOrder
} = {}) {
  return request.get('/records/creator-summary', {
    params: {
      startWeek,
      endWeek,
      caliber,
      creatorTypes: joinCsv(creatorTypes),
      groupByType: groupByType ? undefined : 'false',
      keyword: keyword ? String(keyword).trim() : undefined,
      minCampaigns,
      sortBy,
      sortOrder
    }
  })
}

// 新增单条记录
export function createRecord(data) {
  return request.post('/records', data)
}

// 更新记录（支持部分字段）
export function updateRecord(id, data) {
  return request.put(`/records/${id}`, data)
}

// 删除记录
export function deleteRecord(id) {
  return request.delete(`/records/${id}`)
}

/**
 * 批量导入记录
 * @param {Array<Object>} list 待导入记录
 * @param {Object} [batch] 可选：导入批次元数据（文件名与本次导入统计，用于导入历史）
 *   { fileName, totalCount, failCount, skipCount, duplicateCount, items: [{ rowIndex, status, reason }] }
 *   不传时保持原有调用方式（仅导入，不写批次日志）
 */
export function batchCreateRecords(list, batch) {
  return request.post('/records/batch', batch ? { rows: list, batch } : list)
}

/**
 * 批量更新指定字段（time_cycle / creator_type）
 * @param {Array<number>} ids 记录 ID 数组
 * @param {'time_cycle'|'creator_type'} field 更新字段
 * @param {string} value 目标值（时间周期支持 YYYY-Wxx / 第33周 / 08/17-08/23 等写法）
 * @returns {Promise<{data: {success: number, failed: number, errors: Array<{id:number, reason:string}>}}>}
 */
export function batchUpdateRecords(ids, field, value) {
  return request.post('/records/batch-update', { ids, field, value })
}

/**
 * 批量删除记录
 * @param {Array<number>} ids 记录 ID 数组
 * @returns {Promise<{data: {success: number, failed: number, errors: Array<{id:number, reason:string}>}}>}
 */
export function batchDeleteRecords(ids) {
  return request.post('/records/batch-delete', { ids })
}

/**
 * 拉取全量记录（用于导出、导入去重；接口单页上限 100，自动翻页）
 * @param {Object} params 查询参数
 * @returns {Promise<Array<Object>>}
 */
export async function fetchAllRecords(params = {}) {
  const all = []
  const pageSize = 100
  let page = 1
  while (true) {
    const res = await getRecords({ page, pageSize, ...params })
    all.push(...res.data.list)
    if (all.length >= res.data.total) break
    page += 1
  }
  return all
}
