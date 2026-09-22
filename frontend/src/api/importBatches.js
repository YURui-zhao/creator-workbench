import request from '../utils/request.js'

/**
 * 导入历史（批次）接口
 * 后端统一返回 { code: 200, data, msg: 'success' }
 */

/**
 * 分页查询导入批次（按导入时间倒序）
 * @param {{ page?: number, pageSize?: number, startDate?: string, endDate?: string }} params
 */
export function getImportBatches(params) {
  return request.get('/import/batches', { params })
}

/**
 * 查询单个批次详情（批次统计 + 行级明细 + 对应投放记录）
 * @param {number|string} id 批次 ID
 */
export function getImportBatchDetail(id) {
  return request.get(`/import/batches/${id}`)
}
