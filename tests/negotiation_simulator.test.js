#!/usr/bin/env node
/**
 * 谈价试算器（V3-alpha P4）回归测试
 *
 * 运行方式：node tests/negotiation_simulator.test.js
 * 无 DB、无 AI、无网络：纯前端展示层纯函数 + 「不写库 / 不请求」的源码契约断言。
 *
 * 覆盖：7/6.1/5.2/2 折试算、区间夹取、默认值、无星图价与样本不足禁用、
 *      纯函数集中（不散落 JSX）、不写库 / 不调 AI / 不影响人的决定。
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const frontend = path.join(root, 'frontend/src')

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
      blocked.push(`${method}`)
      throw new Error('simulator test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('simulator test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
  }
}

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const sim = await import(
      pathToFileURL(path.join(frontend, 'utils/negotiationSimulator.js')).href
    )
    const { simulateNegotiation, clampSimulatorRate, formatSimulatorZhe } = sim

    // 标准案例：星图 3000 / 中位播放 52000 / target 1560 / reference_high 1830
    const base = {
      xingtuPrice: 3000,
      medianPlay: 52000,
      targetPrice: 1560,
      referenceHigh: 1830
    }

    console.log('===== 1. 试算区间与结果 =====')
    check('区间常量：2～7折（0.2 / 0.7）', sim.SIMULATOR_MIN_RATE === 0.2 && sim.SIMULATOR_MAX_RATE === 0.7)
    check('默认折扣 = 7折（区间内价格最高的一档，不替用户选「最佳」）', sim.SIMULATOR_DEFAULT_RATE === 0.7 && simulateNegotiation({ ...base }).zhe_label === '7折')

    const seven = simulateNegotiation({ ...base, rate: 0.7 })
    check(
      '7折：price 2100 → 仍高于参考区间',
      seven.price === 2100 && seven.status === 'above_reference_range' && seven.status_label === '仍高于 CPM30参考区间',
      JSON.stringify(seven)
    )
    const entry = simulateNegotiation({ ...base, rate: 0.61 })
    check(
      '6.1折：price 1830 → 已进入参考区间',
      entry.price === 1830 && entry.status === 'within_reference_range' && entry.status_label === '已进入 CPM30参考区间',
      JSON.stringify(entry)
    )
    const target = simulateNegotiation({ ...base, rate: 0.52 })
    check(
      '5.2折：price 1560 → 已达到目标价',
      target.price === 1560 && target.status === 'at_or_below_target' && target.status_label === '已达到或优于 CPM30目标价',
      JSON.stringify(target)
    )
    const floor = simulateNegotiation({ ...base, rate: 0.2 })
    check(
      '2折：price 600 → 已达到目标价（区间下限）',
      floor.price === 600 && floor.status === 'at_or_below_target',
      JSON.stringify(floor)
    )

    console.log('\n===== 2. 对应 CPM =====')
    check('5.2折：对应 CPM = 1560/52000*1000 = 30（正好达标线）', target.cpm === 30, String(target.cpm))
    check('7折：对应 CPM = 2100/52000*1000 ≈ 40.4', seven.cpm === 40.4, String(seven.cpm))
    const custom = simulateNegotiation({ ...base, rate: 0.58 })
    check(
      '5.8折：price 1740 / CPM ≈ 33.5（与需求示例一致）',
      custom.price === 1740 && custom.cpm === 33.5 && custom.zhe_label === '5.8折',
      JSON.stringify(custom)
    )

    console.log('\n===== 3. 边界夹取 =====')
    check('低于 2折被夹到 2折', clampSimulatorRate(0.1) === 0.2 && simulateNegotiation({ ...base, rate: 0.1 }).rate === 0.2)
    check('高于 7折被夹到 7折', clampSimulatorRate(0.95) === 0.7 && simulateNegotiation({ ...base, rate: 0.95 }).rate === 0.7)
    check('非法输入回落到默认 7折', clampSimulatorRate(Number.NaN) === 0.7 && clampSimulatorRate(null) === 0.7)
    check('折数展示：整数不带小数、一位小数保留', formatSimulatorZhe(0.7) === '7折' && formatSimulatorZhe(0.58) === '5.8折' && formatSimulatorZhe(0.2) === '2折')
    check('步长定义 = 0.1折（0.01）', sim.SIMULATOR_STEP_RATE === 0.01)

    console.log('\n===== 4. 不可用场景（不伪造数据）=====')
    const noXingtu = simulateNegotiation({ ...base, xingtuPrice: null, rate: 0.7 })
    check(
      '星图价缺失 → 不可用并给出明确文案',
      noXingtu.available === false && noXingtu.unavailable_reason === 'quote_missing' && /暂无可用星图刊例价/.test(noXingtu.unavailable_label) && noXingtu.price === null && noXingtu.cpm === null,
      JSON.stringify(noXingtu)
    )
    const zeroXingtu = simulateNegotiation({ ...base, xingtuPrice: 0, rate: 0.7 })
    check('星图价为 0 → 同样不可用', zeroXingtu.available === false && zeroXingtu.unavailable_reason === 'quote_missing')
    const insufficient = simulateNegotiation({ xingtuPrice: 3000, medianPlay: null, targetPrice: null, referenceHigh: null, rate: 0.7 })
    check(
      '样本不足 → 不可用并提示不进行 CPM 试算',
      insufficient.available === false && insufficient.unavailable_reason === 'stats_insufficient' && /近期有效样本不足/.test(insufficient.unavailable_label)
    )
    const medianZero = simulateNegotiation({ xingtuPrice: 3000, medianPlay: 0, targetPrice: 1560, referenceHigh: 1830, rate: 0.7 })
    check('中位播放为 0 时不计算 CPM（仍可看价格与状态）', medianZero.available === true && medianZero.cpm === null && medianZero.price === 2100)

    console.log('\n===== 5. 源码契约（不写库 / 不调 AI / 逻辑集中）=====')
    const simSource = fs.readFileSync(path.join(frontend, 'utils/negotiationSimulator.js'), 'utf8')
    const drawerSource = fs.readFileSync(path.join(frontend, 'components/CreatorDecisionDrawer.jsx'), 'utf8')
    check('试算器模块不引用网络 / AI / 存储', !/fetch\(|axios|deepseek|localStorage|sessionStorage/i.test(simSource))
    check('试算器模块不含任何写库调用', !/createCreatorDecision|request\.(post|put|delete)/.test(simSource))
    check(
      '试算逻辑集中在 utils（JSX 中只调用 simulateNegotiation）',
      /simulateNegotiation\(/.test(drawerSource) &&
        (drawerSource.match(/simulateNegotiation\(/g) || []).length === 1 &&
        !/xingtuPrice \* 0\.7|xingtu_price \* 0\.7/.test(drawerSource)
    )
    check(
      '试算器不修改「我的决定」（不调用 setHumanDecision）',
      !/setHumanDecision\([^)]*\)[\s\S]{0,120}simulatorRate/.test(drawerSource) &&
        /onChange=\{\(value\) => setSimulatorRate\(/.test(drawerSource)
    )
    check('试算器滑块范围/步长来自常量', /min=\{SIMULATOR_MIN_RATE \* 100\}/.test(drawerSource) && /max=\{SIMULATOR_MAX_RATE \* 100\}/.test(drawerSource) && /step=\{SIMULATOR_STEP_RATE \* 100\}/.test(drawerSource))
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
