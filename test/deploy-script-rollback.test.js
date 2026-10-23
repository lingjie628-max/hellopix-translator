/**
 * deploy/deploy-code.sh 远端切换逻辑的回归测试
 *
 * 为什么必须测：这段逻辑跑在**生产机**上，本地测试环境永远不会执行到它。
 * 之前它有一个静默的灾难性问题 ——
 *
 *   `node --check $f || { echo ...; node --check $f; rollback; }`
 *
 * 花括号组里的第二条 node 同样失败，组返回值非 0，`set -e` 在**进入 rollback 之前**
 * 就把整个会话掐了。结果：新目录已经搬上线（半成品），备份原地不动，没人回滚，
 * 服务起不来，运维只能上机器手动收拾。把它抽出来真跑一遍才能抓到。
 *
 * 另一个已修的问题：每轮循环 `rm -rf $APP/.tmp-$d` 先把上一版副本删了，
 * 后面任何一步失败都没有可回滚的东西；同时 .tmp-* 从不清理，磁盘单向增长。
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'deploy', 'deploy-code.sh')
const REMOTE = path.join(ROOT, 'deploy', 'remote-deploy.sh')
const src = fs.readFileSync(SCRIPT, 'utf8')

/**
 * 取远端执行体。
 *
 * 2026-10-23 之前远端逻辑是内联在 deploy-code.sh 的双引号字符串里的，
 * 这里靠 indexOf('set -e; export LC_ALL=C.UTF-8') 抠出来再还原转义。
 *
 * 那样写有两个硬伤：
 *   1. 每个变量都得写 \$VAR，漏一个就被**本地** shell 提前展开。
 *      我加保留逻辑时漏了几个，本地 $f 未绑定 → set -u 退出 → 部署中断。
 *      报错指向本地那行 ssh，真正的问题在 40 行之外。
 *   2. 测试也得跟着还原转义，两边一旦不同步，测的就是一份不存在的脚本。
 *
 * 现在远端逻辑是独立文件 deploy/remote-deploy.sh，直接读即可。
 * 这里保留一层兜底：万一有人又改回内联，断言会明确报出来，
 * 而不是悄悄测了个空字符串（那样所有"不包含 X"的断言都会假绿）。
 */
function remoteBody() {
  assert.ok(fs.existsSync(REMOTE), 'deploy/remote-deploy.sh 不存在了')
  const body = fs.readFileSync(REMOTE, 'utf8')
  assert.ok(body.length > 500, '远端脚本内容异常短，测试会假绿')
  // 脱敏线：确认它确实是可执行的完整脚本，不是被清空的壳
  assert.match(body, /rollback\(\)/u, '远端脚本里找不到 rollback()')
  return body
}

function mkExec(file, body) {
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-rollback-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // 生产机上 systemctl / journalctl 存在；这里只关心切换流程。
  //
  // ⚠️ `systemctl is-active hello-pix` 必须输出 "active"。
  // 之前桩写的是 `exit 0`（什么都不输出），而远端脚本最后判的是
  //   [ "$(systemctl is-active hello-pix)" != active ] && rollback
  // 空输出 ≠ "active" → 每次部署都被判定为失败并回滚。
  // 结果是"部署看起来成功、文件其实退回旧版" —— 测试里表现为
  // server/index.js 还是 OLD。这种桩比没有桩更危险。
  mkExec(path.join(bin, 'systemctl'),
    '#!/bin/sh\ncase "$1" in is-active) echo active ;; *) : ;; esac\nexit 0\n')
  mkExec(path.join(bin, 'journalctl'), '#!/bin/sh\nexit 0\n')
  fs.writeFileSync(path.join(dir, 'remote.sh'), remoteBody())
  return {
    dir,
    app: path.join(dir, 'app'),
    env: Object.assign({}, process.env, {
      PATH: bin + ':' + process.env.PATH,
      APP: path.join(dir, 'app'),
      // 生产上等 5 秒让服务起来；测试里服务是假的，不用等
      POST_RESTART_WAIT: '0'
    })
  }
}

/** 造一个"已经在生产上跑着"的旧版本目录 */
function seedOld(sb) {
  for (const d of ['server', 'migrations', 'dist', 'scripts']) fs.mkdirSync(path.join(sb.app, d), { recursive: true })
  fs.writeFileSync(path.join(sb.app, 'server', 'index.js'), 'module.exports = "OLD"\n')
  fs.writeFileSync(path.join(sb.app, 'migrations', '001.js'), '// OLD\n')
  fs.writeFileSync(path.join(sb.app, 'dist', 'app.js'), 'OLD\n')
  fs.writeFileSync(path.join(sb.app, 'scripts', 'migrate.js'), '// OLD\n')
}

