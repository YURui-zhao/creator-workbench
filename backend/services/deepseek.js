import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------- 服务商配置（默认值可被请求头/环境变量覆盖） ----------
const PROVIDERS = {
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsJsonMode: true // 支持 response_format: json_object
  },
  zhipu: {
    key: 'zhipu',
    label: '智谱 AI',
    baseUrl: process.env.ZHIPU_API_URL || 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    supportsJsonMode: false // 提示词已要求严格 JSON，避免部分模型不支持该参数
  }
}
const DEFAULT_PROVIDER = 'deepseek'
const TIMEOUT = 60000 // AI 批量判定耗时较长，超时放宽到 60s

/** 解析服务商（未知/缺省回退 DeepSeek，向下兼容） */
export function resolveProvider(provider) {
  const key = String(provider ?? '').trim().toLowerCase()
  return PROVIDERS[key] || PROVIDERS[DEFAULT_PROVIDER]
}

/** 服务商列表（供状态接口展示） */
export function listProviders() {
  return Object.values(PROVIDERS).map((item) => ({
    key: item.key,
    label: item.label,
    model: item.model,
    baseUrl: item.baseUrl
  }))
}

// ---------- 只读调用日志（不改变任何调用逻辑） ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(__dirname, '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'ai.log')
let logDirReady = false

// 规范化 Token 用量（无则 null）
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = usage.prompt_tokens ?? usage.promptTokens ?? null
  const completion = usage.completion_tokens ?? usage.completionTokens ?? null
  const total = usage.total_tokens ?? usage.totalTokens ?? null
  if (prompt === null && completion === null && total === null) return null
  return { prompt, completion, total }
}

// 错误摘要（截断 + 脱敏：DeepSeek sk- 形态、智谱 id.secret 形态、上游掩码形态）
function summarizeError(err, mapped) {
  const detail = err?.response?.data?.error?.message || err?.response?.data?.message
  const text = detail || mapped?.message || err?.message || '未知错误'
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]+/gi, 'sk-***')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '***.***')
    .replace(/\*{2,}[A-Za-z0-9_-]*/g, '****')
    .slice(0, 300)
}

/**
 * 写入 AI 调用日志：backend/logs/ai.log，按天追加（每行一条 JSON，含日期字段）
 * 仅记录：时间戳、服务商、模型、HTTP 状态码、耗时(ms)、Token 用量、错误摘要、接口地址
 * 写入失败静默忽略，绝不影响正常请求；不记录任何密钥内容
 */
function writeAiLog({ provider, model, status, durationMs, usage, error, endpoint }) {
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      logDirReady = true
    }
    const now = new Date()
    const entry = {
      time: now.toISOString(),
      day: now.toISOString().slice(0, 10),
      provider,
      model,
      status: status ?? null,
      durationMs,
      endpoint: endpoint || null,
      usage: usage ?? null,
      error: error ?? null
    }
    fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, () => {})
  } catch {
    // 日志失败静默忽略：不影响 AI 调用与业务流程
  }
}

/** AI 相关错误：统一携带友好提示，便于路由层返回 */
export class DeepSeekError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'DeepSeekError'
    this.isDeepSeekError = true
    this.status = status
  }
}

// 占位值视为未配置
function isPlaceholderKey(key) {
  if (!key) return true
  const text = String(key).trim()
  return text === '' || text.includes('替换为你的') || text === 'sk-' || text.length < 8
}

/**
 * 校验指定服务商是否已配置有效 API Key：
 * 优先使用页面传入的 Key（请求头 x-ai-api-key），否则回退该服务商环境变量
 * @param {string} provider 服务商（deepseek / zhipu）
 * @param {string} [requestedKey] 请求头传入的 API Key
 */
export function isProviderConfigured(provider, requestedKey) {
  const info = resolveProvider(provider)
  const key = !isPlaceholderKey(requestedKey) ? requestedKey : process.env[info.apiKeyEnv]
  return !isPlaceholderKey(key)
}

/** 向下兼容：默认检查 DeepSeek 配置 */
export function isDeepSeekConfigured(requestedKey) {
  return isProviderConfigured(DEFAULT_PROVIDER, requestedKey)
}

