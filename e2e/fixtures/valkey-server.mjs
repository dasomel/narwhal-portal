import { createServer as createHttpServer } from "node:http"
import { createServer as createNetServer } from "node:net"

const redisPort = 6380
const httpPort = 3200
const ringKey = "live:events"
const lists = new Map()
const counters = new Map()
const persistedEvents = []

function parseCommand(buffer) {
  if (buffer.length === 0 || buffer[0] !== 42) return null
  const lineEnd = buffer.indexOf("\r\n")
  if (lineEnd < 0) return null
  const count = Number(buffer.toString("utf8", 1, lineEnd))
  const args = []
  let offset = lineEnd + 2
  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== 36) return null
    const lengthEnd = buffer.indexOf("\r\n", offset)
    if (lengthEnd < 0) return null
    const length = Number(buffer.toString("utf8", offset + 1, lengthEnd))
    const valueStart = lengthEnd + 2
    const valueEnd = valueStart + length
    if (buffer.length < valueEnd + 2) return null
    args.push(buffer.toString("utf8", valueStart, valueEnd))
    offset = valueEnd + 2
  }
  return { args, bytes: offset }
}

function bulk(value) {
  const body = Buffer.from(value)
  return Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")])
}

function array(values) {
  return Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values.map(bulk)])
}

function runCommand(args) {
  const [rawName, ...values] = args
  const name = rawName.toUpperCase()
  const [key, ...rest] = values
  if (name === "PING") return Buffer.from("+PONG\r\n")
  if (name === "INFO") return bulk("# Server\r\nredis_version:7.2.0\r\n")
  if (name === "CLIENT" || name === "SELECT" || name === "AUTH") return Buffer.from("+OK\r\n")
  if (name === "INCR") {
    const next = (counters.get(key) ?? 0) + 1
    counters.set(key, next)
    return Buffer.from(`:${next}\r\n`)
  }
  if (name === "LPUSH") {
    const list = lists.get(key) ?? []
    list.unshift(...rest)
    lists.set(key, list)
    if (key === ringKey) persistedEvents.unshift(...rest.map((item) => JSON.parse(item)))
    return Buffer.from(`:${list.length}\r\n`)
  }
  if (name === "LTRIM") {
    const list = lists.get(key) ?? []
    const start = Number(rest[0])
    const end = Number(rest[1])
    lists.set(key, list.slice(start, end < 0 ? undefined : end + 1))
    if (key === ringKey) persistedEvents.splice(1000)
    return Buffer.from("+OK\r\n")
  }
  if (name === "PUBLISH") return Buffer.from(":0\r\n")
  if (name === "LRANGE") {
    const list = lists.get(key) ?? []
    const start = Number(rest[0])
    const end = Number(rest[1])
    return array(list.slice(start, end < 0 ? undefined : end + 1))
  }
  if (name === "SCAN") return Buffer.from("*2\r\n$1\r\n0\r\n*0\r\n")
  if (name === "DEL" || name === "UNLINK") return Buffer.from(":0\r\n")
  return Buffer.from(`-ERR unsupported test fixture command '${rawName}'\r\n`)
}

const redisServer = createNetServer((socket) => {
  let pending = Buffer.alloc(0)
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (true) {
      const parsed = parseCommand(pending)
      if (!parsed) return
      pending = pending.subarray(parsed.bytes)
      socket.write(runCommand(parsed.args))
    }
  })
})

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${httpPort}`)
  if (url.pathname === "/health") {
    res.writeHead(204)
    res.end()
    return
  }
  if (url.pathname === "/__test/state") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ events: persistedEvents }))
    return
  }
  if (url.pathname === "/__test/reset" && req.method === "POST") {
    lists.clear()
    counters.clear()
    persistedEvents.length = 0
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(404)
  res.end()
})

redisServer.listen(redisPort, "127.0.0.1")
httpServer.listen(httpPort, "127.0.0.1")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    redisServer.close()
    httpServer.close(() => process.exit(0))
  })
}
