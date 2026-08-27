# Narwhal Portal 기여 가이드 (Contributing Guide)

[English](CONTRIBUTING.md) | 한국어

Narwhal IDP Portal 프로젝트에 기여해 주셔서 감사합니다!

## 로컬 개발 환경 설정

```bash
# 의존성 설치
pnpm install

# Mock 인증 모드로 로컬 Next.js 개발 서버 실행
AUTH_MOCK=true pnpm dev
```

## 코딩 및 디자인 표준

- 모든 UI 컴포넌트는 `DESIGN.md` 및 `src/app/globals.css`에 정의된 시맨틱 토큰을 사용해야 합니다.
- 단위 테스트를 최신 상태로 유지하십시오 (`pnpm test`).
- TypeScript 타입 검사를 통과해야 합니다 (`pnpm typecheck`).
- 요구사항을 해결하는 가장 작고 일관된 변경을 지향합니다.
