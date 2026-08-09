# Narwhal Portal 사건 기록 (Lessons Log)

> 자매 레포 `narwhal`의
> [`docs/common/lessons-log.md`](https://github.com/dasomel/narwhal/blob/main/docs/common/lessons-log.md)와
> 같은 규칙을 따른다. 날짜별 사건 서술은 여기에, 여러 사건에 걸쳐 일반화되는 규칙만
> `CLAUDE.md` / `AGENTS.md`에 남긴다. 고치다 만든 실수도 같은 비중으로 기록한다.
>
> 항목 추가 형식: `| YYYY-MM-DD | 사건 설명 | 조치 |`
>
> 새 행을 추가하기 전에 증상으로 먼저 grep한다. 근접 항목이 있으면 그 행을 날카롭게 다듬고,
> 두 번째 행을 덧붙이지 않는다. 기록할 것은 결론이 아니라 **판별자** — 닮은 원인들과 이 원인을
> 어떻게 구분하는지, 그리고 그럴듯하지만 틀린 처방이 무엇인지.

## Mistakes Log (Compounding Engineering)

### Documentation / Release Mistakes
| Date | Mistake | Fix |
|------|---------|-----|
| 2026-08-09 | 커밋 제목만 주고 CHANGELOG를 작성시킨 워커가 **읽지 않은 구현을 그럴듯하게 지어냈다.** v1.0.2의 "k8s Events informer"를 "native `client-go` event informer"로 서술했는데, 이 레포는 TypeScript이고 `client-go`는 한 글자도 등장하지 않는다. 실제 구현은 `src/lib/live-k8s-informer.ts`의 `fetch`로 여는 core/v1 Events watch(`?watch=1`, `resourceVersion` + 백오프)다. 같은 산출물에서 Kaniko Job 매니페스트 파일명도 `narwhal-portal-k8s.yaml`로 지어냈다(실제 `deploy/kaniko-build-job.yaml`). 두 오류 모두 커밋 제목에는 없는 정보를 "채워 넣은" 자리에서 발생했고, 문장 자체는 완벽하게 자연스러웠다 | 산출물의 **모든 백틱 식별자를 기계적으로 grep**해 존재를 확인한 뒤에만 커밋한다 — 경로·env 이름·쿠키 이름·라우트·이미지 참조·컨트롤 ID 전부. 판별자: 오류는 어색한 문장이 아니라 *가장 구체적으로 들리는* 문장에 숨는다("native client-go"는 주변 어떤 문장보다 전문적으로 읽힌다). 커밋 제목은 무엇이 바뀌었는지만 말하고 어떻게 바뀌었는지는 말하지 않으므로, 구현을 서술하는 문장은 반드시 코드에서 다시 확인해야 한다. 부수 효과로, 실제 코드를 읽자 더 나은 서술이 나왔다 — `docker-publish.yml` 주석에는 v1.0.16 이미지가 QEMU arm64 빌드 2h38m 타임아웃으로 아예 발행되지 못했다는 사실이 적혀 있었고, 워커가 쓴 일반론("QEMU 대신 네이티브 러너 사용")보다 이쪽이 릴리스 노트로서 훨씬 유용하다 |
