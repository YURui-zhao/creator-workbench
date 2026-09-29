import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Popover,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { getRepurchaseRadar } from '../../api/records'
import { getErrorMessage } from '../../utils/request'
import { formatCpm, formatInteger } from '../../utils/format'
import RecentPerformanceAssistantModal from '../../components/RecentPerformanceAssistantModal'
import CreatorDecisionDrawer from '../../components/CreatorDecisionDrawer'
import {
  formatPlayRange,
  formatObservedAtHint,
  formatSnapshotStatusText,
  formatTrendRatio,
  TREND_LABELS_FULL
} from '../../utils/recentPerformanceSave.js'
import { buildPricingRows, formatPrice } from '../../utils/pricingDisplay.js'

// 历史状态 -> 展示文案（文字为主，颜色仅辅助，不依赖颜色理解）
const STATUS_META = {
  passed: { label: '历史通过', color: 'success' },
  mixed: { label: '表现分化', color: 'warning' },
  insufficient: { label: '证据不足', color: 'default' },
  failed: { label: '暂不优先', color: 'error' }
}

const GROUP_HINTS = {
  priority: '有效合作样本 ≥ 2 且多数单次累计 CPM ≤ 目标值',
  watch: '表现分化，或有效样本不足 2 次（证据不足不进入「历史通过」）',
  low_priority: '有效合作样本 ≥ 2 且多数单次累计 CPM 未达标'
}

// P5：雷达 Popover 里「投放结果」只做轻量事实展示（状态码 -> 短文案），不使用长句
const OUTCOME_CPM_SHORT_LABELS = {
  pending: '待更新',
  anomaly: '异常',
  zero_play: '累计播放为0',
  met: '已达标',
  not_met: '未达标'
}

// 列宽合计刻意控制在 1024 宽度下不产生页面级 / 表内横向滚动：
// 「达人名称」列加宽以容纳第二行的近期表现状态，同时小幅收紧中位数与风险列
const RADAR_TABLE_WIDTH = 836
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
      title: '达人名称 / 近期表现',
      dataIndex: 'creator',
      width: 140,
      render: (value, record) => {
        const snapshot = record.recent_snapshot
        // Alpha.2：主表行内暴露「这份近期数据是哪天观察的」（无快照时不显示）
        const observedHint = formatObservedAtHint(snapshot)
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {value}
            </div>
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
              <a style={{ ...SECONDARY_TEXT_STYLE, display: 'inline-block', maxWidth: '100%' }}>
                <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {formatSnapshotStatusText(snapshot)}
                </span>
                {snapshot?.pricing?.target_price !== null && snapshot?.pricing?.target_price !== undefined && (
                  <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
                    目标价 {formatPrice(snapshot.pricing.target_price)}
                  </span>
                )}
                {observedHint && (
                  <span
                    style={{
                      display: 'block',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}
                  >
                    {observedHint}
                  </span>
                )}
              </a>
            </Popover>
          </div>
        )
      }
    },
    { title: '达人类型', dataIndex: 'creator_type', width: 84, ellipsis: true },
    {
      title: '历史合作次数',
      dataIndex: 'record_count',
      width: 84,
      align: 'right',
      render: (value) => `${formatInteger(value)} 次`
    },
    {
      title: '有效CPM样本',
      dataIndex: 'valid_cpm_count',
      width: 84,
      align: 'right',
      render: (value) => `${formatInteger(value)} 次`
    },
    {
      title: 'CPM达标次数',
      key: 'passCount',
      width: 88,
      align: 'right',
      render: (_, record) =>
        `${formatInteger(record.pass_count)} / ${formatInteger(record.valid_cpm_count)}`
    },
    {
      title: '历史CPM中位数',
      dataIndex: 'median_cpm',
      width: 84,
      align: 'right',
      render: (value) => (value === null || value === undefined ? PLACEHOLDER : formatCpm(value))
    },
    {
      title: '最近合作 / 距今',
      dataIndex: 'last_collaboration_date',
      width: 100,
      render: (value, record) => (
        <div>
          <div>{value || PLACEHOLDER}</div>
          <div style={SECONDARY_TEXT_STYLE}>
            {record.days_since_last_collaboration === null ||
            record.days_since_last_collaboration === undefined
              ? '距今 -'
              : `距今 ${formatInteger(record.days_since_last_collaboration)} 天`}
          </div>
        </div>
      )
    },
    {
      title: '历史状态',
      dataIndex: 'historical_status',
      width: 84,
      render: (value) => {
        const meta = STATUS_META[value] || { label: value, color: 'default' }
        return <Tag color={meta.color}>{meta.label}</Tag>
      }
    },
    {
      title: '风险提示',
      key: 'recentRisk',
      width: 88,
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

      {groups.map((group) => (
        <Card
          key={group.key}
          style={{ marginTop: 16 }}
          title={
            <Space size={8} wrap>
              <Typography.Text strong>{group.label}</Typography.Text>
              <Tag>{`${formatInteger(group.count)} 位达人`}</Tag>
              <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
                {GROUP_HINTS[group.key]}
              </Typography.Text>
            </Space>
          }
        >
          {loading ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : group.creators.length === 0 ? (
            <Empty description="当前分组暂无达人" style={{ padding: 24 }} />
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
      ))}

      {!loading && !loadError && groups.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无任何投放记录，请先在投放管理中新增或导入数据" style={{ padding: 32 }} />
        </Card>
      )}
    </div>
  )
}
