#!/usr/bin/env node
/**
 * 候选达人身份层（V3-alpha.3 Playbook Phase 1）回归测试
 *
 * 运行方式：node tests/creator_candidates.test.js
 * 隔离方式：WORKBENCH_DB_PATH 指向临时数据库（先于 import backend/db.js 设置），结束后删除。
 * 网络：拦截 http/https/net/tls/fetch —— Phase 1 不调用 AI、不访问外部网络。
 *
 * 覆盖：creator_candidates schema / name 不唯一、候选 snapshot 保存（candidate_id 归属、creator 由服务端决定）、
 *      同名候选 latest 不串数据、历史达人 snapshot API 行为不变、candidate 不进入 Repurchase Radar、
 *      归档保留历史 snapshot、旧快照 candidate_id 为 NULL 可读。
 */
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const tls = require('node:tls')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-candidates-'))
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
    [http, 'request'],
    [http, 'get'],
    [https, 'request'],
    [https, 'get'],
    [net, 'connect'],
    [net, 'createConnection'],
    [net.Socket.prototype, 'connect'],
    [tls, 'connect']
  ]
  const originals = replacements.map(([target, method]) => [target, method, target[method]])
  for (const [target, method] of replacements) {
    target[method] = () => {
      blocked.push(method)
      throw new Error('Phase 1 test forbids network requests')
    }
  }
  const originalFetch = global.fetch
  global.fetch = () => {
    blocked.push('fetch')
    throw new Error('Phase 1 test forbids network requests')
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
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    }
  }
}

const play = (raw_text, extra = {}) => ({
  raw_text,
  excluded: false,
  source_image_index: 1,
  position_index: 1,
  ...extra
})

const OBSERVED_AT = '2026-09-29'

