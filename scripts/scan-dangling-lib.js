'use strict'

/**
 * 悬空标识符扫描器（库）。
 *
 * ## 它防什么
 *
 * 2026-10-21 拆分 `production.js` 时，同一个事故连捅四刀：
 *
 * | 标识符 | 原位置 | 搬去哪 | 剩下的 |
 * | --- | --- | --- | --- |
 * | `readSettings`  | productionRouter 闭包 | admin.js | 调用点留在 production.js |
 * | `USDT_TRC20_CONTRACT` | 同上 | admin.js | 3 处调用点留在原地 |
 * | `RECHARGE_TTL_MINUTES` | 同上 | admin.js | 2 处调用点留在原地 |
 * | `repo` | productionRouter 闭包 | —— | 提成模块级函数后闭包没了 |
 *
 * 四个全是 `ReferenceError`，全是线上 500，全都没被任何测试抓到：
 * `node --check` 只管语法（悬空标识符语法完全合法），
 * 静态字符串断言只管"写了什么"，冒烟测试只管"路由注册了没有"。
 *
 * ## 为什么不用正则
 *
 * 第一版我用正则找"全大写常量"，结果 SQL 关键字（SELECT/FROM/WHERE）、
 * 错误码字符串（PACKAGE_NOT_FOUND）全被当成悬空常量，噪音淹没了信号，
 * 真正出事的 `RECHARGE_TTL_MINUTES` 反而被 `{3,}` 截断成 `RECHARGE_TTL`。
 *
 * 后来撞到最后那刀 `repo` —— **小写标识符根本不在"常量"这个假设里**。
 *
 * 正则不认作用域。要做对只能上 AST，手写作用域链。
 *
 * ## 边界
 *
 * 只报"爬完作用域链没找到、也不是 JS 全局"的引用。
 * 故意不报：属性访问（`a.b` 的 `b`）、对象字面量的 key、标签、import 的绑定名。
 * 全局对象（`require`/`module`/`process`/`console`/标准内建）走白名单。
 */

const acorn = require('acorn')

/** Node/JS 全局。不在文件里声明也是合法的 */
const GLOBALS = new Set([
  // JS 内建
  'Object', 'Function', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'Proxy', 'Reflect',
  'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'eval', 'undefined', 'NaN', 'Infinity', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'fetch', 'FormData', 'Blob', 'File',
  'console',
  // Node CJS
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global',
  // 浏览器（前端 src/ 是 Vue + 原生 DOM）
  'window', 'document', 'self', 'globalThis', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'HTMLImageElement',
  'HTMLVideoElement', 'HTMLAudioElement', 'HTMLDivElement', 'HTMLSpanElement', 'Element', 'Node',
  'NodeList', 'Document', 'DocumentFragment', 'ShadowRoot', 'CustomEvent', 'Event',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver',
  'CSSStyleSheet', 'DOMParser', 'XMLSerializer', 'getComputedStyle', 'customElements',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'matchMedia',
  'FontFace', 'Image', 'Audio', 'Worker', 'BroadcastChannel', 'MessageChannel',
  'ClipboardEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TouchEvent', 'WheelEvent',
  'FocusEvent', 'InputEvent', 'DragEvent', 'StorageEvent', 'HashChangeEvent',
  'FormData', 'Blob', 'File', 'FileReader', 'Headers', 'Request', 'Response',
  'Notification', 'IntersectionObserverEntry', 'DOMRect', 'Text', 'Comment',
  'requestAnimationFrame', 'queueMicrotask', 'crypto', 'performance', 'atob', 'btoa',
  // window 上的常用只读属性（裸写合法，等价于 window.xxx）
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'scrollX', 'scrollY',
  'pageXOffset', 'pageYOffset', 'devicePixelRatio', 'isSecureContext', 'origin',
  'top', 'parent', 'frames', 'opener', 'name', 'closed', 'length'
])

function parse(source) {
  // 先按 CJS 解析；失败再按 ESM —— 前端 .js 是 ESM，服务端是 CJS，
  // 统一按 script 解析会把所有 import/export 文件全部报成"解析失败"，
  // 结果 11 个前端文件根本没被扫过，等于半个仓库是盲区。
  try {
    return acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true
    })
  } catch (e) {
    return acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true
    })
  }
}

