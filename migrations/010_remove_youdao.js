/**
 * 下架有道翻译通道。
 *
 * 背景：有道翻译（v3 签名接口）确定为不再提供的通道，从产品里整体下架。
 * 数据库里种了四样东西，必须一起清理，否则会留下"数据库有、适配层没有"的悬空通道：
 *   1. engines 里的 youdao 行
 *   2. package_engines 里 basic/advanced/pro 三个套餐对它的关联
 *   3. translation.active_engine 默认值（种子种的就是 "youdao"）
 *   4. 存量账号 users/sub_accounts 上的 active_engine_id
 *
 * 为什么不直接删 002 里的种子：002 已经在生产库跑过了，改它不会重跑。
 * 所以这里单独出一个迁移处理存量库；同时 002 也已改为不再种 youdao，
 * 保证全新部署从第一步就不会出现这个通道。
 *
 * 注意 translation.active_engine 不改成另一个写死的通道名：
 * 没有接通任何通道时，"默认通道"本身没有意义，留空由程序按
 * "套餐内第一个已接通且启用"的规则动态解析（见 core.resolveEngineId）。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1) 套餐关联先删（有外键依赖）
    DELETE FROM package_engines WHERE engine_id = 'youdao';

    -- 2) 通道本体
    DELETE FROM engines WHERE id = 'youdao';

    -- 3) 存量账号上指向 youdao 的选择清空，改为让程序动态解析
    UPDATE users SET active_engine_id = NULL, updated_at = NOW() WHERE active_engine_id = 'youdao';
    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW() WHERE active_engine_id = 'youdao';

    -- 4) 默认通道设置：本来指向 youdao 的清空，不换成另一个写死的通道名
    UPDATE app_settings
    SET value = '""'::jsonb
    WHERE key = 'translation.active_engine' AND value = '"youdao"'::jsonb;

    -- 5) 套餐卖点里也列了"有道翻译"（官网/后台都会展示），一并去掉，
    --    否则下架了通道、页面上还在宣传它
    UPDATE packages
    SET highlights = highlights - '有道翻译', updated_at = NOW()
    WHERE highlights @> '["有道翻译"]'::jsonb;
  `)
}

exports.down = pgm => {
  // 有意不提供回滚：下架是产品决定，恢复通道需要连同适配层代码一起恢复，
  // 单靠回滚数据库只会造出"数据库有、代码没有"的悬空通道。
  pgm.sql('SELECT 1')
}
