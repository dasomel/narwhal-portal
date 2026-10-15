import { createServer } from "node:http"

const port = 3199
const now = "2026-10-03T00:00:00.000Z"

function makeApp() {
  return {
    metadata: {
      name: "portal-e2e",
      namespace: "argocd",
      creationTimestamp: now,
      annotations: { "narwhal.io/owner": "Platform QA" },
    },
    spec: {
      project: "platform",
      source: { repoURL: "https://example.invalid/platform/portal-e2e.git", targetRevision: "main", path: "deploy" },
      destination: { server: "https://kubernetes.default.svc", namespace: "platform-e2e" },
    },
    status: {
      sync: { status: "OutOfSync", revision: "before-sync-revision" },
      health: { status: "Healthy" },
      history: [{ id: 1, revision: "before-sync-revision", deployedAt: now }],
      resources: [{ version: "v1", kind: "Deployment", namespace: "platform-e2e", name: "portal-e2e", status: "OutOfSync", health: { status: "Healthy" } }],
    },
  }
}

function makeFrontendApp() {
  return {
    ...makeApp(),
    metadata: { ...makeApp().metadata, name: "frontend-e2e" },
    spec: {
      ...makeApp().spec,
      project: "apps",
      destination: { ...makeApp().spec.destination, namespace: "frontend-e2e" },
    },
  }
}

let app = makeApp()
let syncRequests = 0
let readsAfterSync = 0

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

async function readBody(req) {
  for await (const _chunk of req) {
    // The fixture intentionally ignores provider request bodies.
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)

  if (url.pathname === "/health") {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === "/__test/reset" && req.method === "POST") {
    app = makeApp()
    syncRequests = 0
    readsAfterSync = 0
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname === "/__test/state" && req.method === "GET") {
    sendJson(res, 200, { syncRequests, readsAfterSync, app })
    return
  }

  if (url.pathname === "/api/v1/applications" && req.method === "GET") {
    sendJson(res, 200, { items: [app, makeFrontendApp()] })
    return
  }

  if (url.pathname === "/api/v1/applications/portal-e2e" && req.method === "GET") {
    if (syncRequests > 0) readsAfterSync += 1
    sendJson(res, 200, app)
    return
  }

  if (url.pathname === "/api/v1/applications/portal-e2e/sync" && req.method === "POST") {
    await readBody(req)
    syncRequests += 1
    app = {
      ...app,
      status: {
        ...app.status,
        sync: { status: "Synced", revision: "verified-sync-revision" },
        operationState: {
          phase: "Succeeded",
          finishedAt: now,
          syncResult: { revision: "verified-sync-revision" },
        },
      },
    }
    sendJson(res, 200, app)
    return
  }

  if (url.pathname === "/api/v1/applications/frontend-e2e" && req.method === "GET") {
    sendJson(res, 200, makeFrontendApp())
    return
  }

  if (url.pathname === "/api/v1/namespaces" && req.method === "GET") {
    sendJson(res, 200, {
      metadata: { resourceVersion: "1" },
      items: [{
        metadata: {
          name: "platform-e2e",
          labels: { "narwhal.io/team": "platform-team" },
          creationTimestamp: now,
        },
        status: { phase: "Active" },
      }, {
        metadata: {
          name: "frontend-e2e",
          labels: { "narwhal.io/team": "frontend-team" },
          creationTimestamp: now,
        },
        status: { phase: "Active" },
      }],
    })
    return
  }

  if (url.pathname === "/api/v2/alerts" && req.method === "GET") {
    sendJson(res, 200, [])
    return
  }

  sendJson(res, 404, { error: "fixture route not found", path: url.pathname })
})

server.listen(port, "127.0.0.1")

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
