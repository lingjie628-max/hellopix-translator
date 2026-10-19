/**
 * 客户端崩溃日志上报。
 *
 * ## 为什么需要
 *
 * 0.1.36 加了崩溃取证（子进程崩溃 / 每个实例的渲染进程崩溃 / 内存水位曲线），
 * 但**日志只留在用户本机**。用户不主动发，我们永远看不到 —— 等于加了取证能力
 * 却没有把证据收回来的通道，出问题时仍然只能靠猜。
 *
 * 这张表就是那条通道：客户端下次启动时，把**上一次异常退出**留下的
 * crash / memory 行自动送上来（用户无感）。
 *
 * ## 只存什么（安全边界，改之前先读这里）
 *
 * **只接收 crash / memory 两个域的行**，白名单过滤，其余一律丢弃。
 * 完整日志包含 WhatsApp 群名、联系人、翻译内容 —— 那些绝不上服务器。
 * 服务端再做一次同样的过滤（不信任客户端），双保险。
 *
 * 建库时日志本身已过 `redact()`（token/password/邮箱/手机号/长串），
 * 但**不能只依赖它**：白名单才是第一道防线。
 *
 * ## 为什么 user_id 允许为空
 *
 * 崩溃可能发生在**登录之前**（启动即闪退、登录页卡死）—— 那正是最需要
 * 日志的场景。此时只有 device_id 可用，不能因为拿不到 user_id 就整条丢掉。
 * 也不挂外键：日志的价值在于"出过什么事"，不该随账号删除而消失
 * （与 deleted_merchants 同理）。
 */

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE client_crash_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

      -- 匿名也能上报：启动即闪退时还没有登录态。
      user_id bigint,
      device_id varchar(64) NOT NULL DEFAULT '',
      username varchar(64) NOT NULL DEFAULT '',

      -- 客户端版本与运行环境：没有这三个字段，日志无法归因到某个版本。
      version varchar(32) NOT NULL DEFAULT '',
      platform varchar(16) NOT NULL DEFAULT '',
      arch varchar(16) NOT NULL DEFAULT '',

      -- 崩溃时刻（客户端本地时钟）与上报时刻（服务端时钟）。
      -- 两者相差过大说明客户端时钟不准，排查时间线时要注意。
      crashed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),

      -- 原始行（已按白名单过滤）与解析出的摘要。
      -- 摘要单独存是为了后台能直接按 reason 排序/筛选，不必解析文本。
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      crash_count int NOT NULL DEFAULT 0,
      memory_peak_pct int,
      reasons text[] NOT NULL DEFAULT '{}'
    )
  `)

  pgm.sql('CREATE INDEX client_crash_logs_created_idx ON client_crash_logs (created_at DESC)')
  pgm.sql('CREATE INDEX client_crash_logs_version_idx ON client_crash_logs (version, created_at DESC)')
  pgm.sql('CREATE INDEX client_crash_logs_device_idx ON client_crash_logs (device_id, created_at DESC)')
  // 同一设备同一次崩溃可能重试上报，去重靠 (device_id, crashed_at)。
  pgm.sql("CREATE UNIQUE INDEX client_crash_logs_dedup_idx ON client_crash_logs (device_id, crashed_at) WHERE crashed_at IS NOT NULL")
}

exports.down = pgm => {
  pgm.sql('DROP TABLE IF EXISTS client_crash_logs')
}
