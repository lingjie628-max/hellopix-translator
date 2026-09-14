'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const { BRIDGE_NAME, buildBridge, writeBridge, writeBridges } = require('../standalone/telegram-win/lib/bridge')

// 随包发出的 Windows 诊断脚本必须满足两个容易在编辑中被破坏的条件。
// 两个都是实测踩过的：$args 是 PowerShell 自动变量；无 BOM 的 UTF-8 会被
// PowerShell 5.1 按 ANSI 解析，脚本里二十多处中文输出会全变乱码。
test('诊断.ps1 保持 UTF-8 BOM 且不占用 PowerShell 自动变量', () => {
  const file = path.join(__dirname, '..', 'standalone', 'telegram-win', '诊断.ps1')
  const raw = fs.readFileSync(file)
  assert.equal(
    raw.subarray(0, 3).toString('hex'),
    'efbbbf',
    '诊断.ps1 的 UTF-8 BOM 丢了：PowerShell 5.1 会把中文按 ANSI 解析成乱码。'
      + '很多编辑器保存时会静默去掉 BOM，改完这个文件请确认前三个字节是 ef bb bf'
  )
  const text = raw.toString('utf8').replace(/^\uFEFF/, '')
  assert.doesNotMatch(
    text,
    /\$args\b/,
    '$args 是 PowerShell 的自动变量，不能拿来存自己的参数（用 $reqArgs）'
  )
  assert.match(text, /GetResponseStream/, '要保留 5.1 的响应体读取路径')
  assert.match(text, /ReadAsStringAsync/, '要保留 7.x 的响应体读取路径')
})

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
  // 引擎默认是空串，不是某个具体通道名：
  // 空串会被原样写进 bridge 文件，服务端按 falsy 回退到账号当前通道。
  // 硬编码 'youdao' 在未接通该通道时会 503 静默失败（气泡永远不出译文）。
  assert.equal(data.engine, '')
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

const APPLY_PY = path.join(__dirname, '../standalone/telegram-win/tdesktop-fork/apply.py')

// apply.py 的锚点是按 tdesktop v7.2.8 真实源码形状校准的（CMakeLists 四空格缩进、
// C++ 源码制表符缩进、core/version.h 里 AppVersionStr = "7.2.8"）。
// fixture 必须复刻这套缩进，否则测的就不是线上真正会走的那条主锚点分支。
const VERSION_H = [
  'constexpr auto AppVersionStr = "7.2.8";',
  ''
].join('\n')

const CMAKE_LISTS = [
  '    lang/translate_url_provider.cpp',
  '    lang/translate_url_provider.h',
  '    layout/layout_item_base.cpp',
  ''
].join('\n')

const PROVIDER_CPP = [
  '#include "lang/translate_url_provider.h"',
  '#include "platform/platform_translate_provider.h"',
  '',
  'std::unique_ptr<TranslateProvider> CreateTranslateProvider(',
  '\t\tnot_null<Main::Session*> session) {',
  '\tconst auto urlTemplate = OptionTranslateUrlTemplate.value();',
  '\treturn CreateMTProtoTranslateProvider(session);',
  '}',
  ''
].join('\n')

const TRACKER_CPP = [
  '#include "lang/translate_provider.h"',
  '#include "main/main_session.h"',
  '',
  'void TranslateTracker::setup() {',
  '\t_trackingLanguage = rpl::combine(',
  '\t\tCore::App().settings().translateChatEnabledValue(),',
  '\t\tData::AmPremiumValue(&_history->session()),',
  '\t\tstd::move(autoTranslationValue),',
  '\t\t_1 && (_2 || _3));',
  '\t_trackingLanguage.value() | rpl::on_next([=](bool tracking) {',
  '\t}, _lifetime);',
  '}',
  '',
  'bool TranslateTracker::shouldTranslate(not_null<Element*> view) {',
  '\tconst auto item = view->data();',
  '\tExpects(_addedInBunch >= 0);',
  '\tif ((item->out() && !item->history()->peer->autoTranslation())',
  '\t\t|| item->isService()',
  '\t\t|| !item->isRegular()',
  '\t\t|| item->isOnlyEmojiAndSpaces()) {',
  '\t\treturn false;',
  '\t}',
  '\tif (item->translationShowRequiresCheck(_bunchTranslatedTo)) {',
  '\t\treturn true;',
  '\t}',
  '\treturn false;',
  '}',
  ''
].join('\n')

