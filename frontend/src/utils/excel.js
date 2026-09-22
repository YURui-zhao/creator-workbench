import * as XLSX from 'xlsx'
import dayjs from 'dayjs'
import { calcCpm } from './calc.js'
import {
  normalizeTimeCycleValue,
  parseTimeCycleToWeekCode,
  weekCodeToLabel
} from './dateCycle.js'

// 时间周期格式换算统一收敛到 dateCycle.js（规则与后端一致），此处复用并保留对外导出
export { labelToWeekCode, normalizeTimeCycleValue, weekCodeToLabel } from './dateCycle.js'

// Excel 列名（中文）-> 数据库字段
export const HEADER_MAP = {
  时间周期: 'time_cycle',
  达人昵称: 'nickname',
  达人主页: 'homepage',
  博主类型: 'creator_type',
  植入内容链接: 'content_link',
  总花费: 'total_cost',
  发布日期: 'publish_date',
  视频发布链接: 'video_link',
  首发播放量: 'first_play',
  次周播放量: 'second_week_play'
}

export const FIELD_LABELS = {
  time_cycle: '时间周期',
  nickname: '达人昵称',
  homepage: '达人主页',
  creator_type: '博主类型',
  content_link: '植入内容链接',
  total_cost: '总花费',
  publish_date: '发布日期',
  video_link: '视频发布链接',
  first_play: '首发播放量',
  second_week_play: '次周播放量'
}

// 字段校验规则（与后端 / 新增表单保持一致）
const FIELD_RULES = {
  time_cycle: { required: true, type: 'time_cycle', max: 20 },
  nickname: { required: true, type: 'string', max: 100 },
  homepage: { type: 'url', max: 500 },
  creator_type: { type: 'string', max: 50 },
  content_link: { type: 'url', max: 500 },
  total_cost: { required: true, type: 'number' },
  publish_date: { required: true, type: 'date' },
  video_link: { type: 'url', max: 500 },
  first_play: { type: 'int' },
  second_week_play: { type: 'int' }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATE_FUZZY_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
// 合并单元格内换行分隔符（兼容 \n、\r\n、\r）
const NEWLINE_RE = /\r\n|\r|\n/
// 数值字段的「无数据」占位写法：必填按 0、非必填按 null（不报错）
const EMPTY_NUMBER_TOKENS = new Set([
  '',
  '/',
  '-',
  '--',
  '—',
  '——',
  '无',
  '空',
  '暂无',
  'n/a',
  'na',
  'null',
  'none'
])

function isEmptyNumberToken(value) {
  return EMPTY_NUMBER_TOKENS.has(String(value ?? '').trim().toLowerCase())
}

// 导入去重判定字段（与表格展示列对应）
const IDENTITY_FIELDS = [
  'time_cycle',
  'nickname',
  'creator_type',
  'homepage',
  'content_link',
  'video_link',
  'total_cost',
  'first_play',
  'second_week_play',
  'publish_date'
]

// 归一化用于指纹比对的单元格值（数字与数字字符串视为相同）
function normalizeIdentityValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return value
  const text = String(value).trim()
  const num = Number(text)
  return text !== '' && Number.isFinite(num) ? num : text
}

function identityFingerprint(row) {
  return JSON.stringify(IDENTITY_FIELDS.map((field) => normalizeIdentityValue(row[field])))
}

/**
 * 剔除无效（重复）数据：与库中已有记录重复、或文件内部重复的行都会被剔除
 * @param {Array<Object>} rows 解析后的有效行（含 rowIndex）
 * @param {Array<Object>} existingRows 数据库已有记录
 * @returns {{ uniqueRows: Array<Object>, duplicateRows: Array<{ rowIndex: number, reason: string }> }}
 */
export function dedupeImportRows(rows, existingRows = []) {
  const seen = new Set(existingRows.map((row) => identityFingerprint(row)))
  const uniqueRows = []
  const duplicateRows = []

  for (const row of rows) {
    const key = identityFingerprint(row)
    if (seen.has(key)) {
      duplicateRows.push({
        rowIndex: row.rowIndex,
        reason: '与已有记录重复（时间周期、昵称、博主类型、主页、链接、花费、播放量、日期均相同）'
      })
    } else {
      seen.add(key)
      uniqueRows.push(row)
    }
  }
  return { uniqueRows, duplicateRows }
}

