import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  buildRecordsExportUrl,
  fetchAllRecords,
  getCreatorSummary,
  getRecordFilters
} from '../../api/records'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc.js'
import { getNextWeek, getPrevWeek, weekCodeToDateRange, formatWeekLabel } from '../../utils/dateCycle.js'
import { getErrorMessage } from '../../utils/request'
import {
  buildCreatorCompareFileName,
  buildCreatorSummaryFileName,
  exportCreatorStatsToExcel
} from '../../utils/excel'
import { buildCompareRows, canCompareCreators, COMPARE_MAX, COMPARE_MIN } from '../../utils/creatorCompare.js'

// 最小投放次数下拉选项
const MIN_CAMPAIGNS_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 2, label: '2 次及以上' },
  { value: 3, label: '3 次及以上' }
]

/**
 * 达人汇总分析页：按达人横向聚合投放数据，支持周范围/博主类型筛选、口径切换、
 * 分组折叠、列排序与单达人下钻明细、一键导出汇总。
 */
export default function CreatorSummary() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [summary, setSummary] = useState(null)
  const [filterMeta, setFilterMeta] = useState({
    creatorTypes: [],
    nicknames: [],
    weekRange: { earliestWeek: null, latestWeek: null }
  })
  const [weekOptions, setWeekOptions] = useState([])
  const [rangeStart, setRangeStart] = useState(null)
  const [rangeEnd, setRangeEnd] = useState(null)
  const [filterTypes, setFilterTypes] = useState([])
  const [caliber, setCaliber] = useState('occurrence')
  // 新增筛选：达人昵称（防抖 500ms）+ 最小投放次数
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [minCampaigns, setMinCampaigns] = useState(0)
  // 排序：由接口完成（sortBy + sortOrder），默认按总花费降序
  const [sort, setSort] = useState({ sortBy: 'total_cost', sortOrder: 'desc' })
  // 达人对比：勾选的达人昵称 + 对比弹窗
  const [compareKeys, setCompareKeys] = useState([])
  const [compareOpen, setCompareOpen] = useState(false)
  // 抽屉：单达人下钻明细
  const [drawerCreator, setDrawerCreator] = useState(null)
  const [detailRecords, setDetailRecords] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [allRecords, setAllRecords] = useState([])

  const caliberLabel = caliber === 'campaign' ? '投放周口径' : '发生周口径'

  // 筛选元数据 + 全量记录（用于下钻明细与周下拉）
  const loadBaseData = useCallback(async () => {
    setLoadError('')
    try {
      const [filtersRes, records] = await Promise.all([getRecordFilters(), fetchAllRecords()])
      const meta = filtersRes.data || {}
      setFilterMeta(meta)
      setAllRecords(records)
      const { earliestWeek, latestWeek } = meta.weekRange || {}
      if (earliestWeek && latestWeek) {
        const options = []
        let cursor = earliestWeek
        while (cursor && cursor <= latestWeek && options.length < 300) {
          const range = weekCodeToDateRange(cursor)
          if (range) {
            options.push({
              weekCode: cursor,
              label: formatWeekLabel(range.startDate, range.endDate)
            })
          }
          cursor = getNextWeek(cursor)
        }
        setWeekOptions(options)
        // 默认整段范围：与看板「全部」一致（不传范围即全量）
        setRangeStart((prev) => prev || earliestWeek)
        setRangeEnd((prev) => prev || latestWeek)
      }
    } catch (err) {
      setLoadError(getErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    loadBaseData()
  }, [loadBaseData])

  // 昵称搜索防抖 500ms（输入即搜索，清空立即生效）
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(keywordInput.trim()), 500)
    return () => window.clearTimeout(timer)
  }, [keywordInput])

  // 汇总数据：周范围 / 类型筛选 / 口径变化即重新拉取
  useEffect(() => {
    let active = true
    setLoading(true)
    getCreatorSummary({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      caliber,
      creatorTypes: filterTypes,
      keyword,
      minCampaigns: minCampaigns || undefined,
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder
    })
      .then((res) => {
        if (!active) return
        setSummary(res.data)
        setLoadError('')
      })
      .catch((err) => {
        if (!active) return
        setSummary(null)
        setLoadError(getErrorMessage(err))
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [rangeStart, rangeEnd, caliber, filterTypes, keyword, minCampaigns, sort])

  const totalSummary = summary?.total_summary
  const groups = summary?.groups || []
  // 扁平达人列表（接口返回全集，用于对比与明细导出）
  const allCreators = summary?.creators || []
  // 对比勾选校验（2~5 位）
  const compareCheck = canCompareCreators(compareKeys.length)
  const compareRows = useMemo(
    () => buildCompareRows(allCreators, compareKeys),
    [allCreators, compareKeys]
  )
  const rangeText = useMemo(() => {
    if (!rangeStart || !rangeEnd) return '全部数据'
    const start = weekOptions.find((item) => item.weekCode === rangeStart)?.label || rangeStart
    const end = weekOptions.find((item) => item.weekCode === rangeEnd)?.label || rangeEnd
    return start === end ? start : `${start} ~ ${end}`
  }, [rangeStart, rangeEnd, weekOptions])

  // 快捷范围：近 N 周 / 全部
  const applyQuickRange = (type) => {
    const latest = weekOptions[weekOptions.length - 1]?.weekCode
    const earliest = weekOptions[0]?.weekCode
    if (!latest || !earliest) return
    if (type === 'all') {
      setRangeStart(earliest)
      setRangeEnd(latest)
      return
    }
    const span = type === '4' ? 4 : 8
    let start = latest
    for (let i = 1; i < span; i += 1) {
      const prev = getPrevWeek(start)
      if (!prev || prev < earliest) break
      start = prev
    }
    setRangeStart(start)
    setRangeEnd(latest)
  }

  // 导出达人汇总（与页面同一筛选条件，后端直接返回 xlsx）
  const handleExportSummary = () => {
    const url = buildRecordsExportUrl({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      caliber,
      creatorTypes: filterTypes,
      type: 'creator-summary',
      keyword,
      minCampaigns,
      sortBy: sort.sortBy,
      sortOrder: sort.sortOrder
    })
    const link = document.createElement('a')
    link.href = url
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // 下钻：该达人在当前周范围内的全部投放记录
  const openCreatorDrawer = (creator) => {
    setDrawerCreator(creator)
    setDetailLoading(true)
    const rows = allRecords.filter((row) => {
      if (String(row.nickname || '').trim() !== creator.nickname) return false
      if (rangeStart && row.time_cycle < rangeStart) return false
      if (rangeEnd && row.time_cycle > rangeEnd) return false
      return true
    })
    setDetailRecords(rows)
    setDetailLoading(false)
  }

  // 排序状态 -> antd 列头箭头（服务端排序，全局统一）
  const sortOrderOf = (field) => (sort.sortBy === field ? sort.sortOrder : null)
  // 点击列头：同一列切换升/降序，切列时重置为降序（默认仍为总花费降序）
  const handleTableSort = (pagination, filters, sorter) => {
    const field = sorter?.field || sorter?.columnKey
    if (!field) return
    const order = sorter.order === 'ascend' ? 'asc' : sorter.order === 'descend' ? 'desc' : 'desc'
    setSort({ sortBy: field, sortOrder: order })
  }

  // 达人表列：数值列支持点击排序（服务端排序），默认总花费降序
  const creatorColumns = [
    {
      title: '达人昵称',
      dataIndex: 'nickname',
      width: 160,
      render: (value, record) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => openCreatorDrawer(record)}>
          {value}
        </Button>
      )
    },
    {
      title: '投放次数',
      dataIndex: 'total_campaigns',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('total_campaigns'),
      render: (value) => formatInteger(value)
    },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('total_cost'),
      render: (value) => formatMoney(value)
    },
    {
      title: '总播放',
      dataIndex: 'total_play',
      width: 120,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('total_play'),
      render: (value) => formatPlays(value)
    },
    {
      title: '平均CPM',
      dataIndex: 'avg_cpm',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('avg_cpm'),
      render: (value) => formatCpm(value)
    },
    {
      title: '爆款数',
      dataIndex: 'hit_count',
      width: 100,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('hit_count'),
      render: (value) =>
        Number(value) >= 1 ? <Tag color="volcano">{formatInteger(value)}</Tag> : formatInteger(value)
    },
    {
      title: '平均单条播放',
      dataIndex: 'avg_play',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('avg_play'),
      render: (value) => formatPlays(value)
    },
    {
      title: '复投次数',
      dataIndex: 'repeat_count',
      width: 110,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderOf('repeat_count'),
      render: (value) =>
        Number(value) > 0 ? (
          `${formatInteger(value)} 次`
        ) : (
          <Typography.Text type="secondary">首次</Typography.Text>
        )
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_, record) => (
        <Button size="small" type="link" onClick={() => openCreatorDrawer(record)}>
          查看明细
        </Button>
      )
    }
  ]

  // 抽屉明细列（与投放管理保持一致）
  const detailColumns = [
    {
      title: '时间周期',
      dataIndex: 'time_cycle',
      width: 120,
      render: (value) => {
        const range = weekCodeToDateRange(value)
        return range ? formatWeekLabel(range.startDate, range.endDate) : value || '-'
      }
    },
    { title: '达人昵称', dataIndex: 'nickname', width: 130, ellipsis: true },
    { title: '博主类型', dataIndex: 'creator_type', width: 110, ellipsis: true },
    {
      title: '总花费(元)',
      dataIndex: 'total_cost',
      width: 110,
      align: 'right',
      render: (value) => formatMoney(value)
    },
    {
      title: '首发播放',
      dataIndex: 'first_play',
      width: 100,
      align: 'right',
      render: (value) => formatPlays(value)
    },
    {
      title: '次周播放',
      dataIndex: 'second_week_play',
      width: 100,
      align: 'right',
      render: (value) => formatPlays(value)
    },
    {
      title: 'CPM数据',
      key: 'cpm',
      width: 100,
      align: 'right',
      render: (_, record) => formatCpm(calcCpm(record.total_cost, record.second_week_play))
    },
    { title: '发布日期', dataIndex: 'publish_date', width: 110, render: (value) => value || '-' }
  ]

  // ---------- 顶部指标卡片（仅布局/样式：数值格式、tooltip 文案、loading 逻辑保持不变） ----------
  const metricCards = [
    {
      key: 'creators',
      title: '总达人数',
      value: formatInteger(totalSummary?.creator_count ?? 0),
      suffix: '人'
    },
    {
      key: 'campaigns',
      title: '总投放次数',
      value: formatInteger(totalSummary?.total_campaigns ?? 0),
      suffix: '次'
    },
    {
      key: 'cost',
      title: '总花费',
      value: formatMoney(totalSummary?.total_cost ?? 0),
      suffix: '元',
      tooltip: '投放周口径：按投放记录归属周汇总总花费，不随口径切换'
    },
    {
      key: 'play',
      title: '总播放',
      value: formatPlays(totalSummary?.total_play ?? 0),
      tooltip: `${caliberLabel}：当周首发 + ${
        caliber === 'campaign' ? '当周投放的次周' : '上周投放的次周'
      }`
    },
    {
      key: 'cpm',
      title: '平均CPM',
      value: formatCpm(totalSummary?.avg_cpm),
      tooltip: '整体平均CPM = 总花费 ÷ 总播放 × 1000；无播放量显示 -'
    },
    {
      key: 'hits',
      title: '爆款总数',
      value: formatInteger(totalSummary?.total_hits ?? 0),
      suffix: '条',
      tooltip: '爆款口径：范围内首发播放量 ≥ 10 万的投放记录条数（不随口径切换）'
    },
    {
      key: 'hitRate',
      title: '爆款率',
      value:
        totalSummary?.hit_rate === null || totalSummary?.hit_rate === undefined
          ? '-'
          : `${totalSummary.hit_rate}%`,
      tooltip: '爆款率 = 爆款总数 ÷ 记录总数 × 100%；无记录显示 -'
    }
  ]
  // 卡片标题：13px 灰色小字在上 + 水平居中 + 收紧行高，超长省略，避免撑高卡片
  const metricTitleStyle = {
    fontSize: 13,
    lineHeight: '18px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  }
  // 数值：20px + nowrap。valueStyle 作用于 .ant-statistic-content（数值 + 单位同容器），
  // 因此「60,535.00 元」「343.2万」等数值与单位始终在同一行，不会换行
  const metricValueStyle = {
    fontSize: 20,
    lineHeight: '28px',
    whiteSpace: 'nowrap',
    textAlign: 'center'
  }
  // 卡片标题/数值：Statistic 根节点撑满栅格单元并整体居中（仅作用于这 7 张卡片，不影响其他 Statistic）
  const metricStatisticStyle = { width: '100%', textAlign: 'center' }
  // 卡片内容：内边距 12px 16px + 标题/数值水平居中 + 垂直居中 + 撑满卡片高度（同一行卡片高度一致）
  const metricCardBodyStyle = {
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: 'center',
    height: '100%',
    minHeight: 76
  }
  // 卡片外层（Grid 单元）：宽度由栅格决定，不做按 key 的固定宽度
  const metricCardWrapStyle = {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box'
  }

  return (
    <div>
      {/* 顶部操作区 */}
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
          <Space size={16} wrap>
            <Segmented
              value={caliber}
              onChange={setCaliber}
              options={[
                { label: '投放周口径', value: 'campaign' },
                { label: '发生周口径', value: 'occurrence' }
              ]}
            />
            <Space size={8} wrap>
              <Typography.Text type="secondary">快捷范围：</Typography.Text>
              <Button size="small" onClick={() => applyQuickRange('4')}>
                近4周
              </Button>
              <Button size="small" onClick={() => applyQuickRange('8')}>
                近8周
              </Button>
              <Button size="small" onClick={() => applyQuickRange('all')}>
                全部
              </Button>
            </Space>
            <Typography.Text strong>当前范围：{rangeText}</Typography.Text>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={loadBaseData}>
              刷新
            </Button>
            <Tooltip title={compareCheck.ok ? '打开达人对比' : compareCheck.reason}>
              <Button
                disabled={!compareCheck.ok}
                onClick={() => setCompareOpen(true)}
              >
                对比所选（{compareKeys.length}）
              </Button>
            </Tooltip>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const count = exportCreatorStatsToExcel(allCreators, {
                  fileName: buildCreatorSummaryFileName(),
                  sheetName: '达人明细'
                })
                if (count) message.success(`已导出 ${count} 位达人明细`)
                else message.info('当前筛选条件下暂无可导出的达人数据')
              }}
            >
              导出达人明细
            </Button>
            <Button type="primary" icon={<DownloadOutlined />} onClick={handleExportSummary}>
              导出汇总
            </Button>
          </Space>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
            marginTop: 12
          }}
        >
          <Typography.Text type="secondary">周范围：</Typography.Text>
          <Select
            value={rangeStart}
            onChange={setRangeStart}
            options={weekOptions.map((item) => ({ value: item.weekCode, label: `${item.label}（${item.weekCode.slice(5)}）` }))}
            placeholder="起始周"
            style={{ width: 200 }}
            showSearch
            optionFilterProp="label"
          />
          <Typography.Text type="secondary">~</Typography.Text>
          <Select
            value={rangeEnd}
            onChange={setRangeEnd}
            options={weekOptions.map((item) => ({ value: item.weekCode, label: `${item.label}（${item.weekCode.slice(5)}）` }))}
            placeholder="结束周"
            style={{ width: 200 }}
            showSearch
            optionFilterProp="label"
          />
          <Typography.Text type="secondary">博主类型：</Typography.Text>
          <Select
            mode="multiple"
            value={filterTypes}
            onChange={setFilterTypes}
            placeholder="全部博主类型"
            style={{ minWidth: 240 }}
            allowClear
            optionFilterProp="label"
            options={filterMeta.creatorTypes.map((item) => ({
              value: item.value,
              label: `${item.value}（${item.count}）`
            }))}
          />
          <Typography.Text type="secondary">达人昵称：</Typography.Text>
          <Input
            allowClear
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="输入即搜索（防抖 500ms）"
            maxLength={50}
            style={{ width: 220 }}
          />
          <Typography.Text type="secondary">最小投放次数：</Typography.Text>
          <Select
            value={minCampaigns}
            onChange={setMinCampaigns}
            options={MIN_CAMPAIGNS_OPTIONS}
            style={{ width: 150 }}
          />
          {compareKeys.length > 0 && (
            <Button size="small" onClick={() => setCompareKeys([])}>
              清空对比选择
            </Button>
          )}
        </div>
      </Card>

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          style={{ marginTop: 16 }}
          action={
            <Button size="small" onClick={loadBaseData}>
              重试
            </Button>
          }
        />
      )}

      {/* 全局汇总卡片：CSS Grid 自动响应，minmax(170px, 1fr) 自动决定一行几列（宽屏 7 列，变窄自动换行） */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 12,
          width: '100%',
          alignItems: 'stretch',
          marginTop: 16
        }}
      >
        {metricCards.map((item) => {
          const card = (
            <Card
              size="small"
              style={{
                width: '100%',
                height: '100%',
                boxSizing: 'border-box',
                borderRadius: 12,
                background: '#fff'
              }}
              styles={{ body: metricCardBodyStyle }}
            >
              {loading ? (
                <Skeleton active paragraph={{ rows: 1 }} style={{ width: '100%' }} />
              ) : (
                <Statistic
                  title={<span style={metricTitleStyle}>{item.title}</span>}
                  value={item.value}
                  suffix={item.suffix ? <span style={{ fontSize: 12 }}>{item.suffix}</span> : undefined}
                  style={metricStatisticStyle}
                  valueStyle={metricValueStyle}
                />
              )}
            </Card>
          )
          return (
            <div key={item.key} style={metricCardWrapStyle}>
              {item.tooltip ? (
                <Tooltip title={item.tooltip}>
                  <div style={{ width: '100%', height: '100%' }}>{card}</div>
                </Tooltip>
              ) : (
                card
              )}
            </div>
          )
        })}
      </div>

      {/* 按博主类型分组的达人汇总 */}
      {loading ? (
        <Card style={{ marginTop: 16 }}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      ) : groups.length === 0 ? (
        <Card style={{ marginTop: 16 }}>
          <Empty description="当前筛选条件下暂无达人数据" style={{ padding: 48 }} />
        </Card>
      ) : (
        <Collapse
          style={{ marginTop: 16 }}
          defaultActiveKey={groups.map((group) => group.creator_type)}
          items={groups.map((group) => ({
            key: group.creator_type,
            label: (
              <Space size={12} wrap>
                <Typography.Text strong>{group.creator_type}</Typography.Text>
                <Tag color="blue">{formatInteger(group.creator_count)} 位达人</Tag>
                <Tag>花费 {formatMoney(group.total_cost)} 元</Tag>
                <Tag>播放 {formatPlays(group.total_play)}</Tag>
                <Tag color="green">CPM {formatCpm(group.avg_cpm)}</Tag>
                <Tag>投放 {formatInteger(group.total_campaigns)} 次</Tag>
              </Space>
            ),
            children: (
              <Table
                size="small"
                rowKey="nickname"
                columns={creatorColumns}
                dataSource={group.creators}
                pagination={false}
                onChange={handleTableSort}
                rowSelection={{
                  selectedRowKeys: compareKeys,
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => setCompareKeys(keys),
                  columnWidth: 46
                }}
                scroll={{ x: 1080 }}
              />
            )
          }))}
        />
      )}

      {/* 达人下钻明细抽屉 */}
      <Drawer
        title={
          drawerCreator
            ? `${drawerCreator.nickname}（${drawerCreator.creator_type || '未分类'}）· 明细`
            : '达人明细'
        }
        width={860}
        open={Boolean(drawerCreator)}
        onClose={() => setDrawerCreator(null)}
      >
        <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">
            范围：{rangeText} · {caliberLabel} · 共 {detailRecords.length} 条投放记录
          </Typography.Text>
          <Table
            size="small"
            rowKey="id"
            loading={detailLoading}
            columns={detailColumns}
            dataSource={detailRecords}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 800 }}
          />
        </Space>
      </Drawer>

      {/* 达人对比弹窗：横向对比所选达人（2~5 位），按总花费降序 */}
      <Modal
        title={`达人对比（${compareRows.length} 位 · 按总花费降序）`}
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        width={1000}
        footer={
          <Space>
            <Button onClick={() => setCompareOpen(false)}>关闭</Button>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={() => {
                const count = exportCreatorStatsToExcel(compareRows, {
                  fileName: buildCreatorCompareFileName(),
                  sheetName: '达人对比'
                })
                if (count) message.success(`已导出 ${count} 位达人对比数据`)
              }}
            >
              导出Excel
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="small" style={{ display: 'flex' }}>
          <Typography.Text type="secondary">
            范围：{rangeText} · {caliberLabel} · 最多支持对比 {COMPARE_MAX} 位达人（至少 {COMPARE_MIN} 位）
          </Typography.Text>
          {compareRows.length === 0 ? (
            <Empty description="请先在达人列表勾选 2~5 位达人" style={{ padding: 32 }} />
          ) : (
            <Table
              size="small"
              rowKey="nickname"
              dataSource={compareRows}
              pagination={false}
              scroll={{ x: 900 }}
              columns={[
                { title: '达人昵称', dataIndex: 'nickname', width: 140, fixed: 'left' },
                { title: '博主类型', dataIndex: 'creator_type', width: 110 },
                {
                  title: '投放次数',
                  dataIndex: 'total_campaigns',
                  width: 100,
                  align: 'right',
                  render: (value) => formatInteger(value)
                },
                {
                  title: '总花费(元)',
                  dataIndex: 'total_cost',
                  width: 120,
                  align: 'right',
                  render: (value) => formatMoney(value)
                },
                {
                  title: '总播放',
                  dataIndex: 'total_play',
                  width: 110,
                  align: 'right',
                  render: (value) => formatPlays(value)
                },
                {
                  title: '平均CPM',
                  dataIndex: 'avg_cpm',
                  width: 100,
                  align: 'right',
                  render: (value) => formatCpm(value)
                },
                {
                  title: '爆款数',
                  dataIndex: 'hit_count',
                  width: 90,
                  align: 'right',
                  render: (value) =>
                    Number(value) >= 1 ? <Tag color="volcano">{formatInteger(value)}</Tag> : formatInteger(value)
                },
                {
                  title: '平均单条播放',
                  dataIndex: 'avg_play',
                  width: 130,
                  align: 'right',
                  render: (value) => formatPlays(value)
                },
                {
                  title: '复投次数',
                  dataIndex: 'repeat_count',
                  width: 100,
                  align: 'right',
                  render: (value) =>
                    Number(value) > 0 ? `${formatInteger(value)} 次` : <Typography.Text type="secondary">首次</Typography.Text>
                }
              ]}
            />
          )}
        </Space>
      </Modal>
    </div>
  )
}
