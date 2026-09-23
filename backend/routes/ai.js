import { Router } from 'express'
import {
  callDeepSeek,
  DeepSeekError,
  isDeepSeekConfigured,
  isProviderConfigured,
  listProviders,
  resolveProvider
} from '../services/deepseek.js'
import {
  normalizeWeekCode,
  parseTimeCycleToWeekCode,
  weekToDateRange
} from '../utils/dateCycle.js'

const router = Router()

function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

/** 从请求头读取 AI 调用参数（前端配置优先，缺省由服务层兜底） */
function aiOptions(req) {
  return {
    provider: req.headers['x-ai-provider'],
    model: req.headers['x-ai-model'],
    apiKey: req.headers['x-ai-api-key'],
    baseUrl: req.headers['x-ai-base-url']
  }
}

// ---------- 时间周期标准化（AI 兜底） ----------
const NORMALIZE_CACHE_MAX = 500
// 会话内缓存：原始值 -> 周码（含 null），避免相同值重复调用 AI
const normalizeCache = new Map()

/**
 * 本地二次校验：格式 ^YYYY-Wxx$，且对应区间必须是周一起始、完整 7 天、周一起始日在当年
 * @param {string} code AI 返回的候选周码
 * @returns {string|null} 合法则返回规范周码，否则 null（不直接使用）
 */
export function validateWeekCodeLocal(code) {
  const normalized = normalizeWeekCode(code)
  if (!normalized) return null
  const [yearText, weekText] = normalized.split('-W')
  try {
    const { start, end } = weekToDateRange(Number(weekText), Number(yearText))
    const startDate = new Date(`${start}T00:00:00`)
    const endDate = new Date(`${end}T00:00:00`)
    if (startDate.getDay() !== 1) return null // 起始必须是周一
    if (Math.round((endDate - startDate) / 86400000) !== 6) return null // 必须完整 7 天
    if (startDate.getFullYear() !== Number(yearText)) return null // 周一须落在当年
    return normalized
  } catch {
    return null
  }
}

/**
 * 组装时间周期归一化提示词
 * 统一输出 MM/DD-MM/DD（对齐系统自然周）；无法识别必须返回 "ERROR:具体原因"
 */
export function buildNormalizePrompt(values, year = new Date().getFullYear()) {
  return `
你是日期周期归一化助手。当前系统年份：${year}。
用户会给出一个「时间周期原始值」的 JSON 数组，请把每个值识别为它所属自然周，并统一输出 MM/DD-MM/DD 格式的完整周区间（如 08/17-08/23）。

规则（必须严格遵守）：
1. 输出格式：只输出 MM/DD-MM/DD（月/日-月/日，补零两位，如 08/17-08/23）。禁止输出周数（如 W33）、禁止输出年份、禁止输出其他格式。
2. 对齐系统自然周：系统每周从周一开始、周日结束。输入里的任意一个日期（含区间起始日），先判断它落在哪个自然周，再输出该完整自然周的周一~周日区间。例如输入 8-13（周四）→ 输出该周 08/10-08/16。
3. 年份缺失时按当前系统年份 ${year} 推断；跨年周（如 12月29日-1月4日）按真实日期处理。
4. 可识别写法（不限于此，业务里真实存在）：
   · 周数类：W33、w33、第33周、33周、2026年第33周、2026-W33
   · 区间类：8‑13~8‑19、8.13-8.19、8/13-8/19、8月13-19日、8月13日-8月19日、8月13日至19日、0813-0819、8-13-8-19、2026-08-13~2026-08-19、2026年8月13日至8月19日
   · 单日期类：2026-08-13、8月13日、08/13（取该日期所在自然周）
5. 无法确定唯一自然周时（区间不是完整自然周但可对齐的请按规则 2 对齐；完全无法解析、信息不足、日期非法、乱码等），该值必须返回字符串 "ERROR:具体原因"（中文，说明清楚原因），严禁编造日期。
6. 必须为每一个输入值输出一个键，键与原值完全一致，不得遗漏、不得新增键。

只输出一个严格 JSON 对象，不要输出任何多余文字、解释或 Markdown 代码块。输出格式示例：
{"W33":"08/17-08/23","8‑13~8‑19":"08/10-08/16","待定":"ERROR:无法解析该时间周期写法，请核对是否包含有效日期"}
`
}

