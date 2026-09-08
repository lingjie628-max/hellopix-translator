'use strict'

const fs = require('fs')
const path = require('path')

function createStore(file) {
  const dir = path.dirname(file)
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (_error) {
      return {}
    }
  }
  function write(data) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  }
  return { read, write }
}

module.exports = { createStore }
