import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Alert,
  Row,
  Skeleton,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DownloadOutlined,
  FilterOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import {
  buildRecordsExportUrl,
  fetchAllRecords,
  getRecordFilters,
  getWeekRangeStats,
  getWeekStatsFiltered
} from '../../api/records'
import {
  dateToWeekCode,
  formatWeekLabel,
  getNextWeek,
  getPrevWeek,
  weekCodeToDateRange
} from '../../utils/dateCycle.js'
import { formatCpm, formatInteger, formatMoney, formatPlays } from '../../utils/format'
import { calcCpm } from '../../utils/calc.js'
import { getErrorMessage } from '../../utils/request'

// 按需引入 echarts 核心模块
echarts.use([
  PieChart,
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer
])

// 明细列表分页大小（默认每页 20 条）
const DETAIL_PAGE_SIZE = 20

// 主色 #1677ff 延伸的渐变色系
const PALETTE = ['#1677ff', '#3d8bfd', '#5ea1ff', '#7fb6ff', '#a0cbff', '#c1dfff', '#e2f1ff']
const OTHER_COLOR = '#bfbfbf'
const HOT_PLAY_THRESHOLD = 100000 // 爆款：首发播放量 >= 10 万

/**
 * 数据看板：基于现有投放记录接口，前端计算指标与图表
 * 顶部周选择器支持切换任意历史周（默认当前自然周，禁止未来周）
 */