/** 一个作用域帧 */
class Scope {
  constructor(parent, kind) {
    this.parent = parent
    this.kind = kind
    this.names = new Set()
  }

  declare(name) {
    if (name) this.names.add(name)
  }

  /** 沿链向外找 */
  has(name) {
    for (let s = this; s; s = s.parent) {
      if (s.names.has(name)) return true
    }
    return false
  }
}

/** 解构模式里的所有绑定名 */
function patternNames(node, out = []) {
  if (!node) return out
  switch (node.type) {
    case 'Identifier':
      out.push(node.name)
      break
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') patternNames(prop.argument, out)
        else patternNames(prop.value, out)
      }
      break
    case 'ArrayPattern':
      for (const el of node.elements) patternNames(el, out)
      break
    case 'AssignmentPattern':
      patternNames(node.left, out)
      break
    case 'RestElement':
      patternNames(node.argument, out)
      break
    default:
      break
  }
  return out
}

/** 通用子节点遍历（跳过元数据字段） */
function forEachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) child.forEach(c => { if (c && typeof c.type === 'string') fn(c) })
    else if (child && typeof child.type === 'string') fn(child)
  }
}

/**
 * 收集提升到本层的声明（var / function），**不进入嵌套函数**。
 * 必须先扫一遍再检查引用，否则 `f(); function f(){}` 会误报。
 */
function hoistDeclarations(body, scope) {
  const walk = node => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'FunctionDeclaration':
        if (node.id) scope.declare(node.id.name)
        return
      case 'VariableDeclaration':
        if (node.kind === 'var') {
          for (const d of node.declarations) patternNames(d.id).forEach(n => scope.declare(n))
        }
        break
      case 'ClassDeclaration':
        if (node.id) scope.declare(node.id.name)
        return
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return
      default:
        break
    }
    forEachChild(node, walk)
  }
  if (Array.isArray(body)) body.forEach(walk)
  else if (body) walk(body)
}

/** 收集本层块里的 let/const/class（不进入嵌套块与函数） */
function declareLexical(body, scope) {
  const walk = node => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind !== 'var') {
          for (const d of node.declarations) patternNames(d.id).forEach(n => scope.declare(n))
        }
        break
      case 'ClassDeclaration':
        if (node.id) scope.declare(node.id.name)
        return
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'BlockStatement':
        return
      default:
        break
    }
    forEachChild(node, walk)
  }
  if (Array.isArray(body)) body.forEach(walk)
  else if (body) walk(body)
}

/**
 * 遍历 AST，收集所有爬完作用域链找不到的标识符引用。
 *
 * @param {string} source
 * @param {string} filename 仅用于错误信息
 * @returns {Array<{name:string, line:number, column:number}>}
 */
