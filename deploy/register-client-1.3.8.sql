-- 登记 Hello Pix 桌面 1.3.8。四份文件已上传到 /opt/hello-pix/downloads/，
-- 三个发布文件均从真实文件流式计算 SHA-256。
--
-- 本版内容：
--   外部录音通过「导入语音」或拖入 OGG/Opus 等音频后，使用 WhatsApp 自己的
--   录音链路编码并发送为原生 PTT，显示波形和真实时长，不再是普通音频文件。
--   录音期间切换聊天会取消，避免误发到另一个会话。
--
-- 用户已明确授权发布未签名构建：
--   · macOS 为 ad-hoc，无 Developer ID、无公证；
--   · Windows 无 Authenticode 签名。

BEGIN;

INSERT INTO client_releases
  (release_group, title, os, arch, app, version, url, enabled, note, sha256, min_version)
VALUES
  ('desktop', 'Hello Pix 1.3.8', 'Windows', 'x64', 'com.hellopix.desktop', '1.3.8',
   'https://pixfanyi.com/downloads/HelloPix-Setup-1.3.8.exe', true,
   '新增外部录音导入：使用 WhatsApp 原生录音链路发送为语音消息，显示波形而不是普通音频文件；录音期间切换聊天会取消，不会误发。',
   '30738e324f5afc90c0669ce927f2d8cb9d149b67d6893ec99612dda8e6306c9c', '1.2.0'),
  ('desktop', 'Hello Pix 1.3.8', 'macOS', 'x64', 'com.hellopix.desktop', '1.3.8',
   'https://pixfanyi.com/downloads/Hello%20Pix-1.3.8.dmg', true,
   '新增外部录音导入：使用 WhatsApp 原生录音链路发送为语音消息，显示波形而不是普通音频文件。macOS 首次打开仍需在系统安全设置中手动允许。',
   'ba1f6e6a8f439bafea797072eb693972c6fc8a517c2a307d0b851de70d599a8e', '1.2.0'),
  ('desktop', 'Hello Pix 1.3.8', 'macOS', 'arm64', 'com.hellopix.desktop', '1.3.8',
   'https://pixfanyi.com/downloads/Hello%20Pix-1.3.8-arm64.dmg', true,
   '新增外部录音导入：使用 WhatsApp 原生录音链路发送为语音消息，显示波形而不是普通音频文件。macOS 首次打开仍需在系统安全设置中手动允许。',
   'cc7fd45006313502cfa0426df0c201b82f9ec6668bb753e0796c14ab09dc129c', '1.2.0')
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
  AND version <> '1.3.8'
  AND enabled;

-- lower(os) 是为兼容历史上的 'macos' / 'macOS' 混写。
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

-- 回滚：先将 1.3.8 的三条记录置 enabled=false，再把 1.3.7 的三条记录
-- （id #157–#159）置 enabled=true；安装包与更新清单文件均保留。
