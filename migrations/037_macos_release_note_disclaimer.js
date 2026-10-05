/**
 * V1.0 发布说明：macOS 未公证的免责声明写明。
 *
 * ## 背景（本轮上线决策）
 *
 * macOS 包本轮**不做 Apple 公证**，接受延期 —— 不因为公证继续推迟 V1.0。
 * 代价是用户首次打开会被 Gatekeeper 拦一次，必须在系统安全设置里手动放行。
 * 这不是缺陷，是"尚未公证"的必然结果；但**必须提前告诉用户**，
 * 否则用户看到「无法验证开发者」会认为软件坏了、要求退款。
 *
 * 官网 `Landing.vue` 已经有一个折叠的安装引导块
 * （「macOS 首次打开被系统拦截？点这里」，含 Sequoia / 旧版 / 已损坏 三种分支），
 * 以及安装包内的《首次打开说明.txt》。**两处都保留，本迁移不动。**
 *
 * 本迁移补的是第三处，也是客户在**下载时**一定会看到的那一处：
 * `client_releases.note`（`Landing.vue:88` 直接把它渲染在下载按钮旁）。
 * 改动前它只写「首次打开需放行一次（安装包内附操作说明）」—— 没说清
 * "要去系统安全设置里手动允许"，用户不知道该去哪放行。
 *
 * ## 改什么 / 不改什么
 *
 *   · 只改 **enabled=true 且 release_group='macos'** 的那两条（当前是 0.1.8 的
 *     arm64 / x64）。停用的历史版本不动 —— 它们的 note 记着版本差异
 *     （如 0.1.6 的「多开分区隔离 / 消息归档 / 后台运行 / 日志落盘」），
 *     是有价值的历史信息，覆盖掉是净损失，而客户看不到它们。
 *   · 幂等：已经含「系统安全设置」的行不重复写。
 *
 * ## 为什么写进迁移而不是手改库
 *
 * 与 031 / 034 / 035 / 036 同一套理由：这是**发布前的合规文案**，
 * 必须可复现、可回滚、可审计 —— 而不是"某天有人在后台改了一句话"。
 * 客户看到的每一句承诺都应当能追到一次代码提交。
 */

const OLD_NOTE = '首次打开需放行一次（安装包内附操作说明）'
const NEW_NOTE = 'macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'

exports.up = pgm => {
  pgm.sql(`
    UPDATE client_releases
    SET note = '${NEW_NOTE}'
    WHERE release_group = 'macos'
      AND enabled = true
      AND note NOT LIKE '%系统安全设置%';
  `)
}

exports.down = pgm => {
  // 只把本迁移写进去的那句还原；管理员后来改成别的就留给人家的版本。
  pgm.sql(`
    UPDATE client_releases
    SET note = '${OLD_NOTE}'
    WHERE release_group = 'macos'
      AND enabled = true
      AND note = '${NEW_NOTE}';
  `)
}
