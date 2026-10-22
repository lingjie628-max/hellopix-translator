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
const src = fs.readFileSync(SCRIPT, 'utf8')

/** 从 deploy-code.sh 里抠出 ssh 的远端请求体，并把本地转义还原 */
function remoteBody() {
  const start = src.indexOf('set -e; export LC_ALL=C.UTF-8')
  const endMarker = 'ls -ld $APP | sed \'s/^/  /\'\n"'
  const end = src.indexOf(endMarker)
  assert.ok(start > 0 && end > start, '远端请求体的边界变了，测试需要同步更新')
  return (src.slice(start, end) + "ls -ld $APP | sed 's/^/  /'\n")
    .replace(/\\"/g, '"')
    .replace(/\\\$/g, '$')
}

function mkExec(file, body) {
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-rollback-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // 生产机上 systemctl / journalctl 存在；这里只关心切换流程
  mkExec(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n')
  mkExec(path.join(bin, 'journalctl'), '#!/bin/sh\nexit 0\n')
  fs.writeFileSync(path.join(dir, 'remote.sh'), remoteBody())
  return {
    dir,
    app: path.join(dir, 'app'),
    env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, APP: path.join(dir, 'app') })
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
  const rb = body.slice(start, body.indexOf('\n}\n', start))
  assert.ok(start > 0 && rb.length > 0, '找不到 rollback 函数')
  assert.match(rb, /set \+e/, 'rollback 没关 set -e：中途任一步失败就停在半路，目录可能空着')
  assert.ok(rb.indexOf('mv $BAK/$d $APP/$d') > 0, 'rollback 没把备份移回来')
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
