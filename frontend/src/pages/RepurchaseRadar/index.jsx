import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
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

// 列宽合计刻意控制在 832px 内：1024 宽度下整张表无需横向滚动即可看全全部指标
const RADAR_TABLE_WIDTH = 832
const SECONDARY_TEXT_STYLE = { fontSize: 12, color: 'rgba(0, 0, 0, 0.45)', lineHeight: '18px' }
const PLACEHOLDER = <Typography.Text type="secondary">-</Typography.Text>

/**
 * 列定义（目标 CPM 只用于提示文案，业务判定全部由后端给出）
 * @param {number} targetCpm 目标 CPM
 */
function buildRadarColumns(targetCpm) {
  return [
    { title: '达人名称', dataIndex: 'creator', width: 120, ellipsis: true },
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
      width: 92,
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
      width: 96,
      render: (_, record) =>
        record.recent_risk ? (
          <Tooltip
            title={`最近连续 2 次有效累计 CPM 都大于 ${targetCpm}；该提示不改变历史状态`}
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
  const [confirmedDraft, setConfirmedDraft] = useState(null)

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
  const columns = buildRadarColumns(targetCpm ?? 30)
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
            <Button onClick={() => setAssistantOpen(true)}>更新近期表现</Button>
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
        onCancel={() => setAssistantOpen(false)}
        onConfirmed={(draft) => setConfirmedDraft(draft)}
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
              单次达标：累计 CPM（总花费 ÷ 累计播放量 × 1000）≤ {targetCpm ?? 30} 为达标。
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
                <Statistic title="当前目标 CPM" value={targetCpm ?? 30} />
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
