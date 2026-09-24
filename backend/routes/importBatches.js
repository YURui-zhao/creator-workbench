import { Router } from 'express'
import db from '../db.js'

const router = Router()
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------- 统一响应格式 { code, data, msg }（与现有接口一致） ----------
function ok(res, data) {
  res.json({ code: 200, data, msg: 'success' })
}

function fail(res, code, msg) {
  res.status(code).json({ code, data: null, msg })
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const BATCH_COLUMNS = [
  'id',
  'file_name',
  'total_count',
  'success_count',
  'fail_count',
  'skip_count',
  'duplicate_count',
  'created_at'
]
// record_count = 该批次「当前仍关联」的投放记录数（与 success_count 语义不同：
// success_count 是导入当时成功写入的条数，record_count 会随记录被删除而减少）
const BATCH_SELECT = `SELECT ${BATCH_COLUMNS.join(', ')},
  (SELECT COUNT(*) FROM import_batch_records br WHERE br.batch_id = import_batches.id) AS record_count
  FROM import_batches`

// 「删除历史」被拒绝时的统一提示（批次仍有关联投放记录）
const HISTORY_DELETE_BLOCKED_MSG =
  '该批次仍有关联投放记录，请先撤销导入；如需保留投放数据，请手动删除对应记录后再删除历史。'
// 「撤销导入」在无可撤销记录时的友好提示
const ROLLBACK_EMPTY_MSG = '该批次当前没有可撤销的投放记录。'

/**
 * GET /api/import/batches
 * 分页查询导入批次（按导入时间倒序）
 * 查询参数：page、pageSize、startDate、endDate（按创建日期筛选，YYYY-MM-DD）
 */
router.get('/batches', (req, res) => {
  const page = Number(req.query.page)
  const pageSize = Number(req.query.pageSize)
  const validPage = Number.isInteger(page) && page > 0
  const validSize = Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100

  if (req.query.page !== undefined && !validPage) {
    return fail(res, 400, 'page 必须为正整数')
  }
  if (req.query.pageSize !== undefined && !validSize) {
    return fail(res, 400, 'pageSize 必须为 1-100 的整数')
  }

  const { startDate, endDate } = req.query
  if (startDate && !DATE_RE.test(String(startDate))) {
    return fail(res, 400, 'startDate 格式必须为 YYYY-MM-DD')
  }
  if (endDate && !DATE_RE.test(String(endDate))) {
    return fail(res, 400, 'endDate 格式必须为 YYYY-MM-DD')
  }
  if (startDate && endDate && String(startDate) > String(endDate)) {
    return fail(res, 400, 'startDate 不能晚于 endDate')
  }

  const finalPage = validPage ? page : 1
  const finalSize = validSize ? pageSize : 10

  const conditions = []
  const params = []
  if (startDate) {
    conditions.push('date(created_at) >= date(?)')
    params.push(String(startDate))
  }
  if (endDate) {
    conditions.push('date(created_at) <= date(?)')
    params.push(String(endDate))
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''

  const total = db.prepare(`SELECT COUNT(*) AS n FROM import_batches${where}`).get(...params).n
  const list = db
    .prepare(`${BATCH_SELECT}${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, finalSize, (finalPage - 1) * finalSize)

  ok(res, { list, total })
})

/**
 * GET /api/import/batches/:id
 * 批次详情：批次统计 + 行级明细（失败/跳过/重复/成功）+ 该批次导入的投放记录（前 50 条）
 */
router.get('/batches/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  const items = db
    .prepare(
      `SELECT id, row_index, status, reason
       FROM import_batch_items
       WHERE batch_id = ?
       ORDER BY row_index ASC, id ASC`
    )
    .all(id)

  const records = db
    .prepare(
      `SELECT r.id, r.time_cycle, r.nickname, r.creator_type, r.homepage, r.content_link,
              r.video_link, r.total_cost, r.publish_date, r.first_play, r.second_week_play
       FROM creator_records r
       JOIN import_batch_records br ON br.record_id = r.id
       WHERE br.batch_id = ?
       ORDER BY r.id ASC
       LIMIT 50`
    )
    .all(id)

  const recordCount = db
    .prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?')
    .get(id).n

  const summary = items.reduce(
    (acc, item) => {
      const key = String(item.status || '').toLowerCase()
      if (Object.prototype.hasOwnProperty.call(acc, key)) acc[key] += 1
      return acc
    },
    { success: 0, fail: 0, skip: 0, duplicate: 0 }
  )

  ok(res, {
    batch,
    items,
    records,
    record_count: recordCount,
    item_summary: summary
  })
})

/**
 * POST /api/import/batches/:id/rollback
 * 【撤销导入】：删除该批次当前仍关联的投放记录（只按 import_batch_records 精确关联，绝不按昵称/周期/文件名模糊匹配）。
 * 事务内完成：删除记录 → 清理该批次的 mapping。
 * 保留 import_batches（当时成功/失败多少条仍是历史事实）与 import_batch_items（行级审计原因）。
 * 记录已被手动删除的情况：只删除当前仍存在的记录，不因数量少于 success_count 而失败。
 */
router.post('/batches/:id/rollback', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  const result = db.transaction((batchId) => {
    // 该批次当前的全部关联（可能指向已被手动删除的记录）
    const mappings = db
      .prepare('SELECT record_id FROM import_batch_records WHERE batch_id = ?')
      .all(batchId)
    const removeRecord = db.prepare('DELETE FROM creator_records WHERE id = ?')
    let deletedCount = 0
    for (const mapping of mappings) {
      const info = removeRecord.run(mapping.record_id)
      if (info.changes > 0) deletedCount += 1
    }
    const clearedMappingCount = db
      .prepare('DELETE FROM import_batch_records WHERE batch_id = ?')
      .run(batchId).changes
    const itemsKept = db
      .prepare('SELECT COUNT(*) AS n FROM import_batch_items WHERE batch_id = ?')
      .get(batchId).n
    return {
      scannedMappingCount: mappings.length,
      deletedCount,
      clearedMappingCount,
      itemsKept
    }
  })(id)

  ok(res, {
    batchId: id,
    deletedCount: result.deletedCount,
    clearedMappingCount: result.clearedMappingCount,
    scannedMappingCount: result.scannedMappingCount,
    itemsKept: result.itemsKept,
    recordCount: 0,
    message:
      result.deletedCount > 0
        ? `已撤销导入：删除 ${result.deletedCount} 条投放记录`
        : ROLLBACK_EMPTY_MSG
  })
})

/**
 * DELETE /api/import/batches/:id
 * 【删除历史】：只删除导入日志（批次 + 行级明细 + 残留 mapping），绝不删除 creator_records。
 * 若该批次仍有关联投放记录 → 409 拒绝（否则用户将失去按批次精确撤销的能力）。
 */
router.delete('/batches/:id', (req, res) => {
  const id = parseId(req.params.id)
  if (!id) return fail(res, 400, 'id 必须为正整数')

  const batch = db.prepare(`${BATCH_SELECT} WHERE id = ?`).get(id)
  if (!batch) return fail(res, 404, '导入批次不存在')

  const mappingCount = db
    .prepare('SELECT COUNT(*) AS n FROM import_batch_records WHERE batch_id = ?')
    .get(id).n
  if (mappingCount > 0) return fail(res, 409, HISTORY_DELETE_BLOCKED_MSG)

  const result = db.transaction((batchId) => ({
    deletedItems: db.prepare('DELETE FROM import_batch_items WHERE batch_id = ?').run(batchId).changes,
    deletedMappings: db
      .prepare('DELETE FROM import_batch_records WHERE batch_id = ?')
      .run(batchId).changes,
    deletedBatches: db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId).changes
  }))(id)

  ok(res, { batchId: id, ...result })
})

export default router
