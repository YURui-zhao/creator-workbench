import request from '../utils/request.js'
import { getAiConfig } from '../utils/aiConfig.js'

// 业务调用才携带当前页面 Key；状态查询只需要服务商和模型。
function buildAiHeaders(includeKey = true) {
  const config = getAiConfig()
  const headers = {}
  if (config?.provider) headers['x-ai-provider'] = config.provider
  if (config?.model) headers['x-ai-model'] = config.model
  if (includeKey && config?.apiKey) headers['x-ai-api-key'] = config.apiKey
  return headers
}

/**
 * DeepSeek AI 智能校验
 * 入参：{ records: Array, rules?: Array<string> }（records 为投放记录数组；
 * rules 为可选规则：规则库标识或自然语言自定义条件）
 * 返回：{ code: 200, data: [{ index, pass, level, issues, suggestions, corrected }], msg }
 */
export function validateRecordsAI(records, rules = []) {
  // 批量 AI 判定耗时较长，超时与后端（60s）对齐，避免提前中断
  return request.post(
    '/ai/validate-records',
    { records, rules },
    { timeout: 60000, headers: buildAiHeaders() }
  )
}

/**
 * 查询后端环境变量配置状态；不发送浏览器当前页面的 Key。
 */
export function getAiStatus() {
  return request.get('/ai/status', { headers: buildAiHeaders(false) })
}

/**
 * 时间周期智能识别（AI 兜底）
 * 入参：values 原始值数组（最多 50 个，后端自动去重）
 * 返回：{ code, data: [{ value, weekCode }], msg }（weekCode 为 null 表示无法识别）
 */
export function normalizeTimeCyclesAI(values) {
  return request.post(
    '/ai/normalize-time-cycles',
    { values },
    { timeout: 60000, headers: buildAiHeaders() }
  )
}

/**
 * 未识别表头的字段映射建议（AI 增强，非导入前置依赖）
 * 入参：columns = [{ header, samples }]（最多 30 列，后端只发送表头与前几个样例值）
 * 返回：{ code, data: { suggestions: [{ source_header, suggested_field, confidence, reason }] }, msg }
 * 说明：suggested_field 一定落在后端白名单内；结果仅供用户在导入弹窗确认，不直接决定入库字段。
 */
export function suggestFieldMappingsAI(columns) {
  return request.post(
    '/ai/suggest-field-mappings',
    { columns },
    { timeout: 60000, headers: buildAiHeaders() }
  )
}
