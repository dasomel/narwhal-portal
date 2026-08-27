# DESIGN-ko.md

[English](DESIGN.md) | 한국어

## 제품 아키타입 (Product archetype)

`archetype: Operations Dashboard`

Narwhal Portal은 Kubernetes 내부 개발자 플랫폼(IDP) 관리 포털을 위한 사용자 인터페이스입니다.

## 제품 성격 및 규칙

1. **라이트 모드가 기본값입니다.** 다크 모드는 사용자 토글 옵션입니다.
2. **단일 테마 시스템:** 모든 컴포넌트는 시맨틱 토큰을 사용합니다.
3. **하드코딩 색상 금지:** `#0f172a`, `text-gray-500` 등의 직접 색상 지정을 지양하고 토큰을 참조합니다.
4. **일관된 브랜드 아이덴티티:** Narwhal 마스코트 색상은 테마와 관계없이 일정하게 유지됩니다.

## 시맨틱 토큰 매핑 (Token mapping)

```yaml
tokens:
  bgCanvas: var(--of-color-bg-canvas, oklch(1 0 0))
  bgSurface: var(--of-color-bg-surface, oklch(0.97 0 0))
  bgSurfaceRaised: var(--of-color-bg-surface-raised, oklch(0.922 0 0))
  textPrimary: var(--of-color-text-primary, oklch(0.145 0 0))
  textSecondary: var(--of-color-text-secondary, oklch(0.50 0 0))
  textMuted: var(--of-color-text-muted, oklch(0.50 0 0))
  borderDefault: var(--of-color-border-default, oklch(0.922 0 0))
  accentPrimary: var(--of-color-accent-primary, #0891b2)
  danger: var(--of-color-status-danger, oklch(0.577 0.245 27.325))
  success: var(--of-color-status-success, #16a34a)
```
