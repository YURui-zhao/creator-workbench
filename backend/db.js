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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    -- V3-alpha.2 Sprint A1：业务观察日期（这批播放量 / 星图价是哪天看到的）
    -- 语义与 created_at（何时保存进系统）永久分开；格式固定 YYYY-MM-DD；旧数据保持 NULL
    observed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_recent_snapshots_creator_created
    ON creator_recent_snapshots(creator, created_at);

  -- V3-alpha P4：决策记录（append-only，固化「当时看到了什么」）
  -- 说明：
  --   · 证据（historical / recent / pricing）、target_cpm、pricing_version 在创建时固化，
  --     未来数据变化不得回写或重算旧记录
  --   · 只记录人的决定；不保存截图 / base64 / API Key / provider 原始响应 / AI prompt
  --   · current_quote（实际商务报价）与 snapshot.xingtu_price（星图刊例价）永久分开
  CREATE TABLE IF NOT EXISTS creator_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator TEXT NOT NULL,
    decision_stage TEXT NOT NULL,
    snapshot_id INTEGER,
    current_quote_raw TEXT,
    current_quote REAL,
    ip_judgement TEXT,
    human_decision TEXT NOT NULL,
    decision_note TEXT,
    historical_evidence_json TEXT NOT NULL,
    recent_evidence_json TEXT,
    pricing_evidence_json TEXT,
    target_cpm REAL NOT NULL,
    pricing_version TEXT NOT NULL,
    system_context_version TEXT NOT NULL DEFAULT 'decision-context-v1',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_creator_decisions_creator_created
    ON creator_decisions(creator, created_at);

  -- V3-alpha P5：决策 ↔ 真实投放结果 的关联（只保存关联关系，不改写 creator_decisions）
  -- 说明：
  --   · creator_decisions 是「当时的决策快照」，因此绝不 UPDATE 旧 decision 去挂 outcome
  --   · 本表只保存 decision_id ↔ record_id 映射；花费 / 播放 / CPM / 发布日期等一律实时取自
  --     creator_records（Outcome result = live，Decision evidence = frozen）
  --   · P5-alpha：一条 decision 最多关联一个 record，一条 record 最多关联一个 decision
  --     （UNIQUE 约束是并发下的最终保护，不做 many-to-many）
  CREATE TABLE IF NOT EXISTS creator_decision_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL,
    record_id INTEGER NOT NULL,
    linked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(decision_id),
    UNIQUE(record_id)
  );

  CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision
    ON creator_decision_outcomes(decision_id);
  CREATE INDEX IF NOT EXISTS idx_decision_outcomes_record
    ON creator_decision_outcomes(record_id);
`)

// V3-alpha.2 Sprint A1：为既有数据库安全补充 observed_at（数据观察日期）
// 说明：
//   · 只在列不存在时 ALTER TABLE，不覆盖任何已有快照
//   · 绝不把 created_at 伪装成 observed_at —— 保存日期不一定等于真实观察日期，
//     旧快照保持 NULL，由 UI 显示「观察日期未知」
const snapshotColumns = db
  .prepare('PRAGMA table_info(creator_recent_snapshots)')
  .all()
  .map((column) => column.name)
if (!snapshotColumns.includes('observed_at')) {
  db.exec('ALTER TABLE creator_recent_snapshots ADD COLUMN observed_at TEXT')
  console.log('[db] 已为 creator_recent_snapshots 添加 observed_at 列（历史快照保持 NULL）')
}

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
