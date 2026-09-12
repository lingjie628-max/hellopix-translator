const { defineConfig } = require('@vue/cli-service')
const express = require('express')
const registerMock = require('./mock')

module.exports = defineConfig({
  transpileDependencies: false,
  lintOnSave: false,
  // 必须是绝对路径: 后台路由形如 /admin/login, 用 './' 会让浏览器把
  // js/app.js 解析成 /admin/js/app.js —— 服务端对未匹配路径回落 index.html,
  // 于是拿到一段 HTML 当 JS 执行, 页面直接白屏。
  publicPath: '/',
  css: {
    loaderOptions: {
      css: {
        esModule: false
      }
    }
  },
  devServer: {
    port: 8080,
    setupMiddlewares(middlewares, devServer) {
      devServer.app.use('/apis', express.urlencoded({ extended: true }))
      devServer.app.use('/apis', express.json())
      registerMock(devServer.app)
      return middlewares
    }
  }
})