function findDanglingIdentifiers(source, filename = '<anon>') {
  let ast
  try {
    ast = parse(source)
  } catch (err) {
    err.message = `${filename}: ${err.message}`
    throw err
  }

  const hits = []

  function visit(node, scope) {
    if (!node || typeof node.type !== 'string') return

    switch (node.type) {
      case 'Program': {
        const s = new Scope(scope, 'module')
        s.declare('arguments')
        hoistDeclarations(node.body, s)
        declareLexical(node.body, s)
        // ESM：import 的绑定名、export 的本地名都要先声明
        for (const stmt of node.body) {
          if (stmt.type === 'ImportDeclaration') {
            for (const spec of stmt.specifiers) s.declare(spec.local.name)
          } else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
            const d = stmt.declaration
            if (d.id) s.declare(d.id.name)
            if (d.declarations) for (const decl of d.declarations) patternNames(decl.id).forEach(n => s.declare(n))
          } else if (stmt.type === 'ExportAllDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
            // 默认导出若是具名声明，名字已在 hoist/lexical 里处理
          }
        }
        for (const stmt of node.body) visit(stmt, s)
        return
      }

      // import/export 本身不是引用
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return

      case 'ExportNamedDeclaration':
        visit(node.declaration, scope)
        return

      case 'ExportDefaultDeclaration':
        visit(node.declaration, scope)
        return

      case 'ImportExpression':
        visit(node.source, scope)
        return

      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const s = new Scope(scope, 'function')
        s.declare('arguments')
        if (node.type === 'FunctionExpression' && node.id) s.declare(node.id.name)
        // 函数自身名字在声明处已由 hoist 处理；FunctionExpression 需在此补
        for (const p of node.params || []) patternNames(p).forEach(n => s.declare(n))
        hoistDeclarations(node.body, s)
        if (node.body && node.body.type === 'BlockStatement') {
          declareLexical(node.body.body, s)
          for (const stmt of node.body.body) visit(stmt, s)
        } else {
          visit(node.body, s)
        }
        for (const p of node.params || []) visit(p, s)
        return
      }

      case 'BlockStatement': {
        const s = new Scope(scope, 'block')
        hoistDeclarations(node.body, s)
        declareLexical(node.body, s)
        for (const stmt of node.body) visit(stmt, s)
        return
      }

      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const s = new Scope(scope, 'block')
        const init = node.init || node.left
        if (init && init.type === 'VariableDeclaration') {
          for (const d of init.declarations) patternNames(d.id).forEach(n => s.declare(n))
        }
        const bodyStmts = node.body && node.body.type === 'BlockStatement' ? node.body.body : []
        hoistDeclarations(bodyStmts, s)
        declareLexical(bodyStmts, s)
        forEachChild(node, c => visit(c, s))
        return
      }

      case 'CatchClause': {
        const s = new Scope(scope, 'catch')
        if (node.param) patternNames(node.param).forEach(n => s.declare(n))
        visit(node.body, s)
        return
      }

      case 'ClassDeclaration':
      case 'ClassExpression': {
        const s = new Scope(scope, 'class')
        if (node.id) s.declare(node.id.name)
        visit(node.superClass, scope)
        visit(node.body, s)
        return
      }

      case 'VariableDeclarator':
        visit(node.init, scope)
        return

      case 'LabeledStatement':
        visit(node.body, scope)
        return

      case 'BreakStatement':
      case 'ContinueStatement':
        return

      case 'Identifier': {
        if (!scope.has(node.name) && !GLOBALS.has(node.name)) {
          hits.push({
            name: node.name,
            line: node.loc ? node.loc.start.line : 0,
            column: node.loc ? node.loc.start.column : 0
          })
        }
        return
      }

      case 'MemberExpression':
        visit(node.object, scope)
        if (node.computed) visit(node.property, scope)
        return

      case 'Property':
        if (node.computed) visit(node.key, scope)
        visit(node.value, scope)
        return

      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope)
        visit(node.value, scope)
        return

      default:
        forEachChild(node, c => visit(c, scope))
    }
  }

  visit(ast, null)
  return hits
}

/**
 * 扫一组共享同一个全局词法作用域的文件。
 *
 * ## 为什么要这个
 *
 * `desktop/renderer/` 里十几个 `.js` 是用 `<script src="...">` 平铺加载的 ——
 * 它们**不是模块**，顶层 `const` 落在同一个全局词法环境里。
 * `dom.js` 声明 `const profile = ...`，`ui-kit.js` 直接用 `profile`，
 * 运行时完全正常。
 *
 * 按单文件扫会报出 900+ 条"悬空" —— 全是这种跨文件共享，纯噪音。
 *
 * 做法：把所有文件拼成一个 Program，给每个节点记上来源文件。
 * 这样跨文件的声明能被看见，真悬空的引用照样会被抓到。
 *
 * @param {Array<{filename:string, source:string}>} files
 * @returns {Array<{name:string, line:number, column:number, file:string}>}
 */
function findDanglingIdentifiersInSet(files) {
  // 拼接，并记录每段的行偏移
  const parts = []
  const offsets = []   // { filename, startLine }
  let cursor = 1
  for (const f of files) {
    offsets.push({ filename: f.filename, startLine: cursor })
    parts.push(f.source)
    cursor += f.source.split('\n').length
  }
  const combined = parts.join('\n')
  const hits = findDanglingIdentifiers(combined, '<shared>')

  return hits.map(h => {
    // 找到这条落在哪个文件里
    let owner = offsets[0]
    for (const o of offsets) {
      if (h.line >= o.startLine) owner = o
      else break
    }
    return {
      name: h.name,
      file: owner.filename,
      line: h.line - owner.startLine + 1
    }
  })
}

module.exports = { findDanglingIdentifiers, GLOBALS, findDanglingIdentifiersInSet }
