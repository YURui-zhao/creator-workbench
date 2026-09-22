import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { ReloadOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getImportBatchDetail, getImportBatches } from '../../api/importBatches'
import { getErrorMessage } from '../../utils/request'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc'
import { weekCodeToLabel } from '../../utils/excel'

const PAGE_SIZE_OPTIONS = [10, 20, 50]

// 行级明细状态 -> 展示标签
const ITEM_STATUS = {
  success: { text: '成功', color: 'success' },
  fail: { text: '失败', color: 'error' },
  skip: { text: '跳过', color: 'default' },
  duplicate: { text: '重复', color: 'warning' }
}

// created_at 由 SQLite CURRENT_TIMESTAMP 写入（UTC 时间字符串），展示时统一转换为浏览器本地时间（精确到分钟）
function formatDateTime(value) {
  if (!value) return '-'
  const text = String(value).trim()
  // 兼容 '2026-09-22 08:12:34'（SQLite UTC）与带时区的 ISO 字符串
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return text.slice(0, 16)
  const pad = (num) => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/**
 * 导入历史页：批次列表（分页 + 时间范围筛选）+ 批次详情（成功/失败/跳过/重复明细）
 * 支持从导入成功提示跳转进来时自动打开指定批次（?batchId=xx）
 */
export default function ImportHistory() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [dateRange, setDateRange] = useState(null)

  // 批次详情抽屉
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')

  // 查询条件：日期范围 -> startDate/endDate
  const queryParams = useMemo(() => {
    const params = { page, pageSize }
    if (Array.isArray(dateRange) && dateRange[0] && dateRange[1]) {
      params.startDate = dateRange[0].format('YYYY-MM-DD')
      params.endDate = dateRange[1].format('YYYY-MM-DD')
    }
    return params
  }, [page, pageSize, dateRange])

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await getImportBatches(queryParams)
      setList(res.data.list || [])
      setTotal(res.data.total || 0)
    } catch (err) {
      setList([])
      setTotal(0)
      setLoadError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [queryParams])

  useEffect(() => {
    loadData()
  }, [loadData])

  // 打开批次详情（列表点击 / URL 带 batchId 时自动打开）
  const openDetail = useCallback(async (batchId) => {
    const id = Number(batchId)
    if (!Number.isSafeInteger(id) || id <= 0) return
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailError('')
    try {
      const res = await getImportBatchDetail(id)
      setDetail(res.data)
    } catch (err) {
      setDetail(null)
      setDetailError(getErrorMessage(err))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // 从导入成功提示跳转进来：?batchId=xx 自动展开详情
  useEffect(() => {
    const batchId = searchParams.get('batchId')
    if (batchId) openDetail(batchId)
  }, [searchParams, openDetail])

  const closeDetail = () => {
    setDetailOpen(false)
    setDetail(null)
    setDetailError('')
    if (searchParams.get('batchId')) {
      const next = new URLSearchParams(searchParams)
      next.delete('batchId')
      setSearchParams(next, { replace: true })
    }
  }

  // 跳转投放管理页并按该批次筛选
  const goRecordsByBatch = (batchId) => {
    navigate(`/records?batchId=${batchId}`)
  }

  const columns = [
    { title: '批次', dataIndex: 'id', width: 80 },
    {
      title: '导入文件',
      dataIndex: 'file_name',
      ellipsis: true,
      render: (value, record) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => openDetail(record.id)}>
          {value || `批次 #${record.id}`}
        </Button>
      )
    },
    {
      title: '导入时间',
      dataIndex: 'created_at',
      width: 150,
      render: (value) => formatDateTime(value)
    },
    {
      title: '总条数',
      dataIndex: 'total_count',
      width: 90,
      align: 'right',
      render: (value) => formatInteger(value)
    },
    {
      title: '成功',
      dataIndex: 'success_count',
      width: 90,
      align: 'right',
      render: (value) => <Tag color="success">{formatInteger(value)}</Tag>
    },
    {
      title: '失败',
      dataIndex: 'fail_count',
      width: 90,
      align: 'right',
      render: (value) => <Tag color={value ? 'error' : 'default'}>{formatInteger(value)}</Tag>
    },
    {
      title: '跳过',
      dataIndex: 'skip_count',
      width: 90,
      align: 'right',
      render: (value) => <Tag>{formatInteger(value)}</Tag>
    },
    {
      title: '重复',
      dataIndex: 'duplicate_count',
      width: 90,
      align: 'right',
      render: (value) => <Tag color={value ? 'warning' : 'default'}>{formatInteger(value)}</Tag>
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space size={8}>
          <Button size="small" type="link" onClick={() => openDetail(record.id)}>
            批次详情
          </Button>
          <Button
            size="small"
            type="link"
            icon={<UnorderedListOutlined />}
            onClick={() => goRecordsByBatch(record.id)}
          >
            查看对应记录
          </Button>
        </Space>
      )
    }
  ]

  // 详情：行级明细（失败 / 跳过 / 重复 / 成功）
  const detailItemColumns = [
    {
      title: 'Excel 行号',
      dataIndex: 'row_index',
      width: 100,
      render: (value) => (value ? `第 ${value} 行` : '未知行')
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value) => {
        const info =
          ITEM_STATUS[String(value || '').toLowerCase()] || { text: value || '-', color: 'default' }
        return <Tag color={info.color}>{info.text}</Tag>
      }
    },
    { title: '说明', dataIndex: 'reason', render: (value) => value || '-' }
  ]

  // V2 单条播放口径（与投放管理页 / 导出保持一致）：
  // latest 未填写 或 异常（latest < first）→ 不可用于 CPM / 后续新增
  const recordLatestPlay = (record) => {
    const latestRaw = record?.second_week_play
    if (latestRaw === null || latestRaw === undefined || latestRaw === '') return null
    const latest = Number(latestRaw)
    if (!Number.isFinite(latest)) return null
    const firstRaw = record?.first_play
    if (firstRaw !== null && firstRaw !== undefined && firstRaw !== '') {
      const first = Number(firstRaw)
      if (Number.isFinite(first) && latest < first) return null
    }
    return latest
  }

  // 累计播放量：未填写显示「待更新」；异常（latest < first）保留原始数值并标红 + 悬浮提示
  const latestPlayRender = (value, record) => {
    if (value === null || value === undefined || value === '') {
      return <Typography.Text type="secondary">待更新</Typography.Text>
    }
    const latest = Number(value)
    const firstRaw = record?.first_play
    const first =
      firstRaw === null || firstRaw === undefined || firstRaw === '' ? null : Number(firstRaw)
    if (Number.isFinite(latest) && first !== null && Number.isFinite(first) && latest < first) {
      return (
        <Tooltip title="累计播放量小于7日播放量">
          <span style={{ color: '#d4380d' }}>{formatPlays(value)}</span>
        </Tooltip>
      )
    }
    return formatPlays(value)
  }

  // CPM = 总花费 ÷ 累计播放量 × 1000；最新累计待更新 / 异常 / ≤0 → -
  const latestCpmRender = (_, record) => {
    const latest = recordLatestPlay(record)
    return formatCpm(latest === null ? null : calcCpm(record.total_cost, latest))
  }

  // 后续新增播放量 = 累计播放量 − 7日播放量（仅 latest 有效且 ≥ 7日播放量时展示，否则 -）
  const post7dGrowthRender = (_, record) => {
    const latest = recordLatestPlay(record)
    const firstRaw = record?.first_play
    if (latest === null || firstRaw === null || firstRaw === undefined || firstRaw === '') return '-'
    const first = Number(firstRaw)
    if (!Number.isFinite(first)) return '-'
    return formatPlays(latest - first)
  }

  // 详情：对应投放记录（字段与投放管理页保持一致）
  const detailRecordColumns = [
    { title: '时间周期', dataIndex: 'time_cycle', width: 120, render: (value) => weekCodeToLabel(value) },
    { title: '达人昵称', dataIndex: 'nickname', width: 130, ellipsis: true },
    { title: '达人类型', dataIndex: 'creator_type', width: 110, ellipsis: true },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 110,
      align: 'right',
      render: (value) => formatMoney(value)
    },
    {
      title: '7日播放量',
      dataIndex: 'first_play',
      width: 120,
      align: 'right',
      render: (value) => formatPlays(value)
    },
    {
      title: '累计播放量',
      dataIndex: 'second_week_play',
      width: 130,
      align: 'right',
      render: latestPlayRender
    },
    {
      title: 'CPM',
      key: 'latestCpm',
      width: 100,
      align: 'right',
      render: latestCpmRender
    },
    {
      title: '后续新增播放量',
      key: 'post7dGrowth',
      width: 145,
      align: 'right',
      render: post7dGrowthRender
    },
    { title: '发布日期', dataIndex: 'publish_date', width: 110, render: (value) => value || '-' }
  ]

  return (
    <div>
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12
          }}
        >
          <Space size={12} wrap>
            <Typography.Text type="secondary">导入时间：</Typography.Text>
            <DatePicker.RangePicker
              value={dateRange}
              onChange={(dates) => {
                setDateRange(dates)
                setPage(1)
              }}
              format="YYYY-MM-DD"
              allowClear
              style={{ width: 260 }}
            />
            <Button
              size="small"
              onClick={() => {
                setDateRange(null)
                setPage(1)
              }}
            >
              重置
            </Button>
          </Space>
          <Space>
            <Typography.Text type="secondary">共 {total} 个导入批次</Typography.Text>
            <Button icon={<ReloadOutlined />} onClick={loadData}>
              刷新
            </Button>
          </Space>
        </div>
      </Card>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          style={{ marginTop: 16 }}
          action={
            <Button size="small" onClick={loadData}>
              重试
            </Button>
          }
        />
      )}

      <Card style={{ marginTop: 16 }}>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={list}
          locale={{ emptyText: '暂无导入记录，可在投放管理页导入 Excel 后查看' }}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (nextPage, nextPageSize) => {
              if (nextPageSize !== pageSize) {
                setPageSize(nextPageSize)
                setPage(1)
              } else {
                setPage(nextPage)
              }
            }
          }}
        />
      </Card>

      {/* 批次详情抽屉：统计 + 行级明细 + 对应投放记录 */}
      <Drawer
        title={detail?.batch ? `导入批次 #${detail.batch.id}` : '导入批次详情'}
        width={980}
        open={detailOpen}
        onClose={closeDetail}
      >
        {detailLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : detailError ? (
          <Alert type="error" showIcon message={detailError} />
        ) : detail?.batch ? (
          <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="文件名">{detail.batch.file_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="导入时间">
                {formatDateTime(detail.batch.created_at)}
              </Descriptions.Item>
              <Descriptions.Item label="总条数">
                {formatInteger(detail.batch.total_count)}
              </Descriptions.Item>
              <Descriptions.Item label="成功 / 失败 / 跳过 / 重复">
                <Space size={6} wrap>
                  <Tag color="success">成功 {formatInteger(detail.batch.success_count)}</Tag>
                  <Tag color={detail.batch.fail_count ? 'error' : 'default'}>
                    失败 {formatInteger(detail.batch.fail_count)}
                  </Tag>
                  <Tag>跳过 {formatInteger(detail.batch.skip_count)}</Tag>
                  <Tag color={detail.batch.duplicate_count ? 'warning' : 'default'}>
                    重复 {formatInteger(detail.batch.duplicate_count)}
                  </Tag>
                </Space>
              </Descriptions.Item>
            </Descriptions>

            <Space>
              <Button type="primary" onClick={() => goRecordsByBatch(detail.batch.id)}>
                查看对应记录
              </Button>
              <Tooltip title="按该批次筛选投放管理页的列表">
                <Typography.Text type="secondary">
                  将跳转到投放管理并自动筛选本批次导入的 {formatInteger(detail.record_count)} 条记录
                </Typography.Text>
              </Tooltip>
            </Space>

            <div>
              <Typography.Text strong>行级明细（失败 / 跳过 / 重复 / 成功）</Typography.Text>
              {detail.items?.length ? (
                <Table
                  size="small"
                  rowKey="id"
                  style={{ marginTop: 8 }}
                  columns={detailItemColumns}
                  dataSource={detail.items}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  scroll={{ y: 240 }}
                />
              ) : (
                <Empty description="本次导入无行级明细记录" style={{ padding: 24 }} />
              )}
            </div>

            <div>
              <Typography.Text strong>
                对应投放记录（共 {formatInteger(detail.record_count)} 条，最多展示前 50 条）
              </Typography.Text>
              {detail.records?.length ? (
                <Table
                  size="small"
                  rowKey="id"
                  style={{ marginTop: 8 }}
                  columns={detailRecordColumns}
                  dataSource={detail.records}
                  pagination={false}
                  scroll={{ x: 1200 }}
                />
              ) : (
                <Empty description="该批次没有成功入库的记录" style={{ padding: 24 }} />
              )}
            </div>
          </Space>
        ) : null}
      </Drawer>
    </div>
  )
}
