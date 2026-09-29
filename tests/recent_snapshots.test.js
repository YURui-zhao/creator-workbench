#!/usr/bin/env node
/**
 * 近期表现快照（V3-alpha P2B）回归测试
 *
 * 运行方式：node tests/recent_snapshots.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— P2B 不调用 AI、不访问外部网络。
 *
 * 覆盖：schema/migration、append-only、creator 归属与身份确认、raw->valid->analysis 三层、
 *      median/P25/P75 插值、去极值、trend 阈值与边界、plays_json 可还原、radar 批量合并（无 N+1）、
 *      P1 规则不变、只读 creator_records、敏感字段不入库。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const frontend = path.join(root, 'frontend/src')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-snapshots-'))
process.env.WORKBENCH_DB_PATH = path.join(TMP_DIR, 'isolated.db')

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
      throw new Error('P2B test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('P2B test forbids network requests')
  }
  return {
    blocked,
    restore() {
      for (const [target, method, original] of originals) target[method] = original
      global.fetch = originalFetch
    }
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

const play = (raw_text, extra = {}) => ({
  raw_text,
  excluded: false,
  source_image_index: 1,
  position_index: 1,
  ...extra
})

// Alpha.2：observed_at 必填。默认观察日期仅用于「与 observed_at 语义无关」的既有用例；
// observed_at 专项语义在最后新增的小节中单独覆盖。
const DEFAULT_OBSERVED_AT = '2026-09-29'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const stats = await import(
      pathToFileURL(path.join(root, 'backend/utils/recentPerformanceStats.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const saveLib = await import(
      pathToFileURL(path.join(frontend, 'utils/recentPerformanceSave.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const snapshotRouter = snapshots.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const postHandler = findHandler(snapshotRouter, '/', 'post')
    const latestHandler = findHandler(snapshotRouter, '/latest', 'get')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')
    const createDecisionHandler = findHandler(decisions.default, '/', 'post')

    const callRoute = async (handler, { body = {}, query = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }
    // 对象 payload 自动带上 observed_at（Alpha.2 起必填）；数组等非法 body 原样透传，
    // 以便「请求体不是对象 → 400」这类既有断言仍然走原路径。
    const save = (payload, headers) => {
      const body =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { observed_at: DEFAULT_OBSERVED_AT, ...payload }
          : payload
      return callRoute(postHandler, { body, headers })
    }
    const latest = (creator) => callRoute(latestHandler, { query: { creator } })
    const radar = () => callRoute(radarHandler, { query: {} })

    console.log('===== 1. 表结构 / migration 行为 =====')
    const columns = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => c.name)
    const expectedColumns = [
      'id', 'creator', 'recognized_creator_name_raw', 'source_type', 'xingtu_price_raw',
      'xingtu_price', 'plays_json', 'recognized_count', 'valid_count', 'excluded_count',
      'unresolved_count', 'analysis_count', 'median_play', 'p25_play', 'p75_play',
      'recent_median_play', 'prior_median_play', 'trend_ratio', 'trend_label',
      'stats_status', 'stats_version', 'created_at', 'observed_at'
    ]
    check('creator_recent_snapshots 列齐全', expectedColumns.every((name) => columns.includes(name)), JSON.stringify(columns))
    // DDL 类型回归守卫：每列必须显式声明类型，禁止「逗号前共享类型」写法导致无类型列
    const columnTypes = Object.fromEntries(
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => [c.name, c.type])
    )
    check(
      'count 列类型均为 INTEGER',
      ['recognized_count', 'valid_count', 'excluded_count', 'unresolved_count', 'analysis_count'].every(
        (name) => columnTypes[name] === 'INTEGER'
      ),
      JSON.stringify(columnTypes)
    )
    check(
      '典型统计列类型均为 REAL',
      ['median_play', 'p25_play', 'p75_play'].every((name) => columnTypes[name] === 'REAL')
    )
    check(
      '趋势统计列类型均为 REAL',
      ['recent_median_play', 'prior_median_play', 'trend_ratio'].every(
        (name) => columnTypes[name] === 'REAL'
      )
    )
    check(
      '状态列类型均为 TEXT',
      ['trend_label', 'stats_status', 'stats_version', 'observed_at'].every((name) => columnTypes[name] === 'TEXT')
    )
    check(
      '没有任何列缺失类型声明',
      Object.values(columnTypes).every((type) => typeof type === 'string' && type.trim() !== ''),
      JSON.stringify(columnTypes)
    )
    const notNull = Object.fromEntries(
      db.prepare('PRAGMA table_info(creator_recent_snapshots)').all().map((c) => [c.name, c.notnull])
    )
    check(
      'count / 状态列 NOT NULL（统计列保持可空以便 insufficient）',
      ['recognized_count', 'valid_count', 'excluded_count', 'unresolved_count', 'analysis_count', 'trend_label', 'stats_status', 'stats_version'].every(
        (name) => notNull[name] === 1
      ) &&
        ['median_play', 'p25_play', 'p75_play', 'recent_median_play', 'prior_median_play', 'trend_ratio'].every(
          (name) => notNull[name] === 0
        ),
      JSON.stringify(notNull)
    )
    const indexes = db.prepare('PRAGMA index_list(creator_recent_snapshots)').all().map((i) => i.name)
    check('存在 creator + created_at 查询索引', indexes.includes('idx_recent_snapshots_creator_created'), JSON.stringify(indexes))
    check('新表初始为空（无可选手动保存）', db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots').get().n === 0)
    const v2Tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    check(
      'V2 表未被删除/重命名',
      ['creator_records', 'import_batches', 'import_batch_records', 'import_batch_items', 'projects'].every((name) => v2Tables.includes(name)),
      JSON.stringify(v2Tables)
    )
    check(
      'creator_records 列未变化',
      ['id', 'time_cycle', 'nickname', 'creator_type', 'total_cost', 'publish_date', 'first_play', 'second_week_play'].every((name) =>
        db.prepare('PRAGMA table_info(creator_records)').all().map((c) => c.name).includes(name)
      )
    )

    // 历史投放记录（radar 与 creator 归属校验都依赖它）
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const seedCreators = ['Gary', '甲达人', '乙达人', '丙达人', '丁达人', '戊达人']
    db.transaction(() => {
      for (const [index, nickname] of seedCreators.entries()) {
        insertRecord.run(`2026-W3${3 + (index % 2)}`, nickname, '数码', 1000 + index, '2026-08-20', 10000, 100000)
        insertRecord.run(`2026-W3${4 + (index % 2)}`, nickname, '数码', 2000 + index, '2026-08-27', 20000, 50000)
      }
    })()
    const recordsBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const recordsChecksumBefore = db
      .prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost, SUM(second_week_play) AS plays FROM creator_records')
      .get()

    console.log('\n===== 2. 保存 / append-only / latest =====')
    const first = await save({
      creator: 'Gary',
      recognized_creator_name_raw: 'Gary',
      xingtu_price_raw: '¥3,000',
      plays: [play('5.2万'), play('4.8万'), play('6.1万'), play('5.5万'), play('1万'), play('9000')]
    })
    check('首次保存返回 200', first.status === 200, JSON.stringify(first.msg))
    check('返回完整 public snapshot', Boolean(first.data?.id) && first.data.creator === 'Gary' && Array.isArray(first.data.plays))
    check('stats_version 正确保存', first.data?.stats_version === 'recent-performance-v1', String(first.data?.stats_version))
    check('source_type 固定 screenshot', first.data?.source_type === 'screenshot')

    const second = await save({
      creator: 'Gary',
      recognized_creator_name_raw: 'Gary',
      xingtu_price_raw: '3000元',
      plays: [play('6万'), play('7万'), play('8万'), play('9万'), play('10万'), play('11万')]
    })
    check('同达人第二次保存新增一条（append-only，不覆盖）', second.status === 200 && second.data.id !== first.data.id, `${first.data?.id} -> ${second.data?.id}`)
    check(
      '两条快照都存在且内容独立',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE creator = ?').get('Gary').n === 2 &&
        first.data.median_play !== second.data.median_play
    )
    const garyLatest = await latest('Gary')
    check('GET latest 返回真正最新的一条', garyLatest.status === 200 && garyLatest.data.snapshot?.id === second.data.id, `latest=${garyLatest.data?.snapshot?.id}`)
    check('无法达人的 latest 返回 null（不是错误）', (await latest('甲达人')).data?.snapshot === null)
    check('latest 缺少 creator → 400', (await latest('')).status === 400)

    console.log('\n===== 3. 后端重新解析（不信任前端派生值）=====')
    const tampered = await save({
      creator: '甲达人',
      recognized_creator_name_raw: '甲达人',
      xingtu_price_raw: '面议',
      plays: [
        { raw_text: '5.2万', normalized_play: 999999, excluded: false, source_image_index: 1, position_index: 1 },
        { raw_text: '3万', normalized_play: 1, excluded: false, source_image_index: 1, position_index: 2 },
        { raw_text: '4万', normalized_play: 2, excluded: false, source_image_index: 1, position_index: 3 },
        { raw_text: '5万', normalized_play: 3, excluded: false, source_image_index: 1, position_index: 4 },
        { raw_text: '6万', normalized_play: 4, excluded: false, source_image_index: 1, position_index: 5 },
        { raw_text: '7万', normalized_play: 5, excluded: false, source_image_index: 1, position_index: 6 }
      ],
      median_play: 1,
      p25_play: 1,
      p75_play: 1,
      valid_count: 999,
      stats_version: 'evil-version',
      base64: 'AAAABBBB',
      apiKey: 'sk-should-not-be-stored',
      provider_response: { raw: 'x' }
    })
    check('含伪造派生值的请求仍以 raw_text 为准', tampered.data?.plays?.[0]?.normalized_play === 52000, String(tampered.data?.plays?.[0]?.normalized_play))
    check('伪造的 valid_count / stats_version 被忽略', tampered.data?.valid_count === 6 && tampered.data?.stats_version === 'recent-performance-v1', `${tampered.data?.valid_count}/${tampered.data?.stats_version}`)
    const storedRow = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(tampered.data.id)
    const storedText = JSON.stringify(storedRow)
    check('base64 / apiKey / provider_response 均未入库', !storedText.includes('AAAABBBB') && !storedText.includes('sk-should-not-be-stored') && !storedText.includes('provider_response'))
    check('响应中同样不含敏感字段', !JSON.stringify(tampered.body).includes('sk-should-not-be-stored') && !JSON.stringify(tampered.body).includes('AAAABBBB'))
    check('无法解析的星图价仍可保存（价格 null）', tampered.status === 200 && tampered.data.xingtu_price === null && tampered.data.xingtu_price_raw === '面议')

    console.log('\n===== 4. raw -> valid -> analysis 三层 =====')
    const mixed = await save({
      creator: '乙达人',
      recognized_creator_name_raw: '乙达人',
      xingtu_price_raw: '¥1000',
      plays: [
        play('0'), // 0 是真实观测，必须有效
        play('1万'),
        play('2万'),
        play('3万', { excluded: true }), // 排除：不进入有效样本
        play('看不清'), // 未排除但解析失败 -> unresolved
        { raw_text: null, excluded: false, source_image_index: 1, position_index: 6 }
      ]
    })
    check('recognized_count = 全部行数', mixed.data?.recognized_count === 6, String(mixed.data?.recognized_count))
    check('excluded_count = 排除数', mixed.data?.excluded_count === 1, String(mixed.data?.excluded_count))
    check('unresolved_count = 未排除但无法解析', mixed.data?.unresolved_count === 2, String(mixed.data?.unresolved_count))
    check('valid_count 只含未排除且可解析（0 也算有效）', mixed.data?.valid_count === 3, String(mixed.data?.valid_count))
    check('valid_count < 5 → stats_status=insufficient 且统计值为 null', mixed.data?.stats_status === 'insufficient' && mixed.data?.median_play === null && mixed.data?.p25_play === null && mixed.data?.p75_play === null && mixed.data?.analysis_count === 0)
    check('样本不足仍允许保存（不阻止写库）', mixed.status === 200)

    console.log('\n===== 5. 典型统计：去极值 / median / P25-P75 =====')
    const fifteenRaw = ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万', '9万', '10万', '11万', '12万', '13万', '14万', '15万']
    const fifteen = await save({ creator: '丙达人', recognized_creator_name_raw: '丙达人', plays: fifteenRaw.map((text, index) => play(text, { position_index: index + 1 })) })
    check('15 条有效 → 去最高最低 → analysis_count = 13', fifteen.data?.valid_count === 15 && fifteen.data?.analysis_count === 13, `${fifteen.data?.valid_count}/${fifteen.data?.analysis_count}`)
    // 去极值后 analysis = [2万..14万]（13 条）：median 取第 7 个 = 8万；
    // P25 position = (13-1)*0.25 = 3 → 第 4 个 = 5万；P75 position = 12*0.75 = 9 → 第 10 个 = 11万
    check('15 条 1万~15万：median=8万、P25=5万、P75=11万', fifteen.data?.median_play === 80000 && fifteen.data?.p25_play === 50000 && fifteen.data?.p75_play === 110000, JSON.stringify({ m: fifteen.data?.median_play, p25: fifteen.data?.p25_play, p75: fifteen.data?.p75_play }))
    const medianEven = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000])
    check('偶数样本 median 取中间两项平均（3.5万）', medianEven.median_play === 35000, String(medianEven.median_play))
    const medianOdd = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000, 70000])
    check('奇数样本 median 取中间值（4万）', medianOdd.median_play === 40000, String(medianOdd.median_play))
    const interpolated = stats.computeRecentPerformanceStats([10000, 20000, 30000, 40000, 50000, 60000])
    // 去极值后 [2万,3万,4万,5万]；P25 position=(4-1)*0.25=0.75 → 2万+0.75×1万 = 2.75万；
    // P75 position=3*0.75=2.25 → 4万+0.25×1万 = 4.25万（线性插值）
    check('P25/P75 采用 linear interpolation（2.75万 / 4.25万）', interpolated.p25_play === 27500 && interpolated.p75_play === 42500, JSON.stringify({ p25: interpolated.p25_play, p75: interpolated.p75_play }))
    const duplicated = stats.computeRecentPerformanceStats([10000, 10000, 10000, 10000, 10000, 10000, 10000])
    check('重复极值只各移除一个观测（7 → 5）', duplicated.analysis_count === 5, String(duplicated.analysis_count))
    const duplicatedEdge = stats.computeRecentPerformanceStats([10000, 10000, 10000, 10000, 10000, 20000, 20000, 20000, 20000, 20000])
    check('重复最高最低各只移除一个（10 → 8）', duplicatedEdge.analysis_count === 8, String(duplicatedEdge.analysis_count))

    console.log('\n===== 6. 趋势算法（±20% 常量 / 边界 / 不除零 / 不提前 round）=====')
    const trendCase = (recent, prior) => stats.computeRecentPerformanceStats([...recent, ...prior])
    check('valid < 8 → trend insufficient 且无统计值', trendCase([1, 2, 3, 4, 5], [6, 7]).trend_label === 'insufficient' && trendCase([1, 2, 3, 4, 5], [6, 7]).recent_median_play === null)
    check('阈值常量集中在后端（TREND_THRESHOLD_PERCENT = 20）', stats.TREND_THRESHOLD_PERCENT === 20 && stats.TREND_THRESHOLD === 0.2)
    check('+20% 边界 → up', trendCase([12000, 12000, 12000, 12000, 12000], [10000, 10000, 10000]).trend_label === 'up')
    check('-20% 边界 → down', trendCase([8000, 8000, 8000, 8000, 8000], [10000, 10000, 10000]).trend_label === 'down')
    check('介于 ±20% → stable', trendCase([11000, 11000, 11000, 11000, 11000], [10000, 10000, 10000]).trend_label === 'stable')
    const zeroPrior = trendCase([5000, 5000, 5000, 5000, 5000], [0, 0, 0])
    check('prior median = 0 且 recent > 0 → up（不除零）', zeroPrior.trend_label === 'up' && zeroPrior.trend_ratio === null, JSON.stringify(zeroPrior.trend_ratio))
    const zeroBoth = trendCase([0, 0, 0, 0, 0], [0, 0, 0])
    check('prior = 0 且 recent = 0 → stable', zeroBoth.trend_label === 'stable')
    const rawPrecision = trendCase([121000, 121000, 121000, 121000, 121000], [100000, 100000, 100000, 101000, 101000, 101000])
    check(
      'trend 使用 raw median（prior 中位数 100500 不做提前 round）',
      rawPrecision.prior_median_play === 100500 && rawPrecision.trend_ratio === 0.204 && rawPrecision.trend_label === 'up',
      JSON.stringify({ prior: rawPrecision.prior_median_play, ratio: rawPrecision.trend_ratio, label: rawPrecision.trend_label })
    )
    const recentNewest = trendCase([90000, 90000, 90000, 90000, 90000], [10000, 10000, 10000])
    check('recent 组 = 确认顺序里最新 5 条', recentNewest.recent_median_play === 90000 && recentNewest.prior_median_play === 10000)

    console.log('\n===== 7. plays_json 可完整还原 / 顺序保留 =====')
    const roundtrip = await save({
      creator: '丁达人',
      recognized_creator_name_raw: '丁达人',
      plays: [
        play('5.2万', { source_image_index: 1, position_index: 1 }),
        play('看不清', { source_image_index: 2, position_index: 1 }),
        play('3万', { source_image_index: 2, position_index: 2, excluded: true })
      ]
    })
    const restored = (await latest('丁达人')).data.snapshot
    check(
      'plays_json 还原 raw_text / normalized / excluded / 图片顺序 / needs_review',
      restored.plays.length === 3 &&
        restored.plays[0].raw_text === '5.2万' &&
        restored.plays[0].normalized_play === 52000 &&
        restored.plays[0].needs_review === false &&
        restored.plays[0].source_image_index === 1 &&
        restored.plays[0].position_index === 1 &&
        restored.plays[1].normalized_play === null &&
        restored.plays[1].needs_review === true &&
        restored.plays[1].source_image_index === 2 &&
        restored.plays[2].excluded === true
    )
    check('latest 返回与写入同一 id', restored.id === roundtrip.data.id)

    console.log('\n===== 8. 校验 / 身份保护 / 只读 =====')
    check('creator 不存在于历史记录 → 400', (await save({ creator: '不存在的达人', plays: [play('1万')] })).status === 400)
    check('creator 为空 → 400', (await save({ creator: '   ', plays: [play('1万')] })).status === 400)
    check('creator 超长 → 400', (await save({ creator: 'x'.repeat(101), plays: [play('1万')] })).status === 400)
    check('plays 非数组 → 400', (await save({ creator: 'Gary', plays: 'nope' })).status === 400)
    check('plays 为空 → 400', (await save({ creator: 'Gary', plays: [] })).status === 400)
    check('plays 超过 60 条 → 400', (await save({ creator: 'Gary', plays: Array.from({ length: 61 }, () => play('1万')) })).status === 400)
    check('excluded 非布尔 → 400', (await save({ creator: 'Gary', plays: [play('1万', { excluded: 'yes' })] })).status === 400)
    check('source_image_index 非正整数 → 400', (await save({ creator: 'Gary', plays: [play('1万', { source_image_index: -1 })] })).status === 400)
    check('raw_text 超长 → 400', (await save({ creator: 'Gary', plays: [play('1'.repeat(61))] })).status === 400)
    check('请求体不是对象 → 400', (await save(['nope'])).status === 400)

    const mismatch = await save({
      creator: 'Gary',
      recognized_creator_name_raw: '探花Gary',
      plays: [play('1万')]
    })
    check('识别昵称与当前达人不一致且未确认 → 400 且提示不一致', mismatch.status === 400 && /不一致/.test(mismatch.msg), mismatch.msg)
    const mismatchConfirmed = await save({
      creator: 'Gary',
      recognized_creator_name_raw: '探花Gary',
      identity_confirmed: true,
      plays: [play('1万')]
    })
    check('显式确认后允许保存（creator 仍为雷达达人）', mismatchConfirmed.status === 200 && mismatchConfirmed.data.creator === 'Gary' && mismatchConfirmed.data.recognized_creator_name_raw === '探花Gary')
    check('前端：名称一致不要求确认', saveLib.needsIdentityConfirmation('Gary', 'Gary') === false && saveLib.needsIdentityConfirmation('Gary', ' gary ') === false)
    check('前端：名称不一致要求确认', saveLib.needsIdentityConfirmation('Gary', '探花Gary') === true)
    check('前端：未识别昵称不触发不一致确认', saveLib.needsIdentityConfirmation('Gary', null) === false)
    check('前端：尚未选择目标达人时不显示不一致警告', saveLib.needsIdentityConfirmation('', 'Gary') === false)
    check('前端：选择目标达人后才提示不一致', saveLib.needsIdentityConfirmation('旧史新解', 'Gary') === true)
    const payload = saveLib.buildSnapshotPayload(
      { creator_name: 'Gary', xingtu_price_raw: '¥3000', plays: [{ raw_text: '5.2万', normalized_play: 52000, excluded: true, source_image_index: 2, position_index: 3 }] },
      { creator: 'Gary', identityConfirmed: false, observedAt: '2026-09-25' }
    )
    check('前端 payload 不含任何派生统计值', !('normalized_play' in payload.plays[0]) && !('median_play' in payload) && !('valid_count' in payload), JSON.stringify(payload))
    check('前端 payload 保留 raw 事实', payload.plays[0].raw_text === '5.2万' && payload.plays[0].excluded === true && payload.plays[0].source_image_index === 2)
    check('前端 payload 携带数据观察日期', payload.observed_at === '2026-09-25', JSON.stringify(payload.observed_at))
    // Alpha.2：本地日期（不能用 UTC，否则东八区凌晨会少一天）
    check(
      '本地日期生成：东八区凌晨 00:30 仍是当天（不使用 toISOString）',
      saveLib.todayLocalDateOnly(new Date(2026, 8, 29, 0, 30)) === '2026-09-29' &&
        new Date(2026, 8, 29, 0, 30).toISOString().slice(0, 10) === '2026-09-28'
    )
    check(
      '前端日期校验与后端一致（2026-02-30 / 2026-9-29 / 空 均无效）',
      saveLib.isValidDateOnly('2026-09-29') === true &&
        saveLib.isValidDateOnly('2026-02-30') === false &&
        saveLib.isValidDateOnly('2026-9-29') === false &&
        saveLib.isValidDateOnly('') === false
    )
    check('前端状态文案：无快照 → 尚未更新', saveLib.formatSnapshotStatusText(null) === '尚未更新')
    check('前端状态文案：样本不足', saveLib.formatSnapshotStatusText({ stats_status: 'insufficient', median_play: null }) === '样本不足')
    check('前端状态文案：中位 + 趋势', saveLib.formatSnapshotStatusText({ stats_status: 'ok', median_play: 52000, trend_label: 'stable' }) === '5.2万 · 稳定')
    const gate = saveLib.canSaveSnapshot
    check('保存闸门：全部条件满足才可提交', gate({ confirmed: true, creator: 'Gary', identityNeedsConfirm: false, identityConfirmed: false, saving: false, savedSnapshot: null }) === true)
    check('保存闸门：未确认识别结果 → 禁止提交', gate({ confirmed: false, creator: 'Gary' }) === false)
    check('保存闸门：未绑定达人 → 禁止提交', gate({ confirmed: true, creator: '' }) === false)
    check('保存闸门：名称不一致未勾选确认 → 禁止提交', gate({ confirmed: true, creator: 'Gary', identityNeedsConfirm: true, identityConfirmed: false }) === false)
    check('保存闸门：正在保存 → 禁止重复提交', gate({ confirmed: true, creator: 'Gary', saving: true }) === false)
    check('保存闸门：同一份草稿已保存过 → 禁止再次提交', gate({ confirmed: true, creator: 'Gary', savedSnapshot: { id: 1 } }) === false)

    const recordsAfter = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const recordsChecksumAfter = db
      .prepare('SELECT COUNT(*) AS n, SUM(total_cost) AS cost, SUM(second_week_play) AS plays FROM creator_records')
      .get()
    check('creator_records 未被修改（行数与内容校验）', recordsAfter === recordsBefore && JSON.stringify(recordsChecksumAfter) === JSON.stringify(recordsChecksumBefore), `${recordsBefore} -> ${recordsAfter}`)
    check(
      'import 相关 V2 数据未被触碰',
      db.prepare('SELECT COUNT(*) AS n FROM import_batches').get().n === 0 &&
        db.prepare('SELECT COUNT(*) AS n FROM import_batch_records').get().n === 0
    )

    console.log('\n===== 9. radar 批量合并 latest snapshot（无 N+1）+ P1 不变 =====')
    const radarBefore = await radar()
    const flatten = (data) => data.groups.flatMap((group) => group.creators.map((item) => ({ ...item })))
    const p1Fields = (item) => {
      const { recent_snapshot, ...rest } = item
      return rest
    }
    const beforeCreators = flatten(radarBefore.data)
    check('radar 每位达人都带 recent_snapshot 字段', beforeCreators.every((item) => 'recent_snapshot' in item))
    check('未保存快照的达人 recent_snapshot 为 null', beforeCreators.find((item) => item.creator === '戊达人')?.recent_snapshot === null)
    check(
      '已保存快照的达人带轻量 summary',
      (() => {
        const gary = beforeCreators.find((item) => item.creator === 'Gary')?.recent_snapshot
        return Boolean(gary) && ['id', 'created_at', 'valid_count', 'median_play', 'p25_play', 'p75_play', 'trend_label', 'xingtu_price', 'stats_status'].every((key) => key in gary) && !('plays' in gary)
      })()
    )
    const originalPrepare = db.prepare.bind(db)
    let prepareCount = 0
    db.prepare = (sql) => { prepareCount += 1; return originalPrepare(sql) }
    const radarAfter = await radar()
    db.prepare = originalPrepare
    check('radar 单次请求只执行少量 SQL（无 N+1）', prepareCount <= 4 && radarAfter.data.groups.flatMap((g) => g.creators).length === beforeCreators.length, `prepare=${prepareCount}, creators=${beforeCreators.length}`)

    await save({
      creator: '戊达人',
      recognized_creator_name_raw: '戊达人',
      xingtu_price_raw: '2000',
      plays: ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万'].map((text) => play(text))
    })
    const radarWithSnapshot = await radar()
    const afterCreators = flatten(radarWithSnapshot.data)
    check(
      '写入新 snapshot 后 P1 字段与顺序完全不变',
      JSON.stringify(beforeCreators.map(p1Fields)) === JSON.stringify(afterCreators.map(p1Fields))
    )
    check(
      'P1 分组顺序与成员不变',
      JSON.stringify(radarBefore.data.groups.map((group) => ({ key: group.key, count: group.count, creators: group.creators.map((item) => item.creator) }))) ===
        JSON.stringify(radarWithSnapshot.data.groups.map((group) => ({ key: group.key, count: group.count, creators: group.creators.map((item) => item.creator) })))
    )
    check(
      '新存储的快照出现在对应达人的 cell summary 上',
      flatten(radarWithSnapshot.data).find((item) => item.creator === '戊达人')?.recent_snapshot?.valid_count === 8
    )

    console.log('\n===== 10. Alpha.2：observed_at（数据观察日期）与 latest 新语义 =====')
    const eightPlays = () => ['1万', '2万', '3万', '4万', '5万', '6万', '7万', '8万'].map((text) => play(text))
    const pinCreatedAt = (id, createdAt) =>
      db.prepare('UPDATE creator_recent_snapshots SET created_at = ? WHERE id = ?').run(createdAt, id)
    // 本节使用全新达人，避免与前序小节已保存的快照相互干扰（语义断言必须确定）
    const OBS_A = '观测达人甲'
    const OBS_B = '观测达人乙'
    const OBS_C = '观测达人丙'
    const OBS_D = '观测达人丁'
    const OBS_E = '观测达人戊'
    const OBS_F = '观测达人己'
    const OBS_G = '观测达人庚' // 本节刻意不保存任何快照（用于 radar「无快照 → null」断言）
    const seedObsCreator = (nickname) =>
      insertRecord.run('2026-W36', nickname, '数码', 1000, '2026-09-05', 10000, 50000)
    db.transaction(() => {
      for (const nickname of [OBS_A, OBS_B, OBS_C, OBS_D, OBS_E, OBS_F, OBS_G]) seedObsCreator(nickname)
    })()
    // 雷达 P1 基线：在「本节达人已入库、但尚未保存任何快照」时采集，
    // 因此 observed_at 相关的所有写入都不得改变任何达人的 P1 字段与顺序
    const radarBaselineBeforeObs = await radar()
    const baselineCreators = new Set(
      radarBaselineBeforeObs.data.groups.flatMap((group) => group.creators.map((item) => item.creator))
    )
    const baselineP1 = radarBaselineBeforeObs.data.groups
      .flatMap((group) => group.creators)
      .map((item) => {
        const { recent_snapshot, recent_decision, ...rest } = item
        return rest
      })

    check(
      'schema：observed_at 为 TEXT 且可空（旧快照保持 NULL，不伪装 created_at）',
      columnTypes.observed_at === 'TEXT' && notNull.observed_at === 0,
      `${columnTypes.observed_at}/${notNull.observed_at}`
    )

    const obsSaved = await save({
      creator: OBS_A,
      recognized_creator_name_raw: OBS_A,
      xingtu_price_raw: '3000',
      observed_at: '2026-09-26',
      plays: eightPlays()
    })
    check(
      '新快照保存并返回 observed_at（created_at 语义不变，仍为保存时间）',
      obsSaved.status === 200 &&
        obsSaved.data.observed_at === '2026-09-26' &&
        typeof obsSaved.data.created_at === 'string' &&
        obsSaved.data.created_at.slice(0, 4) === '2026',
      JSON.stringify({ observed_at: obsSaved.data?.observed_at, created_at: obsSaved.data?.created_at })
    )
    check(
      'GET /latest 返回 observed_at',
      (await latest(OBS_A)).data.snapshot.id === obsSaved.data.id &&
        (await latest(OBS_A)).data.snapshot.observed_at === '2026-09-26'
    )

    const missingObserved = await callRoute(postHandler, { body: { creator: OBS_A, plays: [play('1万')] } })
    check(
      '缺少 observed_at → 400（Alpha.2 起必填）',
      missingObserved.status === 400 && /观察日期/.test(missingObserved.msg),
      missingObserved.msg
    )
    for (const bad of ['2026/09/26', '20260926', '2026-9-26', '2026-02-30', '2026-13-01', 'today', 20260926, true]) {
      const res = await callRoute(postHandler, {
        body: { creator: OBS_A, observed_at: bad, plays: [play('1万')] }
      })
      check(`非法 observed_at（${JSON.stringify(bad)}）→ 400`, res.status === 400, res.msg)
    }
    check(
      'observed_at 空白字符串 → 400',
      (await callRoute(postHandler, { body: { creator: OBS_A, observed_at: '   ', plays: [play('1万')] } })).status === 400
    )
    check(
      '闰年真实日期 2028-02-29 允许保存',
      (await save({ creator: OBS_F, observed_at: '2028-02-29', plays: eightPlays() })).status === 200
    )

    // ---- 关键场景：补录旧截图不得让「最近表现」倒退 ----
    const snapA = await save({ creator: OBS_B, observed_at: '2026-09-29', plays: eightPlays() })
    pinCreatedAt(snapA.data.id, '2026-09-29 08:00:00')
    const snapB = await save({ creator: OBS_B, observed_at: '2026-09-25', plays: eightPlays() })
    pinCreatedAt(snapB.data.id, '2026-09-30 08:00:00') // B 保存得更晚
    check(
      '补录旧观察日期（B 保存更晚）→ latest 仍为 observed 09-29 的 A',
      (await latest(OBS_B)).data.snapshot.id === snapA.data.id,
      JSON.stringify({ latest: (await latest(OBS_B)).data.snapshot?.observed_at })
    )
    const snapC = await save({ creator: OBS_B, observed_at: '2026-10-01', plays: eightPlays() })
    pinCreatedAt(snapC.data.id, '2026-10-01 08:00:00')
    check('出现更新的 observed_at → latest 切换为 C', (await latest(OBS_B)).data.snapshot.id === snapC.data.id)

    // ---- 同一 observed_at：created_at DESC, id DESC ----
    const same1 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same1.data.id, '2026-10-05 07:00:00')
    const same2 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same2.data.id, '2026-10-05 09:00:00')
    check(
      '同一 observed_at → created_at 更晚者优先',
      (await latest(OBS_C)).data.snapshot.id === same2.data.id
    )
    const same3 = await save({ creator: OBS_C, observed_at: '2026-10-05', plays: eightPlays() })
    pinCreatedAt(same3.data.id, '2026-10-05 09:00:00') // 同 created_at，id 更大
    check('同一 observed_at + 同一 created_at → id 更大者优先', (await latest(OBS_C)).data.snapshot.id === same3.data.id)

    // ---- 旧数据（observed_at NULL）不得覆盖明确观察日期 ----
    const insertLegacySnapshot = (creator, createdAt, median) =>
      Number(
        db
          .prepare(
            `INSERT INTO creator_recent_snapshots (
               creator, source_type, plays_json, recognized_count, valid_count, excluded_count,
               unresolved_count, analysis_count, median_play, p25_play, p75_play,
               trend_label, stats_status, stats_version, created_at, observed_at
             ) VALUES (?, 'screenshot', ?, 8, 8, 0, 0, 8, ?, ?, ?, 'stable', 'ok', ?, ?, NULL)`
          )
          .run(creator, JSON.stringify([]), median, median, median, 'recent-performance-v1', createdAt)
          .lastInsertRowid
      )
    const legacyLater = insertLegacySnapshot(OBS_D, '2026-10-08 08:00:00', 60000)
    const observedOlder = await save({ creator: OBS_D, observed_at: '2026-09-20', plays: eightPlays() })
    pinCreatedAt(observedOlder.data.id, '2026-09-20 08:00:00')
    check(
      '旧快照 observed_at=NULL（保存更晚）不覆盖已有明确观察日期的快照',
      (await latest(OBS_D)).data.snapshot.id === observedOlder.data.id,
      JSON.stringify({ latestId: (await latest(OBS_D)).data.snapshot?.id, legacyId: legacyLater })
    )
    const legacyOnlyA = insertLegacySnapshot(OBS_E, '2026-09-10 08:00:00', 30000)
    const legacyOnlyB = insertLegacySnapshot(OBS_E, '2026-09-11 08:00:00', 40000)
    check(
      '全部 observed_at=NULL 的达人 → 保留 created_at/id fallback（取保存更晚者）',
      (await latest(OBS_E)).data.snapshot.id === legacyOnlyB && legacyOnlyB !== legacyOnlyA
    )

    // ---- radar 使用同一 latest 语义，且不改变 P1 ----
    const radarAfterObserved = await radar()
    const creatorSnapshot = (data, creator) =>
      data.groups.flatMap((group) => group.creators).find((item) => item.creator === creator)?.recent_snapshot
    check(
      'radar 合并的是 latest observed snapshot（观测达人乙 = C / observed 10-01）',
      creatorSnapshot(radarAfterObserved.data, OBS_B)?.id === snapC.data.id &&
        creatorSnapshot(radarAfterObserved.data, OBS_B)?.observed_at === '2026-10-01'
    )
    check(
      'radar summary 携带 observed_at（无快照达人仍为 null）',
      'observed_at' in creatorSnapshot(radarAfterObserved.data, OBS_B) &&
        creatorSnapshot(radarAfterObserved.data, OBS_G) === null
    )
    check(
      'radar 的 P1 字段与 observed_at 无关（既有达人与本节插入新达人前的基线完全一致）',
      JSON.stringify(
        radarAfterObserved.data.groups
          .flatMap((g) => g.creators)
          .filter((item) => baselineCreators.has(item.creator))
          .map((item) => {
            const { recent_snapshot, recent_decision, ...rest } = item
            return rest
          })
      ) === JSON.stringify(baselineP1)
    )

    // ---- Decision evidence 冻结 observed_at ----
    const decisionRes = await callRoute(createDecisionHandler, {
      body: {
        creator: OBS_A,
        decision_stage: 'contact',
        snapshot_id: obsSaved.data.id,
        ip_judgement: 'strong',
        human_decision: 'contact_now'
      }
    })
    check(
      'Decision evidence 冻结 observed_at',
      decisionRes.status === 200 && decisionRes.data.recent_evidence.observed_at === '2026-09-26',
      JSON.stringify(decisionRes.data?.recent_evidence)
    )
    check(
      '旧快照（observed_at=NULL）冻结进证据时为 null，不回填 created_at',
      (() => {
        const row = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(legacyLater)
        return decisions.buildRecentEvidence(row).observed_at === null
      })()
    )

    // ---- 无漂移：observed_at 不参与统计 / 价格 / V2 指标 ----
    const statsSame = ['median_play', 'p25_play', 'p75_play', 'trend_label', 'trend_ratio', 'valid_count', 'analysis_count'].every(
      (key) => snapA.data[key] === snapB.data[key]
    )
    check('observed_at 不改变统计口径（同样本不同 observed_at → median/P25/P75/trend 完全一致）', statsSame)
    check(
      'observed_at 不改变 creatorPricing（同星图价 → 同一套目标价 / 参考区间 / 价格状态）',
      JSON.stringify(snapA.data.pricing) === JSON.stringify(snapB.data.pricing) &&
        snapA.data.pricing.pricing_version === 'creator-pricing-v1'
    )

    console.log('\n===== 11. 无 AI / 无网络 / 只读实现 =====')
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/recentSnapshots.js'), 'utf8')
    check('P2B 路由不引用任何 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check('P2B 路由只注册 POST / 与 GET /latest', snapshotRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).sort().join(' | ') === 'GET /latest | POST /', snapshotRouter.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join(' | '))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check('隔离库位于临时目录（未触碰真实 workbench.db）', process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir()))
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
