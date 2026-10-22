'use strict'

/**
 * 未使用 import 扫描（CLI）。
 *
 * 用法：
 *   node scripts/scan-unused-requires.js
 *   node scripts/scan-unused-requires.js server/routes
 *
 * 退出码：0 = 干净，1 = 有未使用的 import。
 *
 * ## 为什么单独一个脚本
 *
 * `scan-dangling.js` 抓的是"用了但没定义"（拆分时搬走定义、调用点留在原地）。
 * 这个脚本抓的是反面："定义了但没用"。
 *
 * 两个方向都必须扫。拆服务的实际过程是这样的：
 *
 *   1. 把 handler 搬进 service 文件
 *   2. 路由里那段代码没了，但顶部 import 还在
 *   3. node --check 通过、测试全绿、悬空扫描 0 处
 *
 * 第 3 步的"全绿"很有迷惑性 —— 多余的 require 不报错，只是拖慢启动、
 * 骗过阅读者的眼睛（"这里 require 了 crypto，说明用到加密"）、
 * 并在打包时把无关模块拖进来。
 *
 * 上次一口气清掉 5 个（production.js 的 crypto / captcha / parseMilli /
 * formatMilli / USDT_TRC20_CONTRACT），全是拆 auth 和下单服务时留下的。
 * 那种量级说明它不是偶发，是拆分的必然产物 —— 所以必须有工具兜着。
 */

const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const ROOT = path.join(__dirname, '..')
const DEFAULT_DIRS = ['server', 'scripts', 'src', 'desktop', 'migrations']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'coverage', 'vendor'])

/**
 * 收集模块顶层 require 引入的本地名。只处理顶层（函数内的条件 require 先不惹）。
 *
 * 覆盖形态：
 *   const x = require('m')
 *   const { a, b: c } = require('m')
 *   const { a = 1 } = require('m')      ← 默认值也要算绑定
 */
function topLevelRequires(ast) {
  const out = []
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue
    for (const decl of node.declarations) {
      if (!decl.init || decl.init.type !== 'CallExpression') continue
      const callee = decl.init.callee
      if (!callee || callee.type !== 'Identifier' || callee.name !== 'require') continue

      if (decl.id.type === 'Identifier') {
        out.push({ name: decl.id.name, line: (decl.loc && decl.loc.start.line) || 0 })
      } else if (decl.id.type === 'ObjectPattern') {
        for (const prop of decl.id.properties) {
          if (prop.type !== 'Property') continue
          const value = prop.value
          // { a } → a ；{ a: b } → b ；{ a = 1 } → AssignmentPattern 里的 a
          const local = value.type === 'AssignmentPattern' ? value.left : value
          if (local && local.type === 'Identifier') {
            out.push({ name: local.name, line: prop.loc.start.line })
          }
        }
      }
    }
  }
  return out
}

/**
 * 这个名字有没有在"声明以外"的地方被引用。
 *
 * 必须按位置排除，不能只数出现次数：
 *   - `const { foo } = require(...)` 里的 foo 是**声明**
 *   - `obj.foo` 里的 foo 是属性名，不是变量
 *   - `{ foo: 1 }` 里的 foo 是字面量键（但 `{ foo }` 简写里的 foo 是引用）
 */