/** 造一个发布包并 tar 起来 */
function pack(sb, files) {
  const pkg = path.join(sb.dir, 'pkg')
  fs.rmSync(pkg, { recursive: true, force: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pkg, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const tgz = path.join(sb.dir, 'release.tgz')
  const dirs = [...new Set(Object.keys(files).map((f) => f.split('/')[0]))]
  execFileSync('tar', ['-czf', tgz, '-C', pkg, ...dirs], { stdio: 'ignore' })
  return fs.readFileSync(tgz)
}

function run(sb, tarball) {
  try {
    const out = execFileSync('bash', [path.join(sb.dir, 'remote.sh')], {
      cwd: sb.dir,
      env: sb.env,
      input: tarball,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { code: 0, out: `${out}` }
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

const read = (p) => fs.readFileSync(p, 'utf8')
const leftovers = (sb) =>
  fs.readdirSync(sb.app).filter((n) => n === '.bak' || n === '.incoming')

test('有语法错误的新代码必须被回滚，线上目录保持旧版且不留备份残留', () => {
  const sb = sandbox()
  try {
    seedOld(sb)
    const tgz = pack(sb, {
      'server/index.js': 'function broken( {\n',
      'scripts/migrate.js': '// NEW\n'
    })
    const r = run(sb, tgz)

    assert.notStrictEqual(r.code, 0, '语法错误还返回成功？')
    assert.match(r.out, /回滚/, '根本没有触发回滚')
    assert.match(read(path.join(sb.app, 'server', 'index.js')), /OLD/,
      '线上 server/index.js 还是半成品 —— 回滚没被执行')
    assert.match(read(path.join(sb.app, 'dist', 'app.js')), /OLD/, '新包没带 dist，旧 dist 被动了')
    assert.deepStrictEqual(leftovers(sb), [], '回滚成功后 .bak/.incoming 必须清掉，否则每次失败都留一整份')
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

test('按目录滚动覆盖的 .tmp-* 备份方式已经移除（它会让回滚无从谈起并撑爆磁盘）', () => {
  const body = remoteBody()
  assert.ok(!/\.tmp-/.test(body), '远端脚本里还在用 .tmp-$d：备份被下一轮循环删掉，失败时无路可退')
})

test('rollback 里必须关掉 set -e，否则中途失败会停在半路', () => {
  const body = remoteBody()
  const start = body.indexOf('rollback() {')
  // 用"下一个顶格 }"来界定函数体，不依赖具体缩进。
  // 原先用 '\n}\n' 找结尾，但函数后面紧跟注释时也能命中；
  // 真正脆的是变量写法（$BAK/$d 与 "$BAK/$d"），所以下面用正则容忍引号。
  const end = body.indexOf('\n}\n', start)
  const rb = body.slice(start, end)
  assert.ok(start > 0 && rb.length > 0, '找不到 rollback 函数')
  assert.match(rb, /set \+e/, 'rollback 没关 set -e：中途任一步失败就停在半路，目录可能空着')
  assert.match(rb, /mv\s+"?\$BAK\/\$d"?\s+"?\$APP\/\$d"?/,
    'rollback 没把备份移回来')
})

test('新包缺目录时保留线上旧目录，不做删除', () => {
  const sb = sandbox()
  try {
    seedOld(sb)
    const tgz = pack(sb, {
      'server/index.js': 'module.exports = "NEW"\n',
      'scripts/migrate.js': '// NEW\n'
    })
    run(sb, tgz)
    assert.equal(read(path.join(sb.app, 'server', 'index.js')), 'module.exports = "NEW"\n')
    assert.match(read(path.join(sb.app, 'dist', 'app.js')), /OLD/,
      '新包没带 dist，旧 dist 必须原样保留（否则前端当场 404）')
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

// ── 2026-10-23 生产中断的回归 ──────────────────────────────────────────

test('生产独有、仓库没有的 scripts/ 文件必须被保留', () => {
  // 事故：生产上有 scripts/preflight.sh，被 systemd 引用为 ExecStartPre，
  // 但仓库里没有。部署把 scripts/ 整目录替换 → 它被删 → 203/EXEC → 全站 000。
  const sb = sandbox()
  try {
    seedOld(sb)
    // 生产上多一个仓库没有的文件，且必须保持可执行
    const prodOnly = path.join(sb.app, 'scripts', 'preflight.sh')
    fs.writeFileSync(prodOnly, '#!/bin/sh\necho preflight\n')
    fs.chmodSync(prodOnly, 0o755)

    const tgz = pack(sb, {
      'server/index.js': 'module.exports = "NEW"\n',
      'scripts/migrate.js': '// NEW\n'   // 注意：包里没有 preflight.sh
    })
    const r = run(sb, tgz)

    assert.ok(fs.existsSync(prodOnly), '生产独有的 scripts/preflight.sh 被删了 —— 服务会起不来')
    const mode = fs.statSync(prodOnly).mode & 0o777
    assert.strictEqual(mode, 0o755, `保留下来但权限变成 ${mode.toString(8)} 了，systemd 会 203/EXEC`)
    assert.match(r.out, /保留生产独有/, '没有把"保留了哪些文件"打出来，出事时无从判断')
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

test('仓库里有的 scripts/ 文件以仓库为准（升级），不被旧版保留逻辑挡住', () => {
  const sb = sandbox()
  try {
    seedOld(sb)
    const tgz = pack(sb, {
      'server/index.js': 'module.exports = "NEW"\n',
      'scripts/migrate.js': '// NEW VERSION\n'
    })
    run(sb, tgz)
    assert.match(read(path.join(sb.app, 'scripts', 'migrate.js')), /NEW VERSION/,
      '同名文件必须升级成仓库版本，否则修复永远发不出去')
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})

test('scripts/*.sh 在部署后必须仍是可执行（chmod 644 一刀切会弄挂 systemd）', () => {
  // 第二次中断就是这条：find ... -exec chmod 644 把 .sh 的执行位也抹了。
  const sb = sandbox()
  try {
    seedOld(sb)
    const tgz = pack(sb, {
      'server/index.js': 'module.exports = "NEW"\n',
      'scripts/migrate.js': '// NEW\n',
      'scripts/preflight.sh': '#!/bin/sh\nexit 0\n'
    })
    run(sb, tgz)
    const sh = path.join(sb.app, 'scripts', 'preflight.sh')
    assert.ok(fs.statSync(sh).mode & 0o100, `.sh 丢了属主执行位（${(fs.statSync(sh).mode & 0o777).toString(8)}）`)
  } finally {
    fs.rmSync(sb.dir, { recursive: true, force: true })
  }
})