/**
 * 用 AI 返回的映射生成本地二次校验后的结果
 * @param {string[]} values 去重后的原始值
 * @param {Object} aiMap AI 返回的 { 原始值: "MM/DD-MM/DD" | "YYYY-Wxx" | "ERROR:原因" | null }
 * @returns {Array<{ value: string, weekCode: string|null, error: string|null }>}
 */
export function applyAiNormalizeResults(values, aiMap = {}) {
  return values.map((value) => {
    const candidate = aiMap?.[value]
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (!text) {
      return { value, weekCode: null, error: 'AI 未返回识别结果' }
    }
    // AI 显式失败：原样透传原因，供前端完整展示
    const errorMatch = /^ERROR\s*[:：]\s*(.+)$/i.exec(text)
    if (errorMatch) {
      return { value, weekCode: null, error: errorMatch[1].trim() || 'AI 无法识别该时间周期' }
    }
    // 兼容 AI 输出标准周码的情况
    const byCode = validateWeekCodeLocal(text)
    if (byCode) return { value, weekCode: byCode, error: null }
    // 规格要求的 MM/DD-MM/DD 输出：本地二次校验（必须周一起始、完整 7 天）
    const byLabel = parseTimeCycleToWeekCode(text)
    if (byLabel) return { value, weekCode: byLabel, error: null }
    return {
      value,
      weekCode: null,
      error: `AI 输出的内容不是合法自然周：${text}`
    }
  })
}

