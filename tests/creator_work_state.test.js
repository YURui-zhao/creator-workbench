#!/usr/bin/env node
// 达人拓展 V0.3 —— Work State（三个工作盒子）与信息架构回归测试
//
// 运行方式：node tests/creator_work_state.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时库（必须先于 import backend/db.js 设置），结束后删除；
//          用户真实库（backend/workbench.db）只读、不被触碰。
// 网络：拦截 http/https/net/tls/fetch —— 本能力纯确定性，不调用 AI、不访问网络。
//
// 覆盖（对应本轮实施范围 A / B / C / E / F）：
//   1. contact → 推进中
//   2. observe → 观察中
//   3. hold → 暂缓池
//   4. 无 candidate_review → 推进中（不是观察中）
//   5. 最新 candidate_review 决定当前状态
//   6. post_quote 决策（proceed / small_test / negotiate / pause）不改变 Work State
//   7. 点击状态新增 decision，不覆盖旧 decision（append-only）
//   8. 三个状态筛选互斥
//   9. 名称 substring 搜索
//   10. 「AI整理达人资料」文案（不再是「AI整理备注」）
//   11. 当前合作可折叠 / 已关联合作记录默认折叠
//   12. 已关联合作记录只取 outcome 显式关联的投放记录
//   13. 无 outcome 时显示「暂无已关联的历史合作记录」，不出现「历史合作 0 次」
//   14. 多轮合作 A / B 并存，不被覆盖
//   15. Work State 可持久化（重新读取 append-only 历史即可还原）
//   16. 多轮谈判 case 不覆盖；不访问网络 / 不调用 AI

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-work-state-'))
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
      blocked.push(method)
      throw new Error('creator work state test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('creator work state test forbids network requests')
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

const play = (value, type = 'sponsored', index = 1) => ({
  raw_text: String(value),
  excluded: false,
  content_type: type,
  source_image_index: 1,
  position_index: index
})

const OBSERVED_AT = '2026-10-05'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const workState = await import(
      pathToFileURL(path.join(root, 'frontend/src/utils/creatorWorkState.js')).href
    )
    const candidatesModule = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default
    const router = candidatesModule.default
    const page = fs.readFileSync(
      path.join(root, 'frontend/src/pages/CreatorPlaybook/index.jsx'),
      'utf8'
    )

    const findHandler = (routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {}, headers = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const createCandidate = findHandler('/', 'post')
    const saveSnapshot = findHandler('/:id/recent-snapshots', 'post')
    const listDecisions = findHandler('/:id/decisions', 'get')
    const createReviewDecision = findHandler('/:id/decisions', 'post')
    const createPostQuoteDecision = findHandler('/:id/post-quote-decisions', 'post')

    const mkCandidate = async (name, withSnapshot = false) => {
      const res = await callRoute(createCandidate, { body: { name, creator_type: '科普' } })
      if (withSnapshot) {
        await callRoute(saveSnapshot, {
          params: { id: String(res.data.id) },
          body: { observed_at: OBSERVED_AT, xingtu_price_raw: '¥5,000', plays: [play(52000, 'sponsored', 1)] }
        })
      }
      return res.data
    }
    const review = (candidateId, humanDecision, note) =>
      callRoute(createReviewDecision, {
        params: { id: String(candidateId) },
        body: { human_decision: humanDecision, decision_note: note ?? null }
      })
    const decisionsOf = async (candidateId) =>
      (await callRoute(listDecisions, { params: { id: String(candidateId) } })).data.decisions
    const stateOfCandidate = async (candidateId) => workState.deriveWorkState(await decisionsOf(candidateId))

    console.log('===== 1. 三个工作盒子的词汇表与默认语义 =====')
    check(
      '三个工作盒子只认 contact / observe / hold',
      JSON.stringify(workState.WORK_STATE_VALUES) === JSON.stringify(['contact', 'observe', 'hold'])
    )
    check(
      '展示标签为 推进中 / 观察中 / 暂缓池',
      workState.WORK_STATE_OPTIONS.map((option) => option.label).join(' / ') === '推进中 / 观察中 / 暂缓池'
    )
    check(
      'post_quote 决策不属于 Work State 词汇表',
      workState.WORK_STATE_VALUES.every(
        (value) => !['proceed', 'small_test', 'negotiate', 'pause'].includes(value)
      )
    )

    console.log('\n===== 2. 无 candidate_review → 推进中（不是观察中） =====')
    const defaultState = workState.deriveWorkState([])
    check('默认 value = contact', defaultState.value === 'contact')
    check('默认 label = 推进中（不是观察中）', defaultState.label === '推进中')
    check('默认 hasReview = false / 无备注', defaultState.hasReview === false && defaultState.note === null)
    check(
      'post_quote-only 历史仍然派生出「推进中」',
      workState.deriveWorkState([
        { id: 1, decision_stage: 'post_quote', human_decision: 'pause', created_at: '2026-10-05 10:00:00' }
      ]).value === 'contact'
    )

    console.log('\n===== 3. contact / observe / hold → 三个盒子 =====')
    const candContact = await mkCandidate('工作盒-推进')
    const candObserve = await mkCandidate('工作盒-观察')
    const candHold = await mkCandidate('工作盒-暂缓')
    await review(candContact.id, 'contact', '本周继续沟通档期')
    await review(candObserve.id, 'observe', '先看下一条数据')
    await review(candHold.id, 'hold', '报价明显高于预算')
    const sContact = await stateOfCandidate(candContact.id)
    const sObserve = await stateOfCandidate(candObserve.id)
    const sHold = await stateOfCandidate(candHold.id)
    check('contact → 推进中', sContact.value === 'contact' && sContact.label === '推进中')
    check('observe → 观察中', sObserve.value === 'observe' && sObserve.label === '观察中')
    check('hold → 暂缓池', sHold.value === 'hold' && sHold.label === '暂缓池')
    check('状态备注来自最新 candidate_review.decision_note', sHold.note === '报价明显高于预算')
    check(
      'decision_stage 固定 candidate_review（服务端决定）',
      (await decisionsOf(candHold.id)).every((row) => row.decision_stage === 'candidate_review')
    )

    console.log('\n===== 4. 最新 candidate_review 决定当前状态（append-only 顺序稳定） =====')
    await review(candContact.id, 'observe', '临时改观察')
    await review(candContact.id, 'hold', '最终暂缓')
    const afterChain = await stateOfCandidate(candContact.id)
    check('contact → observe → hold：当前状态 = 暂缓池', afterChain.value === 'hold' && afterChain.label === '暂缓池')
    check('备注取最新一条', afterChain.note === '最终暂缓')
    const chainRows = await decisionsOf(candContact.id)
    check(
      '三次点击留下三条 candidate_review（不 UPDATE）',
      chainRows.filter((row) => row.decision_stage === 'candidate_review').length === 3
    )
    check(
      '历史决定保留（能看到更早的 contact / observe）',
      chainRows.some((row) => row.human_decision === 'contact') &&
        chainRows.some((row) => row.human_decision === 'observe')
    )
    check(
      '最新决定排在最前（created_at DESC, id DESC）',
      chainRows[0].human_decision === 'hold' && chainRows[0].decision_note === '最终暂缓'
    )

    console.log('\n===== 5. post_quote 决策不改变 Work State =====')
    const candQuote = await mkCandidate('工作盒-报价', true)
    const quotePause = await callRoute(createPostQuoteDecision, {
      params: { id: String(candQuote.id) },
      body: { current_quote_raw: '¥3,000', human_decision: 'pause', decision_note: '暂缓报价' }
    })
    check('post_quote=pause 创建成功', quotePause.status === 200, JSON.stringify(quotePause.msg))
    const afterPause = await stateOfCandidate(candQuote.id)
    check('pause 之后 Work State 仍是「推进中」', afterPause.value === 'contact' && afterPause.label === '推进中')
    await callRoute(createPostQuoteDecision, {
      params: { id: String(candQuote.id) },
      body: { current_quote_raw: '¥2,800', human_decision: 'proceed', decision_note: '直接推进' }
    })
    const afterProceed = await stateOfCandidate(candQuote.id)
    check(
      'proceed 也不会把 Work State 写进任何盒子',
      afterProceed.value === 'contact' && afterProceed.hasReview === false
    )
    check(
      'Work State 派生忽略所有 post_quote 行（只认 candidate_review）',
      workState.deriveWorkState([
        { id: 9, decision_stage: 'post_quote', human_decision: 'hold', created_at: '2026-10-05 12:00:00' },
        { id: 8, decision_stage: 'candidate_review', human_decision: 'observe', created_at: '2026-10-05 11:00:00' }
      ]).value === 'observe'
    )
    const mixedRows = await decisionsOf(candQuote.id)
    check(
      '同一 candidate 同时存在 post_quote 历史且无 candidate_review',
      mixedRows.filter((row) => row.decision_stage === 'post_quote').length === 2 &&
        mixedRows.filter((row) => row.decision_stage === 'candidate_review').length === 0
    )

    console.log('\n===== 6. 点击状态新增 decision，不覆盖旧 decision =====')
    const candAppend = await mkCandidate('工作盒-追加')
    const first = await review(candAppend.id, 'contact', '第一次：推进')
    const countBefore = Number(
      db.prepare('SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ?').get(candAppend.id).n
    )
    const second = await review(candAppend.id, 'hold', '第二次：暂缓')
    const countAfter = Number(
      db.prepare('SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ?').get(candAppend.id).n
    )
    check('每次点击新增一行（+1，不 UPDATE）', countAfter === countBefore + 1)
    check('两次 decision id 不同', first.data.id !== second.data.id)
    const appendRows = await decisionsOf(candAppend.id)
    check(
      '旧 decision 原样保留（备注不被覆盖）',
      appendRows.find((row) => row.id === first.data.id)?.decision_note === '第一次：推进'
    )
    check('当前状态 = 最新一条 hold', (await stateOfCandidate(candAppend.id)).value === 'hold')
    check(
      '更新工作状态不会触碰 creator_candidates.status（仍 active/archived 语义）',
      db.prepare('SELECT status FROM creator_candidates WHERE id = ?').get(candAppend.id).status === 'active'
    )

    console.log('\n===== 7. 三个状态筛选互斥 =====')
    const filterPool = [
      { id: 1, name: '筛选-甲' },
      { id: 2, name: '筛选-乙' },
      { id: 3, name: '筛选-丙' }
    ]
    const workStateByCandidate = {
      1: { value: 'contact' },
      2: { value: 'observe' },
      3: { value: 'hold' }
    }
    const boxIds = workState.WORK_STATE_VALUES.map((value) =>
      workState
        .filterCandidates({ candidates: filterPool, workState: value, workStateByCandidate })
        .map((item) => item.id)
    )
    check(
      '每个盒子只包含对应状态',
      boxIds[0].join() === '1' && boxIds[1].join() === '2' && boxIds[2].join() === '3'
    )
    check(
      '三个盒子互斥（同一 candidate 不会同时落在两个盒子）',
      boxIds.flat().length === 3 && new Set(boxIds.flat()).size === 3
    )
    check(
      '「全部」不做状态过滤（保持输入顺序）',
      workState
        .filterCandidates({ candidates: filterPool, workStateByCandidate })
        .map((item) => item.id)
        .join() === '1,2,3'
    )
    check(
      '无 candidate_review 的 candidate 落在「推进中」盒子里',
      workState
        .filterCandidates({
          candidates: [{ id: 42, name: '新加入' }],
          workState: 'contact',
          workStateByCandidate: {}
        })
        .map((item) => item.id)
        .join() === '42'
    )
    const boxCounts = workState.summarizeWorkStates(filterPool, workStateByCandidate)
    check(
      '盒子计数与「全部」一致',
      boxCounts.all === 3 && boxCounts.contact === 1 && boxCounts.observe === 1 && boxCounts.hold === 1
    )

    console.log('\n===== 8. 名称 substring 搜索 =====')
    const searchPool = [
      { id: 1, name: 'Papi酱' },
      { id: 2, name: 'papi小号' },
      { id: 3, name: '李佳琦' }
    ]
    check(
      'substring 命中（大小写不敏感）',
      workState.filterCandidates({ candidates: searchPool, keyword: 'PAPI' }).map((item) => item.id).join() === '1,2'
    )
    check(
      '中文 substring 命中',
      workState.filterCandidates({ candidates: searchPool, keyword: '佳琦' }).map((item) => item.id).join() === '3'
    )
    check('无命中 → 空列表', workState.filterCandidates({ candidates: searchPool, keyword: '不存在' }).length === 0)
    check(
      '搜索与工作盒子可叠加（AND）',
      workState
        .filterCandidates({
          candidates: searchPool,
          keyword: 'papi',
          workState: 'observe',
          workStateByCandidate: { 2: { value: 'observe' } }
        })
        .map((item) => item.id)
        .join() === '2'
    )

    console.log('\n===== 9. Work State 可持久化（不新增字段） =====')
    const persisted = await stateOfCandidate(candHold.id)
    check(
      '重新读取 append-only 历史即可还原状态（hold → 暂缓池）',
      persisted.value === 'hold' && persisted.label === '暂缓池'
    )
    check(
      '未引入 candidate.current_state（DB schema 未变）',
      !/current_state/.test(fs.readFileSync(path.join(root, 'backend/db.js'), 'utf8')) &&
        !/current_state/.test(page)
    )
    const createdShape = (await callRoute(createCandidate, { body: { name: '列检查' } })).data
    check(
      'candidate 列表仍只有 active / archived 状态语义（无 Work State 列）',
      createdShape.status === 'active' &&
        !('current_state' in createdShape) &&
        !('work_state' in createdShape)
    )

    console.log('\n===== 10. 达人资料画像文案（AI整理达人资料） =====')
    check('页面不再出现「AI整理备注」', !page.includes('AI整理备注'))
    check('统一使用「AI整理达人资料」', page.includes('AI整理达人资料'))
    check('保留既有画像语义文案', page.includes('记录这个达人的长期特征、内容风格、价格感知和合作观察。'))
    check('画像区标为「达人资料画像」', page.includes('达人资料画像'))
    check(
      '观察提示是轻量 guidance（不是必填表单，也不新增字段）',
      /观察提示（仅作参考，不必逐条填写）/.test(page) &&
        /主要内容类型？/.test(page) &&
        /优势 \/ 风险？/.test(page) &&
        !/name="main_content_type"|name="persona"/.test(page)
    )
    check('画像区不混入谈价经验语义', !/达人资料画像[\s\S]{0,400}谈价经验/.test(page))

    console.log('\n===== 11. 当前合作 / 已关联合作记录 折叠区 =====')
    check('存在「当前合作」一级区块', page.includes('当前合作'))
    check(
      '当前合作是可独立折叠区块（Collapse + activeKey 状态）',
      /activeKey=\{cooperationKeys\}/.test(page) && /key: 'cooperation'/.test(page)
    )
    check('当前合作默认展开', /useState\(\['cooperation'\]\)/.test(page))
    check(
      '当前合作二级结构：价格与参考 / 本轮谈价 / 本轮结果',
      page.includes('价格与参考') && page.includes('本轮谈价') && page.includes('本轮结果')
    )
    check(
      '已关联合作记录默认折叠',
      /activeKey=\{linkedRecordKeys\}/.test(page) &&
        /const \[linkedRecordKeys, setLinkedRecordKeys\] = useState\(\[\]\)/.test(page)
    )
    check(
      '本轮谈价仍是事件级（AI整理谈价经验语义未混入画像）',
      page.includes('本次谈价记录') &&
        page.includes('记录这一次具体谈价的价格变化、原因和过程，可用于后续复盘。') &&
        /canRecordNegotiationExperience && !existingNegotiationExperience/.test(page)
    )
    check(
      '历史 / 实时谈价去重语义未被破坏',
      /const existingNegotiationExperience = latestNegotiationCase \|\| linkedHistoricalCase \|\| null/.test(page)
    )

    console.log('\n===== 12. 已关联合作记录只取 outcome =====')
    check(
      '标题为「已关联合作记录（N）」',
      page.includes('已关联合作记录（') && /linkedCollaborationRecords\.length/.test(page)
    )
    check(
      '列表数据只来自 outcome 关联（不按 nickname / name 猜）',
      /const linkedCollaborationRecords = useMemo\(\(\) => buildLinkedCollaborationRecords\(decisions\), \[decisions\]\)/.test(page) &&
        !/nickname/.test(page) &&
        !/fuzzy/i.test(page)
    )
    const linked = workState.buildLinkedCollaborationRecords([
      { id: 1, outcome: { record_id: 11, creator: '合作甲', total_cost: 2000 } },
      { id: 2, outcome: null },
      { id: 3, outcome: { record_id: 12, creator: '合作甲', total_cost: 3000 } }
    ])
    check('只保留有 outcome 的 decision', linked.length === 2 && linked.every((item) => item.record))
    check('多轮合作 A / B 并存（不覆盖）', linked.map((item) => item.record.record_id).join() === '11,12')
    check(
      '未关联时为空（不伪造记录）',
      workState.buildLinkedCollaborationRecords([{ id: 1, outcome: null }, { id: 2 }]).length === 0
    )

    console.log('\n===== 13. 空态文案：不出现「历史合作 0 次」 =====')
    check('空态文案为「暂无已关联的历史合作记录」', page.includes('暂无已关联的历史合作记录'))
    check('不再使用「历史合作记录（N）」标题', !page.includes('历史合作记录（'))
    check('页面不出现「历史合作 0 次」类暗示', !/历史合作\s*0\s*次/.test(page))
    check('页面不直接触碰 creator_records', !/creator_records/.test(page))

    console.log('\n===== 15. 多轮谈价 A / B 并存，不被覆盖 =====')
    const negotiationModule = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorNegotiationCases.js')).href
    )
    const negotiationHandler = (method) => {
      const layer = negotiationModule.default.stack.find(
        (item) => item.route && item.route.path === '/' && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const postCase = negotiationHandler('post')
    const getCases = negotiationHandler('get')

    const candMulti = await mkCandidate('工作盒-多轮谈价', true)
    const roundOne = await callRoute(createPostQuoteDecision, {
      params: { id: String(candMulti.id) },
      body: { current_quote_raw: '¥5,000', human_decision: 'negotiate', decision_note: '第一轮' }
    })
    const roundTwo = await callRoute(createPostQuoteDecision, {
      params: { id: String(candMulti.id) },
      body: { current_quote_raw: '¥4,500', human_decision: 'negotiate', decision_note: '第二轮' }
    })
    const caseOne = await callRoute(postCase, {
      body: { decision_id: roundOne.data.id, negotiated_price: '4200', negotiated_at: '2026-10-06' }
    })
    const caseTwo = await callRoute(postCase, {
      body: { decision_id: roundTwo.data.id, negotiated_price: '3900', negotiated_at: '2026-10-07' }
    })
    check('两轮谈价各自创建 case', caseOne.status === 200 && caseTwo.status === 200)
    check('两个 case id 不同（未合并 / 未覆盖）', caseOne.data.id !== caseTwo.data.id)
    const multiRows = await decisionsOf(candMulti.id)
    check(
      '每个 decision 各自挂自己的 negotiation_case',
      multiRows[0].negotiation_case?.id === caseTwo.data.id &&
        multiRows[1].negotiation_case?.id === caseOne.data.id
    )
    check(
      '两轮价格事实独立保留',
      multiRows[0].negotiation_case?.negotiated_price === 3900 &&
        multiRows[1].negotiation_case?.negotiated_price === 4200
    )
    check(
      '按 decision_id 查询各自返回（不串）',
      (await callRoute(getCases, { query: { decision_id: String(roundOne.data.id) } })).data.cases[0].id ===
        caseOne.data.id
    )
    check('多轮谈价不改变 Work State（仍推进中）', (await stateOfCandidate(candMulti.id)).value === 'contact')
    check(
      'post_quote 决策未被写进 candidate_review',
      multiRows.filter((row) => row.decision_stage === 'candidate_review').length === 0
    )

    console.log('\n===== 16. 无 AI / 无网络 =====')
    check('页面不新增请求库（仍走既有 api 层）', !/axios|fetch\(/.test(page))
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    check(
      '隔离库位于临时目录（未触碰真实 workbench.db）',
      process.env.WORKBENCH_DB_PATH.startsWith(os.tmpdir())
    )
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
