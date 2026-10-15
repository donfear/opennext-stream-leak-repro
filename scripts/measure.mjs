// Renders the force-dynamic page many times in local workerd (`wrangler dev`) and,
// after each batch, takes a V8 heap snapshot through the DevTools protocol.
// A snapshot runs a full GC first, so it shows what is really retained:
// the JS heap size, and how many ReadableStream objects are still alive.
// A leak shows as both numbers growing with renders; a healthy build stays flat.
//
//   node scripts/measure.mjs            # 20 batches of 50 renders
//   BATCHES=40 BATCH=25 LABEL=patched node scripts/measure.mjs
//   ROUTE='/?r=' node scripts/measure.mjs   # force-dynamic page instead of ISR
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8799
const INSPECTOR_PORT = 9239
const BATCHES = Number(process.env.BATCHES ?? 20)
const BATCH = Number(process.env.BATCH ?? 50)
const LABEL = process.env.LABEL ?? 'run'
const BASE = `http://127.0.0.1:${PORT}`
// `/?r=` hits the force-dynamic page; `/items/` prerenders a new ISR page per request.
const ROUTE = process.env.ROUTE ?? '/items/'
const COUNTED = ['ReadableStream', 'ReadableStreamDefaultController', 'ReadableStreamDefaultReader']

const step = (msg) => process.stderr.write(`[${LABEL}] ${msg}\n`)

const wrangler = spawn(
  'node_modules/.bin/wrangler',
  ['dev', '--port', String(PORT), '--inspector-port', String(INSPECTOR_PORT), '--log-level', 'warn'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
)
let wranglerLog = ''
wrangler.stdout.on('data', (d) => (wranglerLog += d))
wrangler.stderr.on('data', (d) => (wranglerLog += d))
const stop = () => {
  try {
    process.kill(-wrangler.pid, 'SIGTERM')
  } catch {}
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1))

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/?r=warmup`)
      if (res.ok) return void (await res.text())
    } catch {}
    await sleep(500)
  }
  throw new Error(`wrangler dev did not come up:\n${wranglerLog}`)
}

async function connectInspector() {
  const targets = await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json`)).json()
  const target = targets.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error(`no inspector target: ${JSON.stringify(targets)}`)
  // wrangler's inspector proxy rejects connections without an allowed Origin.
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://127.0.0.1' } })
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 1
  const pending = new Map()
  let snapshotChunks = null
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      snapshotChunks?.push(msg.params.chunk)
    } else if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`${method}: no reply in ${timeoutMs / 1000}s`)), timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  // workerd does not answer HeapProfiler.collectGarbage; a snapshot does a full GC.
  const snapshot = async () => {
    snapshotChunks = []
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 180_000)
    const json = snapshotChunks.join('')
    snapshotChunks = null
    return JSON.parse(json)
  }
  return { send, snapshot, close: () => ws.close() }
}

function countByName(snap, names) {
  const { node_fields: fields, node_types: types } = snap.snapshot.meta
  const width = fields.length
  const typeIdx = fields.indexOf('type')
  const nameIdx = fields.indexOf('name')
  const objectType = types[0].indexOf('object')
  const wanted = new Map(names.map((n) => [n, 0]))
  const { nodes, strings } = snap
  for (let i = 0; i < nodes.length; i += width) {
    if (nodes[i + typeIdx] !== objectType) continue
    const name = strings[nodes[i + nameIdx]]
    if (wanted.has(name)) wanted.set(name, wanted.get(name) + 1)
  }
  return wanted
}

async function sample(cdp) {
  const snap = await cdp.snapshot()
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  return { usedSize, counts: countByName(snap, COUNTED) }
}

const mb = (bytes) => (bytes / 1048576).toFixed(1)

step('waiting for wrangler dev')
await waitForServer()
step('connecting inspector')
const cdp = await connectInspector()
await cdp.send('Runtime.enable')
await cdp.send('HeapProfiler.enable')

const first = await fetch(`${BASE}${ROUTE}size`)
const pageBytes = (await first.text()).length
const base = await sample(cdp)
console.log(`[${LABEL}] ${ROUTE}<n>: page ${Math.round(pageBytes / 1024)} KB, heap ${mb(base.usedSize)} MB after GC at start`)
console.log(`[${LABEL}] renders  heapMB  growthMB  KB/render  ReadableStream  Controller  Reader`)

let renders = 0
let failures = 0
for (let b = 1; b <= BATCHES; b++) {
  for (let i = 0; i < BATCH; i++) {
    const res = await fetch(`${BASE}${ROUTE}${renders}`)
    await res.text()
    if (!res.ok) failures++
    renders++
  }
  const { usedSize, counts } = await sample(cdp)
  const growth = usedSize - base.usedSize
  console.log(
    `[${LABEL}] ${String(renders).padStart(7)}  ${mb(usedSize).padStart(6)}  ${mb(growth).padStart(8)}  ${(growth / 1024 / renders).toFixed(1).padStart(9)}  ` +
      COUNTED.map((n, i) => String(counts.get(n)).padStart([14, 10, 6][i])).join('  '),
  )
}
if (failures) console.log(`[${LABEL}] ${failures} non-200 responses`)
cdp.close()
stop()
process.exit(0)