// 基础判定规则（始终生效）
const BASE_PROMPT = `
你是一名专业的数据质检专家，负责审核达人投放记录。用户会发送一个 JSON 数组，数组元素是投放记录对象，字段说明：
- time_cycle: 时间周期，如 "2024-W30"
- nickname: 达人昵称
- creator_type: 博主类型（如 美妆/科技/美食/穿搭/数码/生活/知识/职场/其他）
- homepage: 达人主页链接
- content_link: 植入内容链接
- video_link: 视频发布链接
- total_cost: 总花费（元，数字）
- publish_date: 发布日期，YYYY-MM-DD
- first_play: 7日播放量（整数，内容发布约 7 天时记录的累计播放量）
- second_week_play: 累计播放量（整数，最近一次更新时的累计播放量；这只是历史字段名，绝不代表「第二周新增播放量」）
- cpm_quote: CPM报价（可选字段，存在时才参与判定）
- rowIndex: Excel 行号（输入记录里原样携带，输出必须原样返回，禁止改写为数组下标）

请对【每一条记录】逐字段判定，并【只输出一个严格 JSON 对象】，不要输出任何多余文字、解释或 Markdown 代码块。输出格式：
{"records":[{"rowIndex":2,"pass":true,"level":"info","issues":[],"suggestions":[],"warnings":[],"errors":[],"corrected":null}]}

结构化问题项（warnings / errors 数组的元素）必须是对象，四个字段缺一不可：
{"rowIndex":2,"field":"second_week_play","reason":"累计播放量小于7日播放量，数据自相矛盾","suggestion":"核对原始数据后修正累计播放量，或先清空累计播放量标记为待更新"}
- rowIndex：该问题所属的 Excel 行号（与输入记录一致）
- field：涉及的字段名（如 time_cycle/nickname/total_cost/publish_date/first_play/second_week_play/creator_type/homepage/content_link/video_link）；无法定位具体字段时用 "record"
- reason：问题原因（中文，说明「哪里不对、为什么不合理」，不要只写「数据异常」）
- suggestion：可执行的优化/修正建议（中文，说明「怎么改」）

基础判定规则：
1. 必填字段：time_cycle、nickname、total_cost、publish_date 任一为空 → pass=false，level=error；first_play（7日播放量）与 second_week_play（累计播放量）均为可选，为空表示「未采集 / 待更新」，不得因二者为空判错
2. 格式判定：homepage/content_link/video_link 必须是合法 URL（http/https）；publish_date 必须是 YYYY-MM-DD；time_cycle 应形如 2024-W30
3. 数值合理性：total_cost 必填且为非负数字（0 是合法真实值，不得判为错误、不得要求大于 0）；first_play、second_week_play 为非负整数（0 是真实观察值，与「空值 = 未采集/待更新」严格区分）；若存在 cpm_quote，应在 5-200 合理区间
4. 业务逻辑：实际CPM（按累计播放量）= total_cost / second_week_play * 1000；7日CPM（按7日播放量）= total_cost / first_play * 1000（分母为空或 0 时不计算）；当 7日播放量与累计播放量同时有值时，累计播放量必须 ≥ 7日播放量，若「累计播放量 < 7日播放量」则该记录数据自相矛盾，必须标记 error；若记录含 cpm_quote 且实际CPM与报价偏差超过 ±30% → 标记异常；若不含 cpm_quote，实际CPM 超出 5-200 合理区间 → 标记 warning
5. 数据质量：明显录入错误或异常值（如昵称含乱码、链接含空格、播放量/金额异常巨大或为负数）→ 标记 warning 或 error

输出要求：
- rowIndex 必须与输入记录的 Excel 行号完全一致（输入里带的是 rowIndex，禁止用数组下标代替），每条输入记录都必须出现在 records 数组中，不得遗漏、不得新增
- pass: 存在 error 级问题时为 false，否则为 true
- level: 取该记录最高问题等级：无问题 info，仅建议/告警 warning，有必须修正的错误 error
- 警告（warning）与错误（error）的判定标准：
  · 警告 = 数据可以入库，但存在业务风险或可疑点（播放量异常、CPM 明显偏离合理区间、花费与播放量不匹配、博主类型与平台不匹配等）
  · 错误 = 数据不可入库（必填字段非法/缺失、时间周期或日期格式非法、数值为负、逻辑自相矛盾等）
- warnings：warning 级结构化问题数组，元素必须是 {rowIndex, field, reason, suggestion}
- errors：error 级结构化问题数组，元素必须是 {rowIndex, field, reason, suggestion}
- 常见警告必须给出明确建议（禁止模糊表述），参考：
  · 累计播放量为空 → 建议「补充最近一次累计播放量后再评估（未采集期间可保持留空，表示待更新）」
  · 累计播放量 < 7日播放量 → 标记 error，建议「核对原始数据，累计播放量不应小于7日播放量」
  · CPM 偏离合理区间（<5 或 >200）→ 建议「核对总花费与播放量口径，确认是否为异常投放」
  · 花费高但播放量低 → 建议「复核投放效果，考虑减少同类型达人投放」
  · 播放量异常巨大 → 建议「核对数据来源，确认是否存在刷量或统计口径错误」
- issues: 问题描述数组（中文，按字段说明；与 warnings/errors 的 reason 保持一致，可为空数组）
- suggestions: 修正建议数组（中文，可操作；与 warnings/errors 的 suggestion 保持一致，可为空数组）
- corrected: 仅在能明确修正时提供修正后的字段对象（如去除首尾空格、日期格式归一为 YYYY-MM-DD、链接补全 https://），无法确定时填 null，不得编造数值
- issues、suggestions、warnings、errors 为空时输出空数组
`

