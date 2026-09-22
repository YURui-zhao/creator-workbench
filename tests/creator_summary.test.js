#!/usr/bin/env node
/**
 * 达人汇总增强回归测试
 *
 * 运行方式：node tests/creator_summary.test.js
 * 特性：不启动服务、不打开浏览器；直接驱动 creator-summary 路由 handler（只读，不改数据库）
 * 覆盖：keyword / minCampaigns / 新增统计字段 / 新增排序 / 参数校验 / 对比边界 / 导出内容一致性
 */
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

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

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const layer = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/creator-summary' && item.route.methods.get
  )
  const handler = layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  check('creator-summary handler 可用', typeof handler === 'function')

  const call = async (query) => {
    const res = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        this.payload = body
        return this
      }
    }
    await handler({ query }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg }
  }

  console.log('===== 1. 默认行为（不传新参数，保持原有结构）=====')
  const base = await call({})
  check('默认返回 200', base.status === 200)
  check(
    '原有字段全部保留',
    ['caliber', 'groupByType', 'range', 'filters', 'groups', 'total_summary'].every((key) => key in base.data),
    JSON.stringify(Object.keys(base.data))
  )
  check(
    'total_summary 原有字段保留',
    ['creator_count', 'total_campaigns', 'total_cost', 'total_play', 'avg_cpm'].every(
      (key) => key in base.data.total_summary
    ),
    JSON.stringify(Object.keys(base.data.total_summary))
  )
  const firstCreator = base.data.creators[0]
  check(
    '达人字段含原有 + 新增三列',
    ['nickname', 'creator_type', 'total_campaigns', 'total_cost', 'total_play', 'avg_cpm', 'hit_count', 'avg_play', 'repeat_count'].every(
      (key) => key in firstCreator
    ),
    JSON.stringify(Object.keys(firstCreator))
  )
  check('默认排序 = 总花费降序', base.data.sort.sortBy === 'total_cost' && base.data.sort.sortOrder === 'desc')
  const costs = base.data.creators.map((item) => item.total_cost)
  check('默认排序结果确实降序', costs.every((value, i) => i === 0 || costs[i - 1] >= value), JSON.stringify(costs.slice(0, 5)))

  console.log('\n===== 2. 新增统计字段计算正确性 =====')
  const byName = Object.fromEntries(base.data.creators.map((item) => [item.nickname, item]))
  const travel = byName['旅行小李']
  check('hit_count 爆款数正确（首发 15 万 → 1）', travel?.hit_count === 1, JSON.stringify(travel))
  check(
    'avg_play = total_play / total_campaigns（保留 1 位小数）',
    travel?.avg_play === Number((travel.total_play / travel.total_campaigns).toFixed(1)),
    `avg_play=${travel?.avg_play}`
  )
  check('repeat_count = 投放次数 - 1（单次投放 → 0）', travel?.repeat_count === travel.total_campaigns - 1)
  const expectedHits = base.data.creators.reduce((sum, item) => sum + item.hit_count, 0)
  check('total_summary.total_hits = 各达人爆款数之和', base.data.total_summary.total_hits === expectedHits, `hits=${expectedHits}`)
  const recordCount = base.data.total_summary.record_count
  check(
    'total_summary.hit_rate = 爆款总数 / 记录总数 × 100（1 位小数）',
    base.data.total_summary.hit_rate === Number(((expectedHits / recordCount) * 100).toFixed(1)),
    `hit_rate=${base.data.total_summary.hit_rate} (hits=${expectedHits}, records=${recordCount})`
  )

  console.log('\n===== 3. keyword 模糊搜索 =====')
  const kw = await call({ keyword: '大熊' })
  check('keyword 命中单个达人', kw.status === 200 && kw.data.creators.length === 1 && kw.data.creators[0].nickname === '健身大熊', JSON.stringify(kw.data.creators.map((c) => c.nickname)))
  const kwEmpty = await call({ keyword: '' })
  check('keyword 空串返回全部（与默认一致）', kwEmpty.data.creators.length === base.data.creators.length)
  const kwMiss = await call({ keyword: '__不存在的达人__' })
  check('keyword 无匹配返回空列表', kwMiss.status === 200 && kwMiss.data.creators.length === 0 && kwMiss.data.total_summary.creator_count === 0)
  const kwLike = await call({ keyword: '_' })
  check('keyword 通配符被转义（_ 不当通配匹配）', kwLike.status === 200, `命中 ${kwLike.data.creators.length} 条`)
  const kwLong = await call({ keyword: 'x'.repeat(51) })
  check('keyword 超过 50 返回 400', kwLong.status === 400 && kwLong.msg.includes('50'), kwLong.msg)

  console.log('\n===== 4. minCampaigns 最小投放次数 =====')
  const min2 = await call({ minCampaigns: '2' })
  check(
    'minCampaigns=2 只保留投放次数 >= 2 的达人',
    min2.status === 200 && min2.data.creators.every((item) => item.total_campaigns >= 2),
    `达人数 ${min2.data.creators.length}`
  )
  const min1 = await call({ minCampaigns: '1' })
  check('minCampaigns=1 与不限等价', min1.data.creators.length === base.data.creators.length)
  const minBad = await call({ minCampaigns: '0' })
  check('minCampaigns=0 返回 400', minBad.status === 400, minBad.msg)
  const minBad2 = await call({ minCampaigns: 'abc' })
  check('minCampaigns 非整数返回 400', minBad2.status === 400, minBad2.msg)

  console.log('\n===== 5. 新增排序字段 =====')
  const sortCases = [
    ['hit_count', 'desc'],
    ['hit_count', 'asc'],
    ['avg_play', 'asc'],
    ['repeat_count', 'desc'],
    ['avg_cpm', 'asc']
  ]
  for (const [sortBy, sortOrder] of sortCases) {
    const res = await call({ sortBy, sortOrder })
    const values = res.data.creators.map((item) => item[sortBy]).filter((v) => v !== null && v !== undefined)
    const sorted = values.every((value, i) => {
      if (i === 0) return true
      return sortOrder === 'asc' ? values[i - 1] <= value : values[i - 1] >= value
    })
    check(`排序 ${sortBy} ${sortOrder} 生效`, res.status === 200 && sorted, JSON.stringify(values.slice(0, 5)))
  }
  const badSortBy = await call({ sortBy: 'nickname' })
  check('非法 sortBy 返回 400', badSortBy.status === 400 && badSortBy.msg.includes('sortBy'), badSortBy.msg)
  const badOrder = await call({ sortOrder: 'up' })
  check('非法 sortOrder 返回 400', badOrder.status === 400 && badOrder.msg.includes('sortOrder'), badOrder.msg)

  console.log('\n===== 6. 与分组/口径联动 =====')
  const grouped = await call({ creatorTypes: ['历史类'], sortBy: 'hit_count', sortOrder: 'desc' })
  check(
    '博主类型筛选 + 排序联动正常',
    grouped.data.groups.length === 1 && grouped.data.groups[0].creator_type === '历史类',
    `groups=${grouped.data.groups.length}`
  )
  const campaign = await call({ caliber: 'campaign' })
  const occurrence = await call({ caliber: 'occurrence' })
  check(
    '口径切换仍返回新字段（花费一致、播放不同）',
    campaign.data.total_summary.total_cost === occurrence.data.total_summary.total_cost &&
      campaign.data.creators.every((item) => 'hit_count' in item && 'avg_play' in item),
    `cost=${campaign.data.total_summary.total_cost}`
  )

  console.log('\n===== 7. 达人对比边界（2 / 5 / 1 / 6 位）=====')
  const compareModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/creatorCompare.js')).href
  )
  const { canCompareCreators, buildCompareRows } = compareModule
  check('勾选 1 位 → 不可对比并提示', canCompareCreators(1).ok === false && canCompareCreators(1).reason.includes('至少'))
  check('勾选 2 位 → 可对比', canCompareCreators(2).ok === true)
  check('勾选 5 位 → 可对比', canCompareCreators(5).ok === true)
  check('勾选 6 位 → 不可对比并提示', canCompareCreators(6).ok === false && canCompareCreators(6).reason.includes('最多'))
  const allCreators = base.data.creators
  const pick5 = allCreators.slice(0, 5).map((item) => item.nickname)
  const compareRows = buildCompareRows(allCreators, pick5)
  check('对比数据按总花费降序', compareRows.every((item, i) => i === 0 || compareRows[i - 1].total_cost >= item.total_cost), JSON.stringify(compareRows.map((r) => r.total_cost)))
  check('对比只包含所选达人', compareRows.length === 5 && compareRows.every((item) => pick5.includes(item.nickname)))

  console.log('\n===== 8. 导出内容与页面一致（含新增三列）=====')
  const excelModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/src/utils/excel.js')).href
  )
  const xlsx = await import(
    pathToFileURL(path.join(REPO_ROOT, 'frontend/node_modules/xlsx/xlsx.mjs')).href
  )
  const outFile = path.join(REPO_ROOT, 'outputs', '__creator_summary_test.xlsx')
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const exported = excelModule.exportCreatorStatsToExcel(compareRows.slice(0, 3), {
    fileName: outFile,
    sheetName: '达人明细'
  })
  const workbook = xlsx.read(fs.readFileSync(outFile), { type: 'buffer' })
  const sheetRows = xlsx.utils.sheet_to_json(workbook.Sheets['达人明细'], { defval: '' })
  check('导出行数与所选达人一致', exported === 3 && sheetRows.length === 3, `exported=${exported} rows=${sheetRows.length}`)
  check(
    '导出表头包含新增三列',
    ['爆款数', '平均单条播放', '复投次数'].every((key) => key in sheetRows[0]),
    Object.keys(sheetRows[0]).join('|')
  )
  check(
    '导出数值与接口一致',
    String(sheetRows[0]['达人昵称']) === compareRows[0].nickname &&
      Number(sheetRows[0]['爆款数']) === compareRows[0].hit_count &&
      String(sheetRows[0]['平均CPM']) === compareRows[0].avg_cpm.toFixed(2),
    JSON.stringify(sheetRows[0])
  )
  fs.unlinkSync(outFile)

  const total = passCount + failCount
  const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
  console.log('\n================ 测试汇总 ================')
  console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
  if (failCount > 0) {
    console.log('\n失败用例：')
    failures.forEach((item) => console.log(` - ${item}`))
  }
  process.exitCode = failCount > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
