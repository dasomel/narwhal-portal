# Narwhal Portal Adoption Guide

> First success is a user-visible Day-2 workflow backed by the intended Narwhal integration, not merely a successful Next.js build.

## 1. Start with one read-only journey

Use the repository README for local/in-cluster development. For first evaluation, prefer a read-only workflow such as Dashboard or cluster visibility before testing mutating operations.

## 2. First verified success

1. Start the portal in the documented development mode.
2. Complete the required authentication/security bootstrap.
3. Connect to the intended Narwhal/backend boundary.
4. Open one implemented workspace and confirm real or controlled backend data is rendered.
5. Verify error/loading/empty states for that workspace.
6. Only then expand to onboarding, templates, governance, or mutating operations.

## 3. Implemented vs planned UI

Screenshots and feature lists should identify whether the shown workflow is implemented, fixture-backed, or planned. Placeholder imagery must not be presented as evidence of a released workflow.

## 4. Documentation path

README remains the developer entry point. This guide defines the user-oriented acceptance journey. Architecture/navigation documentation should explain how Dashboard, Onboarding, Catalog, Nodes, Cost, Security, Governance, Architecture, and Templates map to backend ownership rather than only listing routes.

## 5. Security boundary

Authentication, cluster credentials, server actions/API routes, filesystem/process access, and Kubernetes mutation are design-level boundaries. UI success alone does not prove the backend permission model is safe.