// ---------- 日期与单元格归一化 ----------
function excelSerialToDate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000
  const date = new Date(ms)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeDate(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (DATE_RE.test(text)) return text
  // 兼容 2024/7/22、2024.7.22 等写法
  const fuzzy = text.match(DATE_FUZZY_RE)
  if (fuzzy) {
    return `${fuzzy[1]}-${fuzzy[2].padStart(2, '0')}-${fuzzy[3].padStart(2, '0')}`
  }
  // 兼容 Excel 日期序列号（如 45536）
  const num = Number(text)
  if (Number.isFinite(num) && num >= 20000 && num <= 60000) {
    return excelSerialToDate(num)
  }
  return text
}

// ---------- 单元格清洗与校验 ----------
// 数值解析：去掉货币符号/千分位/空格/「元」后缀，并支持「1.2万」「1万」「1.5亿」写法
function parseQuantity(value) {
  const text = String(value).trim()
  const compact = text.replace(/[,\s，￥¥$€£]/g, '').replace(/元$/, '')
  const unit = /^([\d.]+)(万|亿)$/.exec(compact)
  if (unit) {
    const num = parseFloat(unit[1]) * (unit[2] === '亿' ? 100000000 : 10000)
    return Number.isFinite(num) ? num : null
  }
  const num = Number(compact)
  return Number.isFinite(num) ? num : null
}

// 金额：支持货币符号、千分位与中文数量级写法
function parseNumber(value) {
  return parseQuantity(value)
}

// 播放量：支持千分位与「x.x万」写法，必须是整数
function parseIntCell(value) {
  const num = parseQuantity(value)
  return num !== null && Number.isInteger(num) ? num : null
}

// 链接：校验 http/https，无协议但像域名时自动补全 https://
function normalizeUrl(value) {
  const text = String(value).trim()
  if (/^https?:\/\//i.test(text)) return text
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/i.test(text)) {
    return `https://${text}`
  }
  return null
}

/**
 * 单元格级判定：按所属列规则清洗并校验，返回该列需要的数据或错误原因
 * @returns {{ value: any, error: string|null }}
 */
