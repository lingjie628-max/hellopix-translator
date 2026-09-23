/**
 * 表单序列化（application/x-www-form-urlencoded）。
 *
 * 单独抽成一个纯函数，是因为它出过一次**只有收款方式页会报错**的故障：
 * 数组此前一律用 `join(',')`，而 `[{...},{...}].join(',')` 得到的是
 * `"[object Object],[object Object]"` —— 服务端 `JSON.parse` 直接抛
 * 「提交的数据不是合法 JSON」。
 *
 * 公告页、线路页、套餐页各自手动 `JSON.stringify(...)` 绕过了这个坑，
 * 收款方式页漏了，于是只有它挂。把逻辑收到这里，谁都不用再记着绕过。
 *
 * 规则：
 *   - 原始类型数组 `[1,2,3]` → 逗号拼接（历史行为，服务端按逗号切）
 *   - 含对象的数组 `[{...}]` → JSON 字符串（服务端 safeParse 后拿到数组）
 *   - 普通对象 `{a:1}`      → JSON 字符串
 *   - undefined / null      → 整个字段丢弃（不要发 "key=undefined"）
 */
export function encodeForm(data) {
  if (!data) return ''
  const parts = []
  Object.keys(data).forEach(key => {
    const value = data[key]
    if (value === undefined || value === null) return
    let encoded
    if (Array.isArray(value)) {
      const hasObject = value.some(item => item !== null && typeof item === 'object')
      encoded = hasObject ? JSON.stringify(value) : value.join(',')
    } else if (typeof value === 'object') {
      encoded = JSON.stringify(value)
    } else {
      encoded = value
    }
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(encoded))
  })
  return parts.join('&')
}
