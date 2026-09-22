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
const BATCH_SELECT = `SELECT ${BATCH_COLUMNS.join(', ')} FROM import_batches`

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

export default router
