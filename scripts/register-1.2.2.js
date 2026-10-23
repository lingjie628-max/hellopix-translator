'use strict'

/**
 * 在**生产库**上架 1.2.2 的三条发布记录（Windows x64 / macOS x64 / macOS arm64）。
 *
 * 在服务器上跑（连 127.0.0.1:5432 的正式库），不在本地隧道上跑 ——
 * 本地 55432 是 docker 里的测试库，写进去等于没发。
 *
 * 用法（服务器上）：
 *   cd /opt/hello-pix && set -a && . /etc/hello-pix/hello-pix.env && set +a \
 *     && node scripts/register-1.2.2.js
 */

const { Client } = require('pg')

const VERSION = '1.2.2'
const MIN_VERSION = '1.2.0'
const APP = 'com.hellopix.desktop'

const ROWS = [
  ['Windows', 'x64', `Hello Pix ${VERSION} (Windows)`,
    `https://pixfanyi.com/downloads/HelloPix-Setup-${VERSION}.exe`,
    '48e2af2bea782cfc97c3edc96a829b31491178097c17b8933274c34a2a4f515d'],
  ['macOS', 'x64', `Hello Pix ${VERSION} (macOS Intel)`,
    `https://pixfanyi.com/downloads/Hello%20Pix-${VERSION}.dmg`,
    'cd00f563c99de29c9cb82466f916e2ca10579b6f40757373b4cae05a04d7603f'],
  ['macOS', 'arm64', `Hello Pix ${VERSION} (macOS Apple Silicon)`,
    `https://pixfanyi.com/downloads/Hello%20Pix-${VERSION}-arm64.dmg`,
    '69e70f8761f72e00aff85759d2a8f93d23a403254a75445a0c4548367af15731']
]

async function main () {
  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()
  try {
    for (const [os, arch, title, url, sha] of ROWS) {
      const dup = await db.query(
        'SELECT id FROM client_releases WHERE version=$1 AND os=$2 AND arch=$3',
        [VERSION, os, arch]
      )
      if (dup.rows[0]) {
        await db.query(
          'UPDATE client_releases SET url=$2,sha256=$3,min_version=$4,enabled=true,updated_at=NOW() WHERE id=$1',
          [dup.rows[0].id, url, sha, MIN_VERSION]
        )
        console.log(`已更新 #${dup.rows[0].id} ${os}/${arch}`)
        continue
      }
      const r = await db.query(
        `INSERT INTO client_releases(release_group,title,os,arch,app,version,url,enabled,note,sha256,min_version)
         VALUES('desktop',$1,$2,$3,$4,$5,$6,true,$7,$8,$9) RETURNING id`,
        [title, os, arch, APP, VERSION, url, `发布 ${VERSION}`, sha, MIN_VERSION]
      )
      console.log(`已创建 #${r.rows[0].id} ${os}/${arch}`)
    }
    // 逐条回读校验，避免"以为写进去了"
    const check = await db.query(
      'SELECT id,os,arch,version,sha256,min_version,enabled FROM client_releases ORDER BY id DESC LIMIT 6'
    )
    console.log('\n当前最新记录：')
    for (const x of check.rows) {
      console.log(`  #${x.id} ${x.version} ${x.os}/${x.arch} sha=${String(x.sha256).slice(0, 12)} min=${x.min_version} enabled=${x.enabled}`)
    }
  } finally {
    await db.end()
  }
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
