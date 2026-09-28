import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 默认使用 backend/workbench.db；允许通过环境变量指向其它数据库文件（仅用于测试隔离）
const dbPath = process.env.WORKBENCH_DB_PATH
  ? path.resolve(process.env.WORKBENCH_DB_PATH)
  : path.join(__dirname, 'workbench.db')

// 首次运行自动创建数据库文件与数据表
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS creator_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_cycle TEXT,
    nickname TEXT,
    homepage TEXT,
    creator_type TEXT,
    content_link TEXT,
    total_cost REAL,
    publish_date TEXT,
    video_link TEXT,
    first_play INTEGER,
    second_week_play INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- 常用筛选字段建立索引，提升分页/筛选查询性能
  CREATE INDEX IF NOT EXISTS idx_records_time_cycle ON creator_records(time_cycle);
  CREATE INDEX IF NOT EXISTS idx_records_creator_type ON creator_records(creator_type);
  CREATE INDEX IF NOT EXISTS idx_records_publish_date ON creator_records(publish_date);
  CREATE INDEX IF NOT EXISTS idx_records_nickname ON creator_records(nickname);

  -- 兼容工作台前端旧接口
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- 导入批次日志（只做导入历史记录，不参与业务计算，不改动 creator_records）
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT,
    total_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    skip_count INTEGER DEFAULT 0,
    duplicate_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 批次 <-> 投放记录 关联（用于「按批次筛选投放记录」，不改动 creator_records 表结构）
  CREATE TABLE IF NOT EXISTS import_batch_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    record_id INTEGER NOT NULL
  );

  -- 批次明细（失败/跳过/重复/成功 的行级记录，用于导入历史详情展示）
  CREATE TABLE IF NOT EXISTS import_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    row_index INTEGER,
    status TEXT,
    reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON import_batches(created_at);
  CREATE INDEX IF NOT EXISTS idx_import_batch_records_batch ON import_batch_records(batch_id);
  CREATE INDEX IF NOT EXISTS idx_import_batch_items_batch ON import_batch_items(batch_id);

  -- V3-alpha P2B：达人近期表现快照（append-only，只保存人工确认后的结构化数据）
  -- 说明：
  --   · 不保存原截图 / base64 / 图片路径 / API Key / provider 原始响应 / prompt 全文
  --   · 只允许新增，不提供覆盖更新（历史快照需要可追溯「当时看到的近期状态」）
  --   · plays_json 保留每条人工确认后的 raw_text / normalized_play / excluded / source_image_index / position_index / needs_review
  --   · stats_version 记录当时采用的统计口径（去极值规则 / quantile 算法 / trend 阈值）
  CREATE TABLE IF NOT EXISTS creator_recent_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    recognized_creator_name_raw TEXT,
    source_type TEXT NOT NULL DEFAULT 'screenshot',
    xingtu_price_raw TEXT,
    xingtu_price REAL,
    plays_json TEXT NOT NULL,
    recognized_count INTEGER NOT NULL DEFAULT 0,
    valid_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    unresolved_count INTEGER NOT NULL DEFAULT 0,
    analysis_count INTEGER NOT NULL DEFAULT 0,
    median_play REAL,
    p25_play REAL,
    p75_play REAL,
    recent_median_play REAL,
    prior_median_play REAL,
    trend_ratio REAL,
    -- 每一列都显式声明类型，不依赖「逗号前共享类型」写法：
    -- 否则 SQLite 会把未声明类型的列当成无类型（NUMERIC 亲和性）列，schema 容易悄悄退化
    trend_label TEXT NOT NULL,
    stats_status TEXT NOT NULL,
    stats_version TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_recent_snapshots_creator_created
    ON creator_recent_snapshots(creator, created_at);
`)

// 首次启动写入示例项目（前端工作台展示用）
const projectCount = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n
if (projectCount === 0) {
  const insert = db.prepare(
    'INSERT INTO projects (name, owner, status, progress) VALUES (?, ?, ?, ?)'
  )
  const seedAll = db.transaction(() => {
    for (const row of [
      ['React 18 学习路线', '张三', 'done', 100],
      ['Vite 工程化配置', '李四', 'doing', 60],
      ['SQLite 数据建模', '王五', 'todo', 0]
    ]) {
      insert.run(...row)
    }
  })
  seedAll()
  console.log('[db] 已写入示例项目数据')
}

console.log(`[db] 数据库初始化完成: ${dbPath}`)

export default db
