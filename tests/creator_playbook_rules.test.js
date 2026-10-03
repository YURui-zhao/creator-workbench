#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Rule Engine 回归测试
//
// 运行方式：node tests/creator_playbook_rules.test.js
// 特性：纯函数测试，不启动服务、不打开浏览器、不写数据库、不访问网络。
//
// 覆盖：播放量级、商单密度、播放稳定性（含 20% 浮点边界）、稳定高播放、商单优先 / 日常辅助、
//       CPM15-20 估价与置信度、万元风险、NULL/0 语义、缺数据优雅降级、确定性、无评分字段。
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

let passCount = 0
let failCount = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) {
    passCount += 1
    console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failCount += 1
    failures.push(`${label}${extra ? `  ${extra}` : ''}`)
    console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

function forbidNetwork() {
  const blocked = []
  const replacements = [
    [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('Rule engine test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('Rule engine test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
  }
}

// 递归检测输出里是否存在非有限数字 / NaN / Infinity
function hasNonFinite(value) {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (Array.isArray(value)) return value.some(hasNonFinite)
  if (value && typeof value === 'object') return Object.values(value).some(hasNonFinite)
  return false
}

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const rules = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/creatorPlaybookRules.js')).href
    )
    const { buildCreatorPlaybookAssessment, computeMeanPlay } = rules

    const assess = (snapshot) => buildCreatorPlaybookAssessment(snapshot)
    const sponsoredPlay = (value, type = 'sponsored') => ({ normalized_play: value, excluded: false, content_type: type })

    console.log('===== 1. 播放量级（规则 1）=====')
    check('median=99999 -> 基础量级', assess({ median_play: 99999 }).scale.code === 'base' && assess({ median_play: 99999 }).scale.label === '基础量级')
    check('median=100000 -> 高量级', assess({ median_play: 100000 }).scale.code === 'high' && assess({ median_play: 100000 }).scale.label === '高量级')
    check('median 缺失 -> 量级未知', assess({}).scale.code === 'unknown' && assess({}).scale.label === '量级未知')

    console.log('\n===== 2. 商单密度（规则 2）=====')
    check('sponsored_count=2 -> 弱商单账号', assess({ sponsored_count: 2 }).commercialDensity.code === 'weak' && assess({ sponsored_count: 2 }).commercialDensity.label === '弱商单账号')
    check('sponsored_count=3 -> 强商单账号', assess({ sponsored_count: 3 }).commercialDensity.code === 'strong' && assess({ sponsored_count: 3 }).commercialDensity.label === '强商单账号')
    check('unknown 不计入 sponsored', assess({ sponsored_count: 0, unknown_count: 9 }).commercialDensity.sponsoredCount === 0)
    check('同时返回 sponsored / organic / unknown 数量', JSON.stringify(assess({ sponsored_count: 3, organic_count: 6, unknown_count: 1 }).commercialDensity) === JSON.stringify({ code: 'strong', label: '强商单账号', sponsoredCount: 3, organicCount: 6, unknownCount: 1 }))

    console.log('\n===== 3. 播放稳定性（规则 3，含 20% 浮点边界）=====')
    check('mean=120000 median=100000（正好20%）-> stable', assess({ mean_play: 120000, median_play: 100000 }).stability.code === 'stable')
    check('mean=120001 median=100000（>20%）-> volatile', assess({ mean_play: 120001, median_play: 100000 }).stability.code === 'volatile')
    check('mean=150000 median=110000 -> volatile 且 highPlaySignal=true', assess({ mean_play: 150000, median_play: 110000 }).stability.code === 'volatile' && assess({ mean_play: 150000, median_play: 110000 }).highPlaySignal.active === true)
    check('mean=90000 median=100000 -> stable 且 highPlaySignal=false（mean<10w）', assess({ mean_play: 90000, median_play: 100000 }).stability.code === 'stable' && assess({ mean_play: 90000, median_play: 100000 }).highPlaySignal.active === false)
    check('median=0 -> stability unknown（不除 0）', assess({ median_play: 0, mean_play: 0 }).stability.code === 'unknown')
    check('deviationRatio 数值正确（150000/110000）', Math.abs(assess({ mean_play: 150000, median_play: 110000 }).stability.deviationRatio - (40000 / 110000)) < 1e-12)

    console.log('\n===== 4. 稳定高播放（规则 4，独立维度）=====')
    check('mean/median 均 >= 10w -> 稳定高播放', assess({ mean_play: 150000, median_play: 110000 }).highPlaySignal.active === true && assess({ mean_play: 150000, median_play: 110000 }).highPlaySignal.label === '稳定高播放')
    check('仅 median >= 10w（mean<10w）-> 不触发', assess({ mean_play: 90000, median_play: 100000 }).highPlaySignal.active === false)
    check('触发高播放信号时不覆盖量级 / 稳定性', assess({ mean_play: 150000, median_play: 110000 }).scale.code === 'high' && assess({ mean_play: 150000, median_play: 110000 }).stability.code === 'volatile')

    console.log('\n===== 5. 商单优先 / 日常辅助（规则 5）=====')
    check('sponsored>=3 -> sponsored_primary / normal', assess({ sponsored_count: 3 }).performanceBasis.code === 'sponsored_primary' && assess({ sponsored_count: 3 }).performanceBasis.confidence === 'normal')
    check('sponsored=1..2 -> sponsored_with_organic_support / low', assess({ sponsored_count: 1 }).performanceBasis.code === 'sponsored_with_organic_support' && assess({ sponsored_count: 2 }).performanceBasis.confidence === 'low')
    check('sponsored=0 organic>0 -> organic_only_low_confidence', assess({ sponsored_count: 0, organic_count: 5 }).performanceBasis.code === 'organic_only_low_confidence')
    check('全部 unknown -> insufficient_classification', assess({ sponsored_count: 0, organic_count: 0, unknown_count: 8 }).performanceBasis.code === 'insufficient_classification')
    check('不存在加权综合播放量字段', !('combinedMedianPlay' in assess({ sponsored_count: 3, organic_count: 6 })) && !('weightedPlay' in assess({ sponsored_count: 3, organic_count: 6 })))

    console.log('\n===== 6. CPM15-20 基础估价（规则 6）=====')
    check('CPM 常量 = 15 / 20', assess({}).estimate.cpmLow === 15 && assess({}).estimate.cpmHigh === 20)
    check('1 条 sponsored -> 可计算区间，confidence=low', (() => {
      const e = assess({ sponsored_count: 1, sponsored_median_play: 50000 }).estimate
      return e.low === 750 && e.high === 1000 && e.confidence === 'low'
    })())
    check('2 条 sponsored -> confidence=low', assess({ sponsored_count: 2, sponsored_median_play: 50000 }).estimate.confidence === 'low')
    check('3 条 sponsored -> confidence=normal', (() => {
      const e = assess({ sponsored_count: 3, sponsored_median_play: 20000 }).estimate
      return e.low === 300 && e.high === 400 && e.confidence === 'normal'
    })())
    check('sponsored median=0 -> 真实 0，estimate 0-0（不是 null）', (() => {
      const e = assess({ sponsored_count: 3, sponsored_median_play: 0 }).estimate
      return e.low === 0 && e.high === 0
    })())
    check('0 sponsored + organic -> 不计算商单区间，返回 organic reference，low', (() => {
      const e = assess({ sponsored_count: 0, organic_count: 9, organic_median_play: 61000 }).estimate
      return e.low === null && e.high === null && e.organicReferenceMedian === 61000 && e.confidence === 'low'
    })())
    check('全部 unknown -> 不计算估价', (() => {
      const e = assess({ sponsored_count: 0, organic_count: 0, unknown_count: 9 }).estimate
      return e.low === null && e.high === null
    })())
    check('估价不覆盖 TARGET_CPM=30（无 targetCpm 字段）', !('targetCpm' in assess({ sponsored_count: 3 })) && !('target_cpm' in assess({ sponsored_count: 3 })))

    console.log('\n===== 7. 万元风险（规则 7）=====')
    check('xingtu=10000 -> 不触发', assess({ xingtu_price: 10000 }).risk.highAmount === false)
    check('xingtu=10000.01 -> 触发', assess({ xingtu_price: 10000.01 }).risk.highAmount === true && /万元/.test(String(assess({ xingtu_price: 10000.01 }).risk.explanation)))
    check('xingtu=0 -> 不触发（0 是真实价格）', assess({ xingtu_price: 0 }).risk.highAmount === false)
    check('xingtu=null -> unknown，不触发', assess({ xingtu_price: null }).risk.highAmount === false)
    check('xingtu=20000 -> 触发', assess({ xingtu_price: 20000 }).risk.highAmount === true)

    console.log('\n===== 8. 派生 mean / 缺数据优雅降级 =====')
    check('从 plays 派生 mean（有效样本算术平均）', computeMeanPlay([sponsoredPlay(10000), sponsoredPlay(20000), sponsoredPlay(30000)]) === 20000)
    check('excluded / 无法解析不计入 mean', computeMeanPlay([sponsoredPlay(10000), { normalized_play: 100000, excluded: true }, { normalized_play: null, excluded: false }]) === 10000)
    check('有效样本含 sponsored / organic / unknown（不按类型拆分 mean）', computeMeanPlay([sponsoredPlay(10000, 'sponsored'), sponsoredPlay(20000, 'organic'), sponsoredPlay(30000, 'unknown')]) === 20000)
    check('已保存 mean_play 优先于 plays 派生', assess({ mean_play: 77777, plays: [sponsoredPlay(10000)] }).metrics.meanPlay === 77777)
    const empty = assess({})
    check('空 snapshot -> 全部 graceful unknown（无 NaN/Infinity）', !hasNonFinite(empty), JSON.stringify(empty.metrics))
    check('空 snapshot：estimate low/high = null', empty.estimate.low === null && empty.estimate.high === null)
    check('mean 派生不产生 NaN（空 plays）', computeMeanPlay([]) === null && computeMeanPlay(null) === null)
    check('输出可 JSON 序列化（无 NaN/Infinity 泄漏）', !/NaN|Infinity/.test(JSON.stringify(assess({ median_play: 0, mean_play: 0, xingtu_price: null }))))

    console.log('\n===== 9. 确定性与边界原则 =====')
    const sample = { median_play: 123456, sponsored_count: 2, sponsored_median_play: 42000, organic_count: 5, organic_median_play: 81000, unknown_count: 1, xingtu_price: 20000, plays: [sponsoredPlay(42000), sponsoredPlay(50000)] }
    check('相同输入 -> 相同输出（deterministic）', JSON.stringify(assess(sample)) === JSON.stringify(assess(sample)))
    check('不产生 overall_score', !('overall_score' in assess(sample)) && !('overallScore' in assess(sample)))
    check('不产生 recommendation_score', !('recommendation_score' in assess(sample)) && !('recommendationScore' in assess(sample)))
    check('不产生 should_invest', !('should_invest' in assess(sample)) && !('shouldInvest' in assess(sample)))
    check('输出维度彼此独立（8 个顶层维度）', ['metrics', 'scale', 'commercialDensity', 'stability', 'highPlaySignal', 'performanceBasis', 'estimate', 'risk'].every((k) => k in assess(sample)))
    const ruleSource = fs.readFileSync(path.join(root, 'frontend/src/utils/creatorPlaybookRules.js'), 'utf8')
    check('规则模块不引用 AI / 网络 / 数据库', !/deepseek|fetch\(|axios|better-sqlite3|from '\.\.\/api/i.test(ruleSource))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
  } finally {
    networkGuard.restore()
  }
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    const total = passCount + failCount
    const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
    console.log('\n================ 测试汇总 ================')
    console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
    if (failCount > 0) {
      console.log('\n失败用例：')
      failures.forEach((item) => console.log(`  - ${item}`))
    }
    process.exitCode = failCount > 0 ? 1 : 0
  })
