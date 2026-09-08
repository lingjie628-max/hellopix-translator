function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

export function formatDateTime(time) {
  if (time === null || time === undefined || time === '') return ''
  const date = time instanceof Date ? time : new Date(time)
  if (isNaN(date.getTime())) return String(time)
  return (
    date.getFullYear() +
    '-' + pad(date.getMonth() + 1) +
    '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) +
    ':' + pad(date.getMinutes()) +
    ':' + pad(date.getSeconds())
  )
}

export function formateStatus(data) {
  const value = String(data)
  if (value === '1') return '正常'
  if (value === '2') return '关闭'
  if (value === '3') return '过期'
  if (value === '4') return '删除'
  return data == null ? '' : String(data)
}
