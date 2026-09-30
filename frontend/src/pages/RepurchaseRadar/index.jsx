import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Input,
  Popover,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { CaretDownOutlined, CaretRightOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { getRepurchaseRadar } from '../../api/records'
import { getErrorMessage } from '../../utils/request'
import { formatInteger } from '../../utils/format'
import RecentPerformanceAssistantModal from '../../components/RecentPerformanceAssistantModal'
import CreatorDecisionDrawer from '../../components/CreatorDecisionDrawer'
import {
  formatPlayRange,
  formatSnapshotStatusText,
  formatTrendRatio,
  TREND_LABELS_FULL
} from '../../utils/recentPerformanceSave.js'
import {
  buildRecentPerformanceCell,
  DEFAULT_COLLAPSED_GROUPS,
  formatCpmCoverageLine,
  formatLastActualCostLabel,
  formatLastActualCostValue,
  formatMedianCpmValue,
  isGroupCollapsed,
  toggleGroupCollapsed
} from '../../utils/radarRowDisplay.js'
import {
  buildContentBreakdownRows,
  buildContentPerformanceLines
} from '../../utils/contentType.js'
import { buildPricingRows, formatPrice } from '../../utils/pricingDisplay.js'
import {
  EMPTY_RADAR_FILTERS,
  RADAR_GROUP_OPTIONS,
  WORK_PRIORITY_FILTER_OPTIONS,
  filterRadarGroups,
  isRadarFilterActive
} from '../../utils/radarFilters.js'

// 历史状态 -> 展示文案（文字为主，颜色仅辅助，不依赖颜色理解）
const STATUS_META = {
  passed: { label: '历史通过', color: 'success' },
  mixed: { label: '表现分化', color: 'warning' },
  insufficient: { label: '证据不足', color: 'default' },
  failed: { label: '暂不优先', color: 'error' }
}

const GROUP_HINTS = {
  priority: '有效合作样本 ≥ 2 且多数单次累计 CPM ≤ 目标值',
  watch: '表现分化，或有效样本不足 2 次（证据不足不进入「历史通过」）；按工作优先级排序',
  low_priority: '有效合作样本 ≥ 2 且多数单次累计 CPM 未达标，或仅 1 次样本且明显低效'
}

// Alpha.2 B1：工作优先级标记颜色（文案与判定全部来自后端，前端只上色）
// 只影响「先看谁」的注意力分配，不改变历史证据结论
const WORK_PRIORITY_TAG_COLORS = {
  high_attention: 'gold',
  medium_attention: 'orange',
  low_priority: 'default'
}

const WORK_PRIORITY_TOOLTIP = '工作优先级只表示「今天先看谁」，不改变历史证据结论'

// P5：雷达 Popover 里「投放结果」只做轻量事实展示（状态码 -> 短文案），不使用长句
const OUTCOME_CPM_SHORT_LABELS = {
  pending: '待更新',
  anomaly: '异常',
  zero_play: '累计播放为0',
  met: '已达标',
  not_met: '未达标'
}

// Alpha.3 信息架构：近期表现独立成列（高视觉权重），有效样本 / 达标次数降级为历史 CPM 的辅助行，
// 达人类型降级为达人名称下的次级文字；列宽合计控制在 1024 宽度下不产生页面级 / 表内横向滚动。
const RADAR_TABLE_WIDTH = 934
const SECONDARY_TEXT_STYLE = { fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', lineHeight: '18px' }
const PLACEHOLDER = <Typography.Text type="secondary">-</Typography.Text>

/**
 * 列定义（目标 CPM 只用于提示文案，业务判定全部由后端给出）
 * @param {number} targetCpm 目标 CPM
 * @param {(creator: string) => void} onOpenAssistant 打开某位达人的「近期表现助手」
 */
function buildRadarColumns(targetCpm, onOpenAssistant, onOpenDecision) {
  return [
    {
      title: '达人',
      dataIndex: 'creator',
      width: 112,
      render: (value, record) => {
        const snapshot = record.recent_snapshot
        return (
          <div style={{ minWidth: 0 }}>
            <Popover
              trigger="click"
              placement="right"
              title={`${value} · 近期表现与价格核算`}
              content={
                <div style={{ width: 288 }}>
                  {snapshot ? (
                    <Space direction="vertical" size={2} style={{ display: 'flex' }}>
                      <Typography.Text strong>近期表现</Typography.Text>
                      <Typography.Text type="secondary">
                        数据截至：{snapshot.observed_at || '观察日期未知'}
                        {snapshot.created_at ? `　保存于：${snapshot.created_at}` : ''}
                      </Typography.Text>
                      <Typography.Text>有效样本：{formatInteger(snapshot.valid_count)}</Typography.Text>
                      {snapshot.stats_status === 'ok' ? (
                        <>
                          <Typography.Text>中位播放：{formatSnapshotStatusText(snapshot).split(' · ')[0]}</Typography.Text>
                          <Typography.Text>
                            典型区间（P25–P75）：{formatPlayRange(snapshot.p25_play, snapshot.p75_play)}
                          </Typography.Text>
                          <Typography.Text>
                            趋势：{TREND_LABELS_FULL[snapshot.trend_label] || '样本不足'}
                            {formatTrendRatio(snapshot.trend_ratio)
                              ? `（${formatTrendRatio(snapshot.trend_ratio)}）`
                              : ''}
                          </Typography.Text>
                        </>
                      ) : (
                        <Typography.Text type="warning">
                          样本不足：建议补充更多近期作品截图
                        </Typography.Text>
                      )}
                      <Typography.Text>
                        星图价：
                        {snapshot.xingtu_price === null || snapshot.xingtu_price === undefined
                          ? '暂无'
                          : `¥${formatInteger(snapshot.xingtu_price)}`}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        统计口径：{snapshot.stats_version}
                      </Typography.Text>
                      <Divider style={{ margin: '6px 0' }} />
                      {/* Alpha.3-04：内容构成（商单 / 日常 / 未识别），只做事实展示 */}
                      <Typography.Text strong>内容构成</Typography.Text>
                      {buildContentBreakdownRows(snapshot).map((row) => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <Typography.Text type="secondary">{row.label}</Typography.Text>
                          <Typography.Text>{row.value}</Typography.Text>
                        </div>
                      ))}
                      <Divider style={{ margin: '6px 0' }} />
                      <Typography.Text strong>价格核算</Typography.Text>
                      {buildPricingRows(snapshot.pricing).map((row) => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <Typography.Text type="secondary">{row.label}</Typography.Text>
                          <Typography.Text>{row.value}</Typography.Text>
                        </div>
                      ))}
                      <Divider style={{ margin: '6px 0' }} />
                      <Typography.Text strong>价格状态</Typography.Text>
                      <Typography.Text>{snapshot.pricing?.pricing_status_label || '-'}</Typography.Text>
                      <Divider style={{ margin: '6px 0' }} />
                      <Typography.Text strong>最近决策</Typography.Text>
                      {record.recent_decision ? (
                        <>
                          <Typography.Text type="secondary">
                            {String(record.recent_decision.created_at || '').slice(5, 10)} ·{' '}
                            {record.recent_decision.human_decision_label}
                            {record.recent_decision.current_quote === null
                              ? ''
                              : ` · 实际报价 ${formatPrice(record.recent_decision.current_quote)}`}
                          </Typography.Text>
                          {/* P5：轻量事实展示（是否已关联投放结果 / CPM30 状态），不参与 P1 分组与排序 */}
                          <Typography.Text type="secondary">
                            结果：
                            {record.recent_decision.outcome
                              ? `已关联 · CPM30${OUTCOME_CPM_SHORT_LABELS[record.recent_decision.outcome.target_cpm_status] || ''}`
                              : '尚未关联'}
                          </Typography.Text>
                        </>
                      ) : (
                        <Typography.Text type="secondary">暂无决策记录</Typography.Text>
                      )}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">近期表现：尚未更新</Typography.Text>
                  )}
                  {/* Alpha.3-02：详情层轻量展示最近一次实际合作价（不做价格分析） */}
                  <div style={{ marginTop: 6 }}>
                    <Typography.Text type="secondary">
                      最近一次实际合作价：{formatLastActualCostValue(record.last_actual_cost)}
                    </Typography.Text>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <Button size="small" type="primary" onClick={() => onOpenAssistant?.(value)}>
                      {snapshot ? '重新更新' : '更新近期表现'}
                    </Button>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Space size={8} wrap>
                      <Button size="small" onClick={() => onOpenDecision?.(record, 'record')}>
                        记录决策
                      </Button>
                      <Button size="small" type="link" onClick={() => onOpenDecision?.(record, 'history')}>
                        查看决策记录
                      </Button>
                    </Space>
                  </div>
                </div>
              }
            >
              <a style={{ display: 'inline-block', maxWidth: '100%', fontWeight: 600 }}>
                <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {value}
                </span>
              </a>
            </Popover>
            {/* 达人类型：保留数据能力，降级为次级文字 */}
            <div
              style={{
                ...SECONDARY_TEXT_STYLE,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {record.creator_type || '未分类'}
            </div>
          </div>
        )
      }
    },
    {
      title: '近期表现',
      key: 'recentPerformance',
      width: 156,
      render: (_, record) => {
        const cell = buildRecentPerformanceCell(record.recent_snapshot)
        if (!cell.hasSnapshot) {
          return <Typography.Text type="secondary">尚未更新</Typography.Text>
        }
        const targetPrice = record.recent_snapshot?.pricing?.target_price
        return (
          <div>
            {cell.isInsufficient ? (
              <Typography.Text type="secondary">样本不足</Typography.Text>
            ) : (
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap' }}>
                {cell.playText} {cell.arrow}
              </div>
            )}
            {!cell.isInsufficient && <div style={SECONDARY_TEXT_STYLE}>{cell.trendText}</div>}
            {cell.observedHint && <div style={SECONDARY_TEXT_STYLE}>{cell.observedHint}</div>}
            {targetPrice !== null && targetPrice !== undefined && (
              <div style={SECONDARY_TEXT_STYLE}>目标价 {formatPrice(targetPrice)}</div>
            )}
          </div>
        )
      }
    },
    {
      // Alpha.3-04A：近期内容表现（商单 / 日常），只做展示，不参与任何业务判断
      title: '近期内容表现',
      key: 'contentType',
      width: 138,
      render: (_, record) => {
        const snapshot = record.recent_snapshot
        if (!snapshot) return PLACEHOLDER
        const cell = buildContentPerformanceLines(snapshot)
        if (cell.lines.length === 0) return PLACEHOLDER
        return (
          <div>
            {cell.lines.map((line) => (
              <div
                key={line.text}
                style={
                  line.primary
                    ? { whiteSpace: 'nowrap', fontWeight: 600, lineHeight: '20px' }
                    : { ...SECONDARY_TEXT_STYLE, whiteSpace: 'nowrap' }
                }
              >
                {line.text}
              </div>
            ))}
            {/* 还有未确认类型的内容时，给一个轻量入口（复用现有「更新近期表现」，不新增编辑器） */}
            {cell.unknownCount > 0 && (
              <a style={SECONDARY_TEXT_STYLE} onClick={() => onOpenAssistant?.(record.creator)}>
                补充分类
              </a>
            )}
          </div>
        )
      }
    },
    {
      title: '历史投放',
      dataIndex: 'record_count',
      width: 76,
      align: 'right',
      render: (value) => `${formatInteger(value)} 次`
    },
    {
      title: '历史CPM',
      dataIndex: 'median_cpm',
      width: 156,
      align: 'right',
      render: (value, record) => {
        const medianText = formatMedianCpmValue(value)
        return (
          <div>
            {/* 0 是真实数值，只有 null 才显示占位 */}
            <div style={{ fontSize: 15, fontWeight: 600, lineHeight: '20px' }}>
              {medianText === '' ? PLACEHOLDER : medianText}
            </div>
            {/* 「有效 CPM 样本 / 达标次数」降级为辅助解释：X/Y 次可计算 · X/Y 达标 */}
            <div style={SECONDARY_TEXT_STYLE}>
              {formatCpmCoverageLine({
                recordCount: record.record_count,
                validCpmCount: record.valid_cpm_count,
                passCount: record.pass_count
              })}
            </div>
          </div>
        )
      }
    },
    {
      title: '最近合作 / 距今',
      dataIndex: 'last_collaboration_date',
      width: 108,
      render: (value, record) => (
        <div>
          <div>{value || PLACEHOLDER}</div>
          <div style={SECONDARY_TEXT_STYLE}>
            {record.days_since_last_collaboration === null ||
            record.days_since_last_collaboration === undefined
              ? '距今 -'
              : `距今 ${formatInteger(record.days_since_last_collaboration)} 天`}
          </div>
          {/* Alpha.3-02：最近一次真实投放记录的实际合作价（与上方日期同一条记录） */}
          <div style={SECONDARY_TEXT_STYLE}>{formatLastActualCostLabel(record.last_actual_cost)}</div>
        </div>
      )
    },
    {
      title: '历史状态',
      dataIndex: 'historical_status',
      width: 104,
      render: (value, record) => {
        const meta = STATUS_META[value] || { label: value, color: 'default' }
        // 工作优先级标记（仅单样本突出 / 优先补数据 / 单次明显低效时出现，文案由后端给出）
        const priorityLabel = record.work_priority_label
        return (
          <div>
            <Tag color={meta.color}>{meta.label}</Tag>
            {priorityLabel && (
              <Tooltip title={WORK_PRIORITY_TOOLTIP}>
                <Tag color={WORK_PRIORITY_TAG_COLORS[record.work_priority] || 'default'}>
                  {priorityLabel}
                </Tag>
              </Tooltip>
            )}
          </div>
        )
      }
    },
    {
      title: '风险提示',
      key: 'recentRisk',
      width: 84,
      render: (_, record) =>
        record.recent_risk ? (
          <Tooltip
            title={`最近连续 2 次有效累计 CPM 都大于 ${formatInteger(targetCpm)}；该提示不改变历史状态`}
          >
            <span style={{ color: '#d4380d' }}>⚠ 最近2次未达标</span>
          </Tooltip>
        ) : (
          PLACEHOLDER
        )
    }
  ]
}

/**
 * 分组标题栏（Alpha.3-03）：整块可点击折叠，标题 / 数量 / 说明始终显示。
 * 只控制「是否渲染该组表格内容」，不参与筛选、计数与排序（数量始终是当前筛选后的真实数量）。
 */
function GroupHeader({ group, filterActive, collapsed, onToggle }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? '展开' : '收起'}${group.label}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        width: '100%',
        cursor: 'pointer',
        userSelect: 'none',
        padding: '2px 6px',
        margin: '-2px -6px',
        borderRadius: 4,
        background: hover ? 'rgba(0, 0, 0, 0.03)' : 'transparent',
        transition: 'background 150ms ease'
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', color: 'rgba(0, 0, 0, 0.45)', fontSize: 12 }}>
        {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
      </span>
      <Typography.Text strong>{group.label}</Typography.Text>
      {/* 原始 group.count 始终是全量口径；有筛选时补充「命中 / 全量」 */}
      <Tag>
        {filterActive
          ? `${formatInteger(group.matched_count)} / ${formatInteger(group.count)} 位达人`
          : `${formatInteger(group.count)} 位达人`}
      </Tag>
      <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
        {GROUP_HINTS[group.key]}
      </Typography.Text>
    </div>
  )
}

/**
 * 复投雷达（V3-alpha P1）
 * 只展示后端已算好的分组结果，前端不重新实现 CPM / 中位数 / 状态判定逻辑。
 */
export default function RepurchaseRadar() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [radar, setRadar] = useState(null)
  // 近期表现助手（V3-alpha P2A）：只生成前端确认草稿，不写数据库
  const [assistantOpen, setAssistantOpen] = useState(false)
  // P2B：助手绑定的雷达达人（从行内入口进入时固定；header 入口为空需用户选择）
  const [assistantCreator, setAssistantCreator] = useState(null)
  const [confirmedDraft, setConfirmedDraft] = useState(null)
  // P4：决策记录抽屉状态
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [decisionCreatorItem, setDecisionCreatorItem] = useState(null)
  const [decisionView, setDecisionView] = useState('record')
  // B2：检索状态（纯 UI 视图状态，不写库、不改变后端返回的任何业务字段）
  const [filters, setFilters] = useState(EMPTY_RADAR_FILTERS)
  // Alpha.3-03：分组折叠状态（纯组件内状态，刷新即回到「全部展开」；不写库 / 不写存储）
  const [collapsedGroups, setCollapsedGroups] = useState(DEFAULT_COLLAPSED_GROUPS)

  const loadRadar = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await getRepurchaseRadar()
      setRadar(res.data)
    } catch (error) {
      setRadar(null)
      setLoadError(getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRadar()
  }, [loadRadar])

  const summary = radar?.summary
  const targetCpm = radar?.target_cpm
  const groups = radar?.groups || []
  // B2：检索只在已加载的雷达数据上做视图过滤（保留后端原排序，不重算任何业务规则）
  const filterActive = isRadarFilterActive(filters)
  const { groups: visibleGroups, visibleCount } = useMemo(
    () => filterRadarGroups(radar?.groups || [], filters),
    [radar, filters]
  )
  const totalCount = summary?.creator_count ?? 0
  // 达人选择器（近期表现助手）始终基于全量达人，不受检索影响
  const creatorOptions = groups.flatMap((group) => group.creators.map((item) => item.creator))
  const openAssistant = (creatorName) => {
    setAssistantCreator(creatorName || null)
    setAssistantOpen(true)
  }
  // P4：决策记录抽屉（「记录决策」/「查看决策记录」都从行内 Popover 进入）
  const openDecision = (creatorItem, view = 'record') => {
    setDecisionCreatorItem(creatorItem)
    setDecisionView(view)
    setDecisionOpen(true)
  }
  // 目标 CPM 一律取后端返回值（唯一来源在 backend/utils/creatorBusinessRules.js），前端不持有字面量
  const columns = buildRadarColumns(targetCpm, openAssistant, openDecision)
  const statisticCardStyle = { height: '100%', minHeight: 96 }

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
          <Space direction="vertical" size={4}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              复投雷达
            </Typography.Title>
            <Typography.Text type="secondary">
              基于已有真实投放记录，回答「过去合作过的达人中，哪些人值得优先重新关注」。
              {targetCpm !== undefined && targetCpm !== null
                ? `单次合作累计 CPM ≤ ${targetCpm} 视为达标。`
                : ''}
            </Typography.Text>
          </Space>
          <Space wrap>
            <Button onClick={() => openAssistant(null)}>更新近期表现</Button>
            <Button icon={<ReloadOutlined />} onClick={loadRadar} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>

        {/* B2：达人名称搜索 + 大组筛选 + 工作优先级筛选（纯前端视图过滤，AND 组合） */}
        <Space wrap size={8} style={{ marginTop: 12 }}>
          <Input
            allowClear
            value={filters.keyword}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, keyword: event.target.value }))
            }
            placeholder="搜索达人名称"
            prefix={<SearchOutlined style={{ color: 'rgba(0, 0, 0, 0.35)' }} />}
            style={{ width: 200 }}
          />
          <Select
            value={filters.groupKey}
            onChange={(value) => setFilters((prev) => ({ ...prev, groupKey: value }))}
            options={RADAR_GROUP_OPTIONS}
            style={{ width: 132 }}
          />
          <Select
            value={filters.workPriority}
            onChange={(value) => setFilters((prev) => ({ ...prev, workPriority: value }))}
            options={WORK_PRIORITY_FILTER_OPTIONS}
            style={{ width: 152 }}
          />
          <Button disabled={!filterActive} onClick={() => setFilters(EMPTY_RADAR_FILTERS)}>
            清空筛选
          </Button>
          <Typography.Text type="secondary">
            显示 {formatInteger(visibleCount)} / {formatInteger(totalCount)} 位达人
          </Typography.Text>
        </Space>

        {confirmedDraft && (
          <Alert
            type="success"
            showIcon
            style={{ marginTop: 12 }}
            message={`已确认识别结果：${confirmedDraft.creator_name || '未命名达人'}${
              confirmedDraft.xingtu_price === null ? '' : ` · 星图价 ¥${formatInteger(confirmedDraft.xingtu_price)}`
            }`}
            description={`识别作品 ${confirmedDraft.summary.identified_count} 条，有效 ${confirmedDraft.summary.valid_count} 条，排除 ${confirmedDraft.summary.excluded_count} 条。P2A 暂不写入数据库，也不参与历史雷达判定。`}
            closable
            onClose={() => setConfirmedDraft(null)}
          />
        )}
      </Card>

      <RecentPerformanceAssistantModal
        open={assistantOpen}
        creator={assistantCreator}
        creatorOptions={creatorOptions}
        onCancel={() => setAssistantOpen(false)}
        onConfirmed={(draft) => setConfirmedDraft(draft)}
        onSaved={() => {
          // 保存成功后单次重拉雷达，让对应达人立即显示最新快照（含 recent_snapshot summary）
          loadRadar()
        }}
      />

      <CreatorDecisionDrawer
        open={decisionOpen}
        creatorItem={decisionCreatorItem}
        initialView={decisionView}
        onClose={() => setDecisionOpen(false)}
        onSaved={() => {
          // 保存决策后单次重拉雷达，让 Popover 的「最近决策」立即更新（不改变 P1 任何字段）
          loadRadar()
        }}
      />

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          style={{ marginTop: 16 }}
          action={
            <Button size="small" onClick={loadRadar}>
              重试
            </Button>
          }
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        message="判定规则（V2 已冻结口径，不做综合评分）"
        description={
          <Space direction="vertical" size={2}>
            <Typography.Text>
              单次达标：累计 CPM（总花费 ÷ 累计播放量 × 1000）≤ {formatInteger(targetCpm)} 为达标。
            </Typography.Text>
            <Typography.Text>
              有效 CPM 样本：累计播放量已填写、未出现「累计播放量 &lt; 7日播放量」异常且大于 0；
              未填写或异常记录不进入分母，但保留在历史合作次数中。
            </Typography.Text>
            <Typography.Text>
              历史状态：有效样本 ≥ 2 次时按达标次数与未达标次数比较（多者取胜，平局为表现分化）；
              有效样本只有 0 或 1 次时一律为证据不足，不进入历史通过。
            </Typography.Text>
            <Typography.Text>
              工作优先级（只影响「先看谁」，不改变上面的历史状态）：仅 1 次有效样本时，累计 CPM ≤ 10
              标记「单次表现突出」，10～20 标记「优先补数据」，≥ 100 标记「单次合作明显低效」（移入暂不优先）；
              多样本仍以历史状态为准。
            </Typography.Text>
          </Space>
        }
      />

      {/* 顶部汇总：历史合作达人数 / 三个分组数量 / 当前目标 CPM */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={12} lg={5}>
          <Card style={statisticCardStyle}>
            {loading ? (
              <Skeleton active paragraph={{ rows: 1 }} />
            ) : (
              <Statistic
                title="历史合作达人数"
                value={summary?.creator_count ?? 0}
                suffix="人"
              />
            )}
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={5}>
          <Card style={statisticCardStyle}>
            {loading ? (
              <Skeleton active paragraph={{ rows: 1 }} />
            ) : (
              <Statistic
                title="优先关注"
                value={summary?.priority_count ?? 0}
                suffix="人"
                valueStyle={{ color: '#237804' }}
              />
            )}
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={5}>
          <Card style={statisticCardStyle}>
            {loading ? (
              <Skeleton active paragraph={{ rows: 1 }} />
            ) : (
              <Statistic title="需要观察" value={summary?.watch_count ?? 0} suffix="人" />
            )}
          </Card>
        </Col>
        <Col xs={12} sm={12} lg={5}>
          <Card style={statisticCardStyle}>
            {loading ? (
              <Skeleton active paragraph={{ rows: 1 }} />
            ) : (
              <Statistic title="暂不优先" value={summary?.low_priority_count ?? 0} suffix="人" />
            )}
          </Card>
        </Col>
        <Col xs={24} sm={24} lg={4}>
          <Card style={statisticCardStyle}>
            {loading ? (
              <Skeleton active paragraph={{ rows: 1 }} />
            ) : (
              <Tooltip title="单次合作累计 CPM 达标线（V3-alpha P1 固定值）">
                <Statistic title="当前目标 CPM" value={targetCpm === null || targetCpm === undefined ? '-' : formatInteger(targetCpm)} />
              </Tooltip>
            )}
          </Card>
        </Col>
      </Row>

      {visibleGroups.map((group) => {
        const collapsed = isGroupCollapsed(collapsedGroups, group.key)
        return (
          <Card
            key={group.key}
            style={{ marginTop: 16 }}
            styles={{
              header: { cursor: 'pointer' },
              // 收起时只隐藏该组的表格内容，标题栏照常显示
              body: collapsed ? { display: 'none' } : undefined
            }}
            title={
              <GroupHeader
                group={group}
                filterActive={filterActive}
                collapsed={collapsed}
                onToggle={() => setCollapsedGroups((prev) => toggleGroupCollapsed(prev, group.key))}
              />
            }
          >
            {collapsed
              ? null
              : loading ? (
                  <Skeleton active paragraph={{ rows: 4 }} />
                ) : group.creators.length === 0 ? (
                  <Empty
                    description={filterActive ? '暂无符合条件的达人' : '当前分组暂无达人'}
                    style={{ padding: 24 }}
                  />
                ) : (
                  <Table
                    size="small"
                    rowKey="creator"
                    dataSource={group.creators}
                    columns={columns}
                    pagination={false}
                    scroll={{ x: RADAR_TABLE_WIDTH }}
                  />
                )}
          </Card>
        )
      })}

      {!loading && !loadError && groups.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无任何投放记录，请先在投放管理中新增或导入数据" style={{ padding: 32 }} />
        </Card>
      )}
    </div>
  )
}
