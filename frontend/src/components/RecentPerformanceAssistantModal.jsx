import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message
} from 'antd'
import dayjs from 'dayjs'
import {
  DeleteOutlined,
  FileImageOutlined,
  InboxOutlined,
  ReloadOutlined,
  SendOutlined
} from '@ant-design/icons'
import { extractCreatorScreenshot, getAiStatus } from '../api/ai'
import { saveRecentSnapshot } from '../api/recentSnapshots'
import { getAiConfig } from '../utils/aiConfig.js'
import { getErrorMessage } from '../utils/request'
import { formatInteger, formatPlays } from '../utils/format'
import {
  buildSnapshotPayload,
  canSaveSnapshot,
  formatPlayRange,
  formatTrendRatio,
  isValidDateOnly,
  needsIdentityConfirmation,
  todayLocalDateOnly,
  TREND_LABELS_FULL
} from '../utils/recentPerformanceSave.js'
import { buildPricingRows } from '../utils/pricingDisplay.js'
import {
  IMAGE_ACCEPT_ATTR,
  MAX_IMAGE_BYTES,
  MAX_SCREENSHOT_COUNT,
  formatBytes,
  prepareImageFile,
  releasePreview,
  validateSelection,
  validateTotalBytes
} from '../utils/screenshotImage.js'
import {
  buildConfirmedDraft,
  buildDraftFromExtraction,
  summarizeDraft,
  togglePlayExcluded,
  updateCreatorName,
  updatePlayRawText,
  updatePriceRawText
} from '../utils/recentPerformanceDraft.js'

const SEND_NOTICE =
  '将向当前配置的 AI 服务发送所选截图，用于识别：达人昵称、星图刊例价、作品播放量。原图不会作为业务记录长期保存。'
const ORDER_NOTICE =
  '请确认作品顺序是否为从新到旧；如截图包含置顶或重复作品，可排除对应项。'
const SAVE_NOTICE = '将保存结构化播放数据与统计结果，不保存原截图。'

/**
 * 近期表现助手（V3-alpha P2A）
 * - 选择 / 拖拽 / 粘贴截图后只在本地预览，绝不自动上传
 * - 只有用户显式点击「开始 AI 识别」才会向 AI 发送截图
 * - AI 只返回可见事实；数值由确定性解析器换算，用户可逐条修改 / 排除
 * - 确认识别结果只在生成前端草稿，P2A 不写数据库、不估值、不给复投建议
 */
