# Contributing to Narwhal Portal

English | [한국어](CONTRIBUTING-ko.md)

Thank you for contributing to the Narwhal IDP Portal!

## Development Setup

```bash
# Install dependencies
pnpm install

# Start local Next.js dev server with mocked auth
AUTH_MOCK=true pnpm dev
```

## Coding & Design Standards

- All components must use semantic tokens from `DESIGN.md` and `src/app/globals.css`.
- Keep unit tests current (`pnpm test`).
- Type check must pass without errors (`pnpm typecheck`).
- Make the smallest coherent change that solves the requested problem.
