#!/usr/bin/env node
// Creator Decision Playbook V0.1 - Phase 4B Candidate Review Decision 回归测试
//
// 运行方式：node tests/creator_candidate_decisions.test.js
// 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
// 网络：拦截 http/https/net/tls/fetch —— 本能力纯确定性，不调用 AI、不访问网络。

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-decisions-'))
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
      throw new Error('candidate decision test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('candidate decision test forbids network requests')
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

const OBSERVED_AT = '2026-10-03'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const decisions = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorDecisions.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const candidateRouter = candidates.default
    const decisionRouter = decisions.default
    const findHandler = (router, routePath, method) => {
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

    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const patchCandidate = findHandler(candidateRouter, '/:id', 'patch')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')
    const listCandidateDecisions = findHandler(candidateRouter, '/:id/decisions', 'get')
    const createCandidateDecision = findHandler(candidateRouter, '/:id/decisions', 'post')
    const priceRef = findHandler(candidateRouter, '/:id/price-reference', 'get')
    const legacyCreateDecision = findHandler(decisionRouter, '/', 'post')
    const legacyListDecisions = findHandler(decisionRouter, '/', 'get')
    const legacyLatestSnapshot = findHandler(snapshots.default, '/latest', 'get')

    // ---------- 历史投放池（供 Historical Price Reference 冻结） ----------
    const insertRecord = db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W40', ?, ?, ?, '2026-08-20', ?, ?)`
    )
    const addRecord = (nickname, type, cost, first, sw) =>
      Number(insertRecord.run(nickname, type, cost, first, sw).lastInsertRowid)
    addRecord('历史甲', '科普', 1500, 50000, 50000)
    addRecord('历史乙', '历史类', 1080, 54000, 54000)
    addRecord('历史丙', '个人成长类', 0, 48000, 48000)
    addRecord('历史丁', '科普', 2100, 60000, 60000)
    addRecord('历史戊', '科普', 900, 45000, 45000)
    addRecord('旧达人', '科普', 1000, 30000, 30000) // 供旧 contact/post_quote 回归

    // ---------- candidates ----------
    const mkCand = async (name, type, plays, xingtuRaw) => {
      const c = await callRoute(createCandidate, { body: { name, creator_type: type } })
      if (plays) {
        await callRoute(saveCandidateSnapshot, {
          params: { id: String(c.data.id) },
          body: { observed_at: OBSERVED_AT, xingtu_price_raw: xingtuRaw ?? null, plays }
        })
      }
      return c.data
    }
    const candA = await mkCand('同名达人', '科普', [
      play(50000, 'sponsored', 1), play(51000, 'sponsored', 2), play(53000, 'sponsored', 3), play(54000, 'sponsored', 4),
      play(80000, 'organic', 5), play(90000, 'organic', 6), play(12000, 'unknown', 7)
    ], '¥5,000')
    const candB = await mkCand('同名达人', '科普', [play(99999, 'sponsored', 1)], '¥3,000')
    const candSp0 = await mkCand('无商单达人', '科普', [play(80000, 'organic', 1), play(90000, 'organic', 2)], null)
    const candSp1 = await mkCand('单商单达人', '科普', [play(50000, 'sponsored', 1)], null)
    const candBigPrice = await mkCand('高金额达人', '科普', [play(20000, 'sponsored', 1)], '¥20,000')
    const candNoSnap = await mkCand('无快照达人', '科普', null, null)

    const snapshotIdOf = (candidateId) =>
      db.prepare('SELECT id FROM creator_recent_snapshots WHERE candidate_id = ?').get(candidateId)?.id ?? null

    console.log('===== 1. 无 creator_record 也可创建 candidate decision =====')
    check('候选不在 creator_records', db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE nickname = ?').get('同名达人').n === 0)
    const dNoSnap = await callRoute(createCandidateDecision, {
      params: { id: String(candNoSnap.id) },
      body: { human_decision: 'hold', decision_note: '先观察' }
    })
    check('无历史投放的 candidate 可保存 decision', dNoSnap.status === 200, JSON.stringify(dNoSnap.msg))
    check('candidate_id 正确', dNoSnap.data?.candidate_id === candNoSnap.id)
    check('creator 由服务端 candidate.name 写入', dNoSnap.data?.creator === '无快照达人')
    check('decision_stage 固定 candidate_review', dNoSnap.data?.decision_stage === 'candidate_review')
    check('human_decision_label = 暂不推进', dNoSnap.data?.human_decision_label === '暂不推进')
    check('无 snapshot：snapshot_id / recent / pricing 均为 null', dNoSnap.data?.snapshot_id === null && dNoSnap.data?.recent_evidence === null && dNoSnap.data?.pricing_evidence === null)

    console.log('\n===== 2. 前端不能伪造 identity / stage =====')
    const forged = await callRoute(createCandidateDecision, {
      params: { id: String(candA.id) },
      body: { human_decision: 'contact', candidate_id: 999, creator: '伪造名称', decision_stage: 'post_quote' }
    })
    check('伪造 candidate_id 被忽略', forged.data?.candidate_id === candA.id)
    check('伪造 creator 被忽略', forged.data?.creator === '同名达人')
    check('伪造 decision_stage 被忽略', forged.data?.decision_stage === 'candidate_review')

    console.log('\n===== 3. candidate_review enum 与旧 enum =====')
    check('只接受 contact / observe / hold', JSON.stringify(decisions.CANDIDATE_REVIEW_DECISIONS) === JSON.stringify(['contact', 'observe', 'hold']))
    for (const bad of ['contact_now', 'skip_for_now', 'repurchase', 'pause', '']) {
      const r = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: bad } })
      check(`拒绝非法 human_decision「${bad}」`, r.status === 400)
    }
    check('缺少 human_decision -> 400（系统不会自动选择）', (await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: {} })).status === 400)
    check('旧 DECISION_STAGES 不变', JSON.stringify(decisions.DECISION_STAGES) === JSON.stringify(['contact', 'post_quote']))
    check('旧 CONTACT_DECISIONS 不变', JSON.stringify(decisions.CONTACT_DECISIONS) === JSON.stringify(['contact_now', 'observe', 'skip_for_now']))
    check('旧 POST_QUOTE_DECISIONS 不变', JSON.stringify(decisions.POST_QUOTE_DECISIONS) === JSON.stringify(['repurchase', 'small_test', 'negotiate', 'pause']))
    check('旧 label 未被覆盖', decisions.HUMAN_DECISION_LABELS.contact_now === '开始建联' && decisions.HUMAN_DECISION_LABELS.skip_for_now === '暂不联系' && decisions.HUMAN_DECISION_LABELS.pause === '暂缓')
    check('新增 label：contact=继续联系 / hold=暂不推进', decisions.HUMAN_DECISION_LABELS.contact === '继续联系' && decisions.HUMAN_DECISION_LABELS.hold === '暂不推进')
    check('旧 POST 不接受 candidate_review stage', (await callRoute(legacyCreateDecision, { body: { creator: '旧达人', decision_stage: 'candidate_review', human_decision: 'contact' } })).status === 400)
    check('候选不存在 -> 404', (await callRoute(createCandidateDecision, { params: { id: '99999' }, body: { human_decision: 'hold' } })).status === 404)

    console.log('\n===== 4. snapshot 由服务端按 candidate_id 取 latest =====')
    const dA = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: 'observe' } })
    const dB = await callRoute(createCandidateDecision, { params: { id: String(candB.id) }, body: { human_decision: 'observe' } })
    check('candidate A 使用自己的 snapshot', dA.data?.snapshot_id === snapshotIdOf(candA.id) && dA.data?.snapshot_id !== snapshotIdOf(candB.id))
    check('candidate B（同名）使用自己的 snapshot', dB.data?.snapshot_id === snapshotIdOf(candB.id))
    check('recent_evidence.candidate_id / snapshot_id 正确', dA.data?.recent_evidence?.candidate_id === candA.id && dA.data?.recent_evidence?.snapshot_id === snapshotIdOf(candA.id))

    console.log('\n===== 5. recent evidence 冻结事实 =====')
    const re = dA.data?.recent_evidence || {}
    check('median_play 冻结（7 样本去极值 -> 53000）', re.median_play === 53000, String(re.median_play))
    check('mean_play 从 plays 派生（非 null）', typeof re.mean_play === 'number' && Math.abs(re.mean_play - 390000 / 7) < 1e-6, String(re.mean_play))
    check('sponsored 事实冻结', re.sponsored_count === 4 && re.sponsored_median_play === 52000)
    check('organic 事实冻结', re.organic_count === 2 && re.organic_median_play === 85000)
    check('unknown_count 冻结', re.unknown_count === 1)
    check('observed_at / valid_count / stats_version 冻结', re.observed_at === OBSERVED_AT && re.valid_count === 7 && re.source_stats_version === 'recent-performance-v1')
    check('不加 Rule Engine 判断文案（无 scale / stability seed）', !('scale' in re) && !('stability' in re) && re.playbook_rule_version === 'creator-playbook-v0.1')

    console.log('\n===== 6. pricing evidence：CPM15-20 与 TARGET_CPM=30 分开 =====')
    const pe = dA.data?.pricing_evidence || {}
    check('target_cpm 列仍为共享常量 30', dA.data?.target_cpm === 30)
    check('CPM15-20 只出现在 pricing_evidence', pe.playbook_estimate?.cpm_low === 15 && pe.playbook_estimate?.cpm_high === 20)
    check('estimate = sponsored中位 × 15-20 / 1000（52000 -> 780 / 1040）', pe.playbook_estimate?.estimate_low === 780 && pe.playbook_estimate?.estimate_high === 1040)
    check('sponsored>=3 -> confidence normal', pe.playbook_estimate?.confidence === 'normal')
    check('xingtu_price 冻结（5000）', pe.xingtu_price === 5000)
    check('high_amount_risk = false（5000 未过万）', pe.high_amount_risk === false)
    check('pricing_version / system_context_version 使用新版本', dA.data?.pricing_version === 'creator-playbook-pricing-v0.1' && dA.data?.system_context_version === 'candidate-review-v0.1')
    const dBig = await callRoute(createCandidateDecision, { params: { id: String(candBigPrice.id) }, body: { human_decision: 'observe' } })
    check('sponsored=1 -> confidence low', dBig.data?.pricing_evidence?.playbook_estimate?.confidence === 'low')
    check('high_amount_risk = true（20000 > 10000）', dBig.data?.pricing_evidence?.high_amount_risk === true)
    const dSp0 = await callRoute(createCandidateDecision, { params: { id: String(candSp0.id) }, body: { human_decision: 'observe' } })
    check('sponsored=0 -> 不生成 estimate（low/high = null）', dSp0.data?.pricing_evidence?.playbook_estimate?.estimate_low === null && dSp0.data?.pricing_evidence?.playbook_estimate?.estimate_high === null)
    const dSp1 = await callRoute(createCandidateDecision, { params: { id: String(candSp1.id) }, body: { human_decision: 'observe' } })
    check('sponsored=1 -> 生成 estimate 且 confidence low', dSp1.data?.pricing_evidence?.playbook_estimate?.estimate_low === 750 && dSp1.data?.pricing_evidence?.playbook_estimate?.confidence === 'low')

    console.log('\n===== 7. historical evidence / price reference 冻结 =====')
    check('historical_evidence = has_prior_collaboration:false', JSON.stringify(dA.data?.historical_evidence) === JSON.stringify({ has_prior_collaboration: false }))
    check('historical evidence 不重复塞 target_cpm', !('target_cpm' in (dA.data?.historical_evidence || {})))
    const hpr = pe.historical_price_reference || {}
    check('historical price reference available + target', hpr.available === true && hpr.target_play === 52000)
    check('selected_case_count 冻结（5）', hpr.selected_case_count === 5)
    check('summary 冻结（非 null）', Boolean(hpr.summary) && typeof hpr.summary.cost_median === 'number')
    check('selected_record_ids 冻结（5 个）', Array.isArray(hpr.selected_record_ids) && hpr.selected_record_ids.length === 5)
    const liveRef = await callRoute(priceRef, { params: { id: String(candA.id) } })
    check('与 Phase 3B 同一实现（record_ids 一致）', JSON.stringify(hpr.selected_record_ids) === JSON.stringify(liveRef.data.cases.map((c) => c.record_id)))

    console.log('\n===== 8. append-only + 排序 =====')
    const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ?').get(candA.id).n
    const dObserve = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: 'observe', decision_note: '第一次' } })
    const dContact = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: 'contact', decision_note: '第二次' } })
    const listA = await callRoute(listCandidateDecisions, { params: { id: String(candA.id) } })
    check('observe -> contact 产生两行（不 UPDATE）', db.prepare('SELECT COUNT(*) AS n FROM creator_decisions WHERE candidate_id = ?').get(candA.id).n === beforeCount + 2)
    check('两条 decision id 不同', dObserve.data?.id !== dContact.data?.id)
    check('latest 排序稳定（最新在前）', listA.data.decisions[0].id === dContact.data.id)
    check('历史保留旧记录', listA.data.decisions.some((x) => x.id === dObserve.data.id))
    check('GET 返回 candidate_id / creator / stage / note / snapshot_id / created_at', listA.data.decisions.every((x) => 'candidate_id' in x && 'creator' in x && 'decision_stage' in x && 'decision_note' in x && 'snapshot_id' in x && 'created_at' in x))

    console.log('\n===== 9. candidate 改名不断链 =====')
    const oldDecisions = (await callRoute(listCandidateDecisions, { params: { id: String(candA.id) } })).data.decisions
    const oldIds = oldDecisions.map((x) => x.id)
    await callRoute(patchCandidate, { params: { id: String(candA.id) }, body: { name: '新名字' } })
    const afterRename = (await callRoute(listCandidateDecisions, { params: { id: String(candA.id) } })).data.decisions
    check('改名后仍能返回旧 decision', oldIds.every((id) => afterRename.some((x) => x.id === id)))
    check('旧 decision.creator 保持旧名（不 UPDATE）', afterRename.find((x) => x.id === oldIds[0]).creator === '同名达人')
    const dRenamed = await callRoute(createCandidateDecision, { params: { id: String(candA.id) }, body: { human_decision: 'hold' } })
    check('新 decision 使用新名字', dRenamed.data?.creator === '新名字' && dRenamed.data?.candidate_id === candA.id)
    check('新旧 decision 同属 candidate_id', afterRename.every((x) => x.candidate_id === candA.id) && dRenamed.data.candidate_id === candA.id)

    console.log('\n===== 10. 同名 candidate 不串 =====')
    const listB = await callRoute(listCandidateDecisions, { params: { id: String(candB.id) } })
    const finalA = (await callRoute(listCandidateDecisions, { params: { id: String(candA.id) } })).data.decisions
    check('A 的列表不含 B 的 decision', !finalA.some((x) => x.id === dB.data.id))
    check('B 的列表不含 A 的 decision', !listB.data.decisions.some((x) => x.candidate_id !== candB.id))
    check('B 只返回自己的 decision', listB.data.decisions.every((x) => x.candidate_id === candB.id && x.creator === '同名达人'))

    console.log('\n===== 11. 无推荐 / 无 AI / 旧 Decision 兼容 =====')
    check('response 不含 should_invest / recommendation_score / similarity', !/should_invest|recommendation_score|similarity|recommended_price/.test(JSON.stringify(dA.body)))
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorCandidates.js'), 'utf8')
    check('candidate decision 不引用 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    // 旧 contact 流程仍可用（creator 存在于 creator_records + 历史 snapshot）
    const histSnap = await callRoute(
      findHandler(snapshots.default, '/', 'post'),
      { body: { creator: '旧达人', recognized_creator_name_raw: '旧达人', observed_at: OBSERVED_AT, plays: [play(30000, 'sponsored', 1)] } }
    )
    const legacyDecision = await callRoute(legacyCreateDecision, {
      body: { creator: '旧达人', decision_stage: 'contact', human_decision: 'contact_now', ip_judgement: 'strong' }
    })
    check('旧 contact decision 仍可创建', legacyDecision.status === 200, JSON.stringify(legacyDecision.msg))
    check('旧 decision.candidate_id = null', legacyDecision.data?.candidate_id === null)
    const legacyList = await callRoute(legacyListDecisions, { query: { creator: '旧达人' } })
    check('旧 GET /api/creator-decisions 行为不变', legacyList.status === 200 && legacyList.data.decisions.some((x) => x.id === legacyDecision.data.id))
    check('旧 decision 不出现在任何 candidate decision 列表', !finalA.some((x) => x.id === legacyDecision.data.id))
    check('legacy latest snapshot 行为不变', (await callRoute(legacyLatestSnapshot, { query: { creator: '旧达人' } })).data.snapshot?.id === histSnap.data.id)
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
