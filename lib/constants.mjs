// lib/constants.mjs — 词汇表与协议常量（零依赖）。

// 插件标识、命令名与工具名。
export const PLUGIN_NAME = 'session-sync'
export const COMMAND_NAME = 'sync'
export const TOOL_PUSH = 'sync_push'
export const TOOL_PULL = 'sync_pull'
export const TOOL_STATUS = 'sync_status'

// ctx.storageDomain 领域名（同步元数据：设备 id、最近推/拉时间与错误）。
// 下划线命名：storage-domain 的域名正则不允许连字符。
export const DOMAIN_NAME = 'session_sync'

// git 工作树内镜像目录：sessionRoot 的相对镜像落在 <repoDir>/<MIRROR_DIR>/…。
export const MIRROR_DIR = 'sessions'

// 仓库根下的设备身份文件（随机 UUID，提交进仓库供跨设备归属 fork）。
export const DEVICE_FILE = 'device.txt'

// 存储领域 state 表的单例键。
export const STATE_KEY = 'singleton'

// --- Web UI（客户端页面 + 同源 API）词汇 ---------------------------------

// 客户端侧栏面板 id 与主内容页 key（两侧必须一致）。
export const PANEL_ID = 'session-sync'

// 侧栏全局面板行顺序：壳层 Plugins=0、Schedule=10，任务看板=20。
// 本插件取 30，紧跟在任务看板之后、工作区区域之前。
export const PANEL_ORDER = 30

// 同源 API 前缀。
export const API_PREFIX = '/api/dsh-session-sync'

// 云同步能力（内置 cloud-sync 核心）同源 API 前缀。
export const CLOUD_PREFIX = '/api/dsh-session-sync/cloud'

// 存储领域 config 表的单例键。
export const CONFIG_KEY = 'singleton'

// 自动备份计划的两种模式。
export const SCHEDULE_MODES = Object.freeze({
  DAILY: 'daily',
  INTERVAL: 'interval',
})

// 还原模式：安全合并（keep-both）/ 完整覆盖（时间点还原）。
export const RESTORE_MODES = Object.freeze({
  MERGE: 'merge',
  OVERWRITE: 'overwrite',
})

// 还原任务状态机。
export const RESTORE_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

// 同步操作（页面按钮/自动任务）在线状态。
export const OPERATION_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
})

// 提交来源标记（写进提交信息，历史列表据此显示「手动/自动」）。
export const COMMIT_SOURCES = Object.freeze({
  MANUAL: 'manual',
  AUTOMATIC: 'automatic',
})

// 提交信息（历史列表解析来源用）。
export const COMMIT_MESSAGE_PREFIX = 'dsh-session-sync'
export const COMMIT_MESSAGE_MANUAL = 'dsh-session-sync: manual backup'
export const COMMIT_MESSAGE_AUTO = 'dsh-session-sync: automatic backup'

// 完整覆盖还原的安全快照目录名（落在 DSH_HOME 下，与 repoDir 分开）。
export const SNAPSHOT_DIR_NAME = 'dsh-session-sync-snapshots'

// 独立还原 helper 脚本文件名（写入 DSH_HOME，供页面触发执行）。
export const RESTORE_HELPER_NAME = 'dsh-session-sync-restore.ps1'

// 需要守护/提示的活动会话锁文件名（宿主租约；还原前置检查用）。
export const SESSION_LOCK_NAME = 'session.lock'

// 后端词汇：git 为明文传输，encrypted 为 age 加密的 git 传输（镜像内容
// 加密后再推，见 lib/backend.mjs 的 seam 契约与 lib/encrypted.mjs）。
export const BACKENDS = Object.freeze({
  GIT: 'git',
  ENCRYPTED: 'encrypted',
})

// 预留后端（接口占位，尚未实现）：配置即加载期响亮失败（backendUnsupported）。
// 与 git/encrypted 共享同一 seam（status/push/pull 三方法），只是传输介质不同。
export const RESERVED_BACKENDS = Object.freeze({
  OBJECT_STORAGE: 'object-storage',
})

// encrypted 后端在 git 工作树内放置密文镜像的目录名与单个密文文件后缀
// （每会话文件一个 .age 密文；明文镜像 sessions/ 只存在于本地、绝不提交）。
export const ENC_DIR = 'encrypted'
export const ENC_EXT = '.age'

// Config.confirmVia 的取值。
export const CONFIRM_CHANNELS = Object.freeze({
  AUTO: 'auto',
  USER_QUESTIONS: 'userQuestions',
  APPROVAL: 'approval',
})

// 冲突分类（lib/merge.mjs 三分支合并的产物，命令/工具渲染与事件共用）。
export const MERGE_KINDS = Object.freeze({
  IDENTICAL: 'identical',
  OURS_ONLY: 'ours-only',
  THEIRS_ONLY: 'theirs-only',
  APPEND_BOTH: 'append-both',
  DIVERGED: 'diverged',
})

