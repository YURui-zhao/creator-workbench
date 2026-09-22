// AI 接口配置：持久化到浏览器 localStorage（ai_config），页面刷新不丢失
const AI_CONFIG_KEY = 'ai_config'

// 支持的服务商及其默认配置
export const AI_PROVIDERS = {
  deepseek: {
    value: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  zhipu: {
    value: 'zhipu',
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash'
  }
}

export const DEFAULT_PROVIDER = 'deepseek'

/** 服务商预设（未知服务商回退 DeepSeek） */
export function getProviderPreset(provider) {
  return AI_PROVIDERS[provider] || AI_PROVIDERS[DEFAULT_PROVIDER]
}

/**
 * 归一化配置：向下兼容旧配置（无 provider 字段视为 DeepSeek）
 * @returns {{ provider: string, model: string, apiKey: string, baseUrl: string }}
 */
export function normalizeAiConfig(config) {
  const provider = AI_PROVIDERS[config?.provider] ? config.provider : DEFAULT_PROVIDER
  const preset = getProviderPreset(provider)
  return {
    provider,
    model: config?.model || preset.model,
    apiKey: config?.apiKey || '',
    baseUrl: config?.baseUrl || preset.baseUrl
  }
}

/**
 * 读取本地 AI 配置
 * @returns {{ provider: string, model: string, apiKey: string, baseUrl: string } | null}
 */
export function getAiConfig() {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? normalizeAiConfig(parsed) : null
  } catch {
    return null
  }
}

/** 保存 AI 配置（统一按标准结构存储） */
export function saveAiConfig(config) {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(normalizeAiConfig(config)))
}

/** 清除 AI 配置 */
export function clearAiConfig() {
  localStorage.removeItem(AI_CONFIG_KEY)
}

/** 默认接口地址（DeepSeek，向后兼容旧调用） */
export function getDefaultAiBaseUrl() {
  return AI_PROVIDERS[DEFAULT_PROVIDER].baseUrl
}
