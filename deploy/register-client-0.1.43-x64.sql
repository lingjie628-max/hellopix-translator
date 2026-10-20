-- 补登 0.1.43 的 Intel Mac（x64）发布记录。
--
-- 上一版 0.1.42 交付时 x64 包是有的；本次首轮构建后 release 目录里只剩
-- arm64，所以我先让 Intel 用户留在 0.1.42 做回退。现在 x64 包已补齐，
-- 主二进制实测为 Mach-O x86_64，asar 内 app.js 已含 attachTabsWheel，
-- 上传后本地与远端 SHA256 一致（f0deaa3d…）。
--
-- 每个 (release_group, os, arch) 只能留一条 enabled=true，否则更新接口
-- 返回哪一条取决于排序，会出现"有的用户收到新版、有的收不到"。
BEGIN;

INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note) VALUES
  ('macos', 'macOS（Intel 芯片）', 'macOS', 'x64', '', '0.1.43',
   'https://pixfanyi.com/downloads/HelloPix-0.1.43-x64.dmg', true,
   '本次更新：顶部标签栏现在可以用鼠标滚轮直接左右滚动，不用再去拖那条细滚动条。滚到最左或最右就会停住，不会再"滚不动也卡着"；触控板横向滑动和 Shift+滚轮保持系统原本的手感。macOS 首次打开可能需要在系统安全设置中手动允许（安装包内附详细操作说明）')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      url = EXCLUDED.url,
      enabled = EXCLUDED.enabled,
      note = EXCLUDED.note,
      updated_at = now();

-- 停用 Intel 的旧版本（0.1.43 已是启用态，不能再被这条 UPDATE 关掉）
UPDATE client_releases
   SET enabled = false, updated_at = now()
 WHERE os = 'macOS' AND arch = 'x64' AND version <> '0.1.43' AND enabled;

COMMIT;

-- 核对：三个平台应全部是 0.1.43，且每个 (os, arch) 只有一条启用行
SELECT DISTINCT ON (os, arch, app) os, arch, version, enabled, url
FROM client_releases WHERE enabled
ORDER BY os, arch, app, created_at DESC;
