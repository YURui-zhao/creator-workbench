import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import { createHistoricalNegotiationCase } from '../api/creatorNegotiationCases'
import { harvestNegotiationExperience } from '../api/ai'
import { getErrorMessage } from '../utils/request'
import { calcCpm } from '../utils/calc'
import { formatCpm, formatMoney, formatPlays } from '../utils/format'
import { isValidDateOnly, todayLocalDateOnly } from '../utils/recentPerformanceSave.js'
import {
  NEGOTIATION_REASON_TAG_LABELS,
  NEGOTIATION_REASON_TAGS,
  formatChangePercent,
  formatQuoteChange
} from '../utils/negotiationCaseDisplay.js'

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const MAX_SOURCE_NOTE_LENGTH = 2000

function readOnlyRows(record) {
  const latest =
    record?.second_week_play === null || record?.second_week_play === undefined || record?.second_week_play === ''
      ? null
      : Number(record.second_week_play)
  const cpm =
    latest !== null && Number.isFinite(latest) && latest > 0 ? calcCpm(record?.total_cost, latest) : null
  return [
    { label: '达人', value: record?.nickname || '-' },
    { label: '发布日期', value: record?.publish_date || '-' },
    { label: '实际合作成本', value: formatMoney(record?.total_cost) },
    { label: '7日播放', value: formatPlays(record?.first_play) },
    { label: '累计播放', value: formatPlays(record?.second_week_play) },
    { label: 'final CPM', value: formatCpm(cpm) }
  ]
}

/**
 * Historical Negotiation Backfill V0.1
 *
 * 把「过去真实发生过、且已有真实 creator_record 的谈价案例」安全回填到 creator_negotiation_cases。
 *   · 只读展示真实投放结果（actual_cost 永远来自 creator_record）
 *   · 谈后价（negotiated_price）与实际成本永久分开，互不覆盖
 *   · source_note 是人工维护的原始备注，AI 只在用户显式点击后把它整理成**建议**，且绝不写库 / 不改 source_note
 *   · append-only：已补录的记录只读展示，V0.1 不提供编辑
 */
