-- 登记 0.1.43 客户端发布记录。产物已上传并逐一比对 SHA256。
--
-- 本版内容：顶部标签栏支持鼠标滚轮横向滚动。
--   以前 .tabs 是 overflow-x:auto 的横向容器，垂直滚轮没被映射到横向，
--   用户只能去拖那条细滚动条 —— 反馈就是"滚轮没用，必须手动拉"。
--   现在垂直滚轮转横向滚动；触控板横向手势、Shift+滚轮仍走浏览器默认；
--   滚到两端不拦截，避免"滚不动还把整页卡死"。
--
-- 幂等：重复执行只更新字段，不会插入重复行。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Apple 芯片）', 'macOS', 'arm64', '', '0.1.43',
   'https://pixfanyi.com/downloads/HelloPix-0.1.43-arm64.dmg', true,
   '本次更新：顶部标签栏现在可以用鼠标滚轮直接左右滚动，不用再去拖那条细滚动条。滚到最左或最右就会停住，不会再"滚不动也卡着"；触控板横向滑动和 Shift+滚轮保持系统原本的手感。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）'),
  ('windows', 'Windows（64 位）', 'Windows', 'x64', '', '0.1.43',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.43.exe', true,
   '本次更新：顶部标签栏现在可以用鼠标滚轮直接左右滚动，不用再去拖那条细滚动条。滚到最左或最右就会停住，不会再"滚不动也卡着"；触控板横向滑动和 Shift+滚轮保持系统原本的手感。')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

-- ★ Intel Mac 本次没有构建 x64 包 ★
--
-- 不能照抄上一版把 macos/x64 也指向 0.1.43 —— 那个 URL 现在 404。
-- 所以：● 先停用 x64 的旧启用行（避免更新接口继续把用户钉在 0.1.42）；
--        ● 0.1.43 的 x64 行不插入。
-- 待补出 x64 包并上传后，再单独执行一条 INSERT 启用即可。

UPDATE client_releases
   SET enabled = false, updated_at = now()
 WHERE os = 'macOS' AND arch = 'x64' AND version <> '0.1.43' AND enabled;

COMMIT;

-- 核对：macOS arm64 / Windows x64 应为 0.1.43；macOS x64 应为「无启用行」
SELECT DISTINCT ON (os, arch, app) os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch, app, created_at DESC;
