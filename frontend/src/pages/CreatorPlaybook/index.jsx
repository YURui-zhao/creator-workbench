import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
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
  Tooltip,
  Typography,
  message
} from 'antd'
import { PlusOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons'
import {
  createCandidateDecision,
  createCandidatePostQuoteDecision,
  createCreatorCandidate,
  getCandidateLatestSnapshot,
  getCandidatePriceReference,
  listCandidateDecisions,
  listCreatorCandidates,
  updateCreatorCandidate
} from '../../api/creatorCandidates'
import { distillCreatorNote, getAiStatus } from '../../api/ai'
import { getAiConfig } from '../../utils/aiConfig.js'
import { getErrorMessage } from '../../utils/request'
import {
  getDecisionOutcomeCandidates,
  linkDecisionOutcome
} from '../../api/creatorDecisions'
import { formatInteger, formatPlays } from '../../utils/format'
import { TREND_LABELS_FULL } from '../../utils/recentPerformanceSave.js'
import { buildCreatorPlaybookAssessment } from '../../utils/creatorPlaybookRules.js'
import {
  applyCandidateEditValues,
  applyXingtuIdFormValues
} from '../../utils/creatorCandidateForm.js'
import RecentPerformanceAssistantModal from '../../components/RecentPerformanceAssistantModal'
import NegotiationCaseModal from '../../components/NegotiationCaseModal'

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

// Phase 3B：历史价格参考空态文案（与后端 reason_code 一一对应）
const PRICE_REF_MESSAGES = {
  no_snapshot: '先录入近期表现后，才能生成历史价格参考。',
  no_sponsored_sample: '暂无商单样本，暂不生成历史价格参考。日常播放仅作为辅助，不直接换算商单价格。',
  high_scale_not_supported: '当前属于高量级达人。现有高量级历史样本较少，V0.1 暂不生成历史价格参考。'
}

// Phase 4B：candidate_review 人工决定（必须由用户显式选择；系统 / AI / 规则绝不自动选择）
const CANDIDATE_REVIEW_OPTIONS = [
  { value: 'contact', label: '继续联系' },
  { value: 'observe', label: '继续观察' },
  { value: 'hold', label: '暂不推进' }
]

// Phase 4D：candidate 报价阶段（candidate 第一次投放，用「直接推进」而非「复投」）
const CANDIDATE_POST_QUOTE_OPTIONS = [
  { value: 'proceed', label: '直接推进' },
  { value: 'small_test', label: '小额测试' },
  { value: 'negotiate', label: '继续议价' },
  { value: 'pause', label: '暂缓' }
]

// 报价相对 Playbook 经验区间的位置（纯事实描述）
const QUOTE_POSITION_LABELS = {
  below_playbook_range: '低于经验区间',
  within_playbook_range: '位于经验区间',
  above_playbook_range: '高于经验区间',
  unavailable: '经验区间不可用'
}

// 历史价格参考渲染（严格使用后端返回顺序，前端不再排序；不显示相似度）
function renderPriceReference(priceRef, loading) {
  if (loading) return <Typography.Text type="secondary">加载历史价格参考…</Typography.Text>
  if (!priceRef) return <Typography.Text type="secondary">-</Typography.Text>
  if (!priceRef.available) {
    return (
      <Typography.Text type="secondary">
        {PRICE_REF_MESSAGES[priceRef.reason_code] || priceRef.message || '暂不生成历史价格参考。'}
      </Typography.Text>
    )
  }
  const cases = Array.isArray(priceRef.cases) ? priceRef.cases : []
  if (cases.length === 0) {
    return <Typography.Text type="secondary">暂无符合当前口径的历史价格案例。</Typography.Text>
  }
  const summary = priceRef.summary
  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={6}>
          <Statistic title="商单中位目标" value={formatPlays(priceRef.target?.sponsored_median_play)} />
        </Col>
        {summary && (
          <>
            <Col xs={12} sm={8} lg={6}>
              <Statistic title="历史案例成交中位" value={formatPrice(summary.cost_median) ?? '-'} />
            </Col>
            <Col xs={12} sm={8} lg={6}>
              <Statistic
                title="案例成交范围"
                value={`${formatPrice(summary.cost_min) ?? '-'} – ${formatPrice(summary.cost_max) ?? '-'}`}
              />
            </Col>
            <Col xs={12} sm={8} lg={6}>
              <Statistic title="案例最终 CPM 中位" value={summary.final_cpm_median ?? '-'} />
            </Col>
          </>
        )}
      </Row>
      {!summary && (
        <Typography.Text type="secondary">
          历史可参考案例较少，仅展示个案，不形成价格区间。
        </Typography.Text>
      )}
      <List
        size="small"
        dataSource={cases}
        renderItem={(item) => (
          <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
            <Space direction="vertical" size={2} style={{ display: 'flex' }}>
              <Space size={6} wrap>
                <Typography.Text strong>{item.creator}</Typography.Text>
                <Typography.Text type="secondary">{item.creator_type || '未分类'}</Typography.Text>
                {item.same_creator_type && <Tag>同类型</Tag>}
              </Space>
              <Typography.Text type="secondary">
                累计播放 {formatPlays(item.cumulative_play)} · 实际合作 {formatPrice(item.actual_cost) ?? '-'} · 最终 CPM{' '}
                {item.final_cpm ?? '-'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                与当前商单中位相差 {formatPlays(item.play_distance)}
              </Typography.Text>
            </Space>
          </List.Item>
        )}
      />
    </Space>
  )
}

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
  // Phase 3B：历史价格参考（只读，后端按 candidate_id 派生 target）
  const [priceRef, setPriceRef] = useState(null)
  const [priceRefLoading, setPriceRefLoading] = useState(false)
  // Phase 4B：人工决定（append-only）
  const [decisions, setDecisions] = useState([])
  const [decisionsLoading, setDecisionsLoading] = useState(false)
  const [pendingDecision, setPendingDecision] = useState(null)
  const [decisionNote, setDecisionNote] = useState('')
  const [savingDecision, setSavingDecision] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  // Phase 4D：报价阶段决策（不自动弹出；无默认选中）
  const [postQuoteOpen, setPostQuoteOpen] = useState(false)
  const [postQuoteAmount, setPostQuoteAmount] = useState('')
  const [postQuoteDecision, setPostQuoteDecision] = useState(null)
  const [postQuoteNote, setPostQuoteNote] = useState('')
  const [savingPostQuote, setSavingPostQuote] = useState(false)
  // Phase 4E：实际投放结果关联
  const [outcomeOpen, setOutcomeOpen] = useState(false)
  const [outcomeCandidates, setOutcomeCandidates] = useState([])
  const [outcomeLoading, setOutcomeLoading] = useState(false)
  const [outcomeError, setOutcomeError] = useState('')
  const [selectedOutcomeRecordId, setSelectedOutcomeRecordId] = useState(null)
  const [outcomeIdentityConfirmed, setOutcomeIdentityConfirmed] = useState(false)
  const [outcomeTimingConfirmed, setOutcomeTimingConfirmed] = useState(false)
  const [savingOutcome, setSavingOutcome] = useState(false)
  // Phase 4F-B：谈价结果（复用现有 NegotiationCaseModal）
  const [negotiationOpen, setNegotiationOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  // AI 是否可用（仅控制「AI整理备注」按钮；不影响 candidate / snapshot 等其它能力）
  const [aiReady, setAiReady] = useState(false)
  // AI 整理备注：预览态（不自动写库）
  const [distilling, setDistilling] = useState(false)
  const [distillPreview, setDistillPreview] = useState(null)
  const [savingDistill, setSavingDistill] = useState(false)
  // 资料维护：星图 ID 就地更新 / 编辑资料（都复用同一 PATCH，不新增 API）
  const [xingtuEditOpen, setXingtuEditOpen] = useState(false)
  const [savingXingtu, setSavingXingtu] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  // 冻结「正在编辑的 candidate」：回填只认这个对象，不受列表刷新 / selected 变化影响
  const [editingCandidate, setEditingCandidate] = useState(null)
  const [form] = Form.useForm()
  const [xingtuForm] = Form.useForm()
  const [editForm] = Form.useForm()

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

  // 历史价格参考：随选中候选变化重新拉取（只读；后端自行派生 target，前端不提交）
  const loadPriceReference = useCallback(async (candidateId) => {
    if (!candidateId) {
      setPriceRef(null)
      return
    }
    setPriceRefLoading(true)
    try {
      const res = await getCandidatePriceReference(candidateId)
      setPriceRef(res?.data || null)
    } catch {
      setPriceRef(null)
    } finally {
      setPriceRefLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPriceReference(selectedId)
  }, [selectedId, loadPriceReference])

  // 人工决定：随选中候选变化重新拉取 append-only 历史（按 candidate_id）
  const loadDecisions = useCallback(async (candidateId) => {
    if (!candidateId) {
      setDecisions([])
      return
    }
    setDecisionsLoading(true)
    try {
      const res = await listCandidateDecisions(candidateId)
      setDecisions(res?.data?.decisions || [])
    } catch {
      setDecisions([])
    } finally {
      setDecisionsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDecisions(selectedId)
  }, [selectedId, loadDecisions])

  // 切换候选时收起历史 / 清空待提交的决定
  useEffect(() => {
    setHistoryExpanded(false)
    setPendingDecision(null)
    setDecisionNote('')
    setPostQuoteOpen(false)
    setPostQuoteAmount('')
    setPostQuoteDecision(null)
    setPostQuoteNote('')
    setOutcomeOpen(false)
    setOutcomeCandidates([])
    setSelectedOutcomeRecordId(null)
    setOutcomeIdentityConfirmed(false)
    setOutcomeTimingConfirmed(false)
  }, [selectedId])

  // AI 可用性：会话 Key（本地）或后端环境变量任一可用即可；查询失败不影响页面其它能力
  useEffect(() => {
    let active = true
    if (Boolean(getAiConfig()?.apiKey)) {
      setAiReady(true)
      return undefined
    }
    getAiStatus()
      .then((res) => {
        if (active) setAiReady(Boolean(res?.data?.available))
      })
      .catch(() => {
        if (active) setAiReady(false)
      })
    return () => {
      active = false
    }
  }, [selectedId])

  // 切换候选时清空未保存的 AI 整理预览
  useEffect(() => {
    setDistillPreview(null)
  }, [selectedId])

  const selected = candidates.find((item) => item.id === selectedId) || null

  const handleCreate = async () => {
    if (creating) return
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
        xingtu_id: values.xingtu_id || null,
        description: values.description || null
      })
      const created = res?.data
      message.success('候选达人已创建')
      setCreateOpen(false)
      form.resetFields()
      await loadCandidates()
      if (created?.id) setSelectedId(created.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setCreating(false)
    }
  }

  // 只整理已有的人工备注（只在用户显式点击时调用；AI 失败不影响 candidate 数据）
  const handleDistill = async () => {
    if (!selected) return
    const note = String(selected.description ?? '').trim()
    if (!note) return
    if (distilling) return
    setDistilling(true)
    setDistillPreview(null)
    try {
      const res = await distillCreatorNote(note)
      setDistillPreview(res?.data || null)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setDistilling(false)
    }
  }

  // 用户明确点击「保存整理结果」后才写库（distilled_description 是派生字段）
  const handleSaveDistill = async () => {
    if (!selected || !distillPreview?.text) return
    if (savingDistill) return
    setSavingDistill(true)
    try {
      await updateCreatorCandidate(selected.id, { distilled_description: distillPreview.text })
      message.success('已保存 AI 整理结果')
      setDistillPreview(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingDistill(false)
    }
  }

  // 星图 ID 就地更新（只 PATCH xingtu_id；不动 candidate_id / snapshot / description / AI整理）
  const openXingtuEdit = () => {
    setEditingCandidate(selected)
    setXingtuEditOpen(true)
  }

  const handleSaveXingtu = async () => {
    if (!editingCandidate) return
    if (savingXingtu) return
    let values
    try {
      values = await xingtuForm.validateFields()
    } catch {
      return
    }
    setSavingXingtu(true)
    try {
      await updateCreatorCandidate(editingCandidate.id, { xingtu_id: values.xingtu_id || null })
      message.success('星图 ID 已更新')
      setXingtuEditOpen(false)
      setEditingCandidate(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingXingtu(false)
    }
  }

  // 复制星图 ID（clipboard API 失败时明确报错，绝不静默假成功）
  const handleCopyXingtuId = async () => {
    const text = String(selected?.xingtu_id ?? '').trim()
    if (!text) return
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      message.success('星图 ID 已复制')
    } catch {
      message.error('复制失败，请手动复制星图 ID')
    }
  }

  // 编辑资料（复用同一 PATCH；description 变化时后端会自动清空过期 AI 整理）
  const openEdit = () => {
    setEditingCandidate(selected)
    setEditOpen(true)
  }

  const handleSaveEdit = async () => {
    if (!editingCandidate) return
    if (savingEdit) return
    let values
    try {
      values = await editForm.validateFields()
    } catch {
      return
    }
    setSavingEdit(true)
    try {
      await updateCreatorCandidate(editingCandidate.id, {
        name: values.name,
        creator_type: values.creator_type || null,
        profile_url: values.profile_url || null,
        xingtu_id: values.xingtu_id || null,
        description: values.description || null
      })
      message.success('资料已更新')
      setEditOpen(false)
      setEditingCandidate(null)
      // 备注若变化，后端已清空过期 AI 整理；同时丢弃未保存的 AI 预览，避免展示过期结果
      setDistillPreview(null)
      await loadCandidates()
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingEdit(false)
    }
  }

  // 人工决定：必须由用户点击某个按钮显式发起（无默认选中、无系统推荐）
  const openDecision = (option) => {
    setPendingDecision(option)
    setDecisionNote('')
  }

  const handleSaveDecision = async () => {
    if (!selected || !pendingDecision || savingDecision) return
    setSavingDecision(true)
    try {
      await createCandidateDecision(selected.id, {
        human_decision: pendingDecision.value,
        decision_note: decisionNote.trim() ? decisionNote.trim() : null
      })
      message.success('决定已记录')
      setPendingDecision(null)
      setDecisionNote('')
      await loadDecisions(selected.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingDecision(false)
    }
  }

  const observedLabel = (() => {
    if (!snapshot) return PLACEHOLDER
    const observed = String(snapshot.observed_at ?? '').trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed : '观察日期未知'
  })()
  // 量化判断全部由纯函数规则引擎给出（页面只负责展示，不重复计算业务规则）
  const assessment = snapshot ? buildCreatorPlaybookAssessment(snapshot) : null
  // Phase 4D：最近一次 review / 报价阶段决策（decisions 已按时间倒序）
  const latestReviewDecision = decisions.find((item) => item.decision_stage === 'candidate_review') || null
  const latestPostQuoteDecision = decisions.find((item) => item.decision_stage === 'post_quote') || null
  const reviewContactConfirmed = latestReviewDecision?.human_decision === 'contact'
  // Phase 4E：只以「最新 post_quote」为当前状态（不越过更晚的 negotiate / pause 去找早期 proceed）
  const latestPostQuoteEligible =
    Boolean(latestPostQuoteDecision) &&
    ['proceed', 'small_test'].includes(latestPostQuoteDecision.human_decision)
  const currentOutcome = latestPostQuoteDecision?.outcome || null
  // Phase 4F-B：最新 post_quote = negotiate 时的谈价事实（按 decision_id 关联）
  const latestPostQuoteNegotiating = latestPostQuoteDecision?.human_decision === 'negotiate'
  const latestNegotiationCase = latestPostQuoteDecision?.negotiation_case || null

  // 报价阶段：必须由用户主动点击后打开，无默认选中
  const openPostQuote = (prefillAmount) => {
    // 只有显式传入字符串才预填（点击事件对象不会被当成金额）
    setPostQuoteAmount(typeof prefillAmount === 'string' ? prefillAmount : '')
    setPostQuoteDecision(null)
    setPostQuoteNote('')
    setPostQuoteOpen(true)
  }

  const handleSavePostQuote = async () => {
    if (!selected || !postQuoteDecision || savingPostQuote) return
    if (!postQuoteAmount.trim()) {
      message.warning('请填写当前报价')
      return
    }
    setSavingPostQuote(true)
    try {
      await createCandidatePostQuoteDecision(selected.id, {
        current_quote_raw: postQuoteAmount.trim(),
        human_decision: postQuoteDecision.value,
        decision_note: postQuoteNote.trim() ? postQuoteNote.trim() : null
      })
      message.success('报价阶段决策已记录')
      setPostQuoteOpen(false)
      await loadDecisions(selected.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingPostQuote(false)
    }
  }

  // Phase 4E：关联真实投放记录（候选列表来自既有 outcome-candidates 接口，前端不自己查 records）
  const selectedOutcomeCandidate =
    outcomeCandidates.find((item) => item.record_id === selectedOutcomeRecordId) || null

  const openOutcome = async () => {
    if (!latestPostQuoteDecision) return
    setOutcomeOpen(true)
    setOutcomeCandidates([])
    setSelectedOutcomeRecordId(null)
    setOutcomeIdentityConfirmed(false)
    setOutcomeTimingConfirmed(false)
    setOutcomeError('')
    setOutcomeLoading(true)
    try {
      const res = await getDecisionOutcomeCandidates(latestPostQuoteDecision.id)
      setOutcomeCandidates(res?.data?.candidates || [])
    } catch (error) {
      setOutcomeError(getErrorMessage(error))
    } finally {
      setOutcomeLoading(false)
    }
  }

  const handleLinkOutcome = async () => {
    if (!latestPostQuoteDecision || !selectedOutcomeCandidate || savingOutcome) return
    if (selectedOutcomeCandidate.requires_identity_confirmation && !outcomeIdentityConfirmed) {
      message.warning('请先确认这条投放记录属于当前候选达人')
      return
    }
    if (selectedOutcomeCandidate.requires_timing_confirmation && !outcomeTimingConfirmed) {
      message.warning('请先确认发布时间与当前决策的时间关系')
      return
    }
    setSavingOutcome(true)
    try {
      // 只提交 record_id + 两个人工确认 flag；candidate / decision / evidence 由后端决定
      await linkDecisionOutcome(latestPostQuoteDecision.id, {
        recordId: selectedOutcomeCandidate.record_id,
        identityConfirmed: outcomeIdentityConfirmed,
        timingConfirmed: outcomeTimingConfirmed
      })
      message.success('已关联实际投放')
      setOutcomeOpen(false)
      await loadDecisions(selected.id)
    } catch {
      // 失败提示由 request 响应拦截器统一给出，这里不再重复 toast
    } finally {
      setSavingOutcome(false)
    }
  }

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
                  {/* 次级操作：编辑资料（不抢「录入近期表现」的主 CTA 层级） */}
                  <Button type="link" size="small" onClick={openEdit}>
                    编辑资料
                  </Button>
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
                    <a href={selected.profile_url} target="_blank" rel="noopener noreferrer">
                      查看主页
                    </a>
                  ) : (
                    PLACEHOLDER
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="星图 ID">
                  <Space size={4} wrap>
                    {selected.xingtu_id ? (
                      <Typography.Text>{selected.xingtu_id}</Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">{PLACEHOLDER}</Typography.Text>
                    )}
                    {selected.xingtu_id && (
                      <Button type="link" size="small" onClick={handleCopyXingtuId}>
                        复制
                      </Button>
                    )}
                    <Button type="link" size="small" onClick={openXingtuEdit}>
                      {selected.xingtu_id ? '更新 ID' : '补充 ID'}
                    </Button>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {String(selected.created_at || '').slice(0, 16) || PLACEHOLDER}
                </Descriptions.Item>
                <Descriptions.Item label="最近观察日期">{observedLabel}</Descriptions.Item>
              </Descriptions>

              <Divider style={{ margin: '8px 0 12px' }} />

              {/* 人工备注：source of truth（AI 只整理，绝不覆盖） */}
              <div>
                <Space size={8} wrap align="center">
                  <Typography.Text strong>人工备注</Typography.Text>
                  {Boolean(String(selected.description ?? '').trim()) && (
                    <Tooltip title={aiReady ? '' : '连接 AI 后可整理备注'}>
                      <Button
                        size="small"
                        disabled={!aiReady}
                        loading={distilling}
                        onClick={handleDistill}
                      >
                        AI整理备注
                      </Button>
                    </Tooltip>
                  )}
                </Space>
                <Typography.Paragraph style={{ marginTop: 6, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                  {selected.description || PLACEHOLDER}
                </Typography.Paragraph>
              </div>

              {/* AI 整理预览（未保存）：明确与人工备注区分，不自动写库 */}
              {distillPreview && (
                <div style={{ marginTop: 10, padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    AI整理（预览，未保存）
                  </Typography.Text>
                  <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
                    {distillPreview.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                  <Space size={8}>
                    <Button size="small" type="primary" loading={savingDistill} onClick={handleSaveDistill}>
                      保存整理结果
                    </Button>
                    <Button size="small" onClick={() => setDistillPreview(null)}>
                      放弃
                    </Button>
                  </Space>
                </div>
              )}

              {/* 已保存的 AI 整理结果（派生文本，与人工备注分开展示） */}
              {selected.distilled_description && (
                <div style={{ marginTop: 10 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    AI整理
                  </Typography.Text>
                  <Typography.Paragraph style={{ marginTop: 4, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                    {selected.distilled_description}
                  </Typography.Paragraph>
                </div>
              )}

              <Divider style={{ margin: '12px 0' }} />

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

              <Divider style={{ margin: '12px 0' }} />

              {/* Phase 3B：历史价格参考（只读历史事实，与 CPM15-20 经验估价并列，不融合成"建议价"） */}
              <div>
                <Typography.Text strong>历史价格参考</Typography.Text>
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  基于过去真实投放记录，按商单播放量接近度检索。仅展示历史事实，不代表推荐价格。
                </Typography.Text>
                <div style={{ marginTop: 8 }}>{renderPriceReference(priceRef, priceRefLoading)}</div>
              </div>

              <Divider style={{ margin: '12px 0' }} />

              {/* Phase 4B：人工决定（append-only；系统不推荐、不自动选择、AI 不参与） */}
              <div>
                <Space size={8} wrap align="baseline">
                  <Typography.Text strong>人工决定</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    由人显式选择，系统不推荐、不自动决定
                  </Typography.Text>
                </Space>
                <Space size={8} wrap style={{ display: 'flex', marginTop: 8 }}>
                  {CANDIDATE_REVIEW_OPTIONS.map((option) => (
                    <Button key={option.value} onClick={() => openDecision(option)}>
                      {option.label}
                    </Button>
                  ))}
                </Space>

                {decisionsLoading ? (
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                    加载决定历史…
                  </Typography.Text>
                ) : decisions.length === 0 ? (
                  <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                    还没有记录人工决定
                  </Typography.Text>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      最近一次人工决定
                    </Typography.Text>
                    <div>
                      <Typography.Text strong>
                        {decisions[0].human_decision_label || decisions[0].human_decision}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                        {String(decisions[0].created_at || '').slice(0, 16)}
                      </Typography.Text>
                    </div>
                    {decisions[0].decision_note && (
                      <Typography.Paragraph style={{ marginTop: 4, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                        备注：{decisions[0].decision_note}
                      </Typography.Paragraph>
                    )}
                    {decisions.length > 1 && (
                      <div style={{ marginTop: 6 }}>
                        <a style={{ fontSize: 12 }} onClick={() => setHistoryExpanded((value) => !value)}>
                          {historyExpanded ? '收起历史决定' : `查看历史决定（${decisions.length - 1}）`}
                        </a>
                        {historyExpanded && (
                          <List
                            size="small"
                            dataSource={decisions.slice(1)}
                            renderItem={(item) => (
                              <List.Item style={{ paddingLeft: 0, paddingRight: 0 }}>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {String(item.created_at || '').slice(0, 16)} ·{' '}
                                  {item.human_decision_label || item.human_decision}
                                  {item.decision_note ? ` · ${item.decision_note}` : ''}
                                </Typography.Text>
                              </List.Item>
                            )}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Phase 4D：报价阶段（继续联系后的自然 next step；同时保留直接记录入口，不制造流程死锁） */}
                <div style={{ marginTop: 12 }}>
                  <Space size={8} wrap align="center">
                    {reviewContactConfirmed ? (
                      <Button type="primary" ghost onClick={openPostQuote}>
                        记录当前报价
                      </Button>
                    ) : (
                      <Button onClick={openPostQuote}>已有报价，直接记录</Button>
                    )}
                    {!snapshot && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        需先录入近期表现
                      </Typography.Text>
                    )}
                  </Space>

                  {latestPostQuoteDecision && (
                    <div style={{ marginTop: 10 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        最近报价阶段
                      </Typography.Text>
                      <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 4 }}>
                        <Typography.Text>
                          当前报价：{formatPrice(latestPostQuoteDecision.current_quote) ?? '-'}
                          {latestPostQuoteDecision.pricing_evidence?.xingtu_price !== null &&
                          latestPostQuoteDecision.pricing_evidence?.xingtu_price !== undefined
                            ? ` · 星图刊例：${formatPrice(latestPostQuoteDecision.pricing_evidence.xingtu_price)}`
                            : ''}
                          {typeof latestPostQuoteDecision.pricing_evidence?.quote_to_xingtu_ratio === 'number'
                            ? ` · 当前报价约 ${(latestPostQuoteDecision.pricing_evidence.quote_to_xingtu_ratio * 10).toFixed(1)} 折`
                            : ''}
                        </Typography.Text>
                        {latestPostQuoteDecision.pricing_evidence?.playbook_estimate && (
                          <Typography.Text type="secondary">
                            Playbook 估价：
                            {renderEstimateRange({
                              low: latestPostQuoteDecision.pricing_evidence.playbook_estimate.estimate_low,
                              high: latestPostQuoteDecision.pricing_evidence.playbook_estimate.estimate_high
                            })}
                            {' · 报价位置：'}
                            {QUOTE_POSITION_LABELS[
                              latestPostQuoteDecision.pricing_evidence.current_quote_assessment?.position
                            ] || '-'}
                          </Typography.Text>
                        )}
                        <Typography.Text type="secondary">
                          人工决定：
                          {latestPostQuoteDecision.human_decision_label || latestPostQuoteDecision.human_decision} ·{' '}
                          {String(latestPostQuoteDecision.created_at || '').slice(0, 16)}
                        </Typography.Text>
                        {latestPostQuoteDecision.decision_note && (
                          <Typography.Text type="secondary">
                            备注：{latestPostQuoteDecision.decision_note}
                          </Typography.Text>
                        )}

                        {/* Phase 4F-B：谈价结果（只有「最新 post_quote = negotiate」才出现） */}
                        {latestPostQuoteNegotiating && !latestNegotiationCase && (
                          <Button size="small" onClick={() => setNegotiationOpen(true)}>
                            记录谈价结果
                          </Button>
                        )}
                        {latestPostQuoteNegotiating && latestNegotiationCase && (
                          <div style={{ marginTop: 6, borderTop: '1px dashed #f0f0f0', paddingTop: 6 }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              谈价结果
                            </Typography.Text>
                            <Typography.Text style={{ display: 'block' }}>
                              初始报价：{formatPrice(latestNegotiationCase.current_quote_snapshot) ?? '暂无'}
                            </Typography.Text>
                            <Typography.Text style={{ display: 'block' }}>
                              谈后价格：{formatPrice(latestNegotiationCase.negotiated_price) ?? '-'}
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ display: 'block' }}>
                              星图刊例：
                              {latestNegotiationCase.xingtu_price_snapshot === null ||
                              latestNegotiationCase.xingtu_price_snapshot === undefined
                                ? '暂无'
                                : `${formatPrice(latestNegotiationCase.xingtu_price_snapshot)} · 谈后价约为星图 ${
                                    latestNegotiationCase.outcome?.xingtu_discount_zhe ?? '-'
                                  }折 · 初始报价约为星图 ${
                                    latestNegotiationCase.outcome?.initial_quote_to_xingtu_ratio !== null &&
                                    latestNegotiationCase.outcome?.initial_quote_to_xingtu_ratio !== undefined
                                      ? (latestNegotiationCase.outcome.initial_quote_to_xingtu_ratio * 10).toFixed(1)
                                      : '-'
                                  }折`}
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ display: 'block' }}>
                              相对初始报价：
                              {latestNegotiationCase.outcome?.quote_change_rate === null ||
                              latestNegotiationCase.outcome?.quote_change_rate === undefined
                                ? '无法计算（初始报价为 0 / 暂无）'
                                : latestNegotiationCase.outcome.quote_change_rate < 0
                                  ? `下降 ${(Math.abs(latestNegotiationCase.outcome.quote_change_rate) * 100).toFixed(1)}%`
                                  : latestNegotiationCase.outcome.quote_change_rate > 0
                                    ? `上升 ${(latestNegotiationCase.outcome.quote_change_rate * 100).toFixed(1)}%`
                                    : '无变化'}
                            </Typography.Text>
                            {(latestNegotiationCase.reason_tag_labels || []).length > 0 && (
                              <Typography.Text type="secondary" style={{ display: 'block' }}>
                                原因：{latestNegotiationCase.reason_tag_labels.join(' · ')}
                              </Typography.Text>
                            )}
                            {latestNegotiationCase.reason_note && (
                              <Typography.Text type="secondary" style={{ display: 'block' }}>
                                补充说明：{latestNegotiationCase.reason_note}
                              </Typography.Text>
                            )}
                            {latestNegotiationCase.strategy_note && (
                              <Typography.Text type="secondary" style={{ display: 'block' }}>
                                谈价依据 / 过程：{latestNegotiationCase.strategy_note}
                              </Typography.Text>
                            )}
                            <Button
                              size="small"
                              style={{ marginTop: 6 }}
                              onClick={() => openPostQuote(String(latestNegotiationCase.negotiated_price))}
                            >
                              以谈后价继续判断
                            </Button>
                          </div>
                        )}
                      </Space>
                    </div>
                  )}
                </div>

                <Divider style={{ margin: '12px 0' }} />

                {/* Phase 4E：实际投放结果（只针对「最新 post_quote 且 eligible」的决策） */}
                <div>
                  <Typography.Text strong>实际投放结果</Typography.Text>
                  {!latestPostQuoteEligible ? (
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
                      尚未进入可关联实际投放结果的阶段。
                    </Typography.Text>
                  ) : currentOutcome ? (
                    <Space direction="vertical" size={2} style={{ display: 'flex', marginTop: 6 }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        已关联实际投放
                      </Typography.Text>
                      <Typography.Text>达人：{currentOutcome.creator || '-'}</Typography.Text>
                      <Typography.Text type="secondary">
                        发布日期：{currentOutcome.publish_date || '-'} · 实际合作成本：
                        {formatPrice(currentOutcome.total_cost) ?? '-'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        7日播放：{formatPlays(currentOutcome.first_play)} · 累计播放：
                        {formatPlays(currentOutcome.latest_play)} · 最终 CPM：
                        {currentOutcome.latest_cpm ?? '-'}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        关联时间：{String(currentOutcome.linked_at || '').slice(0, 16)}
                      </Typography.Text>
                      <Space size={6} wrap>
                        {currentOutcome.link_evidence?.identity?.override_used && (
                          <Tag>人工确认身份关联</Tag>
                        )}
                        {currentOutcome.link_evidence?.timing?.override_used && (
                          <Tag>人工确认发布时间关系</Tag>
                        )}
                      </Space>
                    </Space>
                  ) : (
                    <Space size={8} wrap align="center" style={{ marginTop: 6 }}>
                      <Typography.Text type="secondary">
                        当前投放决定：
                        {latestPostQuoteDecision.human_decision_label || latestPostQuoteDecision.human_decision}
                      </Typography.Text>
                      <Button type="primary" onClick={openOutcome}>
                        关联实际投放记录
                      </Button>
                    </Space>
                  )}
                </div>
              </div>
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
          <Form.Item name="xingtu_id" label="星图 ID（可选）">
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
          <Form.Item name="description" label="简短备注（可选）">
            <Input.TextArea placeholder="来源 / 判断线索等" maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 星图 ID 就地更新（轻量 Modal，只改 xingtu_id） */}
      <Modal
        title={editingCandidate?.xingtu_id ? '更新星图 ID' : '补充星图 ID'}
        open={xingtuEditOpen}
        onCancel={() => {
          setXingtuEditOpen(false)
          setEditingCandidate(null)
        }}
        afterOpenChange={(open) => {
          // 必须等 Modal 真正打开、Form 已挂载后再回填；否则 setFieldsValue 会被丢弃
          if (!open) return
          applyXingtuIdFormValues(xingtuForm, editingCandidate)
        }}
        onOk={handleSaveXingtu}
        confirmLoading={savingXingtu}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={xingtuForm} layout="vertical" preserve={false}>
          <Form.Item
            name="xingtu_id"
            label="星图 ID"
            extra="星图平台中的达人 ID / 业务查询标识；留空表示不填写"
          >
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑资料（复用同一 PATCH；不改 candidate_id / created_at / snapshot / AI整理） */}
      <Modal
        title="编辑资料"
        open={editOpen}
        onCancel={() => {
          setEditOpen(false)
          setEditingCandidate(null)
        }}
        afterOpenChange={(open) => {
          // 必须等 Modal 真正打开、Form 已挂载后再回填；否则 setFieldsValue 会被丢弃
          if (!open) return
          applyCandidateEditValues(editForm, editingCandidate)
        }}
        onOk={handleSaveEdit}
        confirmLoading={savingEdit}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="达人名称"
            rules={[{ required: true, message: '请填写达人名称' }]}
            extra="改名不影响 candidate_id；已保存的历史快照保留创建时的旧名称"
          >
            <Input placeholder="达人名称（允许重名）" maxLength={100} />
          </Form.Item>
          <Form.Item name="creator_type" label="达人类型（可选）">
            <Input placeholder="如 美妆 / 数码 / 生活" maxLength={50} />
          </Form.Item>
          <Form.Item name="profile_url" label="达人主页链接（可选）">
            <Input placeholder="https://..." maxLength={500} />
          </Form.Item>
          <Form.Item name="xingtu_id" label="星图 ID（可选）">
            <Input placeholder="星图 ID" maxLength={100} />
          </Form.Item>
          <Form.Item
            name="description"
            label="人工备注（可选）"
            extra="备注变化后，旧的 AI 整理结果会自动失效"
          >
            <Input.TextArea placeholder="来源 / 判断线索等" maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Phase 4B：人工决定确认（轻量 Modal；无默认选中，不推荐） */}
      <Modal
        title="记录人工决定"
        open={Boolean(pendingDecision)}
        onCancel={() => {
          setPendingDecision(null)
          setDecisionNote('')
        }}
        onOk={handleSaveDecision}
        confirmLoading={savingDecision}
        okText="记录决定"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={8} style={{ display: 'flex' }}>
          <div>
            <Typography.Text type="secondary">你选择：</Typography.Text>
            <Typography.Text strong>{pendingDecision?.label}</Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary">决策备注（可选）</Typography.Text>
            <Input.TextArea
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              maxLength={500}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="记录判断依据 / 后续动作"
            />
          </div>
        </Space>
      </Modal>

      {/* Phase 4D：报价阶段决策（无默认选中；不自动弹出） */}
      <Modal
        title="记录报价阶段决策"
        open={postQuoteOpen}
        onCancel={() => {
          setPostQuoteOpen(false)
          setPostQuoteAmount('')
          setPostQuoteDecision(null)
          setPostQuoteNote('')
        }}
        onOk={handleSavePostQuote}
        confirmLoading={savingPostQuote}
        okText="记录报价决策"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <div>
            <Typography.Text type="secondary">当前报价</Typography.Text>
            <Input
              value={postQuoteAmount}
              onChange={(event) => setPostQuoteAmount(event.target.value)}
              placeholder="如 ¥3000 / 3000元 / 3,000"
              maxLength={60}
            />
          </div>
          <div>
            <Typography.Text type="secondary">决策（请主动选择）</Typography.Text>
            <Space size={8} wrap style={{ display: 'flex', marginTop: 6 }}>
              {CANDIDATE_POST_QUOTE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  type={postQuoteDecision?.value === option.value ? 'primary' : 'default'}
                  onClick={() => setPostQuoteDecision(option)}
                >
                  {option.label}
                </Button>
              ))}
            </Space>
          </div>
          <div>
            <Typography.Text type="secondary">决策备注（可选）</Typography.Text>
            <Input.TextArea
              value={postQuoteNote}
              onChange={(event) => setPostQuoteNote(event.target.value)}
              maxLength={500}
              autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="记录报价来源 / 判断依据"
            />
          </div>
        </Space>
      </Modal>

      {/* Phase 4F-B：记录谈价结果（复用现有 NegotiationCaseModal，candidate 模式不展示 CPM30 体系） */}
      <NegotiationCaseModal
        open={negotiationOpen}
        decision={latestPostQuoteDecision}
        mode="candidate_playbook"
        onClose={() => setNegotiationOpen(false)}
        onSaved={() => loadDecisions(selectedId)}
      />

      {/* Phase 4E：选择真实投放记录（候选来自既有 outcome-candidates 接口） */}
      <Modal
        title="关联实际投放记录"
        open={outcomeOpen}
        onCancel={() => setOutcomeOpen(false)}
        onOk={handleLinkOutcome}
        confirmLoading={savingOutcome}
        okText="关联"
        cancelText="取消"
        okButtonProps={{ disabled: !selectedOutcomeCandidate }}
        destroyOnClose
        width={720}
      >
        {outcomeLoading ? (
          <Typography.Text type="secondary">加载可关联记录…</Typography.Text>
        ) : outcomeError ? (
          <Typography.Text type="danger">{outcomeError}</Typography.Text>
        ) : outcomeCandidates.length === 0 ? (
          <Space direction="vertical" size={8}>
            <Typography.Text type="secondary">
              暂未找到可关联的真实投放记录。请先在投放记录中录入或导入实际合作结果，再回来关联。
            </Typography.Text>
            <Button size="small" onClick={openOutcome}>
              刷新
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" size={10} style={{ display: 'flex' }}>
            <List
              size="small"
              dataSource={outcomeCandidates}
              renderItem={(item) => (
                <List.Item
                  style={{
                    cursor: 'pointer',
                    background: item.record_id === selectedOutcomeRecordId ? 'rgba(22,119,255,0.06)' : undefined,
                    borderRadius: 4,
                    paddingLeft: 8,
                    paddingRight: 8
                  }}
                  onClick={() => {
                    setSelectedOutcomeRecordId(item.record_id)
                    setOutcomeIdentityConfirmed(false)
                    setOutcomeTimingConfirmed(false)
                  }}
                >
                  <Space direction="vertical" size={2} style={{ display: 'flex' }}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{item.creator}</Typography.Text>
                      <Typography.Text type="secondary">{item.publish_date || '-'}</Typography.Text>
                      {item.already_linked && <Tag>已关联其他决策</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      实际合作 {formatPrice(item.total_cost) ?? '-'} · 7日播放 {formatPlays(item.first_play)} · 累计播放{' '}
                      {formatPlays(item.latest_play)} · 最终 CPM {item.latest_cpm ?? '-'}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />

            {selectedOutcomeCandidate?.requires_identity_confirmation && (
              <div style={{ padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                <Checkbox
                  checked={outcomeIdentityConfirmed}
                  onChange={(event) => setOutcomeIdentityConfirmed(event.target.checked)}
                >
                  我确认这条投放记录属于当前候选达人
                </Checkbox>
                {selectedOutcomeCandidate.identity_reason === 'ambiguous_name' ? (
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    存在多个同名候选达人，仅凭名称无法确认身份归属。
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    候选达人当前名称：{selected?.name || '-'}；投放记录名称：{selectedOutcomeCandidate.creator || '-'}
                  </Typography.Text>
                )}
              </div>
            )}

            {selectedOutcomeCandidate?.requires_timing_confirmation && (
              <div style={{ padding: 8, background: 'rgba(0,0,0,0.02)', borderRadius: 4 }}>
                <Checkbox
                  checked={outcomeTimingConfirmed}
                  onChange={(event) => setOutcomeTimingConfirmed(event.target.checked)}
                >
                  我确认该发布时间与当前决策的时间关系无误
                </Checkbox>
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  决策时间：{String(latestPostQuoteDecision?.created_at || '').slice(0, 16)}；投放发布日期：
                  {selectedOutcomeCandidate.publish_date || '-'}
                </Typography.Text>
              </div>
            )}
          </Space>
        )}
      </Modal>

      {/* D. 复用现有近期表现助手（候选模式：按 candidate_id 保存 / 读取） */}
      <RecentPerformanceAssistantModal
        open={assistantOpen}
        creator={selected?.name || null}
        candidateId={selected?.id ?? null}
        creatorOptions={selected ? [selected.name] : []}
        mode="update"
        onCancel={() => setAssistantOpen(false)}
        onSaved={() => {
          // 保存近期表现后同时刷新 snapshot 与历史价格参考
          loadSnapshot(selectedId)
          loadPriceReference(selectedId)
        }}
      />
    </div>
  )
}
