#!/usr/bin/env node
/**
 * 复投雷达（V3-alpha P1）回归测试
 *
 * 运行方式：node tests/repurchase_radar.test.js
 * 隔离方式：通过 WORKBENCH_DB_PATH 指向临时数据库（必须先于 import backend/db.js 设置），
 *          测试自行 seed 固定数据集，结束后删除临时库；用户真实库（backend/workbench.db）不被触碰。
 * 特性：不启动服务、不访问网络、不调用 AI；直接驱动只读 route handler。
 *
 * 覆盖：单次达标判定 / 有效样本语义（null、0、latest<first 异常）/ 历史状态规则 /
 *      中位数（奇数与偶数）/ 最近 2 次失准风险 / 分组与确定性排序 / 只读与日期参数边界。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const REPO_ROOT = path.resolve(__dirname, '..')

// —— 隔离数据库：必须在 import backend/db.js 之前设置
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'repurchase-radar-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')
// 允许测试注入 current_date（生产环境该参数会被忽略）
process.env.WORKBENCH_TEST_MODE = '1'

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

const REFERENCE_DATE = '2026-09-28'

/**
 * 固定数据集（全部为「累计播放量 = 100000」的整数 CPM 场景，便于手算断言）
 * [time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play]
 */
const SEED = [
  // 雷达甲：3 次 18 / 27 / 46 → passed 2/3；另验证同昵称不同类型时取首条类型（数码）
  ['2026-W33', '雷达甲', '数码', 1800, '2026-08-18', 20000, 100000],
  ['2026-W34', '雷达甲', '美妆', 2700, '2026-08-25', 20000, 100000],
  ['2026-W35', '雷达甲', '美妆', 4600, '2026-09-01', 20000, 100000],
  // 雷达乙：5 次 22 / 26 / 29 / 41 / 48 → passed 3/5（最近 2 次均 > 30 → 风险提示）
  ['2026-W33', '雷达乙', '财经类', 2200, '2026-08-10', 20000, 100000],
  ['2026-W34', '雷达乙', '财经类', 2600, '2026-08-17', 20000, 100000],
  ['2026-W35', '雷达乙', '财经类', 2900, '2026-08-24', 20000, 100000],
  ['2026-W36', '雷达乙', '财经类', 4100, '2026-08-31', 20000, 100000],
  ['2026-W37', '雷达乙', '财经类', 4800, '2026-09-07', 20000, 100000],
  // 雷达丙：4 次 19 / 25 / 38 / 45 → mixed 2/2（偶数样本中位数 = 32）
  ['2026-W33', '雷达丙', '历史类', 1900, '2026-08-11', 20000, 100000],
  ['2026-W34', '雷达丙', '历史类', 2500, '2026-08-18', 20000, 100000],
  ['2026-W35', '雷达丙', '历史类', 3800, '2026-08-25', 20000, 100000],
  ['2026-W36', '雷达丙', '历史类', 4500, '2026-09-01', 20000, 100000],
  // 雷达丁：3 次 22 / 41 / 55 → failed 1/2（最近 2 次均 > 30）
  ['2026-W33', '雷达丁', '数码', 2200, '2026-08-12', 20000, 100000],
  ['2026-W34', '雷达丁', '数码', 4100, '2026-08-19', 20000, 100000],
  ['2026-W35', '雷达丁', '数码', 5500, '2026-08-26', 20000, 100000],
  // 雷达戊：仅 1 次 CPM 24 → insufficient（唯一一次达标也不算历史通过）
  ['2026-W33', '雷达戊', '个人成长类', 2400, '2026-08-13', 20000, 100000],
  // 雷达己：1 条 latest=null（未观察，不得当作 0）+ 1 条 CPM 20 → 有效样本 1 → insufficient
  ['2026-W33', '雷达己', '科普类', 5000, '2026-08-20', 10000, null],
  ['2026-W34', '雷达己', '科普类', 2000, '2026-08-27', 20000, 100000],
  // 雷达庚：1 条 latest=0（真实观测但 CPM 无定义）+ 1 条 CPM 25 → 有效样本 1 → insufficient
  ['2026-W33', '雷达庚', '科普类', 3000, '2026-08-21', 0, 0],
  ['2026-W34', '雷达庚', '科普类', 1000, '2026-08-28', 0, 40000],
  // 雷达辛：latest < first（异常）→ 不进入有效 CPM 判断，也不计入未达标
  ['2026-W33', '雷达辛', '历史类', 5000, '2026-08-22', 120000, 90000],
  // 雷达壬：5 次 10 / 12 / 14 / 40 / 50 → passed 3/2，但最近 2 次均 > 30（风险提示不得篡改历史状态）
  ['2026-W33', '雷达壬', '财经类', 1000, '2026-08-05', 20000, 100000],
  ['2026-W34', '雷达壬', '财经类', 1200, '2026-08-12', 20000, 100000],
  ['2026-W35', '雷达壬', '财经类', 1400, '2026-08-19', 20000, 100000],
  ['2026-W36', '雷达壬', '财经类', 4000, '2026-08-26', 20000, 100000],
  ['2026-W37', '雷达壬', '财经类', 5000, '2026-09-02', 20000, 100000],
  // 边界达人：CPM 30.00（达标边界，含等号）+ 30.01（未达标）→ mixed 1/1
  ['2026-W34', '边界达人', '数码', 3000, '2026-08-15', 20000, 100000],
  ['2026-W35', '边界达人', '数码', 3001, '2026-08-29', 20000, 100000],
  // 排序验证：中位数 25 但最近合作更久的排序丙 应排在 中位数 25 且最近合作的排序甲 之前
  ['2026-W33', '排序乙', '数码', 1800, '2026-09-05', 20000, 100000],
  ['2026-W34', '排序乙', '数码', 2200, '2026-09-05', 20000, 100000],
  ['2026-W32', '排序丙', '数码', 2300, '2026-08-01', 20000, 100000],
  ['2026-W33', '排序丙', '数码', 2700, '2026-08-01', 20000, 100000],
  ['2026-W35', '排序甲', '数码', 2400, '2026-09-03', 20000, 100000],
  ['2026-W36', '排序甲', '数码', 2600, '2026-09-03', 20000, 100000],
  // 无发布日期达人：不影响 CPM 判定，但「最近合作日期 / 距今天数」为 null
  ['2026-W34', '无日期达人', '美妆', 2000, null, 20000, 100000],
  ['2026-W35', '无日期达人', '美妆', 2500, null, 20000, 100000],
  // ---------- 精度边界（raw CPM 判定 / raw 中位数）----------
  // 精度甲：raw CPM 30.004（展示 round2 = 30.00）→ 必须 fail（旧实现会误判达标）
  ['2026-W35', '精度甲', '数码', 3000.4, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度甲', '数码', 3000.4, '2026-09-06', 20000, 100000],
  // 精度乙：raw CPM 29.999（展示 round2 = 30.00）→ 必须 pass
  ['2026-W35', '精度乙', '数码', 2999.9, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度乙', '数码', 2999.9, '2026-09-06', 20000, 100000],
  // 精度丙：raw 10.0000 与 10.0103 → raw 中位数 10.00515 → 10.01（逐条 round2 再取中位数会得到 10.00）
  ['2026-W35', '精度丙', '美妆', 1000, '2026-08-30', 20000, 100000],
  ['2026-W36', '精度丙', '美妆', 1001.03, '2026-09-06', 20000, 100000],
  // 精度丁：最近 2 次 raw CPM 均为 30.004（展示 30.00）→ recent_risk 必须为 true（用展示值判断会漏报）
  ['2026-W34', '精度丁', '历史类', 1000, '2026-08-19', 20000, 100000],
  ['2026-W35', '精度丁', '历史类', 3000.4, '2026-08-26', 20000, 100000],
  ['2026-W36', '精度丁', '历史类', 3000.4, '2026-09-02', 20000, 100000],
  // ---------- 排序精度：raw 中位数不同、展示值相同 ----------
  // 排序精度A：raw 中位数 20.004（展示 20.00），但距上次合作更久
  ['2026-W35', '排序精度A', '数码', 2000.4, '2026-08-01', 20000, 100000],
  ['2026-W36', '排序精度A', '数码', 2000.4, '2026-08-01', 20000, 100000],
  // 排序精度B：raw 中位数 20.001（展示同样是 20.00），距上次合作更近 → 仍必须排在 A 之前
  ['2026-W35', '排序精度B', '数码', 2000.1, '2026-09-05', 20000, 100000],
  ['2026-W36', '排序精度B', '数码', 2000.1, '2026-09-05', 20000, 100000]
]

function localToday() {
  const now = new Date()
  const pad = (num) => String(num).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function main() {
  const recordsModule = await import(
    pathToFileURL(path.join(REPO_ROOT, 'backend/routes/records.js')).href
  )
  const db = (await import(pathToFileURL(path.join(REPO_ROOT, 'backend/db.js')).href)).default

  const layer = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/repurchase-radar' && item.route.methods.get
  )
  const handler = layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
  const radarRoute = recordsModule.default.stack.find(
    (item) => item.route && item.route.path === '/repurchase-radar'
  )
  check('repurchase-radar GET handler 可用', typeof handler === 'function')
  check(
    'repurchase-radar 只注册 GET（没有写接口）',
    Boolean(radarRoute) && Object.keys(radarRoute.route.methods).join(',') === 'get',
    radarRoute ? Object.keys(radarRoute.route.methods).join(',') : 'route missing'
  )

  // 写入固定数据集（隔离库，不影响用户真实库）
  const insert = db.prepare(
    `INSERT INTO creator_records
       (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  db.transaction(() => {
    for (const row of SEED) insert.run(...row)
  })()
  const seededCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  check(`隔离库 seed 完成（${SEED.length} 条）`, seededCount === SEED.length, `seeded=${seededCount}`)

  const callRoute = async (route, query) => {
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
      },
      setHeader() {
        return this
      },
      send() {}
    }
    await route({ query }, res)
    return { status: res.statusCode, data: res.payload?.data, msg: res.payload?.msg }
  }
  const call = (query = {}) => callRoute(handler, query)
  const byCreator = (group) => Object.fromEntries(group.map((item) => [item.creator, item]))

  console.log('\n===== 1. 结构 / 只读 / 日期参数 =====')
  const base = await call({ current_date: REFERENCE_DATE })
  check('当前目标 CPM = 30', base.data.target_cpm === 30, String(base.data.target_cpm))
  check('使用注入的参考日期（仅测试模式）', base.data.reference_date === REFERENCE_DATE)
  check(
    '返回三个分组且顺序为 优先关注 / 需要观察 / 暂不优先',
    base.data.groups.map((group) => `${group.key}:${group.label}`).join('|') ===
      'priority:优先关注|watch:需要观察|low_priority:暂不优先',
    JSON.stringify(base.data.groups.map((group) => group.key))
  )
  check(
    '汇总字段齐全',
    [
      'creator_count',
      'record_count',
      'valid_cpm_count',
      'priority_count',
      'watch_count',
      'low_priority_count'
    ].every((key) => key in base.data.summary),
    JSON.stringify(base.data.summary)
  )
  check(
    '分组数量与汇总一致',
    base.data.summary.priority_count === base.data.groups[0].count &&
      base.data.summary.watch_count === base.data.groups[1].count &&
      base.data.summary.low_priority_count === base.data.groups[2].count
  )
  check('总达人数 = 20', base.data.summary.creator_count === 20, String(base.data.summary.creator_count))
  check('总历史合作次数 = 49', base.data.summary.record_count === 49, String(base.data.summary.record_count))
  check('总有效 CPM 样本 = 46', base.data.summary.valid_cpm_count === 46, String(base.data.summary.valid_cpm_count))
  check(
    '分组数量 = 11 / 6 / 3',
    base.data.summary.priority_count === 11 &&
      base.data.summary.watch_count === 6 &&
      base.data.summary.low_priority_count === 3,
    `${base.data.summary.priority_count}/${base.data.summary.watch_count}/${base.data.summary.low_priority_count}`
  )
  const rawJson = JSON.stringify(base.data)
  check('响应中不含 NaN / Infinity', !/NaN|Infinity/.test(rawJson))
  check(
    'API 不暴露 raw 中位数（medianCpmRaw / cpmRaw 均为内部字段）',
    !rawJson.includes('medianCpmRaw') && !rawJson.includes('cpmRaw')
  )
  check(
    '每次合作都只统计在所属达人下（记录数守恒）',
    base.data.groups.reduce(
      (sum, group) => sum + group.creators.reduce((acc, item) => acc + item.record_count, 0),
      0
    ) === SEED.length
  )
  check(
    '每条达人数据字段齐全',
    base.data.groups.every((group) =>
      group.creators.every((item) =>
        [
          'creator',
          'creator_type',
          'record_count',
          'valid_cpm_count',
          'pass_count',
          'fail_count',
          'historical_status',
          'historical_status_label',
          'median_cpm',
          'last_collaboration_date',
          'days_since_last_collaboration',
          'recent_risk'
        ].every((key) => key in item)
      )
    )
  )

  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  await call({ current_date: REFERENCE_DATE })
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
  check('接口只读：调用前后 creator_records 记录数不变', beforeCount === afterCount, `${beforeCount} -> ${afterCount}`)
  check(
    '接口只读：未写入批次日志（import_batches 仍为 0）',
    db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === 0
  )

  const priority = base.data.groups[0].creators
  const watch = base.data.groups[1].creators
  const lowPriority = base.data.groups[2].creators
  const inPriority = byCreator(priority)
  const inWatch = byCreator(watch)
  const inLow = byCreator(lowPriority)

  console.log('\n===== 2. 单次达标与历史状态规则（3 次 18 / 27 / 46 → passed 2/3）=====')
  const jia = inPriority['雷达甲']
  check('雷达甲 历史合作 = 3', jia?.record_count === 3, String(jia?.record_count))
  check('雷达甲 有效 CPM 样本 = 3', jia?.valid_cpm_count === 3, String(jia?.valid_cpm_count))
  check('雷达甲 达标 2 / 未达标 1', jia?.pass_count === 2 && jia?.fail_count === 1)
  check('雷达甲 historical_status = passed', jia?.historical_status === 'passed', jia?.historical_status)
  check('雷达甲 中位数 = 27（奇数样本）', jia?.median_cpm === 27, String(jia?.median_cpm))
  check(
    '雷达甲 同昵称不同类型时取首条类型（数码）',
    jia?.creator_type === '数码',
    jia?.creator_type
  )

  console.log('\n===== 3. 5 次 22 / 26 / 29 / 41 / 48 → passed 3/5 =====')
  const yi = inPriority['雷达乙']
  check('雷达乙 达标 3 / 未达标 2', yi?.pass_count === 3 && yi?.fail_count === 2)
  check('雷达乙 historical_status = passed', yi?.historical_status === 'passed', yi?.historical_status)
  check('雷达乙 中位数 = 29', yi?.median_cpm === 29, String(yi?.median_cpm))

  console.log('\n===== 4. 4 次 19 / 25 / 38 / 45 → mixed（平局不是平均值决胜）=====')
  const bing = inWatch['雷达丙']
  check('雷达丙 达标 2 / 未达标 2', bing?.pass_count === 2 && bing?.fail_count === 2)
  check('雷达丙 historical_status = mixed', bing?.historical_status === 'mixed', bing?.historical_status)
  check(
    '雷达丙 中位数 = 31.5（偶数样本取中间两项 25 / 38 的平均）',
    bing?.median_cpm === 31.5,
    String(bing?.median_cpm)
  )

  console.log('\n===== 5. 3 次 22 / 41 / 55 → failed =====')
  const ding = inLow['雷达丁']
  check('雷达丁 达标 1 / 未达标 2', ding?.pass_count === 1 && ding?.fail_count === 2)
  check('雷达丁 historical_status = failed', ding?.historical_status === 'failed', ding?.historical_status)
  check('雷达丁 位于「暂不优先」分组', Boolean(ding) && !inPriority['雷达丁'] && !inWatch['雷达丁'])

  console.log('\n===== 6. 仅 1 次 CPM 24 → insufficient（不得进入 passed）=====')
  const wu = inWatch['雷达戊']
  check('雷达戊 有效样本 = 1', wu?.valid_cpm_count === 1, String(wu?.valid_cpm_count))
  check('雷达戊 达标次数仍记录为 1', wu?.pass_count === 1, String(wu?.pass_count))
  check('雷达戊 historical_status = insufficient', wu?.historical_status === 'insufficient', wu?.historical_status)
  check('雷达戊 不在「优先关注」分组', !inPriority['雷达戊'])

  console.log('\n===== 7. latest = null → 不进入有效 CPM 分母 =====')
  const ji = inWatch['雷达己']
  check('雷达己 历史合作 = 2（未观察记录仍计入合作次数）', ji?.record_count === 2, String(ji?.record_count))
  check('雷达己 有效 CPM 样本 = 1（null 不算 0）', ji?.valid_cpm_count === 1, String(ji?.valid_cpm_count))
  check('雷达己 historical_status = insufficient', ji?.historical_status === 'insufficient', ji?.historical_status)

  console.log('\n===== 8. latest = 0 保持 V2 语义（真实观测但 CPM 无定义）=====')
  const geng = inWatch['雷达庚']
  check('雷达庚 历史合作 = 2', geng?.record_count === 2, String(geng?.record_count))
  check('雷达庚 有效 CPM 样本 = 1（latest=0 不参与 CPM）', geng?.valid_cpm_count === 1, String(geng?.valid_cpm_count))
  check('雷达庚 中位数 = 25（仅真实有效样本）', geng?.median_cpm === 25, String(geng?.median_cpm))
  check(
    '雷达庚 未被误判为「未达标」',
    geng?.fail_count === 0 && geng?.pass_count === 1,
    `pass=${geng?.pass_count} fail=${geng?.fail_count}`
  )

  console.log('\n===== 9. latest < first 异常 → 不进入累计 CPM 判断 =====')
  const xin = inWatch['雷达辛']
  check('雷达辛 历史合作 = 1', xin?.record_count === 1, String(xin?.record_count))
  check('雷达辛 有效 CPM 样本 = 0', xin?.valid_cpm_count === 0, String(xin?.valid_cpm_count))
  check('雷达辛 不计入达标也不计入未达标', xin?.pass_count === 0 && xin?.fail_count === 0)
  check('雷达辛 中位数为 null（不是 0）', xin?.median_cpm === null, String(xin?.median_cpm))
  check('雷达辛 historical_status = insufficient', xin?.historical_status === 'insufficient', xin?.historical_status)

  console.log('\n===== 10. 达标边界（CPM = 30 达标，30.01 未达标）=====')
  const boundary = inWatch['边界达人']
  check(
    '边界达人 达标 1（30.00 含等号）/ 未达标 1',
    boundary?.pass_count === 1 && boundary?.fail_count === 1,
    `pass=${boundary?.pass_count} fail=${boundary?.fail_count}`
  )
  check('边界达人 historical_status = mixed', boundary?.historical_status === 'mixed', boundary?.historical_status)

  console.log('\n===== 11. 最近 2 次均未达标 → recent_risk（不得篡改历史状态）=====')
  check('雷达乙 recent_risk = true', yi?.recent_risk === true)
  check('雷达乙 历史状态仍为 passed', yi?.historical_status === 'passed', yi?.historical_status)
  check('雷达乙 风险文案存在', yi?.recent_risk_text === '最近2次合作均未达到 CPM 30', yi?.recent_risk_text)
  const ren = inPriority['雷达壬']
  check('雷达壬 达标 3 / 未达标 2', ren?.pass_count === 3 && ren?.fail_count === 2)
  check('雷达壬 最近 2 次失准 → recent_risk = true', ren?.recent_risk === true)
  check('雷达壬 历史状态仍为 passed（风险提示不改资格）', ren?.historical_status === 'passed', ren?.historical_status)
  check('雷达甲 最近 2 次含达标 → recent_risk = false', jia?.recent_risk === false)
  check('雷达丁 最近 2 次均失准 → recent_risk = true', ding?.recent_risk === true)
  check('雷达戊 样本不足 → recent_risk = false', wu?.recent_risk === false)

  console.log('\n===== 12. 分组排序（中位 CPM 升序 → 距上次合作更久优先）=====')
  const medians = priority.map((item) => item.median_cpm)
  check(
    '「优先关注」中位 CPM 升序（null 排最后）',
    medians.every((value, i) => {
      if (i === 0) return true
      const prev = medians[i - 1]
      if (prev === null || prev === undefined) return value === null || value === undefined
      if (value === null || value === undefined) return true
      return prev <= value
    }),
    JSON.stringify(medians)
  )
  const indexOfPriority = (name) => priority.findIndex((item) => item.creator === name)
  check(
    '中位数更低者优先（排序乙 20 < 排序丙/排序甲 25）',
    indexOfPriority('排序乙') >= 0 &&
      indexOfPriority('排序乙') < indexOfPriority('排序丙') &&
      indexOfPriority('排序乙') < indexOfPriority('排序甲'),
    `乙=${indexOfPriority('排序乙')} 丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )
  check(
    '中位数相同则距上次合作更久者优先（排序丙 08-01 早于 排序甲 09-03）',
    indexOfPriority('排序丙') < indexOfPriority('排序甲'),
    `丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )
  const sameMedianPair = [inPriority['排序丙'], inPriority['排序甲']]
  check(
    '排序依据可复现（中位数相同、距今更久更大）',
    sameMedianPair[0]?.median_cpm === sameMedianPair[1]?.median_cpm &&
      sameMedianPair[0]?.days_since_last_collaboration >
        sameMedianPair[1]?.days_since_last_collaboration
  )
  const secondCall = await call({ current_date: REFERENCE_DATE })
  check(
    '两次调用顺序完全一致（稳定排序）',
    JSON.stringify(secondCall.data.groups) === JSON.stringify(base.data.groups)
  )
  check(
    '「需要观察」内 mixed 先于 insufficient',
    watch.findIndex((item) => item.historical_status === 'insufficient') >
      watch.findIndex((item) => item.historical_status === 'mixed')
  )

  console.log('\n===== 12c. 排序精度：raw 中位数不同但展示值相同 =====')
  const sortA = inPriority['排序精度A']
  const sortB = inPriority['排序精度B']
  check(
    '排序精度A 展示 20.00（raw 中位数 20.004）',
    sortA?.median_cpm === 20,
    String(sortA?.median_cpm)
  )
  check(
    '排序精度B 展示 20.00（raw 中位数 20.001）',
    sortB?.median_cpm === 20,
    String(sortB?.median_cpm)
  )
  check(
    '两者展示值完全相同（旧实现会把它们视为并列）',
    sortA?.median_cpm === sortB?.median_cpm,
    `${sortA?.median_cpm} / ${sortB?.median_cpm}`
  )
  check(
    '排序精度A 距上次合作确实更久',
    sortA?.days_since_last_collaboration > sortB?.days_since_last_collaboration,
    `${sortA?.days_since_last_collaboration} 天 vs ${sortB?.days_since_last_collaboration} 天`
  )
  check(
    'raw 中位数更低的 排序精度B 排在 排序精度A 之前（不受距今天数影响）',
    indexOfPriority('排序精度B') < indexOfPriority('排序精度A'),
    `B=${indexOfPriority('排序精度B')} A=${indexOfPriority('排序精度A')}`
  )
  const priorityOrderNames = priority.map((item) => item.creator)
  check(
    '排序精度B 与 排序精度A 相邻且 B 在前（两者之间没有其他达人插队）',
    Math.abs(indexOfPriority('排序精度B') - indexOfPriority('排序精度A')) === 1 &&
      priorityOrderNames[indexOfPriority('排序精度B') + 1] === '排序精度A',
    JSON.stringify(priorityOrderNames.slice(0, 6))
  )
  check(
    'raw 中位数完全相同时才按距上次合作降序（排序丙 23/27 与 排序甲 24/26 raw 中位数均为 25）',
    inPriority['排序丙']?.median_cpm === inPriority['排序甲']?.median_cpm &&
      indexOfPriority('排序丙') < indexOfPriority('排序甲') &&
      inPriority['排序丙']?.days_since_last_collaboration >
        inPriority['排序甲']?.days_since_last_collaboration,
    `丙=${indexOfPriority('排序丙')} 甲=${indexOfPriority('排序甲')}`
  )

  console.log('\n===== 12b. 精度边界：raw CPM 判定 / raw 中位数（禁止先 round2）=====')
  const round2 = (value) => Number(value.toFixed(2))

  // 1) raw CPM 30.004：展示会被 round2 成 30.00，但必须判 fail
  const raw30004 = recordsModule.computeRecordLatestCpm({
    total_cost: 3000.4,
    first_play: 20000,
    second_week_play: 100000
  })
  check(
    'helper 返回 raw CPM（30.004 未被 round2）',
    raw30004 > 30 && raw30004 !== 30,
    String(raw30004)
  )
  check('raw 30.004 的展示值确为 30.00', Number(raw30004.toFixed(2)) === 30, raw30004.toFixed(2))
  const jingJia = inLow['精度甲']
  check(
    '精度甲（2 次 raw 30.004）→ 0 达标 / 2 未达标（禁止被展示值误判为达标）',
    jingJia?.pass_count === 0 && jingJia?.fail_count === 2,
    `pass=${jingJia?.pass_count} fail=${jingJia?.fail_count}`
  )
  check('精度甲 historical_status = failed', jingJia?.historical_status === 'failed', jingJia?.historical_status)
  check(
    '精度甲 median_cpm 输出仍是 30（页面展示 30.00）',
    jingJia?.median_cpm === 30,
    String(jingJia?.median_cpm)
  )

  // 2) raw CPM 29.999：展示同样 30.00，但必须判 pass
  const raw29999 = recordsModule.computeRecordLatestCpm({
    total_cost: 2999.9,
    first_play: 20000,
    second_week_play: 100000
  })
  check('helper 返回 raw CPM（29.999 未被 round2）', raw29999 < 30, String(raw29999))
  check('raw 29.999 的展示值确为 30.00', Number(raw29999.toFixed(2)) === 30, raw29999.toFixed(2))
  const jingYi = inPriority['精度乙']
  check(
    '精度乙（2 次 raw 29.999）→ 2 达标 / 0 未达标',
    jingYi?.pass_count === 2 && jingYi?.fail_count === 0,
    `pass=${jingYi?.pass_count} fail=${jingYi?.fail_count}`
  )
  check('精度乙 historical_status = passed', jingYi?.historical_status === 'passed', jingYi?.historical_status)
  check(
    '精度甲 / 精度乙 展示值同为 30 但判定相反（证明判定基于 raw）',
    jingJia?.median_cpm === 30 &&
      jingYi?.median_cpm === 30 &&
      jingJia?.historical_status === 'failed' &&
      jingYi?.historical_status === 'passed'
  )

  // 3) 中位数：raw 中位数后 round2 ≠（先逐条 round2 再取中位数）
  const rawLow = (1000 / 100000) * 1000 // 10.0000
  const rawHigh = (1001.03 / 100000) * 1000 // 10.0103
  const medianRawThenRound = round2((rawLow + rawHigh) / 2) // 10.00515 → 10.01
  const medianOfRounded = round2((round2(rawLow) + round2(rawHigh)) / 2) // (10.00 + 10.01)/2 → 10.00
  check(
    '构造案例确实能区分两种中位数算法',
    medianRawThenRound !== medianOfRounded,
    `raw 中位数后 round2=${medianRawThenRound}　逐条 round2 后中位数=${medianOfRounded}`
  )
  const jingBing = inPriority['精度丙']
  check(
    '精度丙 median_cpm 采用 raw 中位数后 round2（10.01），不是 10.00',
    jingBing?.median_cpm === medianRawThenRound && jingBing?.median_cpm === 10.01,
    `median_cpm=${jingBing?.median_cpm}`
  )

  // 4) recent_risk 同样基于 raw CPM
  const jingDing = inLow['精度丁']
  check(
    '精度丁 达标 1 / 未达标 2（首条 raw 10.00 达标）',
    jingDing?.pass_count === 1 && jingDing?.fail_count === 2,
    `pass=${jingDing?.pass_count} fail=${jingDing?.fail_count}`
  )
  check(
    '精度丁 最近 2 次 raw 均 > 30（展示 30.00）→ recent_risk = true',
    jingDing?.recent_risk === true
  )
  check(
    '（防回归）raw 30.004 与展示值 30.00 的判定方向确实相反',
    raw30004 > 30 && round2(raw30004) <= 30,
    `raw=${raw30004} 展示=${round2(raw30004)}`
  )

  console.log('\n===== 13. 日期语义（publish_date / 距今天数 / 时区安全）=====')
  check(
    '雷达甲 最近合作日期 = 2026-09-01',
    jia?.last_collaboration_date === '2026-09-01',
    jia?.last_collaboration_date
  )
  check(
    '雷达甲 距上次合作 = 27 天（参考日 2026-09-28）',
    jia?.days_since_last_collaboration === 27,
    String(jia?.days_since_last_collaboration)
  )
  const noDate = inPriority['无日期达人']
  check('无 publish_date 达人：最近合作日期为 null', noDate?.last_collaboration_date === null)
  check('无 publish_date 达人：距今天数为 null', noDate?.days_since_last_collaboration === null)
  check(
    '无 publish_date 达人：CPM 判定不受影响（passed）',
    noDate?.historical_status === 'passed' && noDate?.median_cpm === 22.5,
    `${noDate?.historical_status}/${noDate?.median_cpm}`
  )
  const invalidDate = await call({ current_date: '2026-13-45' })
  check('测试模式下非法 current_date → 400', invalidDate.status === 400, String(invalidDate.status))

  delete process.env.WORKBENCH_TEST_MODE
  const productionCall = await call({ current_date: '2026-01-01' })
  check(
    '非测试模式：current_date 被忽略，使用服务端本地日期',
    productionCall.data.reference_date === localToday(),
    `${productionCall.data.reference_date} / today=${localToday()}`
  )
  process.env.WORKBENCH_TEST_MODE = '1'

  console.log('\n===== 14. 空数据边界 =====')
  db.prepare('DELETE FROM creator_records').run()
  const empty = await call({ current_date: REFERENCE_DATE })
  check(
    '空库：三个分组均为空且计数为 0',
    empty.data.groups.every((group) => group.count === 0 && group.creators.length === 0) &&
      empty.data.summary.creator_count === 0 &&
      empty.data.summary.record_count === 0
  )
}

main()
  .catch((error) => {
    console.error('测试执行异常：', error)
    process.exitCode = 1
  })
  .finally(() => {
    // 清理隔离数据库（含 WAL / SHM），用户真实库始终未被触碰
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
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
