# 보안 정책 (Security Policy)

[English](SECURITY.md) | 한국어

본 문서는 [Narwhal](https://github.com/dasomel/narwhal) Kubernetes IDP 관리 포털의 보안 취약점 보고 절차를 다룹니다.

## 취약점 보고 절차 (Reporting a Vulnerability)

**[GitHub Private Vulnerability Reporting](https://github.com/dasomel/narwhal-portal/security/advisories/new)을 사용해 주십시오.**
취약점 패치가 배포될 때까지 비공개로 안전하게 처리됩니다. 보안 문제를 공개 이슈로 등록하지 마십시오.

유효한 보안 보고서 항목:
- 영향받는 라우트 또는 API 엔드포인트
- 필요 권한 역할 (`cluster-admin`, `developer`, `viewer`, `guest`)
- OIDC 인증 이전 도달 가능 여부 (APISIX 게이트웨이 인증 이전 노출 여부)

단일 유지관리자 프로젝트로 1주일 이내 접수 확인 및 대응 계획을 안내합니다.

## 지원 버전 (Supported Versions)

| 버전 | 상태 |
|---|---|
| 1.0.x | 지원 대상 (최신 패치 태그) |
| < 1.0 | 지원 종료 |

참조: [OpenForge Security Standard](https://github.com/dasomel/openforge/blob/main/docs/security.md)