function normalizeCellValue(field, value) {
  const spec = FIELD_RULES[field]
  const label = FIELD_LABELS[field] || field
  const empty = value === undefined || value === null || String(value).trim() === ''

  if (spec.required && empty) return { value, error: `${label}不能为空` }
  if (empty) return { value: undefined, error: null }

  if (spec.type === 'time_cycle') {
    const text = String(value).trim().replace(/^(\d{4})-w/i, '$1-W')
    if (text.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    if (!/^\d{4}-W\d{1,2}$/.test(text)) {
      return {
        value,
        error: `${label}格式不正确，需为 YYYY-Wxx 或 MM/DD-MM/DD 格式，且必须是周一到周日的完整自然周`
      }
    }
    return { value: text, error: null }
  }

  if (spec.type === 'url') {
    const url = normalizeUrl(value)
    if (url === null) return { value, error: `${label}必须是有效链接（http/https）` }
    if (url.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    return { value: url, error: null }
  }

  if (spec.type === 'number' || spec.type === 'int') {
    // 占位写法（/ - -- 无 空 暂无 等）：必填字段按 0，非必填字段按 null（不报错）
    if (isEmptyNumberToken(value)) {
      return spec.required ? { value: 0, error: null } : { value: undefined, error: null }
    }
    const num = spec.type === 'int' ? parseIntCell(value) : parseNumber(value)
    if (num === null || num < 0) {
      // 无法解析的数值：非必填字段按 null 处理且不报错；必填字段仍提示格式错误
      if (!spec.required) return { value: undefined, error: null }
      return {
        value,
        error:
          spec.type === 'int'
            ? `${label}必须为非负整数（支持 x.x万 写法）`
            : `${label}必须为非负数字（自动识别货币符号/千分位）`
      }
    }
    return { value: num, error: null }
  }

  if (spec.type === 'date') {
    const text = String(value).trim()
    if (!DATE_RE.test(text)) return { value, error: `${label}格式必须为 YYYY-MM-DD` }
    return { value: text, error: null }
  }

  if (spec.type === 'string') {
    const text = String(value).trim()
    if (text.length > spec.max) return { value, error: `${label}长度不能超过 ${spec.max}` }
    return { value: text, error: null }
  }

  return { value, error: null }
}

/**
 * 展开合并单元格：把每个合并区域左上角的值回填到该区域覆盖的所有行
 * （sheet_to_json 默认只读取合并区域的左上角单元格，其余覆盖行为空）
 * @param {Object} sheet 工作表对象
 * @param {Array<Object>} rawRows sheet_to_json 解析出的原始行（第 1 行为表头，数据从下标 0 开始）
 */
function expandMergedCells(sheet, rawRows) {
  const merges = sheet['!merges']
  if (!Array.isArray(merges) || merges.length === 0) return

  // 表头行（第 1 行）：列号 -> 表头名
  const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || []).map((cell) =>
    cell === undefined || cell === null ? '' : String(cell).trim()
  )

  for (const merge of merges) {
    const { s, e } = merge
    const headerName = headerRow[s.c]
    if (!headerName) continue // 无法映射列名的合并区域跳过

    const cell = sheet[XLSX.utils.encode_cell({ r: s.r, c: s.c })]
    if (!cell || cell.v === undefined || cell.v === null) continue
    const rawValue = cell.w !== undefined ? cell.w : cell.v
    const text = String(rawValue)

    // 场景一：合并单元格内换行多值（视觉上每行一个值）
    // 按换行拆分 -> 去空行 -> 去首尾空格，依次填充到合并区域每一行：
    // 值不足时剩余行留空（不强行补值），值超出时只取前 N 个（不溢出）
    if (NEWLINE_RE.test(text)) {
      const values = text
        .split(NEWLINE_RE)
        .map((item) => item.trim())
        .filter((item) => item !== '')
      const totalRows = e.r - s.r + 1
      for (let i = 0; i < totalRows; i += 1) {
        const row = rawRows[s.r + i - 1] // sheet 行号 -> 数据行下标（表头行号为 0）
        if (!row) continue
        row[headerName] = i < values.length ? values[i] : undefined
      }
      continue
    }

    // 场景二：合并单元格单值，回填到该区域覆盖的所有行（跳过左上角首行，其本身已有值）
    for (let r = s.r + 1; r <= e.r; r += 1) {
      const row = rawRows[r - 1] // sheet 行号 -> 数据行下标（表头行号为 0）
      if (row) row[headerName] = rawValue
    }
  }
}

/**
 * 解析 Excel 文件并完成字段映射与行级校验
 * @param {File} file 上传的 .xlsx / .xls 文件
 * @param {Array<Object>} [cycles] 后端周期选项（用于月日区间自动识别为周码）
 * @returns {Promise<{
 *   fileName: string,
 *   headers: string[],
 *   mappedFields: string[],
 *   missingFields: string[],
 *   previewRows: Array<Object>,
 *   validRows: Array<Object>,
 *   failedRows: Array<{ rowIndex: number, reason: string }>
 * }>}
 */
export async function parseRecordsExcel(file, cycles = []) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  // 合并单元格展开补值：确保覆盖行都能读到完整值（如合并的时间周期列）
  expandMergedCells(sheet, rawRows)

  // 原始表头（保持首次出现顺序、去重）
  const headers = []
  const seen = new Set()
  for (const row of rawRows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        headers.push(key)
      }
    }
  }

  // 已匹配到的数据库字段（表头 -> 字段名，去重）
  const mappedFields = headers
    .map((h) => HEADER_MAP[h] || (FIELD_RULES[h] ? h : null))
    .filter(Boolean)
  const missingFields = Object.keys(FIELD_RULES).filter(
    (f) => FIELD_RULES[f].required && !mappedFields.includes(f)
  )

  const mappedRows = []
  const validRows = []
  const failedRows = []
  // 自动跳过的空白行（整行无有效值，不进入校验与报错列表）
  const blankRowIndexes = []
  // 本地规则无法识别的时间周期原始值（去重，供 AI 兜底识别）
  const unrecognizedCycles = new Set()

  rawRows.forEach((raw, index) => {
    const rowIndex = index + 2 // Excel 第 1 行为表头，数据从第 2 行开始
    const mapped = { rowIndex }
    let hasValue = false

    for (const header of headers) {
      const field = HEADER_MAP[header] || (FIELD_RULES[header] ? header : null)
      if (!field) continue
      let value = raw[header]
      // 纯空白（空格/制表符）也视为空，避免空白行误报必填错误
      if (value !== undefined && String(value).trim() !== '') hasValue = true
      if (field === 'publish_date') value = normalizeDate(value)
      if (field === 'time_cycle') {
        const rawText = value === undefined || value === null ? '' : String(value).trim()
        value = normalizeTimeCycleValue(value, cycles)
        // 本地无法识别（非标准周码且不满足自然周规则）时收集原始值
        if (rawText && parseTimeCycleToWeekCode(rawText) === null) {
          unrecognizedCycles.add(rawText)
        }
      }
      mapped[field] = value === undefined || value === '' ? undefined : value
    }

    if (!hasValue) {
      // 跳过完全空白的行（计入「跳过」统计，不产生任何报错）
      blankRowIndexes.push(rowIndex)
      return
    }

    // 逐行逐列判定：每个单元格按所属列规则清洗与校验
    const cellErrors = []
    for (const field of Object.keys(FIELD_RULES)) {
      const { value, error } = normalizeCellValue(field, mapped[field])
      mapped[field] = value
      if (error) cellErrors.push({ field, reason: error })
    }

    if (cellErrors.length) {
      failedRows.push({
        rowIndex,
        cellErrors,
        reason: cellErrors.map((e) => e.reason).join('；')
      })
    } else {
      validRows.push(mapped)
    }
    mappedRows.push({ ...mapped, cellErrors })
  })

  return {
    fileName: file.name,
    headers,
    mappedFields,
    missingFields,
    previewRows: mappedRows.slice(0, 5),
    allRows: mappedRows,
    validRows,
    failedRows,
    blankRows: blankRowIndexes.length,
    blankRowIndexes,
    unrecognizedTimeCycles: [...unrecognizedCycles]
  }
}

