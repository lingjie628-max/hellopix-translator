<template>
  <div id="app">
    <router-view/>
  </div>
</template>

<script>
  export default {
    name: 'app'
  }
</script>

<style>
  #app {
    /* 字体栈交给 theme.css 的 --w-font（系统 UI 字体）：
       这里原本是 Vue CLI 脚手架的默认值 'Avenir, Helvetica, Arial'，
       而 #app 是 ID 选择器、优先级高于 theme.css 的 body 规则 ——
       等于全站字体被脚手架默认值覆盖，英文没走系统 UI 字体。 */
    font-family: inherit;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-align: center;
    /* 原来写死 #2c3e50（同样是脚手架默认值）：夜间模式下它会成为所有
       未显式设色元素的继承色，深色压深色，后台顶栏实测 1.54:1。 */
    color: var(--w-text);
    margin: 0;
  }

  html, body, #app {
    height: 100%;
    margin: 0;
  }
</style>
