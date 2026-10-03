import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
  message
} from 'antd'
import { PlusOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons'
import {
  createCreatorCandidate,
  getCandidateLatestSnapshot,
  listCreatorCandidates
} from '../../api/creatorCandidates'
import { getErrorMessage } from '../../utils/request'
import { formatInteger, formatPlays } from '../../utils/format'
import { TREND_LABELS_FULL } from '../../utils/recentPerformanceSave.js'
import { buildCreatorPlaybookAssessment } from '../../utils/creatorPlaybookRules.js'
import RecentPerformanceAssistantModal from '../../components/RecentPerformanceAssistantModal'

const PLACEHOLDER = '-'

const formatPrice = (value) =>
  value === null || value === undefined ? null : `¥${Number(value).toLocaleString('zh-CN')}`

const renderMedian = (value) =>
  value === null || value === undefined ? PLACEHOLDER : formatPlays(value)

const ESTIMATE_CONFIDENCE_LABELS = {
  normal: '常规置信',
  low: '样本较少，仅供参考',
  none: '暂无依据'
}

const STABILITY_TAG_COLORS = { stable: 'green', volatile: 'orange', unknown: 'default' }

// 只做展示格式化：估价区间由 rule engine 给出，页面不重算
const renderEstimateRange = (estimate) =>
  estimate.low === null || estimate.high === null
    ? '暂无（无商单样本）'
    : `${formatPrice(estimate.low)} ～ ${formatPrice(estimate.high)}`

/**
 * 新达人判断（V3-alpha.3 Playbook Phase 1）
 *
 * 本阶段只做两件事：
 *   1) 建立候选达人稳定身份（creator_candidates）
 *   2) 复用 RecentPerformanceAssistantModal 保存 / 读取候选达人的近期表现 snapshot
 *
 * 明确不做：Playbook 规则计算、价格案例、谈价案例、Decision、相似达人、推荐结论。
 */
export default function CreatorPlaybook() {
  const [candidates, setCandidates] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [snapshot, setSnapshot] = useState(null)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [form] = Form.useForm()

  const loadCandidates = useCallback(async () => {
    setListLoading(true)
    setListError('')
    try {
      const res = await listCreatorCandidates()
      const list = res?.data?.candidates || []
      setCandidates(list)
      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) return current
        return list.length ? list[0].id : null
      })
    } catch (error) {
      setCandidates([])
      setListError(getErrorMessage(error))
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCandidates()
  }, [loadCandidates])

  // 选中候选后按 candidate_id 读取其最新快照（绝不按名称匹配）
  const loadSnapshot = useCallback(async (candidateId) => {
    if (!candidateId) {
      setSnapshot(null)
      return
    }
    setSnapshotLoading(true)
    try {
      const res = await getCandidateLatestSnapshot(candidateId)
      setSnapshot(res?.data?.snapshot || null)
    } catch {
      setSnapshot(null)
    } finally {
      setSnapshotLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSnapshot(selectedId)
  }, [selectedId, loadSnapshot])

  const selected = candidates.find((item) => item.id === selectedId) || null

  const handleCreate = async () => {
    let values
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setCreating(true)
    try {
      const res = await createCreatorCandidate({
        name: values.name,
        creator_type: values.creator_type || null,
        profile_url: values.profile_url || null,
        description: values.description || null
      })
      const created = res?.data
      message.success('候选达人已创建')
      setCreateOpen(false)
      form.resetFields()
      await loadCandidates()
      if (created?.id) setSelectedId(created.id)
    } catch (error) {
      message.error(getErrorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  const observedLabel = (() => {
    if (!snapshot) return PLACEHOLDER
    const observed = String(snapshot.observed_at ?? '').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed : '观察日期未知'
  })()
  // 量化判断全部由纯函数规则引擎给出（页面只负责展示，不重复计算业务规则）
  const assessment = snapshot ? buildCreatorPlaybookAssessment(snapshot) : null

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
              新达人判断
            </Typography.Title>
            <Typography.Text type="secondary">
              为尚未投放的新达人建立稳定身份，并录入 / 查看近期表现。本阶段不做价格案例与推荐结论。
            </Typography.Text>
          </Space>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={loadCandidates} loading={listLoading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建候选达人
            </Button>
          </Space>
        </div>
        {listError && (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: 12 }}>
            {listError}
          </Typography.Text>
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* A. 候选达人列表 */}
        <Col xs={24} lg={8}>
          <Card size="small" title={`候选达人（${candidates.length}）`}>
            {candidates.length === 0 && !listLoading ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有候选达人，先新建一个"
              />
            ) : (
              <List
                loading={listLoading}
                dataSource={candidates}
                renderItem={(item) => (
                  <List.Item
                    style={{
                      cursor: 'pointer',
                      background: item.id === selectedId ? 'rgba(22, 119, 255, 0.06)' : undefined,
                      borderRadius: 4,
                      paddingLeft: 8,
                      paddingRight: 8
                    }}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <List.Item.Meta
                      title={
                        <Space size={6} wrap>
                          <Typography.Text strong>{item.name}</Typography.Text>
                          {item.status === 'archived' && <Tag>已归档</Tag>}
                        </Space>
                      }
                      description={item.creator_type || '未分类'}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        {/* C + D. 选中候选的基本信息 + 近期表现 */}
        <Col xs={24} lg={16}>
          {!selected ? (
            <Card size="small">
              <Empty
                image={<UserAddOutlined style={{ fontSize: 40, color: 'rgba(0,0,0,0.25)' }} />}
                description="选择左侧候选达人，或新建一个候选"
              />
            </Card>
          ) : (
            <Card
              size="small"
              title={
                <Space size={8} wrap>
                  <Typography.Text strong style={{ fontSize: 16 }}>
                    {selected.name}
                  </Typography.Text>
                  <Typography.Text type="secondary">{selected.creator_type || '未分类'}</Typography.Text>
                  {selected.status === 'archived' && <Tag>已归档</Tag>}
                </Space>
              }
              extra={
                <Button type="primary" onClick={() => setAssistantOpen(true)}>
                  录入近期表现
                </Button>
              }
            >
              <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
                <Descriptions.Item label="主页链接">
                  {selected.profile_url ? (
                    <a href={selected.profile_url} target="_blank" rel="noreferrer">
                      {selected.profile_url}
                    </a>
                  ) : (
                    PLACEHOLDER
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="备注">{selected.description || PLACEHOLDER}</Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {String(selected.created_at || '').slice(0, 16) || PLACEHOLDER}
                </Descriptions.Item>
                <Descriptions.Item label="最近观察日期">{observedLabel}</Descriptions.Item>
              </Descriptions>

              <Divider style={{ margin: '8px 0 12px' }} />

              {snapshotLoading ? (
                <Typography.Text type="secondary">加载近期表现…</Typography.Text>
              ) : !snapshot ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="尚未录入近期表现，点击右上角「录入近期表现」"
                />
              ) : (
                <Space direction="vertical" size={16} style={{ display: 'flex' }}>
                  {/* 第一层：近期数据（核心事实，直接来自 snapshot） */}
                  <div>
                    <Typography.Text strong>近期数据</Typography.Text>
                    <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="整体中位播放" value={renderMedian(snapshot.median_play)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="整体平均播放" value={renderMedian(assessment.metrics.meanPlay)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="P25 / P75"
                          value={`${renderMedian(snapshot.p25_play)} / ${renderMedian(snapshot.p75_play)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="趋势"
                          value={TREND_LABELS_FULL[snapshot.trend_label] || '样本不足'}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="有效内容数" value={formatInteger(snapshot.valid_count ?? 0)} />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="商单中位 / 条数"
                          value={`${renderMedian(snapshot.sponsored_median_play)} / ${formatInteger(snapshot.sponsored_count ?? 0)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic
                          title="日常中位 / 条数"
                          value={`${renderMedian(snapshot.organic_median_play)} / ${formatInteger(snapshot.organic_count ?? 0)}`}
                        />
                      </Col>
                      <Col xs={12} sm={8} lg={6}>
                        <Statistic title="未识别条数" value={formatInteger(snapshot.unknown_count ?? 0)} />
                      </Col>
                    </Row>
                  </div>

                  <Divider style={{ margin: '4px 0' }} />

                  {/* 第二层：量化判断（可解释维度，人工决定是否投放） */}
                  <div>
                    <Space size={8} wrap align="baseline">
                      <Typography.Text strong>量化判断</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        仅量化呈现，是否投放由人工决定
                      </Typography.Text>
                    </Space>
                    <Space size={8} wrap style={{ display: 'flex', marginTop: 8 }}>
                      <Tag>{assessment.scale.label}</Tag>
                      <Tag>{assessment.commercialDensity.label}</Tag>
                      <Tag color={STABILITY_TAG_COLORS[assessment.stability.code]}>
                        {assessment.stability.label}
                      </Tag>
                      {assessment.highPlaySignal.active && (
                        <Tag color="gold">{assessment.highPlaySignal.label}</Tag>
                      )}
                    </Space>
                    <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 8 }}>
                      <Typography.Text type="secondary">{assessment.stability.explanation}</Typography.Text>
                      <Typography.Text type="secondary">
                        估价基准：{assessment.performanceBasis.explanation}
                      </Typography.Text>
                    </Space>
                  </div>

                  <Divider style={{ margin: '4px 0' }} />

                  {/* 第三层：价格分寸（CPM15-20 估价锚点 + 万元风险） */}
                  <div>
                    <Typography.Text strong>价格分寸</Typography.Text>
                    <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic title="CPM15-20 基础估价" value={renderEstimateRange(assessment.estimate)} />
                      </Col>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic
                          title="估价置信"
                          value={ESTIMATE_CONFIDENCE_LABELS[assessment.estimate.confidence] || PLACEHOLDER}
                        />
                      </Col>
                      <Col xs={24} sm={12} lg={8}>
                        <Statistic title="星图刊例价" value={formatPrice(snapshot.xingtu_price) ?? '暂无'} />
                      </Col>
                    </Row>
                    <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
                      {assessment.estimate.explanation}
                    </Typography.Text>
                    {assessment.risk.highAmount && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 8 }}
                        message="万元以上高金额"
                        description={assessment.risk.explanation}
                      />
                    )}
                  </div>
                </Space>
              )}
            </Card>
          )}
        </Col>
      </Row>

      {/* B. 新建候选达人 */}
      <Modal
        title="新建候选达人"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="达人名称"
            rules={[{ required: true, message: '请填写达人名称' }]}
          >
            <Input placeholder="达人名称（允许重名）" maxLength={100} />
          </Form.Item>
          <Form.Item name="creator_type" label="达人类型（可选）">
            <Input placeholder="如 美妆 / 数码 / 生活" maxLength={50} />
          </Form.Item>
          <Form.Item name="profile_url" label="主页链接（可选）">
            <Input placeholder="https://..." maxLength={500} />
          </Form.Item>
          <Form.Item name="description" label="简短备注（可选）">
            <Input.TextArea placeholder="来源 / 判断线索等" maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* D. 复用现有近期表现助手（候选模式：按 candidate_id 保存 / 读取） */}
      <RecentPerformanceAssistantModal
        open={assistantOpen}
        creator={selected?.name || null}
        candidateId={selected?.id ?? null}
        creatorOptions={selected ? [selected.name] : []}
        mode="update"
        onCancel={() => setAssistantOpen(false)}
        onSaved={() => loadSnapshot(selectedId)}
      />
    </div>
  )
}
