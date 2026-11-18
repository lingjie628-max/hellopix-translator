-- 登记 Hello Pix 桌面 1.3.9。安装包已上传到 /opt/hello-pix/downloads/，
-- 三个发布文件均从真实文件流式计算 SHA-256。
--
-- 本版内容：
--   修复聊天输入区完全缺少语音入口：
--   1. pageScripts 同步 IPC 正确使用 event.sender；
--   2. pix:// 特权协议在 app ready 前注册，bypassCSP 真正生效；
--   3. 同一 partition 的协议补挂幂等。
--   「导入语音」「快速语音」及音频拖入统一走直接 PTT 链路，
--   使用真实音频幅度生成 64 字节波形，不再产生虚拟麦克风空白波形。
--
-- 用户已明确授权发布未签名构建：
--   · macOS 为 ad-hoc，无 Developer ID、无公证；
--   · Windows 无 Authenticode 签名。

BEGIN;

INSERT INTO client_releases
  (release_group, title, os, arch, app, version, url, enabled, note, sha256, min_version)
VALUES
  ('desktop', 'Hello Pix 1.3.9', 'Windows', 'x64', 'com.hellopix.desktop', '1.3.9',
   'https://pixfanyi.com/downloads/HelloPix-Setup-1.3.9.exe', true,
   '修复语音入口不显示；导入语音、快速语音和音频拖入统一发送 WhatsApp 原生 PTT，并按真实音频幅度生成波形。',
   'eccc7ca3ff906cd015f484a122ffe585a4c22a05bcd70494e923a3a7934bc228', '1.2.0'),
  ('desktop', 'Hello Pix 1.3.9', 'macOS', 'x64', 'com.hellopix.desktop', '1.3.9',
   'https://pixfanyi.com/downloads/Hello%20Pix-1.3.9.dmg', true,
   '修复语音入口不显示；导入语音、快速语音和音频拖入统一发送 WhatsApp 原生 PTT，并按真实音频幅度生成波形。macOS 首次打开仍需在系统安全设置中手动允许。',
   'fc936554254e86b1c0ccac2811cfd04524439fce18e428fb16738bbdb350a02b', '1.2.0'),
  ('desktop', 'Hello Pix 1.3.9', 'macOS', 'arm64', 'com.hellopix.desktop', '1.3.9',
   'https://pixfanyi.com/downloads/Hello%20Pix-1.3.9-arm64.dmg', true,
   '修复语音入口不显示；导入语音、快速语音和音频拖入统一发送 WhatsApp 原生 PTT，并按真实音频幅度生成波形。macOS 首次打开仍需在系统安全设置中手动允许。',
   '118338f23fe3630d843271c9bf34cedf034f6907bd02bf60362ae3ec1850e311', '1.2.0')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
SET title = EXCLUDED.title,
    url = EXCLUDED.url,
    enabled = true,
    note = EXCLUDED.note,
    sha256 = EXCLUDED.sha256,
    min_version = EXCLUDED.min_version,
    updated_at = NOW();

UPDATE client_releases
SET enabled = false, updated_at = NOW()
WHERE release_group = 'desktop'
  AND version <> '1.3.9'
  AND enabled;

UPDATE app_settings
SET value = '"1.3.9 已发布：修复语音入口不显示；导入语音、快速语音和音频拖入均发送 WhatsApp 原生语音，真实波形与账号头像正常显示。"'::jsonb,
    updated_at = NOW()
WHERE key = 'site.announcement';

UPDATE app_settings
SET value = '"https://pixfanyi.com/downloads/Hello%20Pix-1.3.9-arm64.dmg"'::jsonb,
    updated_at = NOW()
WHERE key = 'downloads.client_url';

-- lower(os) 兼容历史上的 'macos' / 'macOS' 混写。
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT 1
    FROM client_releases
    WHERE enabled AND release_group = 'desktop'
    GROUP BY lower(os), arch, app
    HAVING count(*) <> 1
  ) t;
  IF bad > 0 THEN
    RAISE EXCEPTION 'desktop 同平台存在多条 enabled';
  END IF;
END $$;

COMMIT;

SELECT id, os, arch, version, enabled, sha256, min_version
FROM client_releases
WHERE enabled AND release_group = 'desktop'
ORDER BY os, arch;

-- 回滚：将 1.3.9 的三条记录置 enabled=false，再把 1.3.8 的三条记录
-- （id #160–#162）置 enabled=true，并恢复 1.3.8 公告。安装包保留。
