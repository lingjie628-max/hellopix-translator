'use strict'

/**
 * 云编译工作流的回归测试。
 *
 * 为什么需要：`build-telegram.yml` 里的几处守卫，每一个都是实测烧掉几小时才换来的
 * （见 docs/方案设计.md 的 2026-09-14 条目）。它们只写在注释里的话，任何人一次
 * "顺手简化"就会让同样的坑原样重现，而且重现时同样没有报错、只有诡异的挂起或崩溃。
 *
 * 另一个同等重要的理由：工作流原本只存在于 `.ci-build/` —— 那是被 .gitignore 排除的
 * 独立仓库。主仓库那份补丁包的注释写着"补丁包正文在主仓库 standalone 那份，
 * .ci-build 是镜像"，但工作流没遵守这个约定，等于整条流水线在主仓库里没有版本控制，
 * 重新克隆一次就没了。这里把"standalone 是正文、.ci-build 是镜像"固化成断言。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const SOURCE = path.join(__dirname, '..', 'standalone', 'telegram-win', 'tdesktop-fork', 'build-telegram.yml')
const CI_MIRROR = path.join(__dirname, '..', '.ci-build', '.github', 'workflows', 'build-telegram.yml')

const workflow = fs.readFileSync(SOURCE, 'utf8')

function has(pattern, label) {
  assert.match(workflow, pattern, label)
}

function lacks(pattern, label) {
  assert.doesNotMatch(workflow, pattern, label)
}

/**
 * 断言只打在真正会被执行的 YAML 值上。
 * 文件里注释很密，用宽泛的词（比如单个 "silent"）会被注释命中，测试就形同虚设。
 */

test('工作流在主仓库有正文，且与 .ci-build 镜像逐字节一致', {
  skip: !fs.existsSync(CI_MIRROR)
}, () => {
  assert.equal(
    fs.readFileSync(CI_MIRROR, 'utf8'),
    workflow,
    'build-telegram.yml 两份不一致；改完请同步到 .ci-build/.github/workflows/，否则云编译跑的和你以为的不是同一份'
  )
})

test('prepare 必须传 silent，否则 Stale 的 stage 会挂在交互提示上', () => {
  // run 34791050283 实测挂了 37 分钟直到步骤超时，日志里一个字都没有
  has(
    /call D:\\tdesktop\\Telegram\\build\\prepare\\win\.bat silent/,
    'prepare 必须带 silent：prepare.py 遇到 Stale 的 stage 会 print 提示并 getch() 死等键盘'
  )
  lacks(
    /win\.bat\s*$/m,
    '不能存在不带参数的 win.bat 调用：那会在 CI 上永久挂起'
  )
})

test('msbuild 输出必须重定向到文件，不能直接流给 runner', () => {
  // run 34793229857 跑了 2h15m 后 runner 的 SecretMasker 栈溢出，成果全丢且日志取不回
  has(
    /msbuild Telegram\.slnx[^\n]*> "%GITHUB_WORKSPACE%\\msbuild\.log"/,
    'msbuild 输出要重定向到文件；直接输出会让 runner 的密钥脱敏器被几万行日志压垮'
  )
  has(
    /name: Upload msbuild log when the build failed/,
    '失败时要把完整 msbuild 日志作为 artifact 带出来，否则连报错都看不到'
  )
})

test('构建超时必须够长：实测约 185~215 分钟，2 核机器上更久', () => {
  const buildStep = workflow.slice(workflow.indexOf('name: Build Telegram.exe'))
  const match = buildStep.match(/timeout-minutes:\s*(\d+)/)
  assert.ok(match, '构建步骤必须有 timeout-minutes')
  const minutes = Number(match[1])
  assert.ok(
    minutes >= 300,
    `构建超时 ${minutes} 分钟太短：实测编译需要 185~215 分钟（2 核更久），`
      + '超时一次就是白烧 3 小时 + 约 700 计费分钟'
  )
  // 平台对托管 runner 的硬上限是 6 小时，作业级必须留出余量
  const jobMatch = workflow.match(/^ {4}timeout-minutes:\s*(\d+)/m)
  assert.ok(jobMatch && Number(jobMatch[1]) <= 355, '作业级超时必须 ≤ 355，给 6 小时硬上限留余量')
})