/**
 * AI 修正值兜底清洗（用户点「一键修正」时使用）：
 * 数值字段统一转为标准数字（兼容 1.2万 / 1,234 / ￥1000 / 1000元 等写法），
 * 时间周期统一转为标准周码；无法解析的字段直接丢弃，避免脏值入库
 * @param {Object} corrected AI 返回的 corrected 对象
 * @returns {Object} 可直接合并进导入行的清洗结果
 */
export function sanitizeCorrectedFields(corrected = {}) {
  const clean = {}
  if (!corrected || typeof corrected !== 'object') return clean

  for (const [key, value] of Object.entries(corrected)) {
    // 时间周期：AI 修正值必须能转成标准周码，否则丢弃（不写入脏值）
    if (key === 'time_cycle') {
      const code = parseTimeCycleToWeekCode(value)
      if (code) clean.time_cycle = code
      continue
    }

    const spec = FIELD_RULES[key]
    // 非本地校验字段（如 platform）原样保留，由后端忽略未知字段
    if (!spec) {
      if (value !== undefined && value !== null && String(value).trim() !== '') clean[key] = value
      continue
    }

    if (spec.type === 'number' || spec.type === 'int') {
      if (isEmptyNumberToken(value) || value === null) {
        clean[key] = spec.required ? 0 : null
        continue
      }
      const num = spec.type === 'int' ? parseIntCell(value) : parseNumber(value)
      if (num !== null && num >= 0) clean[key] = num
      continue
    }

    if (value !== undefined && value !== null && String(value).trim() !== '') {
      clean[key] = value
    }
  }
  return clean
}

/**
 * 应用时间周期映射并重新校验：把识别结果（原始值 -> 标准周码）映射回全部导入数据，
 * 再走一遍本地单元格校验（幂等），供导入流程“确认应用”后继续原有校验流程
 * @param {Object} result parseRecordsExcel 的解析结果
 * @param {Object} mapping { [原始值]: '2026-W33' | null }，null 表示跳过该值对应行
 * @returns {Object} 新的解析结果
 */
export function applyTimeCycleMapping(result, mapping = {}) {
  const rows = Array.isArray(result?.allRows) ? result.allRows : []
  const mappedRows = []
  const validRows = []
  const failedRows = []

  for (const row of rows) {
    const next = { rowIndex: row.rowIndex }
    for (const field of Object.keys(FIELD_RULES)) {
      next[field] = row[field]
    }

    // 应用映射：命中原始值则替换为识别结果（null/空 表示跳过该值）
    if (
      typeof next.time_cycle === 'string' &&
      Object.prototype.hasOwnProperty.call(mapping, next.time_cycle)
    ) {
      next.time_cycle = mapping[next.time_cycle] || undefined
    }

    // 映射后重新做一遍本地校验（保证最终入库仍是标准 YYYY-Wxx）
    const cellErrors = []
    for (const field of Object.keys(FIELD_RULES)) {
      const { value, error } = normalizeCellValue(field, next[field])
      next[field] = value
      if (error) cellErrors.push({ field, reason: error })
    }

    if (cellErrors.length) {
      failedRows.push({
        rowIndex: next.rowIndex,
        cellErrors,
        reason: cellErrors.map((e) => e.reason).join('；')
      })
    } else {
      validRows.push(next)
    }
    mappedRows.push({ ...next, cellErrors })
  }

  return {
    ...result,
    validRows,
    failedRows,
    previewRows: mappedRows.slice(0, 5),
    allRows: mappedRows,
    unrecognizedTimeCycles: []
  }
}

