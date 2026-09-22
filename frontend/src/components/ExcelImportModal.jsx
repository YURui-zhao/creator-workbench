import { useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Divider,
  Input,
  List,
  Modal,
  Row,
  Space,
  Spin,
  Statistic,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { batchCreateRecords, fetchAllRecords, getCycles } from '../api/records'
import { normalizeTimeCyclesAI, validateRecordsAI } from '../api/ai'
import { getAiConfig } from '../utils/aiConfig.js'
import { getErrorMessage } from '../utils/request.js'
import {
  applyTimeCycleMapping,
  FIELD_LABELS,
  dedupeImportRows,
  exportFailedRowsToExcel,
  parseRecordsExcel,
  sanitizeCorrectedFields,
  weekCodeToLabel,
  buildFailedRowsFileName
} from '../utils/excel'
import { explainTimeCycle, parseTimeCycleToWeekCode } from '../utils/dateCycle.js'

const { Dragger } = Upload

// AI 校验结果为空/结构异常时的兜底文案（禁止展示空内容）
const AI_RESULT_INVALID_TIP = 'AI校验结果格式异常，请重试'

// 行号兜底：无法解析时显示「未知行」，避免出现「第 行」
function formatRowLabel(rowIndex) {
  const num = Number(rowIndex)
  return Number.isFinite(num) && num > 0 ? `第 ${num} 行` : '未知行'
}

// 结构化问题项 -> 展示用明细（行号 / 字段 / 原始值 / AI输出或失败原因 / 原因 / 建议）
function buildAiDetailRows(record, cycleNotes = {}) {
  const items = [
    ...(record.errors || []).map((entry) => ({ ...entry, level: 'error' })),
    ...(record.warnings || []).map((entry) => ({ ...entry, level: 'warning' }))
  ]
  // 时间周期相关的 AI 识别备注（AI 输出 / AI 识别失败原因），按行号取
  const cycleNote = cycleNotes[record.rowIndex] || ''
  return items.map((entry, index) => {
    const field = entry.field && entry.field !== 'record' ? entry.field : ''
    const raw = field ? record.rawRow?.[field] : undefined
    const correctedValue = field ? record.corrected?.[field] : undefined
    const correctedText =
      correctedValue === undefined || correctedValue === null || correctedValue === ''
        ? ''
        : `${weekCodeToLabel(String(correctedValue))}（${String(correctedValue)}）`
    const aiNote =
      field === 'time_cycle'
        ? cycleNote || (correctedText ? `AI输出：${correctedText}` : '无 AI 识别备注')
        : correctedText
          ? `AI输出：${correctedText}`
          : ''
    return {
      key: `${record.rowIndex ?? 'unknown'}-${index}`,
      rowIndex: Number.isFinite(Number(entry.rowIndex)) ? Number(entry.rowIndex) : record.rowIndex,
      level: entry.level,
      field: field ? FIELD_LABELS[field] || field : '整条记录',
      originalValue: raw === undefined || raw === null || String(raw).trim() === '' ? '（空）' : String(raw),
      aiNote,
      reason: entry.reason || '未说明原因',
      suggestion: entry.suggestion || '暂无建议'
    }
  })
}

// 可勾选的高级判定规则（key 与后端 RULE_LIBRARY 对应）
const RULE_OPTIONS = [
  { label: '达人类型CPM匹配（如美妆CPM不超过50，超限标红提示）', value: 'creator_type_cpm' },
  { label: '时间周期格式（YYYY-Wxx）', value: 'time_cycle_format' },
  { label: '重复数据判定（相同达人 + 相同发布日期）', value: 'duplicate_check' },
  { label: '数据量级合理性（播放量与总花费商业逻辑）', value: 'magnitude_check' },
  { label: '链接平台与博主类型匹配（抖音/小红书/B站等）', value: 'platform_link_match' }
]

// 单元格渲染：无效单元格标红并悬浮显示原因
function renderCell(field) {
  return (value, record) => {
    const error = record.cellErrors?.find((item) => item.field === field)
    if (!error) return value ?? '-'
    return (
      <Tooltip title={error.reason}>
        <span style={{ color: '#ff4d4f', cursor: 'help' }}>{value ?? ''}</span>
      </Tooltip>
    )
  }
}

// 时间周期列：显示月日区间，无效单元格标红
function renderTimeCycle(value, record) {
  const error = record.cellErrors?.find((item) => item.field === 'time_cycle')
  const display = weekCodeToLabel(value)
  if (!error) return display
  return (
    <Tooltip title={error.reason}>
      <span style={{ color: '#ff4d4f', cursor: 'help' }}>{display}</span>
    </Tooltip>
  )
}

// 预览表格列（前 5 条）
const PREVIEW_COLUMNS = [
  { title: '行号', dataIndex: 'rowIndex', width: 70 },
  { title: '时间周期', dataIndex: 'time_cycle', width: 120, ellipsis: true, render: renderTimeCycle },
  { title: '达人昵称', dataIndex: 'nickname', width: 130, ellipsis: true, render: renderCell('nickname') },
  { title: '博主类型', dataIndex: 'creator_type', width: 110, ellipsis: true, render: renderCell('creator_type') },
  { title: '总花费(元)', dataIndex: 'total_cost', width: 100, align: 'right', render: renderCell('total_cost') },
  { title: '发布日期', dataIndex: 'publish_date', width: 110, render: renderCell('publish_date') },
  {
    title: '7日播放量',
    dataIndex: 'first_play',
    width: 110,
    align: 'right',
    render: renderCell('first_play')
  },
  {
    title: '累计播放量',
    dataIndex: 'second_week_play',
    width: 110,
    align: 'right',
    render: renderCell('second_week_play')
  }
]

/**
 * Excel 批量导入弹窗（DeepSeek 智能判定版）
 * 流程：上传文件 → AI校验 → 确认导入
 */
export default function ExcelImportModal({ open, onCancel, onSuccess }) {
  const navigate = useNavigate()
  // 步骤：0 上传文件 / 1 AI校验 / 2 确认导入
  const [step, setStep] = useState(0)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  // 批量导入失败信息（保留在弹窗内，便于重试）
  const [importError, setImportError] = useState('')
  // 解析结果（含本地校验）
  const [preview, setPreview] = useState(null)
  // AI 判定结果
  const [aiResults, setAiResults] = useState([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  // AI 返回结构异常（无法解析出任何有效条目）时置位，界面给出重试提示而不是空白
  const [aiFormatError, setAiFormatError] = useState(false)
  // 原始数据与修正后数据：importRows 始终为「当前待导入数据」
  const [importRows, setImportRows] = useState([])
  const [fixedIndexes, setFixedIndexes] = useState(() => new Set())
  // 高级规则配置
  const [selectedRules, setSelectedRules] = useState([])
  const [customRules, setCustomRules] = useState('')
  // 时间周期智能识别（本地规则无法识别时的 AI 兜底）
  const [cycleReview, setCycleReview] = useState(null)
  // 时间周期 AI 识别备注（按 Excel 行号索引）：AI 输出 / AI 识别失败原因，用于界面展示与失败明细导出
  const [cycleNotes, setCycleNotes] = useState({})
  // 去重阶段剔除的行（行号 + 原因）：应用时间周期映射后需要继续保持排除
  const excludedRowsRef = useRef([])
  // 重复行明细（与库中已有记录重复 / 文件内重复），用于统计与明细展示
  const [duplicateRows, setDuplicateRows] = useState([])
  // 时间周期识别面板中手动「跳过该行」的行号，计入「跳过」统计
  const [skippedRowIndexes, setSkippedRowIndexes] = useState([])

  // AI 结果按 Excel 行号索引（与本地校验行号口径一致）
  const aiMap = useMemo(() => new Map(aiResults.map((r) => [r.rowIndex, r])), [aiResults])

  // 统计：共 / 通过 / 警告 / 错误
  const stats = useMemo(() => {
    const s = { total: aiResults.length, pass: 0, warning: 0, error: 0 }
    for (const r of aiResults) {
      if (r.level === 'error') s.error += 1
      else if (r.level === 'warning') s.warning += 1
      else s.pass += 1
    }
    return s
  }, [aiResults])

  // 尚未修正的错误行（存在错误时禁止直接导入）
  const unfixedErrors = useMemo(
    () => aiResults.filter((r) => r.level === 'error' && !fixedIndexes.has(r.rowIndex)),
    [aiResults, fixedIndexes]
  )

  const hasCorrections = aiResults.some(
    (r) => r.corrected && typeof r.corrected === 'object' && Object.keys(r.corrected).length > 0
  )

  // ---------- 导入结果统计（成功 / 失败 / 跳过 / 重复，基于解析结果计算） ----------
  const duplicateIndexes = useMemo(
    () => new Set(duplicateRows.map((item) => item.rowIndex)),
    [duplicateRows]
  )
  const skippedIndexes = useMemo(() => new Set(skippedRowIndexes), [skippedRowIndexes])
  // 失败明细：排除重复行与手动跳过的行（各自单独统计，避免重复计数）
  const failedRows = useMemo(
    () =>
      (preview?.failedRows || []).filter(
        (item) => !duplicateIndexes.has(item.rowIndex) && !skippedIndexes.has(item.rowIndex)
      ),
    [preview, duplicateIndexes, skippedIndexes]
  )
  const importStats = useMemo(
    () => ({
      成功: importRows.length,
      失败: failedRows.length,
      跳过: (preview?.blankRows || 0) + skippedRowIndexes.length,
      重复: duplicateRows.length
    }),
    [importRows.length, failedRows.length, preview, skippedRowIndexes.length, duplicateRows.length]
  )
  const blankRowIndexes = preview?.blankRowIndexes || []

  // AI 校验错误行（未修正）：不拦截警告，仅错误行跳过入库
  const aiErrorRowIndexes = useMemo(
    () => new Set(unfixedErrors.map((item) => item.rowIndex)),
    [unfixedErrors]
  )
  const importableRows = useMemo(
    () => importRows.filter((row) => !aiErrorRowIndexes.has(row.rowIndex)),
    [importRows, aiErrorRowIndexes]
  )
  const skippedByAiIndexes = useMemo(
    () => importRows.filter((row) => aiErrorRowIndexes.has(row.rowIndex)).map((row) => row.rowIndex),
    [importRows, aiErrorRowIndexes]
  )

  // 下载失败明细（行号 / 错误字段 / 原始值 / 错误原因），无失败数据时给出提示
  const handleDownloadFailedRows = () => {
    if (!failedRows.length) {
      message.info('当前没有失败数据')
      return
    }
    const count = exportFailedRowsToExcel(
      failedRows,
      buildFailedRowsFileName(),
      preview?.allRows || [],
      // 失败明细附加【AI识别备注】列（按行号索引）
      { aiNotes: cycleNotes }
    )
    message.success(`已导出 ${count} 条失败明细`)
  }

  // 忙碌状态：解析/AI校验/导入中禁止关闭，避免异步回调写入已重置的状态
  const busy = parsing || importing || aiLoading

  // 重置并回到上传步骤
  const resetUpload = () => {
    setStep(0)
    setPreview(null)
    setAiResults([])
    setAiError('')
    setAiFormatError(false)
    setImportError('')
    setCycleReview(null)
    setCycleNotes({})
    setImportRows([])
    setFixedIndexes(new Set())
    setDuplicateRows([])
    setSkippedRowIndexes([])
    excludedRowsRef.current = []
    setParsing(false)
    setImporting(false)
  }

  const closeModal = () => {
    if (busy) return
    resetUpload()
    onCancel()
  }

  // ---------- 调用 AI 校验 ----------
  /**
   * AI 返回结果 -> 弹窗展示结构
   * 行号统一取 rowIndex（缺省回退 index），解析不出时置 null（界面显示「未知行」）；
   * warnings/errors 统一成 {field, reason, suggestion} 结构，便于逐条展示
   */
  const normalizeAiResults = (list, rows) => {
    const rowMap = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.rowIndex, row]))
    const pickList = (source, level, fallbackRowIndex) =>
      (Array.isArray(source) ? source : [])
        .map((entry) => {
          if (entry === null || entry === undefined) return null
          if (typeof entry === 'string') {
            const reason = entry.trim()
            return reason
              ? { field: '', reason, suggestion: '', level, rowIndex: fallbackRowIndex }
              : null
          }
          if (typeof entry !== 'object') return null
          const reason = String(entry.reason ?? entry.issue ?? entry.message ?? '').trim()
          const suggestion = String(entry.suggestion ?? entry.suggest ?? entry.advice ?? '').trim()
          const field = String(entry.field ?? entry.column ?? '').trim()
          const entryIndex = Number(entry.rowIndex)
          if (!reason && !suggestion) return null
          return {
            field,
            reason,
            suggestion,
            level,
            rowIndex: Number.isFinite(entryIndex) && entryIndex > 0 ? entryIndex : fallbackRowIndex
          }
        })
        .filter(Boolean)

    return (Array.isArray(list) ? list : []).map((item) => {
      const rawIndex = item?.rowIndex ?? item?.index
      const num = Number(rawIndex)
      const rowIndex = Number.isFinite(num) && num > 0 ? num : null
      const errors = pickList(item?.errors, 'error', rowIndex)
      const warnings = pickList(item?.warnings, 'warning', rowIndex)
      const level =
        item?.level === 'error' || item?.level === 'warning' || item?.level === 'info'
          ? item.level
          : errors.length
            ? 'error'
            : 'warning'
      return {
        rowIndex,
        level,
        pass: Boolean(item?.pass),
        issues: Array.isArray(item?.issues) ? item.issues : [],
        suggestions: Array.isArray(item?.suggestions) ? item.suggestions : [],
        warnings,
        errors,
        corrected: item?.corrected && typeof item.corrected === 'object' ? item.corrected : null,
        rawRow: rowMap.get(rowIndex)
      }
    })
  }

  const runAiValidation = async (rows) => {
    setAiLoading(true)
    setAiError('')
    setAiFormatError(false)
    try {
      // 未在右上角配置 API 密钥时：明确提示并跳过，不发起任何 AI 接口请求
      const config = getAiConfig()
      if (!config?.apiKey) {
        const tip = '请先在右上角配置API密钥'
        setAiError(tip)
        message.warning(tip)
        setStep(2)
        return
      }

      // 组装规则：勾选的规则标识 + 自定义自然语言条件（每行一条）
      const rules = [
        ...selectedRules,
        ...customRules
          .split('\n')
          .map((text) => text.trim())
          .filter(Boolean)
      ]
      const res = await validateRecordsAI(rows, rules)
      const items = normalizeAiResults(res.data, rows)
      if (!items.length) {
        // 结构异常（不是数组 / 空数组）：不展示空列表，给出明确重试提示
        setAiResults([])
        setAiFormatError(true)
        setStep(2)
        return
      }
      setAiResults(items)
      setStep(2)
    } catch (err) {
      // AI 调用失败自动降级为普通导入，不阻塞基础功能
      // 错误信息优先后端返回的 msg（如密钥无效、请求过于频繁），避免只显示 500/502
      setAiError(getErrorMessage(err, 'AI校验失败，将跳过智能判定'))
      setStep(2)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- 时间周期智能识别（AI 兜底 + 本地二次校验） ----------
  // 构造识别面板初始数据（需要识别的时间周期原始值）
  const buildCycleReview = (values) => ({
    values,
    results: values.map((value) => ({ value, weekCode: '', skipped: false })),
    loading: false,
    error: '',
    notice: '',
    autoRunning: false
  })

  // 识别结果 -> 原始值映射（跳过 / 识别失败均映射为 null，对应行按原规则判失败）
  const buildCycleMapping = (review) => {
    const mapping = {}
    for (const item of review.results) {
      mapping[item.value] = item.skipped ? null : parseTimeCycleToWeekCode(item.weekCode) || null
    }
    return mapping
  }

  // 面板中手动「跳过该行」的原始值 -> 命中这些值的行号（计入「跳过」统计）
  const collectSkippedRowIndexes = (rows, review) => {
    const skippedValues = (review?.results || []).filter((item) => item.skipped).map((item) => item.value)
    if (!skippedValues.length) return []
    const skippedSet = new Set(skippedValues)
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => skippedSet.has(row.time_cycle))
      .map((row) => row.rowIndex)
  }

  /**
   * 时间周期识别结果 -> 按 Excel 行号索引的备注（AI 输出 / AI 识别失败原因 / 手动跳过）
   * 用于 AI 校验区展示「原始内容 + AI 输出/失败原因」，以及失败明细导出的【AI识别备注】列
   */
  const buildCycleNotes = (rows, review) => {
    const notes = {}
    const rowList = Array.isArray(rows) ? rows : []
    for (const item of review?.results || []) {
      const note = item.skipped
        ? '用户手动跳过该行'
        : item.weekCode
          ? item.aiNote || `已识别为 ${item.weekCode}`
          : item.aiNote || '未能识别为完整自然周'
      for (const row of rowList) {
        if (row.time_cycle === item.value) notes[row.rowIndex] = note
      }
    }
    return notes
  }

  const updateCycleResult = (index, patch) => {
    setCycleReview((prev) =>
      prev
        ? {
            ...prev,
            results: prev.results.map((item, i) => (i === index ? { ...item, ...patch } : item))
          }
        : prev
    )
  }

  /**
   * 调用 AI 识别时间周期（显式传入 review，避免自动流程读到过期的 state）
   * 未配置密钥 / 接口失败时返回带 error 的 review，由调用方决定后续流程
   */
  const requestCycleRecognition = async (review) => {
    // 未配置密钥：明确提示，不发起 AI 请求
    const config = getAiConfig()
    if (!config?.apiKey) {
      const tip = '请先在右上角配置 API 密钥'
      message.warning(tip)
      return { ...review, loading: false, error: tip }
    }
    try {
      const res = await normalizeTimeCyclesAI(review.values)
      // 后端返回 { value, weekCode, error }：error 为 AI 给出的具体失败原因（如 ERROR:xxx）
      const resultMap = new Map((res.data || []).map((item) => [item.value, item]))
      return {
        ...review,
        loading: false,
        error: '',
        // AI 结果统一经本地二次校验（explainTimeCycle）：非完整自然周一律拦截，不提交后端
        results: review.results.map((item) => {
          if (item.skipped) return item
          const found = resultMap.get(item.value) || {}
          const aiOutput = String(found.weekCode || '').trim()
          const aiError = String(found.error || '').trim()
          if (!aiOutput) {
            return {
              ...item,
              weekCode: '',
              aiNote: `AI识别失败：${aiError || '未返回识别结果'}`
            }
          }
          const { weekCode, reason } = explainTimeCycle(aiOutput)
          if (!weekCode) {
            return {
              ...item,
              weekCode: '',
              aiNote: `AI识别失败：${aiError || reason}（AI输出：${aiOutput}）`
            }
          }
          return { ...item, weekCode, aiNote: `AI输出：${aiOutput}（${weekCode}）` }
        })
      }
    } catch (err) {
      return { ...review, loading: false, error: getErrorMessage(err) }
    }
  }

  const handleCycleAiRecognize = async () => {
    if (!cycleReview) return
    setCycleReview((prev) =>
      prev ? { ...prev, loading: true, error: '', notice: '' } : prev
    )
    const recognized = await requestCycleRecognition(cycleReview)
    setCycleReview(recognized)
  }

  // 继续原有校验流程（应用映射后 / 跳过识别时）
  const continueAfterCycleReview = async (updatedResult) => {
    setCycleReview(null)
    setStep(1)
    if (updatedResult.validRows.length) {
      await runAiValidation(updatedResult.validRows)
    } else {
      setStep(2)
    }
  }

  /**
   * applyTimeCycleMapping 会基于 allRows 重新计算有效行，
   * 这里把去重阶段剔除的重复行重新排除，避免重复数据被放行
   */
  const reapplyDedupeExclusion = (result) => {
    const excluded = excludedRowsRef.current
    if (!excluded.length) return result
    const excludedIndexes = new Set(excluded.map((item) => item.rowIndex))
    const validRows = result.validRows.filter((row) => !excludedIndexes.has(row.rowIndex))
    const failedRows = []
    const seen = new Set()
    for (const item of [...result.failedRows, ...excluded]) {
      if (seen.has(item.rowIndex)) continue
      seen.add(item.rowIndex)
      failedRows.push(item)
    }
    return { ...result, validRows, failedRows }
  }

  const applyCycleMapping = async () => {
    if (!cycleReview || !preview) return
    // 手动跳过的行单独统计（不重复计入「失败」）
    setSkippedRowIndexes(collectSkippedRowIndexes(preview.allRows, cycleReview))
    // 记录每行的 AI 识别备注，供 AI 校验区与失败明细导出使用
    setCycleNotes(buildCycleNotes(preview.allRows, cycleReview))
    const updated = reapplyDedupeExclusion(
      applyTimeCycleMapping(preview, buildCycleMapping(cycleReview))
    )
    setPreview(updated)
    setImportRows(updated.validRows.map((row) => ({ ...row })))
    await continueAfterCycleReview(updated)
  }

  const skipCycleRecognition = async () => {
    if (!preview) return
    // 不应用识别结果：未识别值对应行按原有校验规则失败并被跳过
    await continueAfterCycleReview(preview)
  }

  // ---------- 上传 -> 解析 -> 本地校验/去重 -> AI 校验 ----------
  const handleFile = async (file) => {
    setParsing(true)
    try {
      // 获取周期选项：导入时「08/13-08/19」自动识别为对应 weekCode
      let cycles = []
      try {
        const cyclesRes = await getCycles()
        cycles = cyclesRes.data
      } catch {
        // 周期选项获取失败不影响解析，走兜底换算
      }
      const result = await parseRecordsExcel(file, cycles)
      // 自动判定无效数据：与库中已有记录重复、文件内重复的行剔除
      excludedRowsRef.current = []
      setDuplicateRows([])
      setSkippedRowIndexes([])
      try {
        const existing = await fetchAllRecords()
        const { uniqueRows, duplicateRows } = dedupeImportRows(result.validRows, existing)
        result.validRows = uniqueRows
        result.failedRows = [...result.failedRows, ...duplicateRows]
        excludedRowsRef.current = duplicateRows
        setDuplicateRows(duplicateRows)
      } catch {
        // 拉取已有记录失败时跳过去重
      }
      if (!result.validRows.length && !result.failedRows.length) {
        message.warning('文件中没有有效数据')
        return false
      }

      setPreview(result)
      // 本地维护原始数据与修正后数据（importRows 可被一键修正更新）
      setImportRows(result.validRows.map((row) => ({ ...row })))

      // 本地规则无法识别的时间周期：先进入智能识别面板（不直接放行/丢弃）
      const unknownCycles = result.unrecognizedTimeCycles || []
      if (unknownCycles.length > 0) {
        const review = buildCycleReview(unknownCycles)
        setCycleReview(review)
        setStep(1)
        // 已配置密钥：自动触发 AI 识别，识别成功后直接进入 AI 校验（无需手动点按钮）
        if (getAiConfig()?.apiKey) {
          setCycleReview({ ...review, loading: true, autoRunning: true })
          const recognized = await requestCycleRecognition(review)
          // AI 识别结果已过本地二次校验：全部识别成功才自动继续，否则交由用户手动确认
          const allResolved = recognized.results.every(
            (item) => item.skipped || Boolean(parseTimeCycleToWeekCode(item.weekCode))
          )
          if (!recognized.error && allResolved) {
            setCycleNotes(buildCycleNotes(result.allRows, recognized))
            const updated = reapplyDedupeExclusion(
              applyTimeCycleMapping(result, buildCycleMapping(recognized))
            )
            setPreview(updated)
            setImportRows(updated.validRows.map((row) => ({ ...row })))
            await continueAfterCycleReview(updated)
          } else {
            setCycleReview({
              ...recognized,
              autoRunning: false,
              notice: recognized.error
                ? ''
                : '部分时间周期未能自动识别，请手动填写后点击「确认应用」'
            })
          }
        }
        return false
      }

      if (!result.validRows.length) {
        // 没有可导入数据时跳过 AI，直接进入结果页
        setStep(2)
      } else {
        setStep(1)
        await runAiValidation(result.validRows)
      }
    } catch (err) {
      message.error(`文件解析失败：${err.message}`)
    } finally {
      setParsing(false)
    }
    return false // 阻止 antd Upload 自动上传
  }

  // ---------- 一键修正：应用 AI 给出的修正值 ----------
  const applyCorrections = () => {
    const next = importRows.map((row) => {
      const ai = aiMap.get(row.rowIndex)
      if (ai?.corrected && typeof ai.corrected === 'object') {
        // 修正值统一清洗：数值转标准数字、时间周期转标准周码，无法解析的字段丢弃
        return { ...row, ...sanitizeCorrectedFields(ai.corrected) }
      }
      return row
    })
    setImportRows(next)
    const fixed = new Set(fixedIndexes)
    for (const r of aiResults) {
      if (r.corrected && typeof r.corrected === 'object') fixed.add(r.rowIndex)
    }
    setFixedIndexes(fixed)
    message.success('已应用 AI 修正建议，可继续导入')
  }

  // ---------- 确认导入（导入修正后的数据） ----------
  const handleConfirm = async () => {
    // 仅导入「本地校验通过 - AI校验错误」的记录（警告不拦截）
    if (!importableRows.length) return
    setImporting(true)
    setImportError('')
    try {
      const payload = importableRows.map(({ rowIndex, ...rest }) => rest)
      // 导入批次元数据（写入导入历史）：文件名 + 本次成功/失败/跳过/重复统计 + 行级明细
      const batchMeta = {
        fileName: preview?.fileName || '',
        totalCount: payload.length + failedRows.length + duplicateRows.length + importStats.跳过,
        failCount: failedRows.length,
        skipCount: importStats.跳过,
        duplicateCount: duplicateRows.length,
        items: [
          ...failedRows.map((item) => ({
            rowIndex: item.rowIndex,
            status: 'fail',
            reason: item.reason || '本地校验或 AI 校验未通过'
          })),
          ...duplicateRows.map((item) => ({
            rowIndex: item.rowIndex,
            status: 'duplicate',
            reason: item.reason || '与已有记录重复'
          })),
          ...skippedRowIndexes.map((rowIndex) => ({
            rowIndex,
            status: 'skip',
            reason: cycleNotes[rowIndex] || '手动跳过该行'
          }))
        ]
      }
      const res = await batchCreateRecords(payload, batchMeta)
      const batchId = res.data?.batchId
      // 成功提示中提供「查看批次」快捷入口（跳转导入历史并自动展开该批次）
      if (batchId) {
        message.success({
          duration: 6,
          content: (
            <span>
              成功导入 {res.data.count} 条记录
              <a
                style={{ marginLeft: 8 }}
                onClick={() => {
                  onSuccess?.()
                  closeModal()
                  navigate(`/import-history?batchId=${batchId}`)
                }}
              >
                查看批次
              </a>
            </span>
          )
        })
      } else {
        message.success(`成功导入 ${res.data.count} 条记录`)
      }
      if (skippedByAiIndexes.length) {
        message.warning(`${skippedByAiIndexes.length} 条 AI 校验错误记录已跳过`)
      }
      if (failedRows.length) {
        message.warning(`${failedRows.length} 条本地校验失败数据已跳过`)
      }
      onSuccess?.()
      closeModal()
    } catch (err) {
      // 导入失败：保留错误信息与当前数据，便于修正后重试（拦截器同时给出提示）
      setImportError(getErrorMessage(err, '导入失败，请检查数据后重试'))
    } finally {
      setImporting(false)
    }
  }

  // ---------- AI 结果列表项 ----------
  const renderAiItem = (item) => {
    const row = item.rawRow || importRows.find((r) => r.rowIndex === item.rowIndex)
    const levelTag =
      item.level === 'error' ? (
        <Tag color="error">错误</Tag>
      ) : item.level === 'warning' ? (
        <Tag color="orange">警告</Tag>
      ) : (
        <Tag color="success">通过</Tag>
      )
    const detailRows = buildAiDetailRows(item, cycleNotes)
    const rowNote = cycleNotes[item.rowIndex] || ''
    return (
      <List.Item style={{ padding: 0 }}>
        <Collapse
          size="small"
          style={{ width: '100%' }}
          items={[
            {
              key: String(item.rowIndex ?? 'unknown'),
              label: (
                <Space size={8} wrap>
                  <Typography.Text strong>{formatRowLabel(item.rowIndex)}</Typography.Text>
                  {row?.nickname && (
                    <Typography.Text type="secondary">{row.nickname}</Typography.Text>
                  )}
                  {levelTag}
                  {detailRows.length > 0 && (
                    <Typography.Text type="secondary">
                      问题 {detailRows.length} 项
                    </Typography.Text>
                  )}
                  {rowNote && (
                    <Typography.Text
                      type={rowNote.startsWith('AI识别失败') ? 'danger' : 'secondary'}
                      style={{ maxWidth: 260 }}
                      ellipsis={{ tooltip: rowNote }}
                    >
                      {rowNote}
                    </Typography.Text>
                  )}
                  {fixedIndexes.has(item.rowIndex) && <Tag color="blue">已修正</Tag>}
                </Space>
              ),
              children: (
                <Space direction="vertical" size="small" style={{ display: 'flex' }}>
                  {/* 结构化问题明细：行号 / 涉及字段 / 原始值 / 原因 / 优化建议 */}
                  {detailRows.length > 0 ? (
                    <Table
                      size="small"
                      rowKey="key"
                      pagination={false}
                      dataSource={detailRows}
                      scroll={{ x: 640 }}
                      columns={[
                        {
                          title: '行号',
                          dataIndex: 'rowIndex',
                          width: 90,
                          render: (value) => formatRowLabel(value)
                        },
                        {
                          title: '级别',
                          dataIndex: 'level',
                          width: 80,
                          render: (value) =>
                            value === 'error' ? (
                              <Tag color="error">错误</Tag>
                            ) : (
                              <Tag color="orange">警告</Tag>
                            )
                        },
                        { title: '涉及字段', dataIndex: 'field', width: 110 },
                        { title: '原始值', dataIndex: 'originalValue', width: 120, ellipsis: true },
                        {
                          title: 'AI输出/识别备注',
                          dataIndex: 'aiNote',
                          width: 200,
                          render: (value) =>
                            value ? (
                              <Typography.Text
                                type={String(value).startsWith('AI识别失败') ? 'danger' : undefined}
                                style={{ fontSize: 12 }}
                              >
                                {value}
                              </Typography.Text>
                            ) : (
                              <Typography.Text type="secondary">—</Typography.Text>
                            )
                        },
                        { title: '原因', dataIndex: 'reason', width: 220 },
                        { title: '优化建议', dataIndex: 'suggestion', width: 220 }
                      ]}
                    />
                  ) : item.issues.length > 0 || item.suggestions.length > 0 ? (
                    // 兼容旧版自由文本返回（无结构化 warnings/errors）
                    <>
                      {item.issues.length > 0 && (
                        <div>
                          <Typography.Text strong>问题描述：</Typography.Text>
                          {item.issues.map((issue, index) => (
                            <div key={`issue-${index}`}>
                              <Typography.Text type="danger">{issue}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      )}
                      {item.suggestions.length > 0 && (
                        <div>
                          <Typography.Text strong>优化建议：</Typography.Text>
                          {item.suggestions.map((suggestion, index) => (
                            <div key={`suggestion-${index}`}>
                              <Typography.Text type="warning">{suggestion}</Typography.Text>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      {item.level === 'info' ? '本行无问题，可直接导入' : AI_RESULT_INVALID_TIP}
                    </Typography.Text>
                  )}
                  {item.corrected && Object.keys(item.corrected).length > 0 && (
                    <div>
                      <Typography.Text strong>AI修正值：</Typography.Text>
                      <Space size={[4, 4]} wrap>
                        {Object.entries(item.corrected).map(([key, value]) => (
                          <Tag key={key} color="blue">
                            {key}: {String(value)}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  )}
                </Space>
              )
            }
          ]}
        />
      </List.Item>
    )
  }

  // ---------- 底部按钮 ----------
  const importLabel =
    stats.warning > 0 && unfixedErrors.length === 0
      ? '忽略警告，直接导入'
      : `确认导入（${importableRows.length} 条）`

  const renderFooter = () => {
    if (!preview) {
      return <Button onClick={closeModal}>关闭</Button>
    }
    if (step === 1 && aiLoading) {
      return <Button disabled>取消</Button>
    }
    if (step === 1 && aiError) {
      return (
        <Space>
          <Button onClick={closeModal}>取消</Button>
          <Button onClick={() => runAiValidation(importRows)}>重试</Button>
          <Button type="primary" onClick={() => setStep(2)}>
            跳过AI，直接导入
          </Button>
        </Space>
      )
    }
    if (step === 2) {
      return (
        <Space>
          <Button onClick={closeModal} disabled={importing}>
            取消
          </Button>
          <Button onClick={resetUpload} disabled={importing}>
            重新上传
          </Button>
          {hasCorrections && (
            <Button onClick={applyCorrections} disabled={importing}>
              一键修正
            </Button>
          )}
          <Button
            type="primary"
            onClick={handleConfirm}
            loading={importing}
            disabled={importableRows.length === 0}
          >
            {importLabel}
          </Button>
        </Space>
      )
    }
    return <Button onClick={closeModal}>关闭</Button>
  }

  return (
    <Modal
      title="导入Excel"
      open={open}
      onCancel={closeModal}
      width={820}
      footer={renderFooter()}
    >
      {/* 步骤条 */}
      <Steps
        current={step}
        size="small"
        items={[{ title: '上传文件' }, { title: 'AI校验' }, { title: '确认导入' }]}
        style={{ marginBottom: 16 }}
      />

      {/* 步骤1：上传文件 */}
      {step === 0 && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Spin spinning={parsing} tip="正在解析文件...">
            <Dragger
              accept=".xlsx,.xls"
              multiple={false}
              showUploadList={false}
              beforeUpload={handleFile}
              disabled={parsing}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处上传</p>
              <p className="ant-upload-hint">
                仅支持 .xlsx / .xls，上传后自动解析并调用 AI 逐条校验
              </p>
            </Dragger>
          </Spin>

          {/* 高级规则配置 */}
          <Collapse
            items={[
              {
                key: 'advanced-rules',
                label: '高级规则（可选）',
                children: (
                  <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
                    <Checkbox.Group
                      options={RULE_OPTIONS}
                      value={selectedRules}
                      onChange={(values) => setSelectedRules(values)}
                    />
                    <div>
                      <Typography.Text type="secondary">
                        自定义判定条件（自然语言，每行一条，随请求发送给 AI）：
                      </Typography.Text>
                      <Input.TextArea
                        rows={3}
                        placeholder={'例如：美妆类达人CPM不应超过50，超过则标红提示\n例如：总花费超过10万的记录需要重点审核\n例如：播放量低于1000的疑似无效投放'}
                        value={customRules}
                        onChange={(e) => setCustomRules(e.target.value)}
                        style={{ marginTop: 4 }}
                      />
                    </div>
                  </Space>
                )
              }
            ]}
          />
        </Space>
      )}

      {/* 步骤2：时间周期智能识别（本地规则无法识别时） */}
      {step === 1 && cycleReview && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message={
              cycleReview.loading && cycleReview.autoRunning
                ? `检测到 ${cycleReview.values.length} 种无法识别的时间周期，正在自动调用 AI 识别…`
                : `检测到 ${cycleReview.values.length} 种无法识别的时间周期，可点击 AI 智能识别自动整理`
            }
          />
          <Space wrap>
            <Button
              type="primary"
              loading={cycleReview.loading}
              onClick={handleCycleAiRecognize}
            >
              AI 智能识别
            </Button>
            <Button onClick={skipCycleRecognition} disabled={cycleReview.loading}>
              跳过识别，继续导入
            </Button>
          </Space>
          {cycleReview.error && <Alert type="error" showIcon message={cycleReview.error} />}
          {cycleReview.notice && <Alert type="warning" showIcon message={cycleReview.notice} />}
          <Table
            size="small"
            rowKey="value"
            pagination={false}
            dataSource={cycleReview.results}
            scroll={{ y: 260 }}
            columns={[
              { title: '原始单元格内容', dataIndex: 'value', width: 180, ellipsis: true },
              {
                title: 'AI识别备注（输出/失败原因）',
                dataIndex: 'aiNote',
                width: 260,
                render: (value, record) => {
                  const note = value || (record.loading ? '识别中…' : '')
                  if (!note) return <Typography.Text type="secondary">—</Typography.Text>
                  const isError = String(note).startsWith('AI识别失败')
                  return (
                    <Typography.Text type={isError ? 'danger' : 'secondary'}>
                      {note}
                    </Typography.Text>
                  )
                }
              },
              {
                title: '识别结果（可手动修改）',
                dataIndex: 'weekCode',
                render: (value, record, index) => {
                  const typed = String(value || '').trim()
                  const invalid = !record.skipped && typed !== '' && !parseTimeCycleToWeekCode(typed)
                  // 未填写或填写非法时给出具体原因（区分空值 / 非自然周 / 写法无法识别）
                  const reason = !record.skipped && !typed && !record.loading
                    ? record.aiNote || '请手动填写标准周码，如 2026-W33'
                    : invalid
                      ? explainTimeCycle(typed).reason
                      : ''
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Input
                        value={value}
                        placeholder="如 2026-W33"
                        disabled={record.skipped}
                        status={invalid ? 'error' : undefined}
                        onChange={(e) => updateCycleResult(index, { weekCode: e.target.value })}
                      />
                      {reason && <Typography.Text type="danger">{reason}</Typography.Text>}
                    </Space>
                  )
                }
              },
              {
                title: '跳过该行',
                dataIndex: 'skipped',
                width: 100,
                render: (checked, _record, index) => (
                  <Checkbox
                    checked={checked}
                    onChange={(e) => updateCycleResult(index, { skipped: e.target.checked })}
                  />
                )
              }
            ]}
          />
          <Space>
            <Button type="primary" onClick={applyCycleMapping} disabled={cycleReview.loading}>
              确认应用
            </Button>
          </Space>
        </Space>
      )}

      {/* 步骤2：AI 校验加载中 / 失败重试 */}
      {step === 1 && !cycleReview && aiLoading && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            AI正在判定数据...
          </Typography.Title>
          <Typography.Text type="secondary">
            正在调用 DeepSeek 逐条校验记录（必填/格式/数值/业务逻辑/数据质量），请稍候
          </Typography.Text>
        </div>
      )}

      {/* 步骤3：确认导入（AI 结果 + 修正 + 预览） */}
      {step === 2 && preview && (
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message={`已解析：${preview.fileName}`}
            description={
              <>
                匹配字段：
                {preview.mappedFields.length ? preview.mappedFields.join('、') : '无'}
                {preview.missingFields.length > 0 && (
                  <div style={{ color: '#d46b08' }}>
                缺失必填列（对应行将被判定失败）：{preview.missingFields.join('、')}
                 </div>
               )}
              </>
            }
          />

          {/* ============ 阶段一：本地校验结果（解析 + 本地规则，与 AI 无关） ============ */}
          <Divider orientation="left" style={{ margin: '4px 0' }}>
            <Typography.Text strong>本地校验结果</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontWeight: 'normal' }}>
              （Excel 解析 + 格式/必填/去重规则，AI 未参与）
            </Typography.Text>
          </Divider>

          {/* 本地统计：成功 / 失败 / 跳过 / 重复 */}
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="成功（可入库）"
                  value={importStats.成功}
                  valueStyle={{ color: '#52c41a', fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="失败（将跳过）"
                  value={importStats.失败}
                  valueStyle={{ color: importStats.失败 ? '#ff4d4f' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="跳过（空白/手动）"
                  value={importStats.跳过}
                  valueStyle={{ fontSize: 22 }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
                <Statistic
                  title="重复（将跳过）"
                  value={importStats.重复}
                  valueStyle={{ color: importStats.重复 ? '#faad14' : undefined, fontSize: 22 }}
                />
              </Card>
            </Col>
          </Row>

          {/* 导入失败提示：保留错误信息，便于修正后重试 */}
          {importError && (
            <Alert
              type="error"
              showIcon
              message="导入失败"
              description={importError}
            />
          )}

          {/* 本地失败明细：本地校验不通过的行，可一键下载明细 */}
          {failedRows.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={`失败 ${failedRows.length} 条（导入时将跳过）`}
              action={
                <Button size="small" onClick={handleDownloadFailedRows}>
                  下载失败明细
                </Button>
              }
              description={
                <div style={{ maxHeight: 140, overflow: 'auto' }}>
                  {failedRows.map((item) => (
                    <div key={item.rowIndex}>
                      第 {item.rowIndex} 行：{item.reason}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {/* 重复明细：与库中已有记录重复 / 文件内重复 */}
          {duplicateRows.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`重复 ${duplicateRows.length} 条（导入时将跳过）`}
              description={
                <div style={{ maxHeight: 140, overflow: 'auto' }}>
                  {duplicateRows.map((item) => (
                    <div key={item.rowIndex}>
                      第 {item.rowIndex} 行：{item.reason}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {/* 跳过的行：空白行 + 时间周期识别面板中手动跳过的行 */}
          {importStats.跳过 > 0 && (
            <Alert
              type="info"
              showIcon
              message={`跳过 ${importStats.跳过} 条（空白行 ${preview.blankRows || 0} 条${
                skippedRowIndexes.length ? `，手动跳过 ${skippedRowIndexes.length} 条` : ''
              }）`}
              description={
                skippedRowIndexes.length || blankRowIndexes.length ? (
                  <div style={{ maxHeight: 100, overflow: 'auto' }}>
                    {blankRowIndexes.length > 0 && (
                      <div>空白行：第 {blankRowIndexes.join('、')} 行</div>
                    )}
                    {skippedRowIndexes.length > 0 && (
                      <div>手动跳过：第 {skippedRowIndexes.join('、')} 行</div>
                    )}
                  </div>
                ) : null
              }
            />
          )}

          {/* ============ 阶段二：AI 校验结果（本地校验通过后才执行） ============ */}
          <Divider orientation="left" style={{ margin: '4px 0' }}>
            <Typography.Text strong>AI 校验结果</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontWeight: 'normal' }}>
              （业务风险判定：警告不拦截导入，错误将跳过该行）
            </Typography.Text>
          </Divider>

          {/* 无密钥 / 调用失败：降级提示，不影响基础导入 */}
          {aiError ? (
            <Alert
              type="warning"
              showIcon
              message="AI校验失败，将跳过智能判定"
              description={
                <>
                  {aiError}
                  <div>基础导入功能不受影响，可直接确认导入。</div>
                </>
              }
              action={
                <Button size="small" onClick={() => runAiValidation(importRows)}>
                  重试AI校验
                </Button>
              }
            />
          ) : aiFormatError ? (
            <Alert
              type="error"
              showIcon
              message={AI_RESULT_INVALID_TIP}
              description="未解析到有效的校验条目，请点击重试；你也可以直接确认导入（不拦截基础流程）。"
              action={
                <Button size="small" onClick={() => runAiValidation(importRows)}>
                  重试AI校验
                </Button>
              }
            />
          ) : (
            <>
              {/* AI 校验统计：通过 / 警告 / 错误 */}
              <Space size="middle" wrap>
                <Tag>共 {stats.total} 条</Tag>
                <Tag color="success">通过 {stats.pass} 条</Tag>
                <Tag color="orange">警告 {stats.warning} 条</Tag>
                <Tag color="error">错误 {stats.error} 条</Tag>
              </Space>

              {/* AI 错误行：将跳过入库（可用「一键修正」或手动修正后重新导入） */}
              {unfixedErrors.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  message={`${unfixedErrors.length} 条 AI 校验错误将跳过入库（警告不影响导入）`}
                  description={`错误行：${unfixedErrors
                    .map((r) => formatRowLabel(r.rowIndex))
                    .join('、')}；如需保留请点「一键修正」应用 AI 修正值，或修正后重新导入`}
                />
              )}

              {/* AI 判定结果列表（每条含行号 / 字段 / 原始值 / 原因 / 优化建议） */}
              <List size="small" dataSource={aiResults} renderItem={renderAiItem} />
            </>
          )}

          {/* 修正后数据预览（前 5 条） */}
          <div>
            <Typography.Text strong>修正后数据预览（前 5 条）</Typography.Text>
            <Table
              size="small"
              rowKey="rowIndex"
              columns={PREVIEW_COLUMNS}
              dataSource={importRows.slice(0, 5)}
              pagination={false}
              scroll={{ x: 700 }}
              style={{ marginTop: 8 }}
            />
          </div>
        </Space>
      )}
    </Modal>
  )
}
