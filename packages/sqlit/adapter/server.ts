/**
 * Simple SQLit HTTP Adapter
 *
 * Provides the same HTTP API as the full SQLit adapter but uses local SQLite3 for storage.
 * This is suitable for testnet/development where full decentralization isn't required.
 *
 * API Endpoints:
 * - POST /v1/query - Execute SELECT queries
 * - POST /v1/exec - Execute INSERT/UPDATE/DELETE queries
 * - POST /api/v1/query - Compatibility endpoint (agent registry format)
 * - GET /v1/status - Health check
 * - POST /v1/admin/create - Create a new database
 * - DELETE /v1/admin/drop - Drop a database
 */

import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'

const PORT = parseInt(process.env.PORT ?? '8546', 10)

// Default data directory - use local directory for development
const DATA_DIR =
  process.env.DATA_DIR ??
  (process.env.NODE_ENV === 'production'
    ? '/data/sqlit/databases'
    : join(import.meta.dir, '..', '.data', 'databases'))

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

// Database cache
const dbCache = new Map<string, Database>()

function getDatabase(dbid: string): Database {
  let db = dbCache.get(dbid)
  if (!db) {
    const dbPath = join(DATA_DIR, `${dbid}.db`)
    db = new Database(dbPath, { create: true })
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=NORMAL')
    dbCache.set(dbid, db)
  }
  return db
}

interface QueryRequest {
  database: string
  query: string
  assoc?: boolean
  args?: unknown[]
}

// Agent registry format: { database, type: "query"|"exec", sql, params, timestamp }
interface AgentRegistryRequest {
  database: string
  type: 'query' | 'exec'
  sql: string
  params?: unknown[]
  timestamp?: number
}

function executeQuery(database: string, sql: string, params?: unknown[]) {
  const db = getDatabase(database)
  const stmt = db.prepare(sql)
  const rows = stmt.all(...(params ?? [])) as Record<string, unknown>[]
  return {
    rows,
    rowCount: rows.length,
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    blockHeight: 0,
    executionTime: 0,
    success: true,
  }
}

function executeExec(database: string, sql: string, params?: unknown[]) {
  const db = getDatabase(database)
  const result = db.run(sql, ...(params ?? []))
  return {
    rowsAffected: result.changes,
    lastInsertId: String(result.lastInsertRowid),
    txHash: `0x${randomBytes(32).toString('hex')}`,
    blockHeight: 0,
    gasUsed: '0',
    success: true,
  }
}

const app = new Elysia()
  // Health check endpoints
  .get('/health', () => ({
    status: 'ok',
    success: true,
    data: { storage: 'sqlite3', databases: dbCache.size },
  }))
  .get('/', () => ({
    status: 'ok',
    success: true,
    data: { storage: 'sqlite3', databases: dbCache.size },
  }))
  .get('/v1/status', () => ({
    status: 'ok',
    success: true,
    data: {
      storage: 'sqlite3',
      databases: dbCache.size,
    },
  }))

  // Original format: { database, query, args }
  .post('/v1/query', ({ body }) => {
    const req = body as QueryRequest
    if (!req.database || !req.query) {
      return { success: false, status: 'Missing database or query parameter', data: null }
    }
    try {
      return executeQuery(req.database, req.query, req.args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SQLit] Query error: ${message}`)
      return { success: false, status: message, error: message, data: null }
    }
  })

  .post('/v1/exec', ({ body }) => {
    const req = body as QueryRequest
    if (!req.database || !req.query) {
      return { success: false, status: 'Missing database or query parameter', data: null }
    }
    try {
      return executeExec(req.database, req.query, req.args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SQLit] Exec error: ${message}`)
      return { success: false, status: message, error: message, data: null }
    }
  })

  // Compatibility endpoint for agent registry and other DWS services
  // Accepts: { database, type: "query"|"exec", sql, params, timestamp }
  .post('/api/v1/query', ({ body }) => {
    const req = body as AgentRegistryRequest
    if (!req.database || !req.sql) {
      return { success: false, status: 'Missing database or sql parameter', data: null }
    }
    try {
      if (req.type === 'exec') {
        return executeExec(req.database, req.sql, req.params)
      }
      return executeQuery(req.database, req.sql, req.params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[SQLit] API query error: ${message}`)
      return { success: false, status: message, error: message, data: null }
    }
  })

  // Create a new database
  .post('/v1/admin/create', ({ query }) => {
    const nodeCnt = parseInt(query.node ?? '1', 10)
    if (Number.isNaN(nodeCnt) || nodeCnt <= 0) {
      return { success: false, status: 'Invalid node count', data: null }
    }
    const randBytes = randomBytes(32)
    const dbID = createHash('sha256').update(randBytes).digest('hex')
    const db = getDatabase(dbID)
    db.exec('SELECT 1')
    console.log(`[SQLit] Created database: ${dbID}`)
    return { success: true, status: 'created', data: { database: dbID } }
  })

  // Drop a database
  .delete('/v1/admin/drop', ({ query }) => {
    const dbID = query.database
    if (!dbID) {
      return { success: false, status: 'Missing database parameter', data: null }
    }
    const db = dbCache.get(dbID)
    if (db) {
      db.close()
      dbCache.delete(dbID)
    }
    const dbPath = join(DATA_DIR, `${dbID}.db`)
    if (existsSync(dbPath)) {
      rmSync(dbPath)
    }
    console.log(`[SQLit] Dropped database: ${dbID}`)
    return { success: true, status: 'ok', data: {} }
  })

  .listen(PORT, () => {
    console.log(`[SQLit Adapter] Listening on port ${PORT}`)
    console.log(`[SQLit Adapter] Data directory: ${DATA_DIR}`)
    console.log(`[SQLit Adapter] Storage: sqlite3`)
  })

export { app }