export default function RecentPerformanceAssistantModal({
  open,
  onCancel,
  onConfirmed,
  onSaved,
  creator = null,
  creatorOptions = []
}) {
  const [images, setImages] = useState([])
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [draft, setDraft] = useState(null)
  const [confirmed, setConfirmed] = useState(null)
  // P2B：快照必须绑定到用户点击的雷达达人（header 入口需先选择达人）
  const [boundCreator, setBoundCreator] = useState('')
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  // Alpha.2：数据观察日期（默认浏览器本地今天；用户可改为截图实际观察的那天）
  const [observedAt, setObservedAt] = useState(() => todayLocalDateOnly())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState(null)
  const [aiStatus, setAiStatus] = useState({ checked: false, available: false, visionModel: null, visionAvailable: false, providerLabel: '' })
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  // 并发保护：识别进行中禁止重复点击（同一次请求不会被叠加）
  const aiInFlightRef = useRef(false)

  // 打开时绑定达人：由行内入口传入；header 入口为空，需要用户显式选择
  useEffect(() => {
    if (!open) return
    setBoundCreator(String(creator ?? '').trim())
    setIdentityConfirmed(false)
    setObservedAt(todayLocalDateOnly())
    setSaveError('')
    setSavedSnapshot(null)
  }, [open, creator])

  // 打开时读取 AI 状态（只查后端环境变量与固定 vision 模型，不发送 Key/图片）
  useEffect(() => {
    if (!open) return
    let active = true
    getAiStatus()
      .then((res) => {
        if (!active) return
        setAiStatus({
          checked: true,
          available: Boolean(res?.data?.available),
          providerLabel: res?.data?.providerLabel || '',
          visionModel: res?.data?.visionModel || null,
          visionAvailable: Boolean(res?.data?.visionAvailable)
        })
      })
      .catch(() => {
        if (active) {
          setAiStatus({ checked: true, available: false, providerLabel: '', visionModel: null, visionAvailable: false })
        }
      })
    return () => {
      active = false
    }
  }, [open])

  const resetAll = useCallback(() => {
    setImages((list) => {
      list.forEach(releasePreview)
      return []
    })
    setPreparing(false)
    setPrepareError('')
    setAiError('')
    setAiLoading(false)
    setDraft(null)
    setConfirmed(null)
    setIdentityConfirmed(false)
    setSaveError('')
    setSavedSnapshot(null)
    aiInFlightRef.current = false
  }, [])

  const handleClose = () => {
    if (aiLoading) return
    resetAll()
    onCancel?.()
  }

  const totalBytes = useMemo(
    () => images.reduce((sum, image) => sum + (image.bytes || 0), 0),
    [images]
  )

  // 添加图片：只做本地校验 + 本地压缩 + 预览；绝不触发 AI
  const addFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || [])
      if (!files.length) return
      setPrepareError('')
      let currentCount = 0
      setImages((list) => {
        currentCount = list.length
        return list
      })
      const countCheck = validateSelection(files.length, currentCount)
      if (!countCheck.ok) {
        setPrepareError(countCheck.reason)
        return
      }

      setPreparing(true)
      const accepted = []
      let failure = ''
      for (const file of files) {
        const result = await prepareImageFile(file)
        if (!result.ok) {
          failure = result.reason
          break
        }
        if (result.image.oversize) {
          releasePreview(result.image)
          failure = `${file.name || '图片'} 压缩后仍超过 ${formatBytes(MAX_IMAGE_BYTES)}，请先裁剪或降低分辨率`
          break
        }
        accepted.push(result.image)
      }
      setPreparing(false)

      if (failure) {
        accepted.forEach(releasePreview)
        setPrepareError(failure)
        return
      }
      setImages((list) => {
        const next = [...list, ...accepted]
        const totalCheck = validateTotalBytes(next.reduce((sum, image) => sum + (image.bytes || 0), 0))
        if (!totalCheck.ok) {
          setPrepareError(totalCheck.reason)
          accepted.forEach(releasePreview)
          return list
        }
        return next
      })
      // 图片变化后，之前的识别结果不再对应当前截图
      setDraft(null)
      setConfirmed(null)
      setIdentityConfirmed(false)
      setSavedSnapshot(null)
      setAiError('')
    },
    []
  )

  // 粘贴截图（Ctrl/Cmd + V）：仍然只在本地预览
  useEffect(() => {
    if (!open) return undefined
    const handlePaste = (event) => {
      const items = event.clipboardData?.items
      if (!items) return
      const files = []
      for (const item of items) {
        if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (files.length) {
        event.preventDefault()
        addFiles(files)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [open, addFiles])

  const removeImage = (image) => {
    releasePreview(image)
    setImages((list) => list.filter((item) => item.id !== image.id))
    setDraft(null)
    setConfirmed(null)
    setIdentityConfirmed(false)
    setSavedSnapshot(null)
    setAiError('')
  }

  const sessionKeyReady = Boolean(getAiConfig()?.apiKey)
  const canStart = images.length > 0 && !preparing && !aiLoading

  // 唯一的 AI 触发点：必须由用户显式点击
  const handleStartRecognition = async () => {
    if (aiInFlightRef.current || aiLoading) return
    if (!images.length) {
      message.warning('请先选择或粘贴 1~3 张截图')
      return
    }
    if (!sessionKeyReady && !aiStatus.available) {
      setAiError('未检测到可用的 AI 配置：请先在右上角「AI配置」中填写 DeepSeek API Key（或由后端环境变量提供）后再识别。')
      return
    }
    if (!aiStatus.visionAvailable) {
      setAiError('当前 AI 服务商暂未开放图片识别（P2A 仅支持 DeepSeek Vision），请在右上角「AI配置」中切换到 DeepSeek。')
      return
    }

    aiInFlightRef.current = true
    setAiLoading(true)
    setAiError('')
    setConfirmed(null)
    try {
      const res = await extractCreatorScreenshot(images.map((image) => ({ mime: image.mime, base64: image.base64 })))
      setDraft(buildDraftFromExtraction(res?.data || {}))
      setConfirmed(null)
      setIdentityConfirmed(false)
      setSavedSnapshot(null)
    } catch (error) {
      // 识别失败：保留已选截图与人工修改，只提示失败原因
      setAiError(getErrorMessage(error, 'AI 识别失败，请重试（截图与已修改内容均已保留）'))
    } finally {
      aiInFlightRef.current = false
      setAiLoading(false)
    }
  }

  const handleConfirm = () => {
    if (!draft) return
    const result = buildConfirmedDraft(draft)
    setConfirmed(result)
    onConfirmed?.(result)
    message.success('已确认识别结果（P2A 暂不写入数据库）')
  }

  // P2B：显式保存（不静默写库）；失败保留 confirmed draft 与全部人工修改
  const handleSave = async () => {
    if (saving) return
    if (!confirmed) {
      message.warning('请先点击「确认识别结果」，再保存近期表现')
      return
    }
    if (!boundCreator) {
      message.warning('请先选择本次快照所属的达人')
      return
    }
    if (identityNeedsConfirm && !identityConfirmed) {
      message.warning('截图昵称与当前达人不一致，请勾选确认后再保存')
      return
    }
    if (!isValidDateOnly(observedAt)) {
      message.warning('请先填写数据观察日期（这批播放量和刊例价是哪天看到的）')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const res = await saveRecentSnapshot(
        buildSnapshotPayload(draft, {
          creator: boundCreator,
          identityConfirmed,
          observedAt
        })
      )
      setSavedSnapshot(res?.data || null)
      onSaved?.(res?.data || null)
      message.success('近期表现已保存为快照')
    } catch (error) {
      // 后端统一返回中文 msg；网络层失败（超时 / 502 等）不回显 axios 原始英文错误
      const backendMessage = error?.response?.data?.msg || error?.response?.data?.message
      setSaveError(backendMessage || '保存失败，识别结果与人工修改均已保留，可重试')
    } finally {
      setSaving(false)
    }
  }

  const summary = draft ? summarizeDraft(draft) : null
  const recognizedName = draft?.creator_name || ''
  const identityNeedsConfirm = needsIdentityConfirmation(boundCreator, recognizedName)
  const canSave = canSaveSnapshot({
    confirmed: Boolean(confirmed),
    creator: boundCreator,
    identityNeedsConfirm,
    identityConfirmed,
    saving,
    savedSnapshot
  }) && isValidDateOnly(observedAt)

  /**
   * 草稿的任何人工修改都会让「确认识别结果」与「已保存」状态失效：
   * 这样「确认识别结果 → 保存近期表现」始终对应同一份内容，
   * 也避免同一份草稿被重复保存成多条快照。
   */
  const applyDraftChange = (nextDraft) => {
    setDraft(nextDraft)
    setConfirmed(null)
    setSavedSnapshot(null)
    setSaveError('')
  }

  return (
    <Modal
      title="近期表现助手"
      open={open}
      onCancel={handleClose}
      width={860}
      maskClosable={!aiLoading}
      footer={null}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          粘贴 / 上传达人主页或星图截图，AI 只负责识别截图上的可见信息（昵称、星图刊例价、作品播放量），
          数值换算与判断由系统确定性地完成，识别结果必须经你确认；在你点击「保存近期表现」之前不会写入数据库。
        </Typography.Text>

        <Alert type="info" showIcon message="发送范围" description={SEND_NOTICE} />

        {/* Alpha.2：数据观察日期（这批播放量 / 星图价是哪天看到的），与「何时保存进系统」分开 */}
        <div>
          <Typography.Text type="secondary">数据观察日期</Typography.Text>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <DatePicker
              value={observedAt ? dayjs(observedAt) : null}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: 180 }}
              placeholder="请选择观察日期"
              onChange={(value) => setObservedAt(value ? value.format('YYYY-MM-DD') : '')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              这批播放量和刊例价是哪天看到的（默认今天，可改为实际观察的那天）
            </Typography.Text>
          </div>
        </div>

        {/* 上传区：点击 / 拖拽 / 粘贴 */}
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            addFiles(event.dataTransfer?.files)
          }}
          style={{
            border: `1px dashed ${dragging ? '#1677ff' : '#d9d9d9'}`,
            background: dragging ? '#f0f7ff' : '#fafafa',
            borderRadius: 8,
            padding: '18px 16px',
            textAlign: 'center',
            cursor: 'pointer'
          }}
          onClick={() => inputRef.current?.click()}
        >
          <p style={{ margin: 0, fontSize: 22 }}>
            <InboxOutlined />
          </p>
          <p style={{ margin: '6px 0 0' }}>点击选择图片，或拖拽图片到此处，也可直接 Ctrl / Cmd + V 粘贴截图</p>
          <Typography.Text type="secondary">
            仅支持 png / jpg / jpeg / webp，最多 {MAX_SCREENSHOT_COUNT} 张；单张处理后 ≤ 1.5MB，总发送体积 ≤ 3.2MB，
            长边自动缩放到 2000px 以内（只缩小不放大）
          </Typography.Text>
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_ACCEPT_ATTR}
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>

        <Typography.Text type="secondary">
          上传后不会自动发送，需点击下方的「开始 AI 识别」才会向 AI 发送截图。
        </Typography.Text>

        {prepareError && <Alert type="error" showIcon message={prepareError} />}

        {preparing && <Spin size="small" tip="正在本地压缩图片..." />}

        {images.length > 0 && (
          <div>
            <Space size={8} wrap>
              <Typography.Text strong>已选择 {images.length} 张截图</Typography.Text>
              <Typography.Text type="secondary">合计 {formatBytes(totalBytes)}</Typography.Text>
            </Space>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              {images.map((image, index) => (
                <div
                  key={image.id}
                  style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 8, width: 180 }}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 6, background: '#fafafa' }}
                  />
                  <div style={{ marginTop: 6, fontSize: 12 }} title={image.name}>
                    <FileImageOutlined /> 图 {index + 1} · {formatBytes(image.bytes)}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
                    {image.width}×{image.height}
                  </div>
                  <Button
                    size="small"
                    type="link"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={aiLoading}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeImage(image)
                    }}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <Space size={12} wrap>
          <Tooltip
            title={
              aiStatus.visionAvailable
                ? '图片识别模型由系统固定，不可编辑'
                : '当前服务商暂未开放图片识别，请切换到 DeepSeek'
            }
          >
            <Tag color={aiStatus.visionAvailable ? 'blue' : 'default'}>
              图片识别模型：{aiStatus.visionModel || '未配置'}
            </Tag>
          </Tooltip>
          <Typography.Text type="secondary">
            {sessionKeyReady ? '已使用当前会话的 AI Key' : aiStatus.available ? '使用后端环境变量中的 AI Key' : '尚未配置 AI Key'}
          </Typography.Text>
        </Space>

        {!sessionKeyReady && !aiStatus.available && aiStatus.checked && (
          <Alert
            type="warning"
            showIcon
            message="未检测到可用的 AI 配置"
            description="请先在右上角「AI配置」中填写 DeepSeek API Key（或由后端环境变量提供）后再识别；系统不会自动调用 AI，也不会生成假的识别结果。"
          />
        )}

        <Space size={12} wrap>
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canStart}
            loading={aiLoading}
            onClick={handleStartRecognition}
          >
            开始 AI 识别
          </Button>
          {aiError && (
            <Button
              icon={<ReloadOutlined />}
              disabled={!canStart}
              onClick={handleStartRecognition}
            >
              重新识别
            </Button>
          )}
          {images.length > 0 && (
            <Button disabled={aiLoading} onClick={resetAll}>
              清空重来
            </Button>
          )}
        </Space>

        {aiError && <Alert type="error" showIcon message={aiError} description="已保留当前截图与人工修改内容，可直接重试。" />}

        {draft && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Title level={5} style={{ margin: 0 }}>
              人工确认识别结果
            </Typography.Title>
            <Typography.Text type="secondary">
              识别到 {summary.identified_count} 条作品（AI 识别到多少就展示多少，不会自动补足 15 条）；数值可修改，
              无法确定性解析的条目请人工确认。{ORDER_NOTICE}
            </Typography.Text>

            {/* P2B：快照归属由用户点击的雷达达人决定，AI 识别昵称只作为 evidence */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <Typography.Text type="secondary">本次快照所属达人（雷达达人）</Typography.Text>
                <div>
                  {creator ? (
                    <Typography.Text strong>{creator}</Typography.Text>
                  ) : (
                    <Select
                      value={boundCreator || undefined}
                      placeholder="请选择本次快照所属达人"
                      style={{ width: 220 }}
                      showSearch
                      optionFilterProp="label"
                      onChange={(value) => {
                        setBoundCreator(value)
                        setIdentityConfirmed(false)
                      }}
                      options={creatorOptions.map((name) => ({ value: name, label: name }))}
                    />
                  )}
                </div>
              </div>
              {identityNeedsConfirm && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ flex: '1 1 320px' }}
                  message={`截图昵称「${recognizedName}」与当前达人「${boundCreator || '未选择'}」不一致，请确认是否上传了正确截图。`}
                  description={
                    <Checkbox
                      checked={identityConfirmed}
                      onChange={(event) => setIdentityConfirmed(event.target.checked)}
                    >
                      {`我确认本次快照保存到「${boundCreator || '未选择'}」`}
                    </Checkbox>
                  }
                />
              )}
            </div>

            {draft.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="AI 提示"
                description={draft.warnings.map((item) => (
                  <div key={item}>{item}</div>
                ))}
              />
            )}

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <Typography.Text type="secondary">达人昵称</Typography.Text>
                <Input
                  value={draft.creator_name}
                  placeholder="请核对达人昵称"
                  style={{ width: 220 }}
                  onChange={(event) => applyDraftChange(updateCreatorName(draft, event.target.value))}
                />
              </div>
              <div>
                <Typography.Text type="secondary">星图刊例价（可修改原文，系统自动换算）</Typography.Text>
                <div>
                  <Input
                    value={draft.xingtu_price_raw}
                    placeholder="例如 ¥3,000"
                    style={{ width: 180 }}
                    onChange={(event) => applyDraftChange(updatePriceRawText(draft, event.target.value))}
                  />
                  <Typography.Text strong style={{ marginLeft: 8 }}>
                    {draft.xingtu_price === null ? '需人工确认' : `¥${formatInteger(draft.xingtu_price)}`}
                  </Typography.Text>
                  {draft.xingtu_price_needs_review && (
                    <Tooltip title={draft.xingtu_price_reason || '无法确定性解析'}>
                      <Tag color="warning" style={{ marginLeft: 8 }}>
                        需人工确认
                      </Tag>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>

            <div>
              <Space size={8} wrap>
                <Typography.Text strong>作品播放量</Typography.Text>
                <Typography.Text type="secondary">
                  编号 = 上传图片顺序 + 图片内从上到下顺序；修改原文后会立即重新换算
                </Typography.Text>
              </Space>
              <div style={{ marginTop: 8 }}>
                {draft.plays.length === 0 ? (
                  <Empty description="本次没有识别到作品播放量（系统不会自动补足，可重新识别或手工填写）" />
                ) : (
                  draft.plays.map((play, index) => (
                    <div
                      key={play.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        padding: '6px 0',
                        borderBottom: '1px solid #f5f5f5',
                        opacity: play.excluded ? 0.55 : 1
                      }}
                    >
                      <Typography.Text type="secondary" style={{ width: 24 }}>
                        {String(index + 1).padStart(2, '0')}
                      </Typography.Text>
                      <Input
                        size="small"
                        value={play.raw_text ?? ''}
                        placeholder="截图原文"
                        style={{ width: 120 }}
                        onChange={(event) => applyDraftChange(updatePlayRawText(draft, play.id, event.target.value))}
                      />
                      <Typography.Text type="secondary">→</Typography.Text>
                      <Typography.Text
                        strong
                        style={{ minWidth: 92, textDecoration: play.excluded ? 'line-through' : 'none' }}
                      >
                        {play.normalized_play === null ? '需人工确认' : formatInteger(play.normalized_play)}
                      </Typography.Text>
                      <Tag>{`图 ${play.source_image_index ?? '?'} · 第 ${play.position_index} 条`}</Tag>
                      {play.needs_review && (
                        <Tooltip title={play.reason || '无法确定性解析'}>
                          <Tag color="warning">需人工确认</Tag>
                        </Tooltip>
                      )}
                      {play.excluded && <Tag color="default">已排除</Tag>}
                      <Button
                        size="small"
                        type="link"
                        onClick={() => applyDraftChange(togglePlayExcluded(draft, play.id))}
                      >
                        {play.excluded ? '恢复该条' : '排除该条'}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <Space size={16} wrap>
                <Typography.Text>识别作品：{summary.identified_count}</Typography.Text>
                <Typography.Text>有效作品：{summary.valid_count}</Typography.Text>
                <Typography.Text>排除：{summary.excluded_count}</Typography.Text>
                {summary.unresolved_count > 0 && (
                  <Tooltip title="未排除但无法确定性解析的条目，不计入有效样本（后端会存为 unresolved）">
                    <Typography.Text type="warning">
                      待人工确认：{summary.unresolved_count}
                    </Typography.Text>
                  </Tooltip>
                )}
                <Typography.Text>
                  星图价：{summary.xingtu_price === null ? '需人工确认' : `¥${formatInteger(summary.xingtu_price)}`}
                </Typography.Text>
              </Space>
              <Button type="primary" disabled={aiLoading} onClick={handleConfirm}>
                确认识别结果
              </Button>
            </div>

            {confirmed && (
              <Alert
                type="success"
                showIcon
                message="已生成确认草稿"
                description="确认只是形成草稿，尚未写入数据库；点击下方「保存近期表现」才会写入快照。不计算目标价、不做折扣与复投建议。"
              />
            )}

            {/* P2B：显式保存动作（与「确认识别结果」分开，不做静默写库） */}
            <Divider style={{ margin: '4px 0' }} />
            <Space direction="vertical" size={8} style={{ display: 'flex' }}>
              <Typography.Text type="secondary">{SAVE_NOTICE}</Typography.Text>
              <Space size={12} wrap>
                <Tooltip title={confirmed ? '' : '请先点击上方「确认识别结果」'}>
                  <Button type="primary" loading={saving} disabled={!canSave} onClick={handleSave}>
                    保存近期表现
                  </Button>
                </Tooltip>
                <Typography.Text type="secondary">
                  保存后可在复投雷达对应达人处看到最新快照（append-only，不会覆盖历史快照）
                </Typography.Text>
              </Space>

              {saveError && (
                <Alert
                  type="error"
                  showIcon
                  message={saveError}
                  description="识别结果与人工修改均已保留，可直接重试。"
                />
              )}

              {savedSnapshot && (
                <Alert
                  type="success"
                  showIcon
                  message={`已保存快照 #${savedSnapshot.id}（保存于 ${savedSnapshot.created_at || ''}）`}
                  description={
                    <Space direction="vertical" size={2}>
                      <Typography.Text>
                        数据观察日期：{savedSnapshot.observed_at || '观察日期未知'}
                      </Typography.Text>
                      <Typography.Text>
                        有效样本：{formatInteger(savedSnapshot.valid_count)}
                        {savedSnapshot.excluded_count > 0 ? `，排除 ${formatInteger(savedSnapshot.excluded_count)}` : ''}
                        {savedSnapshot.unresolved_count > 0 ? `，待人工确认 ${formatInteger(savedSnapshot.unresolved_count)}` : ''}
                      </Typography.Text>
                      {savedSnapshot.stats_status === 'ok' ? (
                        <>
                          <Typography.Text>
                            中位播放：{formatPlays(savedSnapshot.median_play)}　典型区间（P25–P75）：
                            {formatPlayRange(savedSnapshot.p25_play, savedSnapshot.p75_play)}
                          </Typography.Text>
                          <Typography.Text>
                            趋势：{TREND_LABELS_FULL[savedSnapshot.trend_label] || '样本不足'}
                            {formatTrendRatio(savedSnapshot.trend_ratio)
                              ? `（${formatTrendRatio(savedSnapshot.trend_ratio)}）`
                              : ''}
                          </Typography.Text>
                        </>
                      ) : (
                        <Typography.Text>样本不足：本次不展示中位播放与典型区间，建议补充更多近期作品截图。</Typography.Text>
                      )}
                      <Typography.Text>
                        星图价：{savedSnapshot.xingtu_price === null || savedSnapshot.xingtu_price === undefined ? '待确认 / 未识别' : `¥${formatInteger(savedSnapshot.xingtu_price)}`}
                      </Typography.Text>
                      <Typography.Text type="secondary">统计口径：{savedSnapshot.stats_version}</Typography.Text>
                      <Divider style={{ margin: '6px 0' }} />
                      <Typography.Text strong>
                        CPM30 价格核算
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                          按近期中位播放 / 典型区间（P25–P75）换算，仅价格参考
                        </Typography.Text>
                      </Typography.Text>
                      {buildPricingRows(savedSnapshot.pricing).map((row) => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <Typography.Text type="secondary">{row.label}</Typography.Text>
                          <Typography.Text>{row.value}</Typography.Text>
                        </div>
                      ))}
                      <Typography.Text>
                        价格状态：{savedSnapshot.pricing?.pricing_status_label || '-'}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        价格规则版本：{savedSnapshot.pricing?.pricing_version || '-'}
                      </Typography.Text>
                    </Space>
                  }
                />
              )}
            </Space>
          </>
        )}

        <Divider style={{ margin: '4px 0' }} />
        <div style={{ textAlign: 'right' }}>
          <Button onClick={handleClose} disabled={aiLoading}>
            关闭
          </Button>
        </div>
      </Space>
    </Modal>
  )
}
