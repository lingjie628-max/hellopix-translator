'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { buildUserAgent } = require('../desktop/src/config/user-agent')

test('User-Agent 使用当前内核版本并保留 Hello Pix 应用标识', () => {
  const ua = buildUserAgent({
    platform: 'darwin',
    appVersion: '1.3.14',
    electronVersion: '45.4.1',
    chromeVersion: '156.0.8078.100'
  })
  assert.match(ua, /Macintosh; Intel Mac OS X/)
  assert.match(ua, /HelloPix\/1\.3\.14/)
  assert.match(ua, /Chrome\/156\.0\.8078\.100/)
  assert.match(ua, /Electron\/45\.4\.1/)
  assert.doesNotMatch(ua, /Chrome\/131\.0\.0\.0/, '不能继续冒充旧版 Chrome')
})

test('Windows 与 Linux 不能伪装成 macOS', () => {
  const win = buildUserAgent({
    platform: 'win32', appVersion: '1.3.14', electronVersion: '45.4.1', chromeVersion: '156.0.8078.100'
  })
  const linux = buildUserAgent({
    platform: 'linux', appVersion: '1.3.14', electronVersion: '45.4.1', chromeVersion: '156.0.8078.100'
  })
  assert.match(win, /Windows NT 10\.0; Win64; x64/)
  assert.doesNotMatch(win, /Macintosh/)
  assert.match(linux, /X11; Linux x86_64/)
  assert.doesNotMatch(linux, /Macintosh/)
})