export default function HistoricalNegotiationCaseModal({
  open,
  record,
  existingCase = null,
  onClose,
  onSaved
}) {
  const [xingtuRaw, setXingtuRaw] = useState('')
  const [quoteRaw, setQuoteRaw] = useState('')
  const [priceRaw, setPriceRaw] = useState('')
  const [negotiatedAt, setNegotiatedAt] = useState(() => todayLocalDateOnly())
  const [sourceNote, setSourceNote] = useState('')
  const [reasonTags, setReasonTags] = useState([])
  const [reasonNote, setReasonNote] = useState('')
  const [strategyNote, setStrategyNote] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isReadOnly = Boolean(existingCase)

  useEffect(() => {
    if (!open) return
    setXingtuRaw('')
    setQuoteRaw('')
    setPriceRaw('')
    setNegotiatedAt(todayLocalDateOnly())
    setSourceNote('')
    setReasonTags([])
    setReasonNote('')
    setStrategyNote('')
    setAiSuggestion(null)
    setAiError('')
    setError('')
  }, [open, record?.id])

  const contextRows = useMemo(() => readOnlyRows(record), [record])
  const canSave =
    !isReadOnly && priceRaw.trim() !== '' && isValidDateOnly(negotiatedAt) && !saving && !aiLoading

  const handleHarvest = async () => {
    if (!sourceNote.trim()) {
      setAiError('请先填写历史谈价原始备注，再让 AI 整理')
      return
    }
    setAiLoading(true)
    setAiError('')
    try {
      // 只发送 source_note（数据最小化）；AI 输出仅作为建议，不写库
      const res = await harvestNegotiationExperience(sourceNote.trim())
      setAiSuggestion(res?.data || null)
    } catch (err) {
      setAiError(getErrorMessage(err, 'AI 整理失败，可继续人工填写并保存'))
    } finally {
      setAiLoading(false)
    }
  }

  const applySuggestion = () => {
    if (!aiSuggestion) return
    setReasonTags(aiSuggestion.reason_tags || [])
    setReasonNote(aiSuggestion.reason_note || '')
    setStrategyNote(aiSuggestion.strategy_note || '')
    setAiSuggestion(null)
    // AI 建议只是写入当前表单（尚未持久化）；历史谈价案例仍需用户显式保存
    message.success('已应用到表单，保存历史谈价案例后才会写入系统。')
  }

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      const res = await createHistoricalNegotiationCase({
        record_id: record.id,
        negotiated_price: priceRaw.trim(),
        negotiated_at: negotiatedAt,
        xingtu_price_snapshot: xingtuRaw.trim() || null,
        current_quote_snapshot: quoteRaw.trim() || null,
        source_note: sourceNote.trim() || null,
        reason_tags: reasonTags,
        reason_note: reasonNote ? reasonNote : null,
        strategy_note: strategyNote ? strategyNote : null
      })
      message.success('历史谈价案例已补录')
      onSaved?.(res?.data || null)
      onClose?.()
    } catch (err) {
      setError(getErrorMessage(err, '历史谈价案例保存失败，请稍后重试（输入内容已保留）'))
    } finally {
      setSaving(false)
    }
  }

  // ---------- 只读查看（已补录） ----------
  if (isReadOnly) {
    const outcome = existingCase.outcome || {}
    return (
      <Modal
        title={`历史谈价案例 · ${existingCase.creator || record?.nickname || ''}`}
        open={open}
        onCancel={onClose}
        footer={<Button onClick={onClose}>关闭</Button>}
        width={600}
      >
        <Space direction="vertical" size={10} style={{ display: 'flex' }}>
          <Alert
            type="info"
            showIcon
            message="该投放记录已补录历史谈价（append-only，只读）"
            description="历史谈价事实在提交时已冻结；实际合作成本仍以本投放记录为准。"
          />
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              {contextRows.map((row) => (
                <div key={row.label} style={rowStyle}>
                  <Typography.Text type="secondary">{row.label}</Typography.Text>
                  <Typography.Text>{row.value}</Typography.Text>
                </div>
              ))}
            </Space>
          </div>
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
            <Space direction="vertical" size={4} style={{ display: 'flex' }}>
              <div style={rowStyle}>
                <Typography.Text type="secondary">历史星图刊例</Typography.Text>
                <Typography.Text>{formatMoney(existingCase.xingtu_price_snapshot)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">历史初始报价</Typography.Text>
                <Typography.Text>{formatMoney(existingCase.current_quote_snapshot)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈后价格</Typography.Text>
                <Typography.Text strong>{formatMoney(existingCase.negotiated_price)}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">星图折扣</Typography.Text>
                <Typography.Text>
                  {outcome.xingtu_discount_zhe === null || outcome.xingtu_discount_zhe === undefined
                    ? '暂无'
                    : `${outcome.xingtu_discount_zhe} 折`}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">相对初始报价</Typography.Text>
                <Typography.Text>
                  {outcome.quote_drop_computable
                    ? `${outcome.quote_drop_direction === 'increase' ? '上升' : outcome.quote_drop_direction === 'flat' ? '持平' : '下降'} ${formatChangePercent(outcome.quote_change_rate)}`
                    : '暂无'}
                </Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">谈价日期</Typography.Text>
                <Typography.Text>{existingCase.negotiated_at || '-'}</Typography.Text>
              </div>
              <div style={rowStyle}>
                <Typography.Text type="secondary">录入时间</Typography.Text>
                <Typography.Text>{existingCase.created_at || '-'}</Typography.Text>
              </div>
            </Space>
          </div>
          {(existingCase.reason_tags || []).length > 0 && (
            <div>
              <Typography.Text type="secondary">谈价原因 / 背景</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Space wrap size={4}>
                  {existingCase.reason_tags.map((tag) => (
                    <Tag key={tag}>{NEGOTIATION_REASON_TAG_LABELS[tag] || tag}</Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
          {existingCase.source_note && (
            <div>
              <Typography.Text type="secondary">历史谈价原始备注</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.source_note}
              </Typography.Paragraph>
            </div>
          )}
          {existingCase.reason_note && (
            <div>
              <Typography.Text type="secondary">补充说明</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.reason_note}
              </Typography.Paragraph>
            </div>
          )}
          {existingCase.strategy_note && (
            <div>
              <Typography.Text type="secondary">谈价依据 / 过程</Typography.Text>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {existingCase.strategy_note}
              </Typography.Paragraph>
            </div>
          )}
        </Space>
      </Modal>
    )
  }

  // ---------- 新增补录 ----------
  return (
    <Modal
      title={`补录历史谈价 · ${record?.nickname || ''}`}
      open={open}
      onCancel={onClose}
      destroyOnClose
      width={640}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!canSave} loading={saving} onClick={handleSave}>
            保存历史谈价案例
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={10} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          仅用于补录「过去真实发生过、且已有真实投放记录」的谈价案例。不会创建决策 / 结果记录，也不改写投放数据。
        </Typography.Text>

        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            真实投放结果（只读，来自投放记录）
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
            {contextRows.map((row) => (
              <div key={row.label} style={rowStyle}>
                <Typography.Text type="secondary">{row.label}</Typography.Text>
                <Typography.Text>{row.value}</Typography.Text>
              </div>
            ))}
          </Space>
        </div>

        <div>
          <Typography.Text type="secondary">历史星图刊例（可选）</Typography.Text>
          <Input
            value={xingtuRaw}
            placeholder="例如 ¥3,000 / 3000"
            style={{ width: 220 }}
            onChange={(event) => setXingtuRaw(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">历史初始报价（可选）</Typography.Text>
          <Input
            value={quoteRaw}
            placeholder="例如 ¥5,000 / 5000"
            style={{ width: 220 }}
            onChange={(event) => setQuoteRaw(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">谈后价格（必填）</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              value={priceRaw}
              placeholder="例如 ¥4,500 / 4500"
              style={{ width: 220 }}
              onChange={(event) => setPriceRaw(event.target.value)}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              与实际合作成本分开记录（不会互相覆盖）
            </Typography.Text>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">谈价日期（必填）</Typography.Text>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <DatePicker
              value={negotiatedAt ? dayjs(negotiatedAt) : null}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 180 }}
              onChange={(value) => setNegotiatedAt(value ? value.format('YYYY-MM-DD') : '')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当时真实谈价 / 确认成交的日期（系统录入时间单独记录）
            </Typography.Text>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">历史谈价原始备注（可选）</Typography.Text>
          <Input.TextArea
            value={sourceNote}
            rows={4}
            maxLength={MAX_SOURCE_NOTE_LENGTH}
            showCount
            placeholder="可粘贴当时的聊天摘要 / 备注 / 有证据的回忆，例如：达人最开始报价5000，我先没有急着回复，后面以预算有限+后续合作预期继续谈，最后口头确认4500。"
            onChange={(event) => setSourceNote(event.target.value)}
          />
          <div style={{ marginTop: 6 }}>
            <Button size="small" loading={aiLoading} disabled={isReadOnly} onClick={handleHarvest}>
              AI整理谈价经验
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              可选；只发送这段原始备注，结果仅作建议，需你确认后才填入
            </Typography.Text>
          </div>
          {aiError && (
            <Alert type="warning" showIcon style={{ marginTop: 6 }} message={aiError} />
          )}
          {aiSuggestion && (
            <div
              style={{ marginTop: 8, border: '1px solid #f0f0f0', borderRadius: 8, padding: 10 }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI整理建议（尚未保存）
              </Typography.Text>
              <Space direction="vertical" size={4} style={{ display: 'flex', marginTop: 6 }}>
                <div style={rowStyle}>
                  <Typography.Text type="secondary">建议原因标签</Typography.Text>
                  <Typography.Text>
                    {(aiSuggestion.reason_tags || []).length
                      ? aiSuggestion.reason_tags
                          .map((tag) => NEGOTIATION_REASON_TAG_LABELS[tag] || tag)
                          .join('、')
                      : '无'}
                  </Typography.Text>
                </div>
                <div style={rowStyle}>
                  <Typography.Text type="secondary">建议补充说明</Typography.Text>
                  <Typography.Text>{aiSuggestion.reason_note || '无'}</Typography.Text>
                </div>
                <div style={rowStyle}>
                  <Typography.Text type="secondary">建议谈价依据 / 过程</Typography.Text>
                  <Typography.Text>{aiSuggestion.strategy_note || '无'}</Typography.Text>
                </div>
              </Space>
              <Space style={{ marginTop: 8 }}>
                <Button size="small" type="primary" onClick={applySuggestion}>
                  应用到表单
                </Button>
                <Button size="small" onClick={() => setAiSuggestion(null)}>
                  放弃
                </Button>
              </Space>
              <Typography.Text
                type="secondary"
                style={{ display: 'block', fontSize: 12, marginTop: 8 }}
              >
                应用到表单不会写入系统；保存历史谈价案例后才会持久化。
              </Typography.Text>
            </div>
          )}
        </div>

        <div>
          <Typography.Text type="secondary">谈价原因 / 背景（可选，可多选）</Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Checkbox.Group value={reasonTags} onChange={(values) => setReasonTags(values)}>
              <Space direction="vertical" size={4}>
                {NEGOTIATION_REASON_TAGS.map((tag) => (
                  <Checkbox key={tag.value} value={tag.value}>
                    {tag.label}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </div>
        </div>

        <div>
          <Typography.Text type="secondary">补充说明（可选）</Typography.Text>
          <Input.TextArea
            value={reasonNote}
            rows={2}
            maxLength={500}
            onChange={(event) => setReasonNote(event.target.value)}
          />
        </div>

        <div>
          <Typography.Text type="secondary">谈价依据 / 过程（可选）</Typography.Text>
          <Input.TextArea
            value={strategyNote}
            rows={2}
            maxLength={500}
            onChange={(event) => setStrategyNote(event.target.value)}
          />
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        <Divider style={{ margin: '2px 0' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只记录真实发生过的谈价事实；实际合作成本仍以投放记录为准（两者不会互相覆盖）。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
