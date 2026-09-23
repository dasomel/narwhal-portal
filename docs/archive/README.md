# Archive — 개발 이력 문서

이 디렉토리는 **시점이 지난 개발 이력 문서**를 보존하는 곳입니다.
현행 문서(ADR, 로드맵, design-system, 로컬 개발 가이드 등)는 상위 `docs/`에 그대로 유지하고,
1회성 스냅샷 기록만 여기로 옮깁니다.

| 파일 | 시점 | 내용 |
|------|------|------|
| `portal-full-check.qa-report-2026-06-10.md` | 2026-06-10 | 포탈 전체 점검 + 가독성 감사 QA 리포트 (1회성 스냅샷) |
| `RELEASE-TODO-gitea-permanence.md` | 2026-06-08 (archived 2026-09-17) | selfHeal-off + etcd/Admin API 직접 patch 임시 조치 기록. **superseded** — 현재는 GitOps에 영구화되어 selfHeal은 항상 `true`. |

> 최신 상태는 상위 `docs/`의 현행 문서와 `CLAUDE.md`, `README.md`를 참고하세요.

## 아카이브 표기 규칙 (agent/source-search 판별용)

이 디렉토리로 옮기는 문서는 파일 최상단에 `> **⚠️ ARCHIVED / SUPERSEDED (<날짜>)**`로 시작하는
경고 블록을 반드시 추가한다 (grep 가능한 고정 문구). 이 블록은:
- 문서가 현재 상태를 나타내지 않음을 명시하고,
- 대체된 현재 지침이 있으면 그 문서를 링크하고,
- 문서 안의 명령/설정이 실행 지침이 아니라 이력 기록임을 밝힌다.

상위 `docs/`에 있는 활성 문서 안에서 일부만 superseded인 경우(문서 전체를 옮길 필요는 없는
경우)에도 동일하게 `> **⚠️ Superseded:**` 헤더를 그 섹션 앞에 붙여 활성 지침과 구분한다
(예: `docs/adr-skaffold-dev-workflow.md`의 "Superseded: dev TLS 전략" 섹션).