function makeTdesktopTree(version = '7.2.8') {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-tdesktop-'))
  const lang = path.join(tree, 'Telegram', 'SourceFiles', 'lang')
  const view = path.join(tree, 'Telegram', 'SourceFiles', 'history', 'view')
  const core = path.join(tree, 'Telegram', 'SourceFiles', 'core')
  fs.mkdirSync(lang, { recursive: true })
  fs.mkdirSync(view, { recursive: true })
  fs.mkdirSync(core, { recursive: true })
  fs.writeFileSync(
    path.join(core, 'version.h'),
    version === '7.2.8'
      ? VERSION_H
      : `constexpr auto AppVersionStr = "${version}";\n`
  )
  fs.writeFileSync(path.join(tree, 'Telegram', 'CMakeLists.txt'), CMAKE_LISTS)
  fs.writeFileSync(path.join(lang, 'translate_provider.cpp'), PROVIDER_CPP)
  fs.writeFileSync(path.join(view, 'history_view_translate_tracker.cpp'), TRACKER_CPP)
  return { tree, lang, view }
}

// 测试必须走"非 CI"分支，否则 apply.py 会尝试 git checkout 固定 tag。
function applyEnv() {
  const env = { ...process.env }
  delete env.GITHUB_ACTIONS
  // 夹具树没有 .git；挡住 git 向上遍历，免得把外层仓库的 HEAD 当成源码树版本
  env.GIT_CEILING_DIRECTORIES = os.tmpdir()
  return env
}