async function main() {
  const networkGuard = forbidNetwork()
  try {
    const candidates = await import(
      pathToFileURL(path.join(root, 'backend/routes/creatorCandidates.js')).href
    )
    const snapshots = await import(
      pathToFileURL(path.join(root, 'backend/routes/recentSnapshots.js')).href
    )
    const records = await import(pathToFileURL(path.join(root, 'backend/routes/records.js')).href)
    const db = (await import(pathToFileURL(path.join(root, 'backend/db.js')).href)).default

    const candidateRouter = candidates.default
    const snapshotRouter = snapshots.default
    const findHandler = (router, routePath, method) => {
      const layer = router.stack.find(
        (item) => item.route && item.route.path === routePath && item.route.methods?.[method]
      )
      return layer?.route?.stack?.[layer.route.stack.length - 1]?.handle
    }
    const callRoute = async (handler, { body = {}, query = {}, params = {} } = {}) => {
      const res = response()
      await handler({ body, query, params, headers: {} }, res)
      return { status: res.statusCode, body: res.body, data: res.body?.data, msg: res.body?.msg }
    }

    const createCandidate = findHandler(candidateRouter, '/', 'post')
    const listCandidates = findHandler(candidateRouter, '/', 'get')
    const detailCandidate = findHandler(candidateRouter, '/:id', 'get')
    const patchCandidate = findHandler(candidateRouter, '/:id', 'patch')
    const saveCandidateSnapshot = findHandler(candidateRouter, '/:id/recent-snapshots', 'post')
    const candidateLatest = findHandler(candidateRouter, '/:id/recent-snapshots/latest', 'get')
    const historyPost = findHandler(snapshotRouter, '/', 'post')
    const historyLatest = findHandler(snapshotRouter, '/latest', 'get')
    const radarHandler = findHandler(records.default, '/repurchase-radar', 'get')

    console.log('===== 1. schema =====')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name)
    check('新增 creator_candidates 表', tables.includes('creator_candidates'), JSON.stringify(tables))
    const candidateColumns = db.prepare('PRAGMA table_info(creator_candidates)').all()
    const candidateColumnMap = Object.fromEntries(candidateColumns.map((c) => [c.name, c]))
    check(
      'creator_candidates 字段齐全',
      ['id', 'name', 'creator_type', 'profile_url', 'description', 'status', 'created_at', 'updated_at'].every(
        (name) => name in candidateColumnMap
      ),
      JSON.stringify(Object.keys(candidateColumnMap))
    )
    check('每列都显式声明类型', candidateColumns.every((c) => c.type && c.type.trim()))
    const nameUnique = candidateColumns.find((c) => c.name === 'name').pk
    check('name 不是主键（稳定身份是 id）', nameUnique === 0)
    const candidateIndexes = db.prepare('PRAGMA index_list(creator_candidates)').all()
    check(
      'name 上没有 UNIQUE 约束（允许重名）',
      candidateIndexes.every((i) => i.unique !== 1),
      JSON.stringify(candidateIndexes.map((i) => i.name))
    )
    const snapshotColumns = db.prepare('PRAGMA table_info(creator_recent_snapshots)').all()
    check(
      'creator_recent_snapshots 新增 candidate_id 列',
      snapshotColumns.some((c) => c.name === 'candidate_id'),
      JSON.stringify(snapshotColumns.map((c) => c.name))
    )
    check(
      'candidate_id 显式声明类型',
      snapshotColumns.find((c) => c.name === 'candidate_id')?.type === 'INTEGER'
    )
    const snapshotIndexes = db.prepare('PRAGMA index_list(creator_recent_snapshots)').all().map((i) => i.name)
    check('存在 candidate_id 索引', snapshotIndexes.includes('idx_recent_snapshots_candidate'), JSON.stringify(snapshotIndexes))

    console.log('\n===== 2. 创建候选（name 不唯一）=====')
    const c1 = await callRoute(createCandidate, {
      body: { name: '新达人甲', creator_type: '美妆', profile_url: 'https://example.com/a', description: '测试候选' }
    })
    check('创建候选返回 200', c1.status === 200 && Boolean(c1.data?.id), JSON.stringify(c1.msg))
    check('默认 status=active', c1.data?.status === 'active', String(c1.data?.status))
    check('可选字段被 trim（\n 测试候选 → 测试候选）', c1.data?.description === '测试候选')
    const c1dup = await callRoute(createCandidate, { body: { name: '新达人甲' } })
    check('同名候选可再次创建（不同 id）', c1dup.status === 200 && c1dup.data.id !== c1.data.id, `${c1.data?.id} vs ${c1dup.data?.id}`)
    check('空 name → 400', (await callRoute(createCandidate, { body: { name: '   ' } })).status === 400)
    check('非法 status → 400', (await callRoute(createCandidate, { body: { name: 'x', status: 'converted' } })).status === 400)
    check('name 超长 → 400', (await callRoute(createCandidate, { body: { name: 'x'.repeat(101) } })).status === 400)

    const list = await callRoute(listCandidates, { query: {} })
    check('列表返回全部候选', list.status === 200 && list.data.candidates.length === 2, String(list.data?.candidates?.length))
    const detail = await callRoute(detailCandidate, { params: { id: String(c1.data.id) } })
    check('详情返回对应候选', detail.status === 200 && detail.data.name === '新达人甲')
    check('不存在的候选详情 → 404', (await callRoute(detailCandidate, { params: { id: '99999' } })).status === 404)
    const patched = await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: { creator_type: '数码' } })
    check('PATCH 更新字段', patched.status === 200 && patched.data.creator_type === '数码')
    check('PATCH 空 body → 400', (await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: {} })).status === 400)

    console.log('\n===== 3. 候选快照：服务端决定 creator / 落 candidate_id =====')
    check(
      '候选不在 creator_records（未投放）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_records WHERE nickname = ?').get('新达人甲').n === 0
    )
    const recordsBefore = db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n
    const candSave = await callRoute(saveCandidateSnapshot, {
      params: { id: String(c1.data.id) },
      body: {
        // 恶意：前端提交伪造 creator，服务端必须忽略并用 candidate.name
        creator: '伪造名称',
        recognized_creator_name_raw: '新达人甲',
        xingtu_price_raw: '¥5,000',
        observed_at: OBSERVED_AT,
        plays: [play('5.2万'), play('4.8万'), play('6.1万'), play('5.5万'), play('1万'), play('9000')]
      }
    })
    check('无历史候选仍可保存快照', candSave.status === 200 && Boolean(candSave.data?.id), JSON.stringify(candSave.msg))
    check('candidate_id 正确落库', candSave.data?.candidate_id === c1.data.id, String(candSave.data?.candidate_id))
    check('creator 由服务端 candidate.name 决定（忽略前端伪造）', candSave.data?.creator === '新达人甲', String(candSave.data?.creator))
    check('未写入 creator_records', db.prepare('SELECT COUNT(*) AS n FROM creator_records').get().n === recordsBefore)
    check('observed_at / 星图价语义保留', candSave.data?.observed_at === OBSERVED_AT && candSave.data?.xingtu_price === 5000, JSON.stringify({ o: candSave.data?.observed_at, p: candSave.data?.xingtu_price }))
    check('候选不存在 → 404', (await callRoute(saveCandidateSnapshot, { params: { id: '99999' }, body: { observed_at: OBSERVED_AT, plays: [play('1万')] } })).status === 404)
    check('候选快照仍要求 observed_at', (await callRoute(saveCandidateSnapshot, { params: { id: String(c1.data.id) }, body: { plays: [play('1万')] } })).status === 400)

    console.log('\n===== 4. 同名候选不互相串数据 =====')
    const sameName2 = await callRoute(saveCandidateSnapshot, {
      params: { id: String(c1dup.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('30万'), play('31万'), play('32万'), play('33万'), play('34万'), play('35万')] }
    })
    check('同名第二候选保存成功', sameName2.status === 200 && sameName2.data.candidate_id === c1dup.data.id)
    const latest1 = await callRoute(candidateLatest, { params: { id: String(c1.data.id) } })
    const latest2 = await callRoute(candidateLatest, { params: { id: String(c1dup.data.id) } })
    check(
      '同名候选 latest 各自取自己的快照（不串）',
      latest1.data?.snapshot?.id === candSave.data.id && latest2.data?.snapshot?.id === sameName2.data.id,
      `${latest1.data?.snapshot?.id} / ${latest2.data?.snapshot?.id}`
    )
    check('不一致的中位数（证明未串数据）', latest1.data?.snapshot?.median_play !== latest2.data?.snapshot?.median_play)

    console.log('\n===== 5. 历史达人 snapshot API 行为不变 =====')
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W33', '历史达人', '数码', 1800, '2026-08-18', 20000, 100000)`
    ).run()
    const histOk = await callRoute(historyPost, {
      body: { creator: '历史达人', recognized_creator_name_raw: '历史达人', observed_at: OBSERVED_AT, plays: [play('2万'), play('3万')] }
    })
    check('历史达人（有 record）仍可保存', histOk.status === 200, JSON.stringify(histOk.msg))
    check('历史达人快照 candidate_id 为 NULL', histOk.data?.candidate_id === null, String(histOk.data?.candidate_id))
    check(
      '历史达人未在 creator_records 的达人仍被拒绝（行为不变）',
      (await callRoute(historyPost, { body: { creator: '未投放达人', observed_at: OBSERVED_AT, plays: [play('1万')] } })).status === 400
    )
    const histLatest = await callRoute(historyLatest, { query: { creator: '历史达人' } })
    check('历史 latest 正常返回', histLatest.status === 200 && histLatest.data.snapshot?.id === histOk.data.id)

    console.log('\n===== 6. 同名：candidate 快照不污染历史 latest / Radar =====')
    db.prepare(
      `INSERT INTO creator_records (time_cycle, nickname, creator_type, total_cost, publish_date, first_play, second_week_play)
       VALUES ('2026-W34', '重名达人', '生活', 900, '2026-08-25', 15000, 40000)`
    ).run()
    const histSame = await callRoute(historyPost, {
      body: { creator: '重名达人', recognized_creator_name_raw: '重名达人', observed_at: OBSERVED_AT, plays: [play('1.5万'), play('1.6万'), play('1.7万'), play('1.8万'), play('1.9万'), play('2万')] }
    })
    const candidateSame = await callRoute(createCandidate, { body: { name: '重名达人' } })
    const candSameSave = await callRoute(saveCandidateSnapshot, {
      params: { id: String(candidateSame.data.id) },
      body: { observed_at: OBSERVED_AT, plays: [play('99万'), play('98万')] }
    })
    const histSameLatest = await callRoute(historyLatest, { query: { creator: '重名达人' } })
    check(
      '历史 latest 只返回历史快照（不返回同名候选快照）',
      histSameLatest.data?.snapshot?.id === histSame.data.id && histSameLatest.data?.snapshot?.id !== candSameSave.data.id,
      `${histSameLatest.data?.snapshot?.id}`
    )
    const candSameLatest = await callRoute(candidateLatest, { params: { id: String(candidateSame.data.id) } })
    check('候选 latest 只返回候选快照', candSameLatest.data?.snapshot?.id === candSameSave.data.id)

    const radar = await callRoute(radarHandler, { query: {} })
    const radarCreators = (radar.data?.groups || []).flatMap((g) => g.creators || []).map((c) => c.creator)
    check('新候选（未投放）不出现在雷达', !radarCreators.includes('新达人甲'), JSON.stringify(radarCreators))
    const radarSame = (radar.data?.groups || []).flatMap((g) => g.creators || []).find((c) => c.creator === '重名达人')
    check(
      'Radar 上同名达人的 recent_snapshot 不来自候选（未污染）',
      radarSame && (radarSame.recent_snapshot === null || radarSame.recent_snapshot.id === histSame.data.id),
      JSON.stringify(radarSame?.recent_snapshot?.id ?? null)
    )

    console.log('\n===== 7. 归档保留历史事实 =====')
    const arch = await callRoute(patchCandidate, { params: { id: String(c1.data.id) }, body: { status: 'archived' } })
    check('归档成功（status=archived）', arch.status === 200 && arch.data.status === 'archived')
    check(
      '归档后历史 snapshot 仍保留',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(c1.data.id).n === 1
    )
    const archivedLatest = await callRoute(candidateLatest, { params: { id: String(c1.data.id) } })
    check('归档候选仍可读取其最新快照', archivedLatest.status === 200 && archivedLatest.data.snapshot?.id === candSave.data.id)
    const activeOnly = await callRoute(listCandidates, { query: { status: 'active' } })
    check('status=active 过滤生效', activeOnly.data.candidates.every((c) => c.status === 'active'))

    console.log('\n===== 8. 旧快照（candidate_id=NULL）可读 =====')
    const nullRows = db
      .prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id IS NULL')
      .get().n
    check('历史快照 candidate_id 全部为 NULL', nullRows >= 2, String(nullRows))
    const histPublic = await callRoute(historyLatest, { query: { creator: '历史达人' } })
    check('旧快照（NULL）可正常读取', histPublic.data?.snapshot?.candidate_id === null && histPublic.data?.snapshot?.id === histOk.data.id)

    console.log('\n===== 9. 生命周期：改名后身份稳定（依赖 candidate_id，而非名称）=====')
    const renameCand = await callRoute(createCandidate, { body: { name: '旧达人名' } })
    const renameId = renameCand.data.id
    const snapA = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameId) },
      body: { observed_at: OBSERVED_AT, plays: [play('1.1万'), play('1.2万')] }
    })
    check('snapshot A 创建：creator=旧达人名', snapA.status === 200 && snapA.data.creator === '旧达人名' && snapA.data.candidate_id === renameId)
    const snapARowBefore = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapA.data.id)
    const renamed = await callRoute(patchCandidate, { params: { id: String(renameId) }, body: { name: '新达人名' } })
    check('PATCH 改名成功', renamed.status === 200 && renamed.data.name === '新达人名')
    const latestAfterRename = await callRoute(candidateLatest, { params: { id: String(renameId) } })
    check(
      '改名后 latest 仍能找到 snapshot A（不断链）',
      latestAfterRename.data?.snapshot?.id === snapA.data.id,
      String(latestAfterRename.data?.snapshot?.id)
    )
    check(
      'snapshot A.creator 保持「旧达人名」（创建时名称快照，不回填 / 不 UPDATE）',
      latestAfterRename.data?.snapshot?.creator === '旧达人名',
      String(latestAfterRename.data?.snapshot?.creator)
    )
    const snapB = await callRoute(saveCandidateSnapshot, {
      params: { id: String(renameId) },
      body: { observed_at: '2026-09-30', plays: [play('9万'), play('10万'), play('11万'), play('12万'), play('13万'), play('14万')] }
    })
    check('snapshot B：candidate_id 仍为 X', snapB.data?.candidate_id === renameId, String(snapB.data?.candidate_id))
    check('snapshot B：creator 由服务端写成「新达人名」', snapB.data?.creator === '新达人名', String(snapB.data?.creator))
    const latestAfterB = await callRoute(candidateLatest, { params: { id: String(renameId) } })
    check('latest 正确返回 snapshot B（更新的 observed_at / created_at）', latestAfterB.data?.snapshot?.id === snapB.data.id, String(latestAfterB.data?.snapshot?.id))
    const snapARowAfter = db.prepare('SELECT * FROM creator_recent_snapshots WHERE id = ?').get(snapA.data.id)
    check(
      'snapshot A 业务字段 byte-for-byte 未变（不改写历史）',
      JSON.stringify(snapARowAfter) === JSON.stringify(snapARowBefore),
      JSON.stringify({ before: snapARowBefore.median_play, after: snapARowAfter.median_play })
    )
    check(
      '改名不按名称误连：不存在名为「旧达人名」的候选 / 新 latest 只认 candidate_id',
      db.prepare('SELECT COUNT(*) AS n FROM creator_candidates WHERE name = ?').get('旧达人名').n === 0
    )

    console.log('\n===== 10. 生命周期：archived 冻结写入（保留历史）=====')
    const archCand = await callRoute(createCandidate, { body: { name: '归档达人' } })
    const archId = archCand.data.id
    const archSnap = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: OBSERVED_AT, plays: [play('2万'), play('2.5万')] }
    })
    check('active 时可保存', archSnap.status === 200)
    await callRoute(patchCandidate, { params: { id: String(archId) }, body: { status: 'archived' } })
    const archDetail = await callRoute(detailCandidate, { params: { id: String(archId) } })
    check('archived：detail 仍可读取', archDetail.status === 200 && archDetail.data.status === 'archived')
    const archLatest = await callRoute(candidateLatest, { params: { id: String(archId) } })
    check('archived：latest 仍可读取（历史不隐藏）', archLatest.status === 200 && archLatest.data.snapshot?.id === archSnap.data.id)
    const archBlocked = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: '2026-09-30', plays: [play('3万')] }
    })
    check(
      'archived：新增 snapshot 被拒绝（4xx，提示需恢复 active）',
      archBlocked.status >= 400 && archBlocked.status < 500 && /归档|active/.test(String(archBlocked.msg)),
      `${archBlocked.status} ${archBlocked.msg}`
    )
    check(
      'archived：拒绝时未写入任何新快照',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(archId).n === 1
    )
    await callRoute(patchCandidate, { params: { id: String(archId) }, body: { status: 'active' } })
    const reactivated = await callRoute(saveCandidateSnapshot, {
      params: { id: String(archId) },
      body: { observed_at: '2026-09-30', plays: [play('3万'), play('3.1万')] }
    })
    check('恢复 active 后可继续新增 snapshot', reactivated.status === 200 && reactivated.data.candidate_id === archId)
    check(
      '恢复后历史仍保留（两条共存）',
      db.prepare('SELECT COUNT(*) AS n FROM creator_recent_snapshots WHERE candidate_id = ?').get(archId).n === 2
    )

    console.log('\n===== 11. 安全边界 =====')
    check('未发生任何外部网络请求', networkGuard.blocked.length === 0, JSON.stringify(networkGuard.blocked))
    const routeSource = fs.readFileSync(path.join(root, 'backend/routes/creatorCandidates.js'), 'utf8')
    check('Phase 1 路由不引用任何 AI 服务', !/deepseek|callProviderVision|extract-creator-screenshot/i.test(routeSource))
    check(
      'Phase 1 注册的候选路由集合',
      candidateRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .sort()
        .join(' | ') ===
        'GET / | GET /:id | GET /:id/recent-snapshots/latest | PATCH /:id | POST / | POST /:id/recent-snapshots',
      candidateRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .join(' | ')
    )
    check(
      '历史 recent-snapshots 路由集合未变（仍只有 GET /latest | POST /）',
      snapshotRouter.stack
        .filter((l) => l.route)
        .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
        .sort()
        .join(' | ') === 'GET /latest | POST /'
    )
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