// 会话事件类型（插件自有；运行时是否 append 取决于宿主是否收录该类型，
// 或宿主 append 是否支持 ignorable 信封，见 lib/gate.mjs 的自适应门）。
export const SESSION_EVENTS = Object.freeze({
  PUSH: 'sync/push',
  PULL: 'sync/pull',
  CONFLICT: 'sync/conflict',
})

// 领域错误码（稳定、可路由）。
export const ERROR_CODES = Object.freeze({
  BAD_CONFIG: 'BAD_CONFIG',
  BACKEND_UNSUPPORTED: 'BACKEND_UNSUPPORTED',
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
  GIT_FAILED: 'GIT_FAILED',
  PUSH_REJECTED: 'PUSH_REJECTED',
  SYNC_DENIED: 'SYNC_DENIED',
  PATH_UNSAFE: 'PATH_UNSAFE',
  AGE_FAILED: 'AGE_FAILED',
})

// fork 文件名模式：<basename>.remote-fork-<UTC 时间戳>-<设备短 id>；镜像与
// 清理永不删除、永不覆盖匹配该模式的文件（两边保留的持久载体）。
export const FORK_NAME_RE = /\.remote-fork-\d{14}-[0-9a-z]{8}(?:\.|$)/iu

// 宿主私有会话产物：会话租约与迁移暂存文件。宿主在会话目录内自建、自清，属于
// 运行时状态而非可同步内容——镜像既不把源侧同名文件复制进工作树，也绝不删除
// 目标侧同名文件（否则一次 pull/commit 会把某设备的瞬时锁状态传播成删除）。
// 名称来源（session-persistence-jsonl）：
// - lease.ts:40  LEASE_FILENAME = 'session.lock'（flock 租约；仅会话打开期间存在）
// - generation.ts:725  `session.migration.<token><suffix>.tmp`（迁移暂存，失败自清）
// 注意：`session.jsonl` / `session.v<N>.jsonl[.zstd]`（session-format/filename.ts 的
// sessionFormatLogFilename + format.ts 的 logSuffix）是**同步载荷**，不在此列。
export const HOST_ARTIFACT_NAME_RE = /^(?:session\.lock|session\.migration\..+\.tmp)$/u

// 默认值（Config schema 的默认与 DEFAULT_* 常量同源；cordis.yml 可整体覆盖）。
export const DEFAULTS = Object.freeze({
  ENABLED: true,
  BACKEND: BACKENDS.GIT,
  SESSION_ROOT: '',
  REPO_DIR: '',
  REMOTE: '',
  BRANCH: 'main',
  GIT_BIN: 'git',
  AGE_BIN: 'age',
  AGE_RECIPIENT: '',
  AGE_IDENTITY: '',
  AUTO_PULL_ON_START: false,
  AUTO_PUSH_ON_TURN_END: false,
  PULL_INTERVAL_MINUTES: 0,
  CONFIRM_VIA: CONFIRM_CHANNELS.AUTO,
  GRACE_MS: 10000,
  COMMAND_TIMEOUT_MS: 120000,
  MAX_OUTPUT_BYTES: 262144,
  COMMIT_NAME: 'dsh-session-sync',
  COMMIT_EMAIL: 'dsh-session-sync@localhost',
  REGISTER_COMMAND: true,
  REGISTER_TOOLS: true,
})

// 配置字段合法性边界（加载期校验，越界响亮失败）。
export const LIMITS = Object.freeze({
  MIN_GRACE_MS: 1000,
  MAX_GRACE_MS: 2_147_483_647, // SubprocessSpawnSpec.graceMs 上限（Node 定时器上限）。
  MIN_COMMAND_TIMEOUT_MS: 1000,
  MAX_COMMAND_TIMEOUT_MS: 3_600_000,
  MIN_MAX_OUTPUT_BYTES: 4096,
  MAX_MAX_OUTPUT_BYTES: 16 * 1024 * 1024,
  MIN_PULL_INTERVAL_MINUTES: 0,
  MAX_PULL_INTERVAL_MINUTES: 10080,
  MAX_COMMIT_MESSAGE_LENGTH: 200,
  MAX_DEVICE_ID_LENGTH: 128,
  // --- Web UI 边界 ---
  MIN_SCHEDULE_MINUTES: 5,
  MAX_SCHEDULE_MINUTES: 10080,
  MAX_REMOTE_LENGTH: 2048,
  MAX_BRANCH_LENGTH: 255,
  MAX_HISTORY_LIMIT: 200,
  DEFAULT_HISTORY_LIMIT: 50,
  MAX_RESTORE_PREVIEW_FILES: 500,
})

// git 白名单动词（运行时断言；见 lib/git.mjs 的 ALLOWED_VERBS）。
// 归入 lib/git.mjs 会形成 lib 内循环依赖提示，故这里只放展示用的说明常量。
export const GIT_ENV = Object.freeze({
  // 终端凭据提示会让 git 挂起等待输入；可选锁避免只读原语触发锁竞争。
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
})