test('tdesktop apply script inserts Hello Pix hooks', () => {
  const { tree, lang, view } = makeTdesktopTree()

  const applied = spawnSync('python3', [APPLY_PY, tree], {
    encoding: 'utf8',
    env: applyEnv()
  })
  assert.equal(applied.status, 0, applied.stdout + applied.stderr)
  const cmake = fs.readFileSync(path.join(tree, 'Telegram', 'CMakeLists.txt'), 'utf8')
  const provider = fs.readFileSync(path.join(lang, 'translate_provider.cpp'), 'utf8')
  const tracker = fs.readFileSync(path.join(view, 'history_view_translate_tracker.cpp'), 'utf8')
  assert.match(cmake, /hello_pix_translate_provider\.cpp/)
  assert.match(cmake, /hello_pix_translate_provider\.h/)
  assert.match(provider, /#include "lang\/hello_pix_translate_provider\.h"/)
  assert.match(provider, /CreateHelloPixTranslateProvider/)
  assert.match(tracker, /HelloPixShouldTranslateIncoming/)
  assert.match(tracker, /HelloPixShouldTranslateGroup/)
  assert.match(tracker, /HelloPixShouldTranslateSend/)
  // 追踪开关必须用 ShouldTrackTranslation（transRecv || transSend），不能用
  // ShouldTranslateIncoming：后者只认 transRecv，会让"关掉接收翻译、只留发送
  // 翻译"的用户连自己发出去的消息也翻不了，而且是静默的。
  assert.match(tracker, /HelloPixShouldTrackTranslation/)
  assert.doesNotMatch(
    tracker,
    /if \(Ui::HelloPixShouldTranslateIncoming\(\)\) \{\n\t\t_trackingLanguage/,
    '追踪开关不能退回只认 transRecv 的版本'
  )
  assert.equal(fs.existsSync(path.join(lang, 'hello_pix_translate_provider.cpp')), true)
  assert.equal(fs.existsSync(path.join(lang, 'hello_pix_translate_provider.h')), true)

  // 幂等：同一棵源码树再打一次补丁必须仍然成功且不重复注入。
  const again = spawnSync('python3', [APPLY_PY, tree], {
    encoding: 'utf8',
    env: applyEnv()
  })
  assert.equal(again.status, 0, again.stdout + again.stderr)
  const trackerAgain = fs.readFileSync(
    path.join(view, 'history_view_translate_tracker.cpp'),
    'utf8'
  )
  assert.equal(
    trackerAgain.split('HelloPixShouldTranslateSend').length - 1,
    1,
    '重复执行不应二次注入发送翻译开关'
  )
})

test('tdesktop apply script refuses an unpinned tdesktop version', () => {
  const { tree } = makeTdesktopTree('7.2.9')

  const applied = spawnSync('python3', [APPLY_PY, tree], {
    encoding: 'utf8',
    env: applyEnv()
  })
  assert.notEqual(applied.status, 0, '非锚点版本必须 fail-closed，不能带错版本编下去')
  assert.match(applied.stdout + applied.stderr, /版本|7\.2\.8/)
})

// apply.py 只比 AppVersionStr 是不够的：dev 分支发版后一段时间里版本号同样是 7.2.8，
// 于是"版本已匹配"会放行一棵与 tag 无关的快照（2026-09-11 云编译就是这么编上 dev 的）。
// 所以 git 目录必须再比 HEAD；这里把那条 fail-closed 固化下来。
test('tdesktop apply script rejects a dev snapshot that only shares the version number', {
  skip: spawnSync('git', ['--version']).status !== 0
}, () => {
  const { tree } = makeTdesktopTree('7.2.8')
  const git = (args) => {
    const done = spawnSync('git', args, { cwd: tree, encoding: 'utf8' })
    assert.equal(done.status, 0, `git ${args.join(' ')} 失败: ${done.stderr}`)
  }
  git(['init', '-q'])
  git(['config', 'user.email', 'test@local'])
  git(['config', 'user.name', 'test'])
  git(['add', '-A'])
  git(['commit', '-qm', 'v7.2.8 tree'])
  git(['tag', 'v7.2.8'])
  git(['commit', '-q', '--allow-empty', '-m', 'dev ahead'])

  const applied = spawnSync('python3', [APPLY_PY, tree], {
    encoding: 'utf8',
    env: applyEnv()
  })
  assert.notEqual(applied.status, 0, '版本号相同但 HEAD 不是 v7.2.8 tag 时必须拒绝')
  assert.match(
    applied.stdout + applied.stderr,
    /272f6f5c/,
    '报错里要写清期望的锚点 commit，方便定位'
  )
})

// 2026-09-11 云编译 [28/34] 挂在 breakpad 链接：LNK1104 cannot open file 'atls.lib'。
// 原因是 dump_syms 用 v143(14.44) 工具集编，链接器按该工具集自己的路径找 ATL，
// 而镜像上 ATL 只装在 14.51 下 —— 只补共享 VC\atlmfc 救不了这条库路径。
// 这条判定逻辑纯路径运算，可以在 mac 上直接测。
test('atl detection flags toolsets whose atlmfc is missing or partial', {
  skip: spawnSync('python3', ['--version']).status !== 0
}, () => {
  const vs = fs.mkdtempSync(path.join(os.tmpdir(), 'pix-vs-'))
  const writeKit = (root) => {
    fs.mkdirSync(path.join(root, 'include'), { recursive: true })
    fs.mkdirSync(path.join(root, 'lib', 'x64'), { recursive: true })
    for (const name of ['atlbase.h', 'atlcomcli.h']) {
      fs.writeFileSync(path.join(root, 'include', name), '')
    }
    fs.writeFileSync(path.join(root, 'lib', 'x64', 'atls.lib'), '')
  }
  const msvc = path.join(vs, 'VC', 'Tools', 'MSVC')
  writeKit(path.join(msvc, '14.51.36231', 'atlmfc')) // 镜像上唯一完整的一份
  fs.mkdirSync(path.join(msvc, '14.44.35207'), { recursive: true }) // 实际编译用的 v143，没有 atlmfc
  writeKit(path.join(msvc, '14.40.00000', 'atlmfc', 'include')) // 只有头文件的半残工具集

  const script = [
    'import importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('kit', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'from pathlib import Path',
    'print(json.dumps(sorted(p.parent.name for p in m.toolsets_missing_atl(Path(sys.argv[2])))))'
  ].join('\n')
  const done = spawnSync('python3', ['-c', script, APPLY_PY, vs], { encoding: 'utf8' })
  assert.equal(done.status, 0, done.stderr)
  assert.deepEqual(
    JSON.parse(done.stdout.trim()),
    ['14.40.00000', '14.44.35207'],
    '缺 ATL 的工具集必须全部被点名，完整的那个不能误报'
  )
})

// .ci-build/tdesktop-fork 是推给 GitHub Actions 的镜像工作副本（未纳入主仓库版本控制）。
// 两份补丁包曾经分叉：CI 那份缺发送翻译钩子、standalone 那份 ATL 逻辑旧，
// 结果是"云编译出来的 exe 和本地源码不是一份东西"。这里把它固化成回归。
// 镜像目录不存在时（例如干净 clone）跳过，不影响主仓库独立可用。
const CI_KIT = path.join(__dirname, '../.ci-build/tdesktop-fork')
const MIRRORED_KIT_FILES = [
  'apply.py',
  'hello_pix_translate_provider.cpp',
  'hello_pix_translate_provider.h',
  'APPLY.txt'
]

test('ci patch kit mirrors the standalone tdesktop kit', {
  skip: !fs.existsSync(CI_KIT)
}, () => {
  const standalone = path.join(__dirname, '../standalone/telegram-win/tdesktop-fork')
  for (const name of MIRRORED_KIT_FILES) {
    const ciFile = path.join(CI_KIT, name)
    const localFile = path.join(standalone, name)
    assert.equal(fs.existsSync(ciFile), true, `CI 镜像缺少 ${name}`)
    assert.equal(
      fs.readFileSync(ciFile, 'utf8'),
      fs.readFileSync(localFile, 'utf8'),
      `${name} 在两份补丁包之间不一致；改完请同步，否则云编译产物与本地源码不符`
    )
  }
})