// ---------- 导出 ----------
const EXPORT_COLUMNS = [
  ['时间周期', 'time_cycle'],
  ['达人昵称', 'nickname'],
  ['博主类型', 'creator_type'],
  ['达人主页', 'homepage'],
  ['植入链接', 'content_link'],
  ['视频链接', 'video_link'],
  ['总花费(元)', 'total_cost'],
  ['CPM数据', 'cpm'],
  ['首发播放量', 'first_play'],
  ['次周播放量', 'second_week_play'],
  ['发布日期', 'publish_date']
]

// 展示宽度：中文等宽字符按 2 计
function displayWidth(text) {
  let width = 0
  for (const ch of String(text ?? '')) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1
  }
  return width
}

// 列宽自适应（按内容最长值 + 留白）
function applyColumnWidths(worksheet, rows) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  worksheet['!cols'] = headers.map((header) => {
    let maxLen = displayWidth(header)
    for (const row of rows) {
      maxLen = Math.max(maxLen, displayWidth(row[header]))
    }
    return { wch: Math.min(maxLen + 2, 60) }
  })
}

/**
 * 导出投放记录为 Excel（含表格全部显示列 + CPM数据）
 * @param {Array<Object>} rows 后端字段对象数组
 * @param {string} fileName 文件名
 */
export function exportRecordsToExcel(rows, fileName) {
  const data = rows.map((row) => {
    const cpm = calcCpm(row.total_cost, row.second_week_play)
    const item = {}
    for (const [zhHeader, field] of EXPORT_COLUMNS) {
      let value = row[field]
      if (field === 'time_cycle') {
        // 导出：时间周期显示为月日区间（08/13-08/19）
        value = weekCodeToLabel(value)
      } else if (field === 'total_cost') {
        value = value === undefined || value === null ? '' : Number(value).toFixed(2)
      } else if (field === 'cpm') {
        value = cpm === null ? '-' : cpm.toFixed(2)
      }
      item[zhHeader] = value === undefined || value === null ? '' : value
    }
    return item
  })

  const worksheet = XLSX.utils.json_to_sheet(data)
  applyColumnWidths(worksheet, data)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '投放记录')
  XLSX.writeFile(workbook, fileName)
}

/**
 * 生成导出文件名：达人投放记录_YYYY-MM-DD.xlsx
 */