test('凭据门禁必须拦在编译之前，且测试凭据模式不产出 artifact', () => {
  has(
    /if not "%APIID%"=="" if not "%APIHASH%"=="" goto :realcreds/,
    '缺少凭据门禁：官方测试凭据编出来的包用户一登录就报内部错误'
  )
  has(/exit \/b 1/, '门禁必须真的让步骤失败')

  // 判定结果要写两处：$GITHUB_ENV 给 shell 用，$GITHUB_OUTPUT 给 if 用。
  // 官方文档只承诺 GITHUB_ENV 的变量"后续步骤能访问"，没明确 if 里的 env 上下文
  // 能不能看到；押错的代价是编了 2 小时却没有 artifact。所以两条路都留着。
  has(/echo PIX_CRED_MODE=production>> %GITHUB_ENV%/, '要写 $GITHUB_ENV')
  has(/echo mode=production>> %GITHUB_OUTPUT%/, '要写 $GITHUB_OUTPUT')

  has(
    /if: env\.PIX_CRED_MODE == 'production' \|\| steps\.creds\.outputs\.mode == 'production'/,
    'artifact 上传必须限定真凭据模式，且 env 与 steps.outputs 取或，任一机制生效即可'
  )
  has(
    /name: Fail loudly when no artifact was produced/,
    '测试凭据模式最后要显式报错，避免"绿色的失败"'
  )
  has(
    /if: env\.PIX_CRED_MODE != 'production' && steps\.creds\.outputs\.mode != 'production'/,
    '报错条件要与上传条件严格互补，否则会出现"没上传也不报错"的绿色失败'
  )
  has(/id: creds/, '门禁步骤要有 id，步骤输出才有地方挂')
})

test('缓存守卫：命中就跳过 prepare，且保存条件不能误触发', () => {
  has(
    /if: steps\.libs-cache\.outputs\.cache-hit != 'true'/,
    'prepare 需要 cache-hit 守卫'
  )
  // 这条曾经写成 != 'true'：restore 被跳过时输出是空串，always() 会把保存也拉起来，
  // 在 D:\Libraries 根本不存在的情况下白试一次并报 Cache save failed
  has(
    /if: always\(\) && steps\.libs-cache\.outputs\.cache-hit == 'false'/,
    "保存条件必须是 == 'false'，不能用 != 'true'"
  )
})

test('三方库缓存路径必须在 repo 的上一级（prepare.py 的 rootDir = D:\\）', () => {
  has(/D:\\Libraries/, '缓存必须包含 D:\\Libraries')
  has(/D:\\ThirdParty/, '缓存必须包含 D:\\ThirdParty')
  has(/LIBS_CACHE_KEY:/, '缓存 key 要集中在一处，换版本时只改一个地方')
})

test('必须限制并发编译器数，否则多核 runner 会内存耗尽', () => {
  // run 34848304108 / 34851186939 / 34861189904 连续三轮都死在编译阶段，
  // 错误码只有内存类三种、没有任何真实编译错误：
  //   C1060 compiler is out of heap space
  //   C3859 Failed to create virtual memory for PCH
  //         → system returned code 1455: The paging file is too small
  //   C1076 compiler limit: internal heap limit reached
  // 1455 = ERROR_COMMITMENT_LIMIT。
  //
  // 关键是**并发层数有两层，会相乘**：
  //   msbuild 的 /m 不带数字 -> 同时编多个【项目】
  //   CMake 的 /MP           -> 每个项目内再同时编多个【文件】
  // 最坏能同时跑 8 个 cl.exe，每个都要映射那份巨大的 PCH。
  has(
    /CMAKE_CXX_MP_PROCESSOR_COUNT=1/,
    'configure 必须把 /MP 压到 1：tdesktop 的 PCH 极大，并发映射会撑爆提交上限'
  )
  has(
    /msbuild Telegram\.slnx[^\n]*\/m:2/,
    'msbuild 必须用 /m:2 而不是裸 /m —— 裸 /m 会并发多个项目，和 /MP 相乘'
  )
  has(
    /name: Report and enlarge the page file/,
    '要有调大页面文件的步骤：错误信息明说 "The paging file is too small"，'
      + '这是唯一能直接抬高提交上限的手段'
  )
})
