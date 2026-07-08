# Portal Screenshots

Drop PNG captures here using the exact filenames below — the repo `README.md` /
`README_ko.md` "Screenshots" section references them and they render automatically.

| Filename | View | Suggested capture |
|----------|------|-------------------|
| `dashboard.png`    | 홈 / Dashboard   | Cluster real-time metrics (CPU/Memory/Nodes/Pods), trend charts, ArgoCD app status, active alerts |
| `architecture.png` | 아키텍처 / Architecture | Cluster infra tab (nodes/namespaces/control plane) or the service dependency graph |
| `security.png`     | 보안 / Security  | Trivy vulnerability reports summary |
| `cost.png`         | 비용 / Cost      | Namespace cost breakdown |
| `governance.png`   | 거버넌스 / Governance | Scorecard / DORA metrics / distribution |
| `catalog.png`      | 카탈로그 / Catalog | Self-service application catalog |

## Capture tips

- Log in to `https://portal.local.narwhal.internal` (SSO) as `admin`, then navigate to each page.
- Use a **1440–1600px** wide viewport and light theme for crisp, consistent shots.
- Crop to the content area (exclude browser chrome) for a clean look.
- Keep filenames lowercase; PNG preferred. Optimize (e.g. `pngquant`/`oxipng`) to keep the repo light.