export function buildExportFileName() {
  return `达人投放记录_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

// ---------- 达人汇总 / 达人对比 导出 ----------

/**
 * 生成达人汇总导出文件名：达人汇总明细_YYYY-MM-DD.xlsx
 */
export function buildCreatorSummaryFileName() {
  return `达人汇总明细_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 生成达人对比导出文件名：达人对比_YYYY-MM-DD.xlsx
 */
export function buildCreatorCompareFileName() {
  return `达人对比_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 导出达人维度统计（达人汇总明细 / 达人对比共用）
 * 列：博主类型、达人昵称、投放次数、总花费(元)、总播放、平均CPM、爆款数、平均单条播放、复投次数
 * @param {Array<Object>} creators 达人统计数组
 * @param {{ fileName?: string, sheetName?: string }} [options]
 * @returns {number} 导出行数
 */
export function exportCreatorStatsToExcel(creators = [], options = {}) {
  const list = Array.isArray(creators) ? creators : []
  const fileName = options.fileName || buildCreatorSummaryFileName()
  const sheetName = options.sheetName || '达人汇总'
  const data = list.map((item) => ({
    博主类型: item.creator_type || '未分类',
    达人昵称: item.nickname || '未命名达人',
    投放次数: Number(item.total_campaigns) || 0,
    总花费: (Number(item.total_cost) || 0).toFixed(2),
    总播放: Number(item.total_play) || 0,
    平均CPM: item.avg_cpm === null || item.avg_cpm === undefined ? '-' : Number(item.avg_cpm).toFixed(2),
    爆款数: Number(item.hit_count) || 0,
    平均单条播放:
      item.avg_play === null || item.avg_play === undefined ? '-' : Number(item.avg_play).toFixed(1),
    复投次数: Number(item.repeat_count) || 0
  }))
  const sheetRows = data.length ? data : [{
    博主类型: '',
    达人昵称: '',
    投放次数: '',
    总花费: '',
    总播放: '',
    平均CPM: '',
    爆款数: '',
    平均单条播放: '',
    复投次数: '暂无数据'
  }]

  const worksheet = XLSX.utils.json_to_sheet(sheetRows, {
    header: ['博主类型', '达人昵称', '投放次数', '总花费', '总播放', '平均CPM', '爆款数', '平均单条播放', '复投次数']
  })
  applyColumnWidths(worksheet, sheetRows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
  XLSX.writeFile(workbook, fileName)
  return data.length
}

// ---------- 导入失败明细导出 ----------
// 明细列：行号 / 错误字段 / 原始值 / 错误原因 / AI识别备注
const FAILED_DETAIL_COLUMNS = ['行号', '错误字段', '原始值', '错误原因', 'AI识别备注']

/**
 * 生成失败明细文件名：导入失败明细_YYYY-MM-DD.xlsx
 */
export function buildFailedRowsFileName() {
  return `导入失败明细_${dayjs().format('YYYY-MM-DD')}.xlsx`
}

/**
 * 失败行 -> 明细数据行（一个单元格错误一行，便于逐条排查）
 * @param {Array<Object>} failedRows 解析结果中的失败行（含 cellErrors / reason）
 * @param {Array<Object>} rows 全部解析行（用于回填「原始值」，可选）
 * @param {Object} [options] 附加信息
 * @param {Object} [options.aiNotes] AI 识别备注：{ [rowIndex]: string } 或 { [原始值]: string }
 * @returns {Array<Object>} 明细数据（列：行号、错误字段、原始值、错误原因、AI识别备注）
 */
export function buildFailedDetailRows(failedRows = [], rows = [], options = {}) {
  const rowMap = new Map(
    (Array.isArray(rows) ? rows : []).map((row) => [row.rowIndex, row])
  )
  const aiNotes = options.aiNotes && typeof options.aiNotes === 'object' ? options.aiNotes : {}
  const detailRows = []

  for (const item of Array.isArray(failedRows) ? failedRows : []) {
    const row = rowMap.get(item.rowIndex)
    const errors =
      Array.isArray(item.cellErrors) && item.cellErrors.length > 0
        ? item.cellErrors
        : [{ field: '', reason: item.reason || '无效数据' }]

    for (const error of errors) {
      const field = error.field || ''
      const raw = row && field ? row[field] : undefined
      // AI 识别备注：优先按行号取，其次按原始单元格内容取
      const rawText =
        raw === undefined || raw === null || String(raw).trim() === '' ? '' : String(raw)
      const aiNote = aiNotes[item.rowIndex] || (rawText ? aiNotes[rawText] : '') || ''
      detailRows.push({
        行号: item.rowIndex,
        错误字段: FIELD_LABELS[field] || field || '-',
        原始值: rawText === '' ? '（空）' : rawText,
        错误原因: error.reason || item.reason || '无效数据',
        AI识别备注: aiNote
      })
    }
  }
  return detailRows
}

/**
 * 导出导入失败明细为 Excel（行号 / 错误字段 / 原始值 / 错误原因）
 * @param {Array<Object>} failedRows 失败行（含 cellErrors / reason），或已整理好的明细行
 * @param {string} [fileName] 文件名，默认「导入失败明细_YYYY-MM-DD.xlsx」
 * @param {Array<Object>} [rows] 全部解析行，用于回填原始值（失败行已是明细时可不传）
 * @param {Object} [options] 附加信息（aiNotes：AI 识别备注，按行号或原始值索引）
 */
export function exportFailedRowsToExcel(
  failedRows = [],
  fileName = buildFailedRowsFileName(),
  rows = [],
  options = {}
) {
  const source = Array.isArray(failedRows) ? failedRows : []
  const isDetail = source.every(
    (item) => item && Object.prototype.hasOwnProperty.call(item, '错误原因')
  )
  const data = isDetail ? source : buildFailedDetailRows(source, rows, options)
  const sheetRows = data.length
    ? data
    : [{ 行号: '', 错误字段: '', 原始值: '', 错误原因: '无失败数据', AI识别备注: '' }]

  const worksheet = XLSX.utils.json_to_sheet(sheetRows, { header: FAILED_DETAIL_COLUMNS })
  applyColumnWidths(worksheet, sheetRows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '失败明细')
  XLSX.writeFile(workbook, fileName)
  return data.length
}