function isUsedOutsideDeclaration(ast, name) {
  let found = false

  /**
   * @param node   当前节点
   * @param parent 父节点
   * @param key    当前节点在父节点里的**属性名**（'id' / 'params' / 'property' / ...）
   * @param grand  祖父节点 —— 区分 ObjectPattern 里的绑定和 ObjectExpression 里的简写引用时必须用它
   */
  const visit = (node, parent, key, grand) => {
    if (found || !node || typeof node.type !== 'string') return

    if (node.type === 'Identifier' && node.name === name) {
      // 1) VariableDeclarator 的 id 位置 = 声明本身
      const isDeclName = parent && parent.type === 'VariableDeclarator' && key === 'id'

      // 2) 函数参数位置 = 声明（各参数自己算声明，不是"使用了外层变量"）
      const isParam = parent &&
        (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
         parent.type === 'ArrowFunctionExpression') && key === 'params'

      // 3) 解构模式里的绑定名 = 声明。
      //    判据：父节点是 ObjectPattern（或属性挂在 ObjectPattern 下），
      //    **而不是** ObjectExpression。`const { a } = m` 是声明，
      //    `const o = { a }` 是引用 —— 两者 AST 长得很像，只能看祖父。
      const inPattern = (parent && (parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern')) ||
        (grand && grand.type === 'ObjectPattern')

      // 4) import 说明符里的 local = 声明
      const isImportSpec = parent && (parent.type === 'ImportSpecifier' ||
        parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier')

      // 5) 对象字面量的键（非简写）、成员属性名、label —— 都不是变量引用
      const isPropKey = parent && parent.type === 'Property' && key === 'key' && !parent.shorthand
      const isMemberProp = parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed
      const isLabel = parent && (parent.type === 'LabeledStatement' ||
        parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')

      if (!isDeclName && !isParam && !inPattern && !isImportSpec &&
          !isPropKey && !isMemberProp && !isLabel) {
        found = true
        return
      }
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue
      const child = node[k]
      if (Array.isArray(child)) for (const c of child) visit(c, node, k, parent)
      else if (child && typeof child.type === 'string') visit(child, node, k, parent)
    }
  }

  visit(ast, null, null, null)
  return found
}

function collectFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(path.join(dir, entry.name), acc)
    } else if (entry.name.endsWith('.js') && !entry.name.startsWith('.')) {
      acc.push(path.join(dir, entry.name))
    }
  }
  return acc
}

function scanFile(file) {
  const source = fs.readFileSync(file, 'utf8')
  let ast
  let isModule = false
  // 双模式：前端的 src/ 是 ESM（import/export），后端是 CJS（require）。
  // 只试一种会让另一类文件全部"解析失败"而静默跳过 —— 跳过等于不检查。
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'script' })
  } catch (e) {
    try {
      ast = acorn.parse(source, { ecmaVersion: 'latest', locations: true, sourceType: 'module' })
      isModule = true
    } catch (e2) {
      return { parseError: e2.message, unused: [] }
    }
  }

  const bindings = isModule ? moduleImports(ast) : topLevelRequires(ast)
  const unused = bindings.filter(b => !isUsedOutsideDeclaration(ast, b.name))
  return { unused }
}

/**
 * 收集 ESM `import` 引入的本地名。
 *
 *   import x from 'm'                 → x
 *   import { a, b as c } from 'm'     → a, c
 *   import * as ns from 'm'           → ns
 *   import 'm'                        → 无绑定（副作用导入，不算未使用）
 */
function moduleImports(ast) {
  const out = []
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue
    // 必须跳类型导入标记：`import type { X }` 的 X 不参与运行时
    for (const spec of node.specifiers || []) {
      const local = spec.local
      if (local && local.type === 'Identifier') {
        out.push({ name: local.name, line: (node.loc && node.loc.start.line) || 0 })
      }
    }
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const targets = args.length ? args : DEFAULT_DIRS
  const files = []
  for (const t of targets) {
    const abs = path.join(ROOT, t)
    if (!fs.existsSync(abs)) continue
    collectFiles(abs, files)
  }

  let total = 0
  let parseFailures = 0
  const report = []

  for (const file of files) {
    const result = scanFile(file)
    if (result.parseError) { parseFailures++; continue }
    if (result.unused.length) {
      report.push({ file, unused: result.unused })
      total += result.unused.length
    }
  }

  for (const item of report) {
    console.log(`\n✖ ${path.relative(ROOT, item.file)}  (${item.unused.length} 个未使用)`)
    for (const u of item.unused) {
      console.log(`    ${String(u.line).padStart(5)}  ${u.name}`)
    }
  }

  console.log(`\n═══ 扫了 ${files.length} 个文件 · ${total} 个未使用 import · ${parseFailures} 个解析失败 ═══`)
  process.exit(total ? 1 : 0)
}

if (require.main === module) main()

module.exports = { scanFile, topLevelRequires, moduleImports, isUsedOutsideDeclaration }
