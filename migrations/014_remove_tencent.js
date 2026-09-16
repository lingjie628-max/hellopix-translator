/**
 * 下架腾讯翻译通道。
 *
 * 与有道（010）、谷歌拆分（011）同一套处理方式：把数据库里所有引用一起清掉，
 * 避免留下"数据库有、适配层没有"的悬空通道 ——
 * translation-provider.test.js 里那条护栏测试会直接抓到这种状态。
 *
 * 需要清的位置：
 *   1. engines 里的 tencent 行
 *   2. package_engines 里 advanced / pro 对它的关联
 *   3. 套餐卖点里写的"腾讯翻译"（官网/后台都会展示）
 *   4. 存量账号 users / sub_accounts 上指向它的 active_engine_id
 *      —— 不像 youdao 那样能改指别的通道，这里**清空**：
 *      原优惠是把用户指向一个仍在架上的通道，但"腾讯"下架后没有语义等价物，
 *      强行改成百度反而是替用户做了选择。留空由程序按
 *      "套餐内第一个已接通且启用"的规则动态解析（core.resolveEngineId）。
 *
 * 002 的种子也已同步去掉腾讯，保证全新部署从第一步就不含它。
 */

exports.up = pgm => {
  pgm.sql(`
    -- 1) 存量账号先清指向（不能留悬空引用）
    UPDATE users SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id = 'tencent';
    UPDATE sub_accounts SET active_engine_id = NULL, updated_at = NOW()
    WHERE active_engine_id = 'tencent';

    -- 2) 默认通道设置指向腾讯的清空，交给程序动态解析
    UPDATE app_settings
    SET value = '""'::jsonb
    WHERE key = 'translation.active_engine' AND value = '"tencent"'::jsonb;

    -- 3) 套餐关联
    DELETE FROM package_engines WHERE engine_id = 'tencent';

    -- 4) 通道本体
    DELETE FROM engines WHERE id = 'tencent';

    -- 5) 套餐卖点里的"腾讯翻译"
    UPDATE packages
    SET highlights = highlights - '腾讯翻译', updated_at = NOW()
    WHERE highlights @> '["腾讯翻译"]'::jsonb;
  `)
}

exports.down = pgm => {
  // 有意不提供回滚：恢复通道要连同适配层实现一起恢复，
  // 单靠回滚数据库只会造出悬空通道（与 010 / 011 同理）。
  pgm.sql('SELECT 1')
}