// 读取 API Key：请求头优先，对应服务商环境变量兜底（禁止硬编码）
function getApiKey(providerKey, requestedKey) {
  const info = resolveProvider(providerKey)
  const key = !isPlaceholderKey(requestedKey) ? requestedKey : process.env[info.apiKeyEnv]
  if (isPlaceholderKey(key)) {
    throw new DeepSeekError(
      `未配置 ${info.label} API Key，请先在页面右上角配置（或设置后端环境变量 ${info.apiKeyEnv}）`,
      400
    )
  }
  return key
}

// 接口地址拼接：baseUrl + /chat/completions，兼容传入完整地址
function buildEndpoint(baseUrl, defaultBaseUrl) {
  const raw = (baseUrl && /^https?:\/\//i.test(baseUrl) ? baseUrl : defaultBaseUrl).replace(
    /\/+$/,
    ''
  )
  return /\/chat\/completions$/i.test(raw) ? raw : `${raw}/chat/completions`
}

/** 将 axios 错误转换为友好提示（按服务商标注） */
function toDeepSeekError(err, providerLabel = PROVIDERS[DEFAULT_PROVIDER].label) {
  if (err instanceof DeepSeekError) return err
  if (err.code === 'ECONNABORTED') {
    return new DeepSeekError(`${providerLabel} 请求超时，请稍后重试`)
  }
  const status = err.response?.status
  const detail = err.response?.data?.error?.message || err.response?.data?.message
  if (status === 401 || status === 403) {
    return new DeepSeekError(
      `${providerLabel} API Key 无效或未授权，请在页面右上角「AI配置」中检查密钥（或后端环境变量）`,
      502
    )
  }
  if (status === 429) {
    return new DeepSeekError(`${providerLabel} 请求过于频繁，请稍后重试`)
  }
  if (status >= 500) {
    return new DeepSeekError(`${providerLabel} 服务异常（${status}），请稍后重试`)
  }
  const detailText = detail ? `：${detail}` : ''
  return new DeepSeekError(`${providerLabel} 接口调用失败${detailText}`, 502)
}

/**
 * 统一的多服务商 AI 调用函数（OpenAI 标准 chat/completions 协议）
 * @param {string} systemPrompt 系统提示词
 * @param {string} userContent 用户输入内容
 * @param {Object} [options] { temperature, maxTokens, apiKey, baseUrl, provider, model }
 * @returns {Promise<string>} 模型返回的文本内容
 */
export async function callDeepSeek(systemPrompt, userContent, options = {}) {
  const startedAt = Date.now()
  const { temperature = 0, maxTokens = 4096, apiKey, baseUrl, provider, model } = options
  const providerInfo = resolveProvider(provider)
  const finalUrl = buildEndpoint(baseUrl, providerInfo.baseUrl)
  const finalModel = (model && String(model).trim()) || providerInfo.model

  let finalKey
  try {
    finalKey = getApiKey(providerInfo.key, apiKey)
  } catch (err) {
    // 只读日志：未发起外部调用的配置错误
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: null,
      durationMs: Date.now() - startedAt,
      usage: null,
      error: `配置错误：${err.message}`,
      endpoint: finalUrl
    })
    throw err
  }

  const payload = {
    model: finalModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature,
    max_tokens: maxTokens,
    stream: false
  }
  // 严格 JSON 输出（仅对支持该参数的服务商开启，其余依赖提示词约束）
  if (providerInfo.supportsJsonMode) {
    payload.response_format = { type: 'json_object' }
  }

  try {
    const response = await axios.post(finalUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${finalKey}`
      },
      timeout: TIMEOUT
    })

    const content = response.data?.choices?.[0]?.message?.content
    if (!content) {
      throw new DeepSeekError(`${providerInfo.label} 返回内容为空`)
    }
    // 只读日志：成功调用（状态码/耗时/Token 用量）
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: response.status ?? 200,
      durationMs: Date.now() - startedAt,
      usage: normalizeUsage(response.data?.usage),
      error: null,
      endpoint: finalUrl
    })
    return String(content)
  } catch (err) {
    const mapped = toDeepSeekError(err, providerInfo.label)
    // 只读日志：失败调用（状态码/耗时/错误摘要）
    writeAiLog({
      provider: providerInfo.key,
      model: finalModel,
      status: err.response?.status ?? null,
      durationMs: Date.now() - startedAt,
      usage: normalizeUsage(err.response?.data?.usage),
      error: summarizeError(err, mapped),
      endpoint: finalUrl
    })
    throw mapped
  }
}
