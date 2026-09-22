import request from '../utils/request.js'
import { getAiConfig } from '../utils/aiConfig.js'

// 从本地配置读取 AI 请求头：页面配置的 Key/接口地址优先于后端环境变量
function buildAiHeaders() {
  const config = getAiConfig()
  const headers = {}
  if (config?.provider) headers['x-ai-provider'] = config.provider
  if (config?.model) headers['x-ai-model'] = config.model
  if (config?.apiKey) headers['x-ai-api-key'] = config.apiKey
  if (config?.baseUrl) headers['x-ai-base-url'] = config.baseUrl
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
 * 查询 AI 服务状态（是否已配置 DeepSeek API Key）
 * 返回：{ code: 200, data: { available, model, msg }, msg }
 */
export function getAiStatus() {
  return request.get('/ai/status', { headers: buildAiHeaders() })
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