// 智能补全能力（始终开启）
const COMPLETION_PROMPT = `
智能补全能力（仅在能明确判断时提供 corrected，无法确定时不得编造）：
- 根据达人昵称自动推测博主类型 creator_type（如昵称含「美妆/护肤」→美妆，含「美食/探店」→美食，含「穿搭/时尚」→穿搭，含「数码/测评」→数码，无法确定时不填）
- 根据链接自动提取平台信息，写入 corrected.platform（平台名称，如 抖音/小红书/B站/快手/微博/视频号/其他）
- 自动修正日期格式（归一化为 YYYY-MM-DD）、数字格式（去除货币符号/千分位，播放量支持 x.x万 写法）
- 数值字段自动修正（total_cost、first_play、second_week_play 等）：遇到「/」「-」「--」「无」「空」「暂无」「N/A」等占位写法时按缺失处理——必填字段在 corrected 中给 0，非必填字段给 null；遇到「1.2万」「1万」「1,234」「￥1000」「1000元」等写法时在 corrected 中换算为标准数值（12000 / 10000 / 1234 / 1000 / 1000）；无法解析时非必填字段给 null 并在 suggestions 中提示
- 时间周期自动修正：time_cycle 若为「第33周」「8.17-8.23」「8月17日」「2026年8月17日至8月23日」等写法，请识别为该周的标准周码 YYYY-Wxx（周一为每周第一天，区间必须是完整自然周）写入 corrected.time_cycle；无法唯一确定时置 null 并在 issues 中说明
`

// 可选判定规则库（key 为前端勾选项）
const RULE_LIBRARY = {
  creator_type_cpm: {
    label: '达人类型CPM匹配判定',
    prompt: `
6. 达人类型CPM匹配判定：结合达人类型与平台判断CPM合理性。例如美妆类达人CPM不应超过50，穿搭/生活类一般不超过30；若CPM超限，在 issues 中标注「该达人CPM过高」，并在 suggestions 中给出「建议后续不再投放该达人」，level 标记为 warning 或 error。
`
  },
  time_cycle_format: {
    label: '时间周期格式判定',
    prompt: `
7. 时间周期格式判定：time_cycle 必须符合 YYYY-Wxx 格式（如 2024-W30），不合法时标记 error，并在 corrected.time_cycle 中给出规范值。
`
  },
  duplicate_check: {
    label: '重复数据判定',
    prompt: `
8. 重复数据判定：相同 nickname + 相同 publish_date 视为重复记录；同一组重复记录只保留第一条，后续重复记录标记 error，并在 suggestions 中建议删除/跳过该行。
`
  },
  magnitude_check: {
    label: '数据量级合理性判定',
    prompt: `
9. 数据量级判定：结合播放量与总花费判断商业逻辑是否合理（如花费高但播放量极低、播放量异常巨大且花费极低等），不合理时标记 warning/error 并说明原因。
`
  },
  platform_link_match: {
    label: '链接平台与博主类型匹配判定',
    prompt: `
10. 链接平台判定：从 homepage/content_link/video_link 的 URL 自动识别平台（抖音 douyin.com、小红书 xiaohongshu.com、B站 bilibili.com、快手 kuaishou.com、微博 weibo.com、视频号 channels.weixin.qq.com 等），识别结果写入 corrected.platform（平台名称）；并判断平台与博主类型是否匹配（如美妆通常投放小红书/抖音，数码通常投放B站/抖音），不匹配时标记 warning。
`
  }
}

/**
 * 根据启用的规则动态构建系统提示词
 * @param {string[]} rules 规则标识（RULE_LIBRARY 的 key）或自然语言自定义规则
 */
export function buildSystemPrompt(rules = []) {
  const parts = [BASE_PROMPT, COMPLETION_PROMPT]
  const customRules = []
  for (const rule of rules) {
    if (typeof rule !== 'string' || !rule.trim()) continue
    const key = rule.trim()
    if (RULE_LIBRARY[key]) {
      parts.push(RULE_LIBRARY[key].prompt)
    } else {
      customRules.push(`- ${key}`)
    }
  }
  if (customRules.length) {
    parts.push(
      `\n自定义判定条件（用户补充，优先级最高，必须逐条遵守）：\n${customRules.join('\n')}`
    )
  }
  return parts.join('\n')
}

/**
 * 解析 DeepSeek 返回内容为 JSON（兼容 Markdown 代码块包裹与多余空白）
 */
