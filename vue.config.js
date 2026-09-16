const { defineConfig } = require('@vue/cli-service')

module.exports = defineConfig({
  transpileDependencies: false,
  lintOnSave: false,
  // 两个 HTML 入口：
  //   index.html   → 主应用（后台 / 商户端，整包 Element UI）
  //   landing.html → 官网（只有 3 个组件，不带后台代码）
  // 拆分理由：官网原本只是主应用的一个路由，访客为了看一页官网要下载整个
  // 后台 + 商户端 + 全部 Element 组件（实测 1.0MB vendors + 292KB app）。
  pages: {
    index: {
      entry: 'src/main.js',
      template: 'public/index.html',
      filename: 'index.html',
      chunks: ['chunk-vendors', 'chunk-common', 'index']
    },
    landing: {
      entry: 'src/landing.js',
      template: 'public/landing.html',
      filename: 'landing.html',
      chunks: ['landing']
    }
  },
  chainWebpack(config) {
    // 关键：让 splitChunks **完全跳过 landing 入口**。
    // 默认配置会把两个入口共用的 node_modules 抽成公共 chunk，
    // 那样官网就会连带加载主应用的 chunk-vendors（含整包 Element UI），
    // 拆分就白做了。这里按 chunk 名排除，官网那一块保持自包含。
    config.optimization.splitChunks({
      cacheGroups: {
        vendors: {
          name: 'chunk-vendors',
          test: /[\\/]node_modules[\\/]/,
          priority: -10,
          chunks: chunk => chunk.name !== 'landing'
        },
        common: {
          name: 'chunk-common',
          minChunks: 2,
          priority: -20,
          chunks: chunk => chunk.name !== 'landing',
          reuseExistingChunk: true
        }
      }
    })
  },
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
      // express / mock 都只服务开发服务器（前者给 /apis 解析请求体，后者是接口模拟）。
      // 放在这里按需 require：生产构建只跑 `vue-cli-service build`，不会进这个分支，
      // 因此部署时不需要上传 mock/ 目录，也不会因为缺它而构建失败。
      const express = require('express')
      const registerMock = require('./mock')
      devServer.app.use('/apis', express.urlencoded({ extended: true }))
      devServer.app.use('/apis', express.json())
      registerMock(devServer.app)
      return middlewares
    }
  }
})
