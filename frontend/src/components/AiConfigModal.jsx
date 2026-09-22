import { useEffect } from 'react'
import { Form, Input, Modal, Select, Typography, message } from 'antd'
import {
  AI_PROVIDERS,
  DEFAULT_PROVIDER,
  getAiConfig,
  getProviderPreset,
  saveAiConfig
} from '../utils/aiConfig.js'

const PROVIDER_OPTIONS = Object.values(AI_PROVIDERS).map((item) => ({
  value: item.value,
  label: item.label
}))

/**
 * AI 接口配置弹窗
 * - AI 服务商：DeepSeek / 智谱 AI（切换时自动填充默认接口地址与模型）
 * - API 密钥：密码样式，可切换显示明文
 * - 接口地址 / 模型：默认值可自定义修改
 * - 保存到 localStorage（key: ai_config），刷新不丢失
 */
export default function AiConfigModal({ open, onCancel, onSaved }) {
  const [form] = Form.useForm()

  // 打开时回显本地配置（含向下兼容：旧配置无 provider 视为 DeepSeek）
  useEffect(() => {
    if (!open) return
    const config = getAiConfig()
    if (config) {
      form.setFieldsValue(config)
    } else {
      const preset = getProviderPreset(DEFAULT_PROVIDER)
      form.setFieldsValue({
        provider: DEFAULT_PROVIDER,
        model: preset.model,
        baseUrl: preset.baseUrl,
        apiKey: ''
      })
    }
  }, [open, form])

  // 切换服务商：自动填充该服务商的默认接口地址与模型（密钥保留，需与所选服务商匹配）
  const handleProviderChange = (provider) => {
    const preset = getProviderPreset(provider)
    form.setFieldsValue({
      provider,
      baseUrl: preset.baseUrl,
      model: preset.model
    })
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const config = {
        provider: values.provider,
        model: String(values.model || '').trim(),
        apiKey: String(values.apiKey || '').trim(),
        baseUrl: String(values.baseUrl || '').trim()
      }
      saveAiConfig(config)
      message.success('AI 配置已保存')
      onSaved?.(config.apiKey ? config : null)
    } catch {
      // 表单校验失败由 antd 内联提示
    }
  }

  return (
    <Modal
      title="AI 接口配置"
      open={open}
      onOk={handleSave}
      onCancel={onCancel}
      okText="保存配置"
      cancelText="取消"
      width={520}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          name="provider"
          label="AI 服务商"
          rules={[{ required: true, message: '请选择 AI 服务商' }]}
        >
          <Select options={PROVIDER_OPTIONS} onChange={handleProviderChange} />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API 密钥"
          rules={[{ required: true, message: '请输入 AI API Key' }]}
        >
          <Input.Password placeholder="请输入 AI API Key" autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="baseUrl"
          label="接口地址"
          rules={[{ required: true, message: '请输入接口地址' }]}
        >
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item
          name="model"
          label="模型"
          rules={[{ required: true, message: '请输入模型名称' }]}
        >
          <Input placeholder="deepseek-chat" />
        </Form.Item>
        <Typography.Text type="secondary">
          提示：API 密钥需与所选服务商匹配；切换服务商会自动填充默认接口地址与模型。
        </Typography.Text>
      </Form>
    </Modal>
  )
}
