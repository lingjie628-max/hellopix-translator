'use strict'

/**
 * IP 归属地查询。
 *
 * 四个通道，字段名各不相同，所以每个通道单独一个纯函数解析。
 * 拆出来之后终于能测 —— 以前只能靠真机点一次"节点检测"看结果对不对，
 * 某个通道的响应格式变了（是 `country_code` 还是 `countryCode`？）
 * 只能等用户反馈。
 *
 * ## 失败一律返回 empty，不抛
 *
 * 归属地是"锦上添花"的信息：查不到不该让节点检测失败。
 * 但也不能什么线索都不留 —— 所以有 onError 回调。
 *
 * ## loc 统一成 "经度/纬度"
 *
 * 三个上游给的顺序不一样（ip-api 给单独的 lat/lon，ipinfo 给 "纬,经"，
 * ipwho.is 给 longitude/latitude），统一成 `经度/纬度` 出去，
 * 上层不用再关心是哪个通道。
 */

const EMPTY_GEO = { country: '', region: '', city: '', loc: '', timezone: '', zip: '' }

function emptyGeo (ip) {
  return Object.assign({}, EMPTY_GEO, { ip: ip || '' })
}

/** ip-api.com：字段是 country/regionName/lat/lon，需要 status === 'success' */
function parseIpApi (data, ip) {
  if (!data || data.status !== 'success') return emptyGeo(ip)
  return {
    ip: data.query || ip,
    country: (data.country || '') + (data.countryCode ? '(' + data.countryCode + ')' : ''),
    region: data.regionName || '',
    city: data.city || '',
    loc: (data.lon != null && data.lat != null) ? (data.lon + '/' + data.lat) : '',
    timezone: data.timezone || '',
    zip: data.zip || ''
  }
}

/** ipinfo.io：loc 是 "纬度,经度" 一个字符串，需要翻成 "经度/纬度" */
function parseIpInfo (data, ip) {
  if (!data) return emptyGeo(ip)
  const loc = String(data.loc || '')
  const parts = loc.split(',')
  return {
    ip: data.ip || ip,
    country: data.country || '',
    region: data.region || '',
    city: data.city || '',
    loc: parts.length === 2 ? (parts[1] + '/' + parts[0]) : loc,
    timezone: data.timezone || '',
    zip: data.postal || ''
  }
}

/** ipwho.is：country_code / longitude / latitude，timezone 是个对象 */
function parseIpWhois (data, ip) {
  if (!data || data.success === false) return emptyGeo(ip)
  return {
    ip: data.ip || ip,
    country: (data.country || '') + (data.country_code ? '(' + data.country_code + ')' : ''),
    region: data.region || '',
    city: data.city || '',
    loc: (data.longitude != null && data.latitude != null) ? (data.longitude + '/' + data.latitude) : '',
    timezone: (data.timezone && data.timezone.id) || '',
    zip: data.postal || ''
  }
}

/** db-ip.com：countryName / countryCode / stateProv */
function parseDbIp (data, ip) {
  if (!data) return emptyGeo(ip)
  return {
    ip: data.ipAddress || ip,
    country: (data.countryName || '') + (data.countryCode ? '(' + data.countryCode + ')' : ''),
    region: data.stateProv || '',
    city: data.city || '',
    loc: '',
    timezone: '',
    zip: ''
  }
}

const CHANNELS = {
  ipapi: {
    url: ip => 'http://ip-api.com/json/' + encodeURIComponent(ip) +
      '?lang=zh-CN&fields=status,country,countryCode,regionName,city,lat,lon,timezone,zip,query',
    parse: parseIpApi
  },
  ipinfo: {
    url: ip => 'https://ipinfo.io/' + encodeURIComponent(ip) + '/json',
    parse: parseIpInfo
  },
  ipwhois: {
    url: ip => 'https://ipwho.is/' + encodeURIComponent(ip),
    parse: parseIpWhois
  },
  // 默认通道：不带 channel 或认不出的 channel 都走这里
  dbip: {
    url: ip => 'https://api.db-ip.com/v2/free/' + encodeURIComponent(ip),
    parse: parseDbIp
  }
}

/**
 * @param {object} deps
 * @param {Function} deps.sessionGetText  (session, url) => Promise<string>
 * @param {Function} deps.getDefaultSession  () => session
 * @param {Function} deps.parseJsonSafe
 * @param {Function} [deps.onError]      (channel, error) => void
 */
function createIpGeo (deps) {
  async function lookupIpGeo (ip, channel) {
    if (!ip) return emptyGeo('')
    const spec = CHANNELS[channel] || CHANNELS.dbip
    const name = CHANNELS[channel] ? channel : 'dbip'
    try {
      const text = await deps.sessionGetText(deps.getDefaultSession(), spec.url(ip))
      return spec.parse(deps.parseJsonSafe(text), ip)
    } catch (e) {
      // 归属地查不到不该让节点检测失败，但也别完全没线索
      try { if (deps.onError) deps.onError(name, e) } catch (ignore) {}
      return emptyGeo(ip)
    }
  }

  return { lookupIpGeo }
}

module.exports = { createIpGeo, emptyGeo, parseIpApi, parseIpInfo, parseIpWhois, parseDbIp, CHANNELS }