export default function Dashboard() {
  const [loading, setLoading] = useState(true)
  // 周/口径切换时的指标加载状态（与 week-stats 请求生命周期联动，不额外发请求）
  const [statsLoading, setStatsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [records, setRecords] = useState([])
  // 周度聚合（后端按“发生周”统计播放量；花费/达人数按投放周统计）
  const [weekStats, setWeekStats] = useState(null)
  // 统计口径：campaign 投放周 / occurrence 发生周（默认发生周，向下兼容）
  const [caliber, setCaliber] = useState('occurrence')
  const [selectedWeek, setSelectedWeek] = useState(null)
  // ---------- BI 分析状态（周范围 / 维度筛选 / 明细分页） ----------
  // 周范围：与选中周同源，startWeek === endWeek 时视为单周模式（保持原有看板表现）
  const [rangeStart, setRangeStart] = useState(null)
  const [rangeEnd, setRangeEnd] = useState(null)
  const [rangeData, setRangeData] = useState(null)
  const [filterTypes, setFilterTypes] = useState([])
  const [filterNicknames, setFilterNicknames] = useState([])
  const [filterMeta, setFilterMeta] = useState({
    creatorTypes: [],
    nicknames: [],
    weekRange: { earliestWeek: null, latestWeek: null }
  })
  const [weekOptions, setWeekOptions] = useState([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [detailPage, setDetailPage] = useState(1)
  const selectedWeekCode = selectedWeek ? selectedWeek.weekCode : null
  // 范围模式：起止周都存在且不相同
  const rangeEnabled = Boolean(rangeStart && rangeEnd && rangeStart !== rangeEnd)
  const pieRef = useRef(null)
  const barRef = useRef(null)
  const trendRef = useRef(null)
  const pieChartRef = useRef(null)
  const barChartRef = useRef(null)
  const trendChartRef = useRef(null)

  // 周信息构建：日期 -> { weekCode, startDate, endDate, label }
  const buildWeekInfo = (date) => {
    const weekCode = dateToWeekCode(date)
    return buildWeekInfoFromWeekCode(weekCode)
  }

  // 周信息构建：周码 -> { weekCode, startDate, endDate, label }
  const buildWeekInfoFromWeekCode = (weekCode) => {
    const range = weekCodeToDateRange(weekCode)
    if (!range) return null
    return {
      weekCode,
      ...range,
      label: formatWeekLabel(range.startDate, range.endDate)
    }
  }

  // 当前系统日期所在自然周（仅无数据时兜底，不参与按钮边界判断）
  const currentWeek = useMemo(() => buildWeekInfo(new Date()), [])

  // 拉取全量投放记录（可重试；默认选中最新有数据周，确保打开即有数据而非全 0）
  const loadRecords = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const rows = await fetchAllRecords()
      setRecords(rows)
      // —— 关键调试日志：确认真实接口数据、字段名、周代码格式 ——
      console.log('接口返回全部记录:', rows)
      console.log('每条记录的time_cycle:', rows.map((r) => r.time_cycle))
      if (rows.length) {
        // 取所有记录中 time_cycle 最新的一周（YYYY-Wxx 字符串比较即时间序）
        const latestWeekCode = rows.reduce(
          (max, row) => (row.time_cycle > max ? row.time_cycle : max),
          ''
        )
        console.log('计算出的最新周latestWeekCode:', latestWeekCode)
        const nextSelectedWeek = buildWeekInfoFromWeekCode(latestWeekCode) || currentWeek
        setSelectedWeek(nextSelectedWeek)
        // 周范围默认与选中周一致（单周模式，保持原有看板表现）
        setRangeStart(nextSelectedWeek.weekCode)
        setRangeEnd(nextSelectedWeek.weekCode)
        console.log('当前选中周selectedWeekCode:', nextSelectedWeek.weekCode)
        // 精确匹配筛选（字段名 time_cycle，格式 YYYY-Wxx 完全一致）
        const filteredRecords = rows.filter(
          (row) => row.time_cycle === nextSelectedWeek.weekCode
        )
        console.log('筛选后匹配的记录:', filteredRecords)
        console.log('筛选后记录数:', filteredRecords.length)
      } else {
        // 无任何数据：兜底选中系统当前自然周，展示空状态
        setSelectedWeek(currentWeek)
        setRangeStart(currentWeek?.weekCode || null)
        setRangeEnd(currentWeek?.weekCode || null)
      }
    } catch (err) {
      setRecords([])
      setSelectedWeek(currentWeek)
      setLoadError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [currentWeek])

  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  // 周边界：投放周口径=数据中实际存在的投放周；发生周口径=最新周扩展到「有次周播放量的下一周」
  const weekBounds = useMemo(() => {
    let campaignEarliest = null
    let campaignLatest = null
    let occurrenceLatest = null
    for (const row of records) {
      const code = row.time_cycle
      if (typeof code !== 'string' || !code) continue
      if (!campaignEarliest || code < campaignEarliest) campaignEarliest = code
      if (!campaignLatest || code > campaignLatest) campaignLatest = code
      if (!occurrenceLatest || code > occurrenceLatest) occurrenceLatest = code
      if ((Number(row.second_week_play) || 0) > 0) {
        const nextCode = getNextWeek(code)
        if (nextCode && (!occurrenceLatest || nextCode > occurrenceLatest)) {
          occurrenceLatest = nextCode
        }
      }
    }
    return { campaignEarliest, campaignLatest, occurrenceLatest }
  }, [records])
  const earliestWeekCode = weekBounds.campaignEarliest
  const latestWeekCode =
    caliber === 'campaign'
      ? weekBounds.campaignLatest
      : weekBounds.occurrenceLatest || weekBounds.campaignLatest

  // 筛选元数据：博主类型 / 达人昵称 / 数据周范围（一次拉取，供筛选面板与周下拉初始化）
  useEffect(() => {
    let active = true
    getRecordFilters()
      .then((res) => {
        if (!active || !res?.data) return
        setFilterMeta(res.data)
        const { earliestWeek, latestWeek } = res.data.weekRange || {}
        if (!earliestWeek || !latestWeek) return
        // 展开最早周到最晚周（含空周），供起止周下拉选择
        const options = []
        let cursor = earliestWeek
        while (cursor && cursor <= latestWeek && options.length < 300) {
          const info = buildWeekInfoFromWeekCode(cursor)
          if (info) options.push(info)
          cursor = getNextWeek(cursor)
        }
        setWeekOptions(options)
      })
      .catch(() => {
        // 元数据拉取失败不影响主流程（筛选面板为空）
      })
    return () => {
      active = false
    }
  }, [])

  // 拉取当前选中周（或周范围）+ 当前口径 + 当前筛选条件的聚合数据
  useEffect(() => {
    // 范围模式：使用 startWeek/endWeek；单周模式：沿用原有 weekCode 请求
    const isRange = Boolean(rangeStart && rangeEnd && rangeStart !== rangeEnd)
    if (!isRange && !selectedWeekCode) {
      setWeekStats(null)
      setRangeData(null)
      return undefined
    }
    let active = true
    // 周切换 / 口径切换：指标卡片进入骨架屏，请求结束（含失败）后平滑显示数值
    setStatsLoading(true)
    const filters = { creatorTypes: filterTypes, nicknames: filterNicknames }
    const request = isRange
      ? getWeekRangeStats({ startWeek: rangeStart, endWeek: rangeEnd, caliber, ...filters })
      : getWeekStatsFiltered(selectedWeekCode, caliber, filters)
    request
      .then((res) => {
        if (!active) return
        if (isRange) {
          setRangeData(res.data)
          setWeekStats(null)
        } else {
          setWeekStats(res.data)
          setRangeData(null)
        }
      })
      .catch(() => {
        if (!active) return
        setWeekStats(null)
        setRangeData(null)
      })
      .finally(() => active && setStatsLoading(false))
    return () => {
      active = false
    }
  }, [selectedWeekCode, caliber, rangeStart, rangeEnd, filterTypes, filterNicknames])

  // 周切换：更新选中周、打印切换日志（加载态由上面的请求 effect 驱动）
  const switchToWeek = (weekCode) => {
    const info = buildWeekInfoFromWeekCode(weekCode)
    if (!info) return
    setSelectedWeek(info)
    // 单周切换：范围同步为该周（避免范围模式残留）
    setRangeStart(weekCode)
    setRangeEnd(weekCode)
    // —— 切换日志：验证周码与筛选命中 ——
    console.log('切换到周：', weekCode)
    const filteredRecords = records.filter((row) => row.time_cycle === weekCode)
    console.log('匹配到的记录：', filteredRecords)
    console.log('匹配条数：', filteredRecords.length)
  }

  // 日历选周：任意日期自动对齐到完整自然周
  const handlePickerChange = (date) => {
    if (!date) return
    const info = buildWeekInfo(date)
    if (info) switchToWeek(info.weekCode)
  }

  // 目标周数据：精确匹配 record.time_cycle === selectedWeekCode（依赖 selectedWeekCode，切换即重算）
  const weekRecords = useMemo(
    () =>
      selectedWeekCode
        ? records.filter((row) => row.time_cycle === selectedWeekCode)
        : [],
    [records, selectedWeekCode]
  )

  // 顶部核心指标
  const metrics = useMemo(() => {
    // 范围模式：使用范围汇总 total_summary；单周模式：沿用单周聚合（口径逻辑完全一致）
    if (rangeEnabled) {
      const summary = rangeData?.total_summary
      const totalPlays = summary?.total_play ?? 0
      const totalCost = summary?.total_cost ?? 0
      return {
        totalPlays,
        firstPlayTotal: summary?.first_play_total ?? 0,
        secondPlayTotal: summary?.second_play_total ?? 0,
        totalCost,
        // 平均CPM 直接使用后端范围汇总（无播放量时为 null -> 显示 -）
        avgCpm: summary?.avg_cpm ?? (totalPlays > 0 ? (totalCost / totalPlays) * 1000 : null),
        creatorCount: summary?.creator_count ?? 0,
        recordCount: summary?.record_count ?? 0
      }
    }
    // 播放量：当周实际发生（首发 + 来自上周投放的次周播放量）
    const totalPlays = weekStats?.total_play ?? 0
    // 首发/次周播放拆分（接口字段：first_play_total / second_play_total）
    const firstPlayTotal = weekStats?.first_play_total ?? 0
    const secondPlayTotal = weekStats?.second_play_total ?? weekStats?.second_week_play_total ?? 0
    // 花费/达人数量：仍按投放周口径
    const totalCost = weekStats?.total_cost ?? 0
    const creatorCount = weekStats?.creator_count ?? 0
	// 平均CPM = 投放周总花费 / 当周总播放 × 1000；无播放量时为 null（显示 -）
    const avgCpm = totalPlays > 0 ? (totalCost / totalPlays) * 1000 : null
    return {
      totalPlays,
      firstPlayTotal,
      secondPlayTotal,
      totalCost,
      avgCpm,
      creatorCount,
      recordCount: weekStats?.record_count ?? 0
    }
  }, [weekStats, rangeEnabled, rangeData])

  const caliberLabel = caliber === 'campaign' ? '投放周口径' : '发生周口径'
  // 口径说明（hover 提示文案，随口径开关变化）
  const playCaliberTip =
    caliber === 'campaign'
      ? '投放周口径：统计当周投放记录的首发播放量 + 次周播放量（次周也计入投放当周）'
      : '发生周口径：按播放实际发生的周统计（当周投放的首发 + 上周投放的次周播放量）'

  // ---------- BI：周范围、快捷选择、筛选、导出 ----------
  const weekOptionValues = weekOptions.map((item) => item.weekCode)
  const selectedRangeText = rangeStart
    ? rangeStart === rangeEnd
      ? buildWeekInfoFromWeekCode(rangeStart)?.label || rangeStart
      : `${buildWeekInfoFromWeekCode(rangeStart)?.label || rangeStart} ~ ${
          buildWeekInfoFromWeekCode(rangeEnd)?.label || rangeEnd
        }（${rangeData?.total_summary?.weekCount ?? 0} 周）`
    : '--'
  const activeFilterCount = filterTypes.length + filterNicknames.length

  // 周范围选择：任一改动都同步「选中周」，单周模式与范围模式共用同一套聚合接口
  const handleRangeStartChange = (value) => {
    setRangeStart(value)
    // 起始周晚于结束周时自动纠正结束周
    if (value && rangeEnd && value > rangeEnd) setRangeEnd(value)
    const info = buildWeekInfoFromWeekCode(value)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  const handleRangeEndChange = (value) => {
    setRangeEnd(value)
    if (value && rangeStart && value < rangeStart) setRangeStart(value)
    const info = buildWeekInfoFromWeekCode(value)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  // 快捷范围：近 N 周 / 全部（以数据中最晚周为终点）
  const applyQuickRange = (type) => {
    const latest = weekOptionValues[weekOptionValues.length - 1] || selectedWeekCode
    const earliest = weekOptionValues[0] || selectedWeekCode
    if (!latest || !earliest) return
    if (type === 'all') {
      setRangeStart(earliest)
      setRangeEnd(latest)
    } else {
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
    const info = buildWeekInfoFromWeekCode(latest)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  // 上一周 / 下一周：单周模式移动一周；范围模式整体平移窗口
  const shiftWindow = (direction) => {
    const step = direction === 'prev' ? getPrevWeek : getNextWeek
    const nextStart = step(rangeStart || selectedWeekCode)
    const nextEnd = step(rangeEnd || selectedWeekCode)
    if (!nextStart || !nextEnd) return
    if (earliestWeekCode && nextStart < earliestWeekCode) return
    if (latestWeekCode && nextEnd > latestWeekCode) return
    setRangeStart(nextStart)
    setRangeEnd(nextEnd)
    const info = buildWeekInfoFromWeekCode(nextEnd)
    if (info) setSelectedWeek(info)
    setDetailPage(1)
  }

  const handleExportDetail = () => {
    const url = buildRecordsExportUrl({
      startWeek: rangeStart,
      endWeek: rangeEnd,
      creatorTypes: filterTypes,
      nicknames: filterNicknames
    })
    // 触发浏览器下载（后端直接返回 xlsx，Content-Disposition 指定文件名）
    const link = document.createElement('a')
    link.href = url
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // 明细列表：按当前周范围 + 维度筛选过滤（与聚合接口同一套筛选口径）
  const detailRecords = useMemo(() => {
    return records.filter((row) => {
      const code = row.time_cycle
      if (rangeStart && code < rangeStart) return false
      if (rangeEnd && code > rangeEnd) return false
      if (filterTypes.length && !filterTypes.includes(String(row.creator_type || '').trim())) {
        return false
      }
      if (
        filterNicknames.length &&
        !filterNicknames.includes(String(row.nickname || '').trim())
      ) {
        return false
      }
      return true
    })
  }, [records, rangeStart, rangeEnd, filterTypes, filterNicknames])

  useEffect(() => {
    setDetailPage(1)
  }, [detailRecords.length])

  // 范围模式：把各周 creators 合并成一条达人播放量列表（与范围汇总同口径）
  const pieSource = useMemo(() => {
    if (!rangeEnabled) return weekStats?.creators || []
    const merged = new Map()
    for (const week of rangeData?.weeks || []) {
      for (const item of week.creators || []) {
        const name = String(item.nickname || '').trim()
        if (!name) continue
        merged.set(name, (merged.get(name) || 0) + (Number(item.play) || 0))
      }
    }
    return [...merged.entries()].map(([nickname, play]) => ({ nickname, play }))
  }, [rangeEnabled, rangeData, weekStats])

  // 饼图：达人播放量占比（Top7 + 其他）
  const pieData = useMemo(() => {
    const sorted = (pieSource || [])
      .map((item) => ({
        name: String(item.nickname || '').trim() || '未知达人',
        value: Number(item.play) || 0
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
    if (sorted.length <= 7) return sorted
    const top = sorted.slice(0, 7)
    const rest = sorted.slice(7).reduce((sum, item) => sum + item.value, 0)
    return [...top, { name: '其他', value: rest, itemStyle: { color: OTHER_COLOR } }]
  }, [pieSource])

  // 榜单/柱图作用域：范围模式用范围内记录，单周模式用当周记录
  const scopeRecords = rangeEnabled ? detailRecords : weekRecords

  // 柱状图：爆款类型分布（首发播放量 >= 10 万，按条数降序）
  const barData = useMemo(() => {
    const map = new Map()
    for (const row of scopeRecords) {
      if ((Number(row.first_play) || 0) < HOT_PLAY_THRESHOLD) continue
      const type = String(row.creator_type || '').trim() || '未分类'
      map.set(type, (map.get(type) || 0) + 1)
    }
    return [...map.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
  }, [scopeRecords])

  // 图表配置（数据变化时重新生成）
  const pieOption = useMemo(
    () => ({
      color: PALETTE,
      // 图表数值格式与全局统一：播放量万级转换
      tooltip: {
        trigger: 'item',
        formatter: (params) => `${params.name}<br/>${formatPlays(params.value)}（${params.percent}%）`
      },
      legend: { orient: 'vertical', right: 0, top: 'center' },
      series: [
        {
          name: '首发播放量',
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['38%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, fontWeight: 'bold' } },
          data: pieData
        }
      ]
    }),
    [pieData]
  )

  const barOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value) => `${formatInteger(value)} 条`
      },
      grid: { left: 12, right: 24, top: 32, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: barData.map((item) => item.name),
        axisTick: { alignWithLabel: true }
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: '爆款条数',
          type: 'bar',
          data: barData.map((item) => item.value),
          itemStyle: { color: '#1677ff', borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 36
        }
      ]
    }),
    [barData]
  )

  // 周度趋势：三条折线（总花费左轴 / 总播放量(万) 与 平均CPM 右轴），空周补零无断点
  const trendWeeks = rangeData?.weeks || []
  const trendOption = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const week = trendWeeks[params[0]?.dataIndex ?? 0]
          if (!week) return ''
          const cpm = week.total_play > 0 ? (week.total_cost / week.total_play) * 1000 : null
          return [
            `${week.weekCode}`,
            `总花费：${formatMoney(week.total_cost)} 元`,
            `总播放量：${formatPlays(week.total_play)}`,
            `平均CPM：${formatCpm(cpm)}`,
            `首发：${formatPlays(week.first_play_total)}　次周：${formatPlays(week.second_play_total)}`,
            `投放达人：${formatInteger(week.creator_count)} 人`
          ].join('<br/>')
        }
      },
      legend: { data: ['总花费(元)', '总播放量(万)', '平均CPM(元)'], top: 0 },
      grid: { left: 12, right: 24, top: 44, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: trendWeeks.map((week) => week.weekCode.slice(5))
      },
      yAxis: [
        { type: 'value', name: '花费(元)', position: 'left' },
        { type: 'value', name: '播放(万)/CPM(元)', position: 'right' }
      ],
      series: [
        {
          name: '总花费(元)',
          type: 'line',
          smooth: true,
          yAxisIndex: 0,
          itemStyle: { color: '#faad14' },
          data: trendWeeks.map((week) => Number(week.total_cost) || 0)
        },
        {
          name: '总播放量(万)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#1677ff' },
          data: trendWeeks.map((week) => Number(((Number(week.total_play) || 0) / 10000).toFixed(2)))
        },
        {
          name: '平均CPM(元)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#52c41a' },
          data: trendWeeks.map((week) =>
            week.total_play > 0 ? Number(((week.total_cost / week.total_play) * 1000).toFixed(2)) : 0
          )
        }
      ]
    }),
    [trendWeeks]
  )

  // 明细列表列（与投放管理页保持一致）
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

  // 渲染/更新图表：实例复用 + setOption 平滑过渡，数据为空时销毁实例
  useEffect(() => {
    if (loading) return
    const renderChart = (ref, chartRef, data, option) => {
      if (data.length === 0) {
        if (chartRef.current) {
          chartRef.current.dispose()
          chartRef.current = null
        }
        return
      }
      const el = ref.current
      if (!el) return
      let instance = chartRef.current
      // 骨架屏加载会把图表容器卸载后重建：旧实例绑定在已移除的节点上，需要重建
      if (instance && typeof instance.getDom === 'function' && instance.getDom() !== el) {
        instance.dispose()
        instance = null
      }
      if (!instance) instance = echarts.init(el)
      chartRef.current = instance
      instance.setOption(option)
    }
    renderChart(pieRef, pieChartRef, pieData, pieOption)
    renderChart(barRef, barChartRef, barData, barOption)
    renderChart(trendRef, trendChartRef, trendWeeks, trendOption)
    // statsLoading 决定骨架屏与图表容器之间的切换：必须作为依赖，
    // 否则「加载中先卸载容器、加载完成后容器重建」时不会重新 init 图表
  }, [
    loading,
    statsLoading,
    scopeRecords.length,
    pieData,
    pieOption,
    barData,
    barOption,
    trendWeeks,
    trendOption
  ])

  // 窗口缩放与组件卸载清理
  useEffect(() => {
    const handleResize = () => {
      pieChartRef.current?.resize()
      barChartRef.current?.resize()
      trendChartRef.current?.resize()
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      pieChartRef.current?.dispose()
      barChartRef.current?.dispose()
      trendChartRef.current?.dispose()
      pieChartRef.current = null
      barChartRef.current = null
      trendChartRef.current = null
    }
  }, [])

  // ---------- 顶部核心指标卡片：仅布局/样式（数据计算、API、图表、日期与口径逻辑均不变） ----------
  // 四张主卡严格等高：Row 默认 stretch，每列只放一个 Card，height:100% 不会再挤出任何子卡片
  const metricCardStyle = { height: '100%', minHeight: 180 }
  // 卡内排版统一：标题 + 主数字在上，播放量卡的 secondary 贴底，四张卡一致
  const metricCardBodyStyle = {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 12
  }
  // 主数字 30px；「投放达人数量」单独放大到 32px
  const metricValueStyle = { fontSize: 30, lineHeight: '36px', fontWeight: 600 }
  const metricValueLargeStyle = { fontSize: 32, lineHeight: '38px', fontWeight: 600 }
  // 播放量卡内的 secondary 指标：浅灰分隔线 + 左右两栏（不再是独立 Card）
  const playSplitStyle = {
    borderTop: '1px solid #f0f0f0',
    paddingTop: 12,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    columnGap: 12
  }
  const playSplitLabelStyle = { fontSize: 12 }
  const playSplitValueStyle = { fontSize: 18, lineHeight: '24px', fontWeight: 500 }

  return (
    <div>
      {/* 周选择栏（与指标卡同宽，右对齐布局） */}
      <Row gutter={[16, 16]}>
        <Col span={24}>
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
                {/* 统计口径切换：默认发生周口径；切换不改变当前选中的周 */}
                <Segmented
                  value={caliber}
                  onChange={(value) => setCaliber(value)}
                  options={[
                    { label: '投放周口径', value: 'campaign' },
                    { label: '发生周口径', value: 'occurrence' }
                  ]}
                />
                {/* 快捷范围：近 4 周 / 近 8 周 / 全部 */}
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
                <Typography.Text strong>
                  当前统计：{selectedRangeText}
                </Typography.Text>
              </Space>
              <Space wrap>
                <Button
                  icon={<FilterOutlined />}
                  onClick={() => setFiltersOpen((prev) => !prev)}
                  type={filtersOpen || activeFilterCount > 0 ? 'primary' : 'default'}
                  ghost={filtersOpen || activeFilterCount > 0}
                >
                  筛选{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
                </Button>
                <Button icon={<DownloadOutlined />} onClick={handleExportDetail}>
                  导出明细
                </Button>
              </Space>
            </div>

            {/* 周范围选择：起止周下拉（所有可用周），单周模式 = 起止周相同 */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12,
                marginTop: 12
              }}
            >
              <Space wrap>
                <Typography.Text type="secondary">周范围：</Typography.Text>
                <Select
                  value={rangeStart}
                  onChange={handleRangeStartChange}
                  options={weekOptions.map((item) => ({
                    value: item.weekCode,
                    label: `${item.label}（${item.weekCode.slice(5)}）`
                  }))}
                  placeholder="起始周"
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                />
                <Typography.Text type="secondary">~</Typography.Text>
                <Select
                  value={rangeEnd}
                  onChange={handleRangeEndChange}
                  options={weekOptions.map((item) => ({
                    value: item.weekCode,
                    label: `${item.label}（${item.weekCode.slice(5)}）`
                  }))}
                  placeholder="结束周"
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                />
              </Space>
              <Space wrap>
                <Button
                  icon={<ArrowLeftOutlined />}
                  onClick={() => shiftWindow('prev')}
                  // 上一周：仅当窗口起始已到最早有数据的周时禁用
                  disabled={!rangeStart || (earliestWeekCode && rangeStart <= earliestWeekCode)}
                >
                  上一周
                </Button>
                <DatePicker
                  value={selectedWeek ? dayjs(selectedWeek.startDate) : null}
                  onChange={handlePickerChange}
                  format="MM/DD"
                  allowClear={false}
                  placeholder="跳转到周"
                  style={{ width: 150 }}
                />
                <Button
                  icon={<ArrowRightOutlined />}
                  onClick={() => shiftWindow('next')}
                  // 下一周：窗口结束到达数据中最新的周时禁用
                  disabled={!rangeEnd || (latestWeekCode && rangeEnd >= latestWeekCode)}
                >
                  下一周
                </Button>
              </Space>
            </div>

            {/* 筛选面板：博主类型 / 达人昵称（实时生效，可折叠） */}
            {filtersOpen && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid #f0f0f0',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 16
                }}
              >
                <div style={{ minWidth: 280, flex: '1 1 280px' }}>
                  <Typography.Text type="secondary">博主类型（可多选）</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Space size={8} wrap style={{ marginBottom: 6 }}>
                      <Button
                        size="small"
                        onClick={() =>
                          setFilterTypes(filterMeta.creatorTypes.map((item) => item.value))
                        }
                      >
                        全选
                      </Button>
                      <Button size="small" onClick={() => setFilterTypes([])}>
                        取消全选
                      </Button>
                    </Space>
                    <Select
                      mode="multiple"
                      value={filterTypes}
                      onChange={(values) => {
                        setFilterTypes(values)
                        setDetailPage(1)
                      }}
                      placeholder="全部博主类型"
                      style={{ width: '100%' }}
                      allowClear
                      optionFilterProp="label"
                      options={filterMeta.creatorTypes.map((item) => ({
                        value: item.value,
                        label: `${item.value}（${item.count}）`
                      }))}
                    />
                  </div>
                </div>
                <div style={{ minWidth: 280, flex: '1 1 280px' }}>
                  <Typography.Text type="secondary">达人昵称（支持搜索）</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Select
                      mode="multiple"
                      value={filterNicknames}
                      onChange={(values) => {
                        setFilterNicknames(values)
                        setDetailPage(1)
                      }}
                      placeholder="全部达人"
                      style={{ width: '100%' }}
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      maxTagCount="responsive"
                      options={filterMeta.nicknames.map((item) => ({
                        value: item.value,
                        label: `${item.value}（${item.count}）`
                      }))}
                    />
                  </div>
                </div>
                <div style={{ alignSelf: 'flex-end' }}>
                  <Button
                    size="small"
                    onClick={() => {
                      setFilterTypes([])
                      setFilterNicknames([])
                    }}
                  >
                    清空筛选
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Spin spinning={statsLoading}>
        {/* 数据加载失败提示 */}
        {loadError && (
          <Alert
            type="error"
            showIcon
            message={loadError}
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={loadRecords}>
                重试
              </Button>
            }
          />
        )}

        {/* 无任何数据：统一空状态，不展示全 0 数值 */}
        {!loading && !loadError && records.length === 0 && (
          <Card>
            <Empty description="暂无任何投放数据，请先新增投放记录" style={{ padding: 48 }} />
          </Card>
        )}

        {records.length > 0 && (
          <>
            {/* 顶部核心指标行：桌面端一行四张（lg 7+5+5+7=24），左右稍宽、中间稍窄，四张等高 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col xs={24} sm={12} lg={7}>
                {/* 播放量卡：主指标 + 卡内 secondary（当周首发 / 当周次周），不再另挂两张独立 Card */}
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 3 }} />
                  ) : (
                    <>
                      <Tooltip
                        title={
                          <span>
                            {playCaliberTip}
                            <br />
                            首发 {formatPlays(metrics.firstPlayTotal)} + 次周{' '}
                            {formatPlays(metrics.secondPlayTotal)} = 合计{' '}
                            {formatPlays(metrics.totalPlays)}
                          </span>
                        }
                      >
                        <Statistic
                          title={`本周总播放量（${caliberLabel}）`}
                          value={metrics.totalPlays}
                          formatter={(value) => formatPlays(value)}
                          valueStyle={metricValueStyle}
                        />
                      </Tooltip>
                      {/* 播放量拆分：当周首发 / 当周次周（接口字段 first_play_total / second_play_total） */}
                      <div style={playSplitStyle}>
                        <Tooltip title={`${playCaliberTip}（首发部分）`}>
                          <Statistic
                            title={<span style={playSplitLabelStyle}>当周首发播放量</span>}
                            value={metrics.firstPlayTotal > 0 ? formatPlays(metrics.firstPlayTotal) : '-'}
                            valueStyle={playSplitValueStyle}
                          />
                        </Tooltip>
                        <Tooltip
                          title={
                            caliber === 'campaign'
                              ? '投放周口径：当周投放记录的次周播放量（计入投放当周）'
                              : '发生周口径：来自上周投放、在本周产生的次周播放量'
                          }
                        >
                          <Statistic
                            title={<span style={playSplitLabelStyle}>当周次周播放量</span>}
                            value={metrics.secondPlayTotal > 0 ? formatPlays(metrics.secondPlayTotal) : '-'}
                            valueStyle={playSplitValueStyle}
                          />
                        </Tooltip>
                      </div>
                    </>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={5}>
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 1 }} />
                  ) : (
                    <Tooltip title="投放周口径：按投放记录归属周汇总总花费，不随播放量口径开关变化">
                      <Statistic
                        title="本周总花销"
                        value={metrics.totalCost}
                        formatter={(value) => formatMoney(value)}
                        suffix="元"
                        valueStyle={metricValueStyle}
                      />
                    </Tooltip>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={5}>
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 1 }} />
                  ) : (
                    <Tooltip
                      title={`平均CPM = 总花费（投放周口径）÷ 当周总播放量（${caliberLabel}）× 1000；无播放量时显示 -`}
                    >
                      <Statistic
                        title="本周平均CPM"
                        value={formatCpm(metrics.avgCpm)}
                        valueStyle={metricValueStyle}
                      />
                    </Tooltip>
                  )}
                </Card>
              </Col>
              <Col xs={24} sm={12} lg={7}>
                {/* 达人数量卡：宽度 lg=7 且主数字略大（32px），保持同一套视觉语言 */}
                <Card style={metricCardStyle} styles={{ body: metricCardBodyStyle }}>
                  {loading || statsLoading ? (
                    <Skeleton active paragraph={{ rows: 1 }} />
                  ) : (
                    <Tooltip title="投放周口径：按投放记录归属周对达人昵称去重，不随播放量口径开关变化">
                      <Statistic
                        title="投放达人数量"
                        value={formatInteger(metrics.creatorCount)}
                        suffix="人"
                        valueStyle={metricValueLargeStyle}
                      />
                    </Tooltip>
                  )}
                </Card>
              </Col>
            </Row>

            {/* 下方双列图表区 */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col xs={24} md={12}>
                <Card title={`达人播放量占比（${caliberLabel}）`}>
                  {loading ? (
                    <Skeleton active paragraph={{ rows: 8 }} />
                  ) : pieData.length === 0 ? (
                    <Empty
                      description={rangeEnabled ? '所选范围无播放量数据' : '该周无播放量数据'}
                      style={{ padding: 40 }}
                    />
                  ) : (
                    <div ref={pieRef} style={{ width: '100%', height: 360 }} />
                  )}
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card title="爆款类型分布（投放周口径）">
                  {loading ? (
                    <Skeleton active paragraph={{ rows: 8 }} />
                  ) : scopeRecords.length === 0 ? (
                    <Empty
                      description={rangeEnabled ? '所选范围暂无投放数据' : '该周暂无投放数据'}
                      style={{ padding: 40 }}
                    />
                  ) : barData.length === 0 ? (
                    <Empty description="暂无爆款记录（首发播放量≥10万）" style={{ padding: 40 }} />
                  ) : (
                    <div ref={barRef} style={{ width: '100%', height: 360 }} />
                  )}
                </Card>
              </Col>
            </Row>

            {/* 周度趋势：仅范围模式展示（单周模式保持原有看板布局不变） */}
            {rangeEnabled && (
              <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                <Col span={24}>
                  <Card
                    title={`周度趋势（${caliberLabel}${activeFilterCount ? ' · 已筛选' : ''}）`}
                    extra={
                      <Typography.Text type="secondary">
                        近 {trendWeeks.length} 周 · 空数据周自动补零
                      </Typography.Text>
                    }
                  >
                    {loading || statsLoading ? (
                      <Skeleton active paragraph={{ rows: 8 }} />
                    ) : trendWeeks.length === 0 ? (
                      <Empty description="所选范围内暂无数据" style={{ padding: 40 }} />
                    ) : (
                      <div ref={trendRef} style={{ width: '100%', height: 340 }} />
                    )}
                  </Card>
                </Col>
              </Row>
            )}

            {/* 投放明细列表：当前周范围 + 筛选条件下的全部记录（默认每页 20 条） */}
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col span={24}>
                <Card
                  title="投放明细"
                  extra={
                    <Space size={12} wrap>
                      <Typography.Text type="secondary">
                        共 {detailRecords.length} 条
                      </Typography.Text>
                      <Button size="small" icon={<DownloadOutlined />} onClick={handleExportDetail}>
                        导出明细
                      </Button>
                    </Space>
                  }
                >
                  <Table
                    size="small"
                    rowKey="id"
                    loading={loading}
                    columns={detailColumns}
                    dataSource={detailRecords}
                    pagination={{
                      pageSize: DETAIL_PAGE_SIZE,
                      current: detailPage,
                      onChange: setDetailPage,
                      showSizeChanger: false,
                      showTotal: (total) => `共 ${total} 条`
                    }}
                    scroll={{ x: 900 }}
                  />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </Spin>
    </div>
  )
}
