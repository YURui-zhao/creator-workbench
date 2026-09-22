import { useEffect, useState } from 'react'
import { Avatar, Button, Layout, Menu, Space, Tag, Tooltip, Typography, theme } from 'antd'
import {
  BarChartOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  OrderedListOutlined,
  TeamOutlined,
  UserOutlined
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { checkHealth } from '../api/health'
import { getAiStatus } from '../api/ai'
import AiConfigModal from '../components/AiConfigModal'
import { getAiConfig, getProviderPreset } from '../utils/aiConfig.js'

const { Header, Sider, Content } = Layout

const MENU_ITEMS = [
  { key: 'dashboard', icon: <BarChartOutlined />, label: '数据看板' },
  { key: 'creators', icon: <TeamOutlined />, label: '达人汇总' },
  { key: 'records', icon: <OrderedListOutlined />, label: '投放管理' },
  { key: 'import-history', icon: <HistoryOutlined />, label: '导入历史' }
]

// 菜单 key <-> 路由路径（保持一致，便于高亮与跳转）
const MENU_PATHS = {
  dashboard: '/dashboard',
  creators: '/creators',
  records: '/records',
  'import-history': '/import-history'
}

export default function MainLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(true)
  // 后端连通状态：checking 检测中 / ok 已连接 / down 未连接
  const [backendStatus, setBackendStatus] = useState('checking')
  // AI 服务状态：checking 检测中 / ready 已就绪 / unavailable 未配置或不可用
  const [aiStatus, setAiStatus] = useState(() =>
    getAiConfig()?.apiKey ? 'ready' : 'checking'
  )
  // AI 配置弹窗
  const [aiConfigOpen, setAiConfigOpen] = useState(false)
  // 本地 AI 配置（用于状态标签 hover 展示服务商与模型）
  const [aiConfig, setAiConfig] = useState(() => getAiConfig())
  const { token } = theme.useToken()
  // 根据当前路由高亮菜单（默认首页仍为数据看板）
  const selectedKey =
    Object.keys(MENU_PATHS).find((key) =>
      location.pathname.startsWith(MENU_PATHS[key])
    ) || 'dashboard'

  // 首页加载时自动调用健康检查，确认后端连通
  useEffect(() => {
    let active = true
    checkHealth()
      .then(() => active && setBackendStatus('ok'))
      .catch(() => active && setBackendStatus('down'))
    // 同时检测 AI 服务状态
    getAiStatus()
      .then((res) => active && setAiStatus(res.data?.available ? 'ready' : 'unavailable'))
      .catch(() => active && setAiStatus('unavailable'))
    return () => {
      active = false
    }
  }, [])

  // 保存 AI 配置后立即更新右上角状态，并重新向后端确认可用性
  const handleAiConfigSaved = (config) => {
    setAiConfigOpen(false)
    setAiConfig(config || getAiConfig())
    setAiStatus(config?.apiKey ? 'ready' : 'unavailable')
    getAiStatus()
      .then((res) => setAiStatus(res.data?.available ? 'ready' : 'unavailable'))
      .catch(() => setAiStatus(config?.apiKey ? 'ready' : 'unavailable'))
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 顶部导航栏 */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: token.colorBgContainer,
          padding: '0 24px',
          boxShadow: '0 1px 4px rgba(0, 21, 41, 0.08)',
          position: 'sticky',
          top: 0,
          zIndex: 10
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
          <Typography.Title level={4} style={{ margin: 0 }}>
            达人投放工作台
          </Typography.Title>
        </div>
        <Space size={12}>
          {backendStatus === 'checking' && <Tag>后端检测中...</Tag>}
          {backendStatus === 'ok' && <Tag color="success">后端已连接</Tag>}
          {backendStatus === 'down' && <Tag color="error">后端未连接</Tag>}
          {backendStatus === 'ok' && aiStatus === 'checking' && (
            <Tag style={{ cursor: 'pointer' }} onClick={() => setAiConfigOpen(true)}>
              AI检测中...
            </Tag>
          )}
          {backendStatus === 'ok' && aiStatus === 'ready' && (
            <Tooltip
              title={`${getProviderPreset(aiConfig?.provider).label} · ${
                aiConfig?.model || getProviderPreset(aiConfig?.provider).model
              }`}
            >
              <Tag
                color="success"
                style={{ cursor: 'pointer' }}
                onClick={() => setAiConfigOpen(true)}
              >
                AI已配置
              </Tag>
            </Tooltip>
          )}
          {backendStatus === 'ok' && aiStatus === 'unavailable' && (
            <Tooltip title="点击设置 AI API Key（未配置时 AI 校验将自动降级为普通导入）">
              <Tag style={{ cursor: 'pointer' }} onClick={() => setAiConfigOpen(true)}>
                AI未配置
              </Tag>
            </Tooltip>
          )}
          <Avatar
            size={36}
            style={{ backgroundColor: token.colorPrimary }}
            icon={<UserOutlined />}
          />
        </Space>
      </Header>

      <Layout>
        {/* 左侧侧边栏：默认收起 80px，展开 200px */}
        <Sider
          theme="dark"
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          width={200}
          collapsedWidth={80}
          trigger={null}
        >
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            items={MENU_ITEMS}
            onClick={({ key }) => navigate(MENU_PATHS[key] || '/dashboard')}
            style={{ borderInlineEnd: 'none' }}
          />
        </Sider>

        {/* 主内容区：路由出口 */}
        <Content style={{ padding: 24, background: token.colorBgLayout }}>
          <Outlet />
        </Content>
      </Layout>

      {/* AI 接口配置弹窗 */}
      <AiConfigModal
        open={aiConfigOpen}
        onCancel={() => setAiConfigOpen(false)}
        onSaved={handleAiConfigSaved}
      />
    </Layout>
  )
}
