-- 官网客户端下载项
--
-- 只注册 3 条：唯一约束是 (release_group, os, arch, app, version)，
-- 同分组下"同版本同架构"只能有一条，所以 Windows 安装版与免安装版
-- 无法同时登记（两者都是 windows/Windows/x64/0.1.0）。
-- 免安装版文件已上传到 /downloads/，需要时可在后台换成它，或后续按
-- 不同 version/arch 命名再补。
INSERT INTO client_releases (release_group, title, os, arch, app, version, url, enabled, note)
VALUES
  ('windows', 'Windows 安装版',      'Windows', 'x64',   '', '0.1.0',
   'https://pixfanyi.com/downloads/HelloPix-Setup-0.1.0.exe', true, '推荐 · 可选安装目录'),
  ('macos',   'macOS（Apple 芯片）', 'macOS',   'arm64', '', '0.1.0',
   'https://pixfanyi.com/downloads/HelloPix-0.1.0-arm64.dmg', true, '适用于 M 系列芯片'),
  ('macos',   'macOS（Intel 芯片）', 'macOS',   'x64',   '', '0.1.0',
   'https://pixfanyi.com/downloads/HelloPix-0.1.0-x64.dmg', true, '适用于 Intel 芯片')
ON CONFLICT (release_group, os, arch, app, version) DO UPDATE
  SET title = EXCLUDED.title,
      note = EXCLUDED.note,
      url = EXCLUDED.url,
      enabled = true,
      updated_at = now();
