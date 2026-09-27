/**
 * 摘掉「手机版」这个没有任何东西在后面的权益承诺。
 *
 * ## 起因
 *
 * 三个套餐的权益列表里都写着「手机版」，`packages.clients.mobile` 也都是 true
 * （后台「上架」页上那个「手机版」勾选框）。但翻遍四条独立线索，**没有任何
 * 形式的移动端存在**：
 *
 *   1. 仓库：没有 ios / android 工程目录；小程序 / 公众号 / uni-app /
 *      cordova / capacitor 等关键词全部零命中（`standalone/` 里只有 Telegram）；
 *   2. `下载目录`：只有 `.dmg`（macOS）与 `.exe`（Windows），无 apk / ipa；
 *   3. `client_releases`：15 条记录，`os` 只有 `Windows` 与 `macOS`；
 *   4. 服务器全盘：不存在 apk / ipa。
 *
 * 而且 `clients.mobile` 本身**不驱动任何东西** —— 全仓库只有后台
 * `AdminPackages.vue` 用它渲染一个标签和一个勾选框，没有任何下载链接或代码路径
 * 依赖它。它纯粹是一句营销话术。
 *
 * ## 为什么必须撤掉而不是留着
 *
 * 它写在**套餐权益列表**里，客户读到的是"我买了这个套餐就得到手机版"。
 * 而产品本体是 Electron 桌面客户端，核心能力是**多开**并排跑多个账号 ——
 * 这件事在手机上本来就不成立。这是一个客户付完钱才能发现兑现不了的承诺，
 * 属于退款/拒付风险，不是措辞问题。
 *
 * ## 改了什么
 *
 *   · 三个套餐的 `highlights` 去掉「手机版」；
 *   · `clients.mobile` 置为 false（用 `||` 合并，保留 standalone / counter）。
 *
 * 保留「独立应用版」—— 桌面客户端是真实存在的（有 0.1.8 的 dmg/exe 在架）。
 *
 * ## 没改什么
 *
 * `clients.counter`（专业版为 true）与「柜台版」同样没有对应客户端，
 * 但它**没有出现在任何宣传文案里**，对客户不构成虚假承诺，故本次不动 ——
 * 只把"已经向客户承诺、却兑现不了"的那一条摘掉。
 */

exports.up = pgm => {
  // 基础版
  pgm.sql(`
    UPDATE packages
    SET highlights = '["150万字符","DeepSeek、GPT、通义千问","独立应用版"]'::jsonb,
        clients = clients || '{"mobile": false}'::jsonb,
        updated_at = NOW()
    WHERE id = 1
      AND highlights::text LIKE '%手机版%';
  `)

  // 高级版
  pgm.sql(`
    UPDATE packages
    SET highlights = '["150万字符","豆包、GLM、MiniMax、Mistral","+基础版各翻译通道","独立应用版"]'::jsonb,
        clients = clients || '{"mobile": false}'::jsonb,
        updated_at = NOW()
    WHERE id = 2
      AND highlights::text LIKE '%手机版%';
  `)

  // 专业版
  pgm.sql(`
    UPDATE packages
    SET highlights = '["150万字符","Claude、谷歌翻译、Grok、Kimi","+高级版各翻译通道","独立应用版"]'::jsonb,
        clients = clients || '{"mobile": false}'::jsonb,
        updated_at = NOW()
    WHERE id = 3
      AND highlights::text LIKE '%手机版%';
  `)
}

exports.down = pgm => {
  // 回到迁移 034 之后、本迁移之前的状态（含「手机版」）。
  pgm.sql(`
    UPDATE packages
    SET highlights = '["150万字符","DeepSeek、GPT、通义千问","独立应用版","手机版"]'::jsonb,
        clients = clients || '{"mobile": true}'::jsonb,
        updated_at = NOW()
    WHERE id = 1
      AND highlights::text LIKE '%DeepSeek、GPT、通义千问%';

    UPDATE packages
    SET highlights = '["150万字符","豆包、GLM、MiniMax、Mistral","+基础版各翻译通道","独立应用版","手机版"]'::jsonb,
        clients = clients || '{"mobile": true}'::jsonb,
        updated_at = NOW()
    WHERE id = 2
      AND highlights::text LIKE '%豆包、GLM、MiniMax、Mistral%';

    UPDATE packages
    SET highlights = '["150万字符","Claude、谷歌翻译、Grok、Kimi","+高级版各翻译通道","独立应用版","手机版"]'::jsonb,
        clients = clients || '{"mobile": true}'::jsonb,
        updated_at = NOW()
    WHERE id = 3
      AND highlights::text LIKE '%Claude、谷歌翻译、Grok、Kimi%';
  `)
}
