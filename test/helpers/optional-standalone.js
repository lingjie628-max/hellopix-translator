'use strict'

const fs = require('node:fs')

/**
 * Skip tests that depend on the removed Telegram standalone product, while
 * keeping the files runnable if that product is restored later.
 *
 * This is deliberately a visible skip, not a deletion: the test suite should
 * not turn green by pretending the removed product still exists.
 */
function optionalTest (nodeTest, paths, reason) {
  const list = Array.isArray(paths) ? paths : [paths]
  const missing = list.filter(item => !fs.existsSync(item))
  if (!missing.length) return nodeTest
  const skip = reason || ('removed standalone source: ' + missing.join(', '))
  const optionalTestWrapper = function (name, options, fn) {
    if (typeof options === 'function') return nodeTest(name, { skip }, options)
    return nodeTest(name, Object.assign({}, options || {}, { skip }), fn)
  }
  for (const key of ['after', 'before', 'afterEach', 'beforeEach', 'skip', 'todo', 'describe', 'it']) {
    if (typeof nodeTest[key] === 'function') optionalTestWrapper[key] = nodeTest[key].bind(nodeTest)
  }
  return optionalTestWrapper
}

module.exports = { optionalTest }