export function parseAiResult(content) {
  const text = String(content ?? '').trim()
  const candidates = [text, text.replace(/```(?:json)?/gi, '').trim()]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续尝试下一个候选
    }
  }
  // 提取最外层 JSON 对象/数组
  const match = text.match(/[\[{][\s\S]*[\]}]/)
  if (match) {
    try {
      return JSON.parse(match[0])
    } catch {
      // 兜底失败
    }
  }
  throw new DeepSeekError('DeepSeek 返回内容不是合法 JSON')
}

/**
 * 归一化 AI 判定结果，保证每条记录结构稳定
 * 兼容两种返回：结构化 {rowIndex, field, reason, suggestion} 的 warnings/errors 数组，
 * 以及旧版自由文本 issues/suggestions 数组（向下兼容，不破坏原有解析）
 */
export function normalizeResult(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.records
  if (!Array.isArray(list)) {
    throw new DeepSeekError('DeepSeek 返回结构缺少 records 数组')
  }
  return list.map((item) => ({
    // 行号：优先 rowIndex（Excel 真实行号），兼容旧字段 index；无法解析时置 null（前端显示「未知行」）
    rowIndex: normalizeRowIndex(item),
    index: normalizeRowIndex(item),
    pass: Boolean(item?.pass),
    level: normalizeLevel(item),
    issues: Array.isArray(item?.issues) ? item.issues : [],
    suggestions: Array.isArray(item?.suggestions) ? item.suggestions : [],
    warnings: normalizeIssueList(item?.warnings),
    errors: normalizeIssueList(item?.errors),
    corrected: item?.corrected && typeof item.corrected === 'object' ? item.corrected : null
  }))
}

/** 行号解析：rowIndex 优先，其次 index；非数字返回 null */
function normalizeRowIndex(item) {
  const raw = item?.rowIndex ?? item?.index
  if (raw === undefined || raw === null || raw === '') return null
  const num = Number(raw)
  return Number.isFinite(num) ? num : null
}

/** 等级解析：未返回合法等级时，按 errors/warnings 推导，避免全部退化为 warning */
function normalizeLevel(item) {
  if (['info', 'warning', 'error'].includes(item?.level)) return item.level
  if (Array.isArray(item?.errors) && item.errors.length > 0) return 'error'
  if (Array.isArray(item?.warnings) && item.warnings.length > 0) return 'warning'
  return 'warning'
}

/**
 * 结构化问题项归一化：元素必须是对象且带 reason，缺失字段用兜底值填充；
 * 兼容 AI 直接返回字符串数组的情况（转成只带 reason 的项）
 */
function normalizeIssueList(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => {
      if (entry === null || entry === undefined) return null
      if (typeof entry === 'string') {
        const reason = entry.trim()
        return reason ? { field: 'record', reason, suggestion: '' } : null
      }
      if (typeof entry !== 'object') return null
      const reason = String(entry.reason ?? entry.issue ?? entry.message ?? '').trim()
      const suggestion = String(
        entry.suggestion ?? entry.suggest ?? entry.advice ?? ''
      ).trim()
      const field = String(entry.field ?? entry.column ?? 'record').trim() || 'record'
      const rowIndex = normalizeRowIndex(entry)
      if (!reason && !suggestion) return null
      return { field, reason, suggestion, rowIndex }
    })
    .filter(Boolean)
}

/**
 * 智能校验：按启用规则构建提示词并调用 DeepSeek（可注入 callFn 便于测试）
 */
export async function validateRecords(records, callFn = callDeepSeek, rules = [], options = {}) {
  const content = await callFn(buildSystemPrompt(rules), JSON.stringify(records), options)
  return normalizeResult(parseAiResult(content))
}

/**
 * GET /api/ai/status
 * 返回 AI 服务是否可用（仅校验 Key 配置，不发起外部请求）
 */
router.get('/status', (req, res) => {
  // 页面配置的服务商/Key/接口地址优先（请求头），否则回退环境变量
  const options = aiOptions(req)
  const providerInfo = resolveProvider(options.provider)
  const available = isProviderConfigured(providerInfo.key, options.apiKey)
  ok(res, {
    available,
    provider: providerInfo.key,
    providerLabel: providerInfo.label,
    model: available ? options.model || providerInfo.model : null,
    baseUrl: options.baseUrl || providerInfo.baseUrl,
    providers: listProviders(),
    msg: available
      ? 'AI服务已配置'
      : `未配置 ${providerInfo.label} API Key，请先在页面右上角配置`
  })
})

/**
 * POST /api/ai/validate-records
 * 入参：{ records: Array, rules?: Array<string> }
 * rules 元素可以是规则库标识（如 creator_type_cpm）或自然语言自定义条件
 */
/**
 * POST /api/ai/normalize-time-cycles
 * 入参：{ values: string[] }（最多 50 个，自动去重）
 * 出参：{ code, data: [{ value, weekCode }], msg }
 * 本地规则无法识别的值由 AI 兜底识别；AI 结果经本地二次校验，校验不过置为 null
 */
router.post('/normalize-time-cycles', async (req, res) => {
  const rawValues = req.body?.values
  if (!Array.isArray(rawValues)) {
    return fail(res, 400, 'values 必须是非空数组')
  }
  const values = [...new Set(rawValues.map((v) => String(v ?? '').trim()).filter(Boolean))]
  if (values.length === 0) {
    return fail(res, 400, 'values 不能为空')
  }
  if (values.length > 50) {
    return fail(res, 400, '单次最多支持 50 个时间周期值')
  }

  const year = new Date().getFullYear()
  // 命中会话缓存的直接复用，避免相同原始值重复调用 AI
  const pendingValues = values.filter((value) => !normalizeCache.has(value))
  if (pendingValues.length === 0) {
    return ok(
      res,
      values.map((value) => ({
        value,
        weekCode: normalizeCache.get(value) ?? null,
        error: null
      }))
    )
  }

  try {
    // 服务商/密钥读取与 AI 校验一致：请求头优先，环境变量兜底（缺失时由 callDeepSeek 抛 400）
    const content = await callDeepSeek(
      buildNormalizePrompt(pendingValues, year),
      JSON.stringify(pendingValues),
      aiOptions(req)
    )
    const parsed = parseAiResult(content)
    const aiMap = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const pendingResults = applyAiNormalizeResults(pendingValues, aiMap)
    const pendingMap = new Map(pendingResults.map((item) => [item.value, item]))

    for (const item of pendingResults) {
      // 仅缓存识别成功的结果；未识别的值不缓存，保证每次都能拿到具体失败原因
      if (item.weekCode && normalizeCache.size < NORMALIZE_CACHE_MAX) {
        normalizeCache.set(item.value, item.weekCode)
      }
    }

    ok(
      res,
      values.map((value) => {
        const cached = normalizeCache.get(value)
        if (cached) return { value, weekCode: cached, error: null }
        const item = pendingMap.get(value)
        return {
          value,
          weekCode: item ? item.weekCode : null,
          error: item ? item.error : 'AI 未返回该时间周期的识别结果'
        }
      })
    )
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 时间周期识别异常:', err)
    return fail(res, 500, 'AI 时间周期识别服务异常，请稍后重试')
  }
})

router.post('/validate-records', async (req, res) => {
  const { records, rules } = req.body || {}
  if (!Array.isArray(records)) {
    return fail(res, 400, 'records 必须是非空数组')
  }
  if (records.length === 0) {
    return fail(res, 400, 'records 不能为空')
  }
  if (records.length > 1000) {
    return fail(res, 400, '单次智能校验最多支持 1000 条记录')
  }
  if (
    rules !== undefined &&
    (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))
  ) {
    return fail(res, 400, 'rules 必须是由规则标识或自然语言描述组成的字符串数组')
  }

  try {
    // 页面配置的服务商/模型/Key/接口地址优先，其次环境变量兜底
    const result = await validateRecords(records, callDeepSeek, rules || [], aiOptions(req))
    ok(res, result)
  } catch (err) {
    if (err instanceof DeepSeekError || err.isDeepSeekError) {
      return fail(res, err.status || 502, err.message)
    }
    console.error('[ai] 智能校验异常:', err)
    return fail(res, 500, 'AI 校验服务异常，请稍后重试')
  }
})

export default router
