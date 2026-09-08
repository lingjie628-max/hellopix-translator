'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { BRIDGE_NAME, buildBridge, writeBridge, writeBridges } = require('../standalone/telegram-win/lib/bridge')

test('bridge json keeps api, cookies and translation prefs', () => {
  const data = buildBridge({
    apiBase: 'http://192.168.21.136:8080/',
    deviceId: 'dev-1',
    cookies: { pix_session: 'abc', pix_csrf: 'token' },
    prefs: { engine: 'google', lang: 'en', transRecv: true, transSend: false, transGroup: false }
  })
  assert.equal(data.apiBase, 'http://192.168.21.136:8080')
  assert.equal(data.deviceId, 'dev-1')
  assert.equal(data.cookies.pix_session, 'abc')
  assert.equal(data.engine, 'google')
  assert.equal(data.lang, 'en')
  assert.equal(data.transRecv, true)
  assert.equal(data.transSend, false)
  assert.equal(data.transGroup, false)
})

test('bridge defaults stay on for receive, send and group', () => {
  const data = buildBridge({ apiBase: 'http://127.0.0.1:8080' })
  assert.equal(data.engine, 'youdao')
  assert.equal(data.lang, 'zh')
  assert.equal(data.transRecv, true)
  assert.equal(data.transSend, true)
  assert.equal(data.transGroup, true)
})

test('writeBridge puts hello-pix-bridge.json in the telegram workdir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-bridge-'))
  const file = writeBridge(dir, {
    apiBase: 'http://127.0.0.1:8080',
    deviceId: 'x',
    cookies: { pix_session: 's' },
    prefs: { engine: 'youdao', lang: 'zh' }
  })
  assert.equal(path.basename(file), BRIDGE_NAME)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.apiBase, 'http://127.0.0.1:8080')
  assert.equal(saved.cookies.pix_session, 's')
  const files = writeBridges([path.join(dir, 'a'), path.join(dir, 'b')], {
    apiBase: 'http://127.0.0.1:8080'
  })
  assert.equal(files.length, 2)
  assert.equal(fs.existsSync(files[0]), true)
  assert.equal(fs.existsSync(files[1]), true)
})

test('tdesktop apply script inserts Hello Pix hooks', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-tdesktop-'))
  const lang = path.join(tree, 'Telegram', 'SourceFiles', 'lang')
  const view = path.join(tree, 'Telegram', 'SourceFiles', 'history', 'view')
  fs.mkdirSync(lang, { recursive: true })
  fs.mkdirSync(view, { recursive: true })
  fs.writeFileSync(path.join(tree, 'Telegram', 'CMakeLists.txt'), [
    'lang/translate_url_provider.cpp',
    ' lang/translate_url_provider.h',
    ' layout/layout_item_base.cpp',
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(lang, 'translate_provider.cpp'), [
    '#include "lang/translate_url_provider.h"',
    '#include "platform/platform_translate_provider.h"',
    '',
    'std::unique_ptr<TranslateProvider> CreateTranslateProvider(',
    ' not_null<Main::Session*> session) {',
    ' const auto urlTemplate = OptionTranslateUrlTemplate.value();',
    ' return CreateMTProtoTranslateProvider(session);',
    '}',
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(view, 'history_view_translate_tracker.cpp'), [
    '#include "lang/translate_provider.h"',
    '#include "main/main_session.h"',
    '',
    'void TranslateTracker::setup() {',
    ' _trackingLanguage = rpl::combine(',
    ' Core::App().settings().translateChatEnabledValue(),',
    ' Data::AmPremiumValue(&_history->session()),',
    ' std::move(autoTranslationValue),',
    ' _1 && (_2 || _3));',
    ' _trackingLanguage.value() | rpl::on_next([=](bool tracking) {',
    ' }, _lifetime);',
    '}',
    '',
    ' if ((item->out() && !item->history()->peer->autoTranslation())',
    ' || item->isService()',
    ' || !item->isRegular()',
    ' || item->isOnlyEmojiAndSpaces()) {',
    ' return false;',
    ' }',
    ''
  ].join('\n'))

  const applied = spawnSync('python3', [
    path.join(__dirname, '../standalone/telegram-win/tdesktop-fork/apply.py'),
    tree
  ], { encoding: 'utf8' })
  assert.equal(applied.status, 0, applied.stdout + applied.stderr)
  const cmake = fs.readFileSync(path.join(tree, 'Telegram', 'CMakeLists.txt'), 'utf8')
  const provider = fs.readFileSync(path.join(lang, 'translate_provider.cpp'), 'utf8')
  const tracker = fs.readFileSync(path.join(view, 'history_view_translate_tracker.cpp'), 'utf8')
  assert.match(cmake, /hello_pix_translate_provider\.cpp/)
  assert.match(provider, /CreateHelloPixTranslateProvider/)
  assert.match(tracker, /HelloPixShouldTranslateIncoming/)
  assert.match(tracker, /HelloPixShouldTranslateGroup/)
  assert.equal(fs.existsSync(path.join(lang, 'hello_pix_translate_provider.cpp')), true)
})
