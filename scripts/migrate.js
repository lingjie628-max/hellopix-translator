const path = require('path')
const config = require('../server/config')

function parseArguments(argv) {
  const direction = argv[0] || 'up'
  if (!['up', 'down'].includes(direction)) {
    throw new Error('Usage: node scripts/migrate.js [up|down] [count]')
  }

  const defaultCount = direction === 'down' ? 1 : Infinity
  const count = argv[1] == null ? defaultCount : Number(argv[1])
  if (count !== Infinity && (!Number.isInteger(count) || count < 1)) {
    throw new Error('Migration count must be a positive integer')
  }
  return { direction, count }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const { runner } = await import('node-pg-migrate')
  await runner({
    databaseUrl: {
      connectionString: config.database.connectionString,
      ssl: config.database.ssl,
      connectionTimeoutMillis: config.database.connectionTimeoutMillis,
      statement_timeout: config.database.statementTimeout,
      application_name: `${config.database.applicationName}-migrate`
    },
    dir: path.join(__dirname, '..', 'migrations'),
    direction: options.direction,
    count: options.count,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    lock: true,
    log: message => console.log(message)
  })
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`)
  process.exitCode = 1
})
