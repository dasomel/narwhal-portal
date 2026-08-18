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
| 2026-08-09 | `release.yml`의 CHANGELOG 섹션 추출이 **모든 버전에서 조용히 빈 결과**를 냈다. 원인은 `awk -v p="^## \\[${v}\\]"` — `awk -v`는 값에 든 백슬래시 이스케이프를 소비하므로 `\[`가 `[`로 줄어들어 정규식이 `^## [1.0.16]`, 즉 문자 클래스가 된다. 이 클래스는 `## ` 다음의 한 글자를 요구하므로 실제 제목과 절대 일치하지 않는다. 자매 레포 narwhal의 원본은 같은 정규식을 **프로그램 문자열에 직접 보간**해서(`awk "/^## \[${VERSION}\]/{...}"`) 이 경로를 타지 않았고, 그래서 "그대로 옮기면 된다"는 가정이 틀렸다. awk는 경고조차 내지 않았고 종료 코드도 0이었다 | 제목 일치를 정규식이 아니라 **접두사 비교**로 바꿨다: `awk -v target="## [${version}]" 'index($0, target) == 1'`. 이스케이프 문제가 사라질 뿐 아니라 버전의 `.`이 자동으로 리터럴이 되어 `1.0.1`이 `1.0.15` 제목에 걸리는 별개의 함정까지 같이 막힌다. 판별자: `awk -v`로 넘긴 값이 정규식이면 항상 의심하라 — 실패가 "매치 없음"으로 나타나기 때문에 데이터가 없는 것과 구분되지 않는다. 그리고 이 버그를 잡은 것은 코드 리뷰가 아니라 **커밋 전에 7개 태그 전부로 추출을 돌려본 것**이다. 존재하는 태그가 하나라도 빈 결과면 로직이 틀린 것이고, 존재하지 않는 태그가 빈 결과여야 가드가 맞는 것 — 두 방향을 다 돌려야 판별된다 |
| 2026-08-09 | 커밋 제목만 주고 CHANGELOG를 작성시킨 워커가 **읽지 않은 구현을 그럴듯하게 지어냈다.** v1.0.2의 "k8s Events informer"를 "native `client-go` event informer"로 서술했는데, 이 레포는 TypeScript이고 `client-go`는 한 글자도 등장하지 않는다. 실제 구현은 `src/lib/live-k8s-informer.ts`의 `fetch`로 여는 core/v1 Events watch(`?watch=1`, `resourceVersion` + 백오프)다. 같은 산출물에서 Kaniko Job 매니페스트 파일명도 `narwhal-portal-k8s.yaml`로 지어냈다(실제 `deploy/kaniko-build-job.yaml`). 두 오류 모두 커밋 제목에는 없는 정보를 "채워 넣은" 자리에서 발생했고, 문장 자체는 완벽하게 자연스러웠다 | 산출물의 **모든 백틱 식별자를 기계적으로 grep**해 존재를 확인한 뒤에만 커밋한다 — 경로·env 이름·쿠키 이름·라우트·이미지 참조·컨트롤 ID 전부. 판별자: 오류는 어색한 문장이 아니라 *가장 구체적으로 들리는* 문장에 숨는다("native client-go"는 주변 어떤 문장보다 전문적으로 읽힌다). 커밋 제목은 무엇이 바뀌었는지만 말하고 어떻게 바뀌었는지는 말하지 않으므로, 구현을 서술하는 문장은 반드시 코드에서 다시 확인해야 한다. 부수 효과로, 실제 코드를 읽자 더 나은 서술이 나왔다 — `docker-publish.yml` 주석에는 v1.0.16 이미지가 QEMU arm64 빌드 2h38m 타임아웃으로 아예 발행되지 못했다는 사실이 적혀 있었고, 워커가 쓴 일반론("QEMU 대신 네이티브 러너 사용")보다 이쪽이 릴리스 노트로서 훨씬 유용하다 |

### Licensing / Redistribution Mistakes
| Date | Mistake | Fix |
|------|---------|-----|
| 2026-08-18 | 공개 레포에 **OSS 라이선스 고지가 한 줄도 없었다.** `LICENSE` 없음, `package.json`에 `license` 필드 없음, README에 라이선스 절 없음, `NOTICE`/`THIRD-PARTY-NOTICES` 없음 — GitHub API도 `license: null`을 반환했다. 더 무거운 쪽은 **배포 이미지**였다. `next build`의 파일 트레이싱은 서버가 로드하는 것만 남기므로 `LICENSE` 파일을 걷어낸다: 1.0.17 빌드 기준 `node_modules` 631개 → `.next/standalone` **3개**(그마저 `fetch-blob`과 `grpc-js` 내부 proto). MIT/BSD/ISC는 "all copies or substantial portions"에 저작권·허가 고지를 요구하고 Apache-2.0 §4(d)는 NOTICE 전파를 요구하는데, 이미지가 바로 그 copy다. 레포에 의존성을 vendoring 하지 않는다는 사실이 "재배포하지 않는다"는 뜻으로 오독되기 쉽다 — 재배포는 이미지에서 일어난다 | `LICENSE`(Apache-2.0, narwhal과 동일) + `NOTICE`(사람이 읽는 요약) + `scripts/generate-third-party-notices.mjs`가 생성하는 `THIRD-PARTY-NOTICES.md`(프로덕션 659패키지, 라이선스 원문 포함)를 추가하고, Dockerfile runner 스테이지가 셋 다 이미지에 `COPY` 한다. 생성물이므로 `license-and-sbom.yml`이 재생성 후 diff로 신선도를 강제하고, `--strict`가 PERMISSIVE에도 ACCEPTED에도 없는 라이선스에서 CI를 세운다. 판별자: **"레포에 없다"와 "배포물에 없다"는 다른 질문이다.** 라이선스 준수는 소스 트리가 아니라 *아티팩트*를 기준으로 세야 하고, 그 확인 명령은 `find .next/standalone -type f -iname 'LICENSE*' \| wc -l`처럼 산출물을 직접 세는 것이어야 한다. `.dockerignore`에 `*.md`가 있어 `!THIRD-PARTY-NOTICES.md` 재포함이 필요했던 것도 같은 이유로 놓치기 쉽다 |
| 2026-08-18 | (고치다 만든 실수) libvips(LGPL-3.0-or-later)를 이미지에서 빼려고 `images: { unoptimized: true }`를 넣고 **끝난 줄 알았다.** 근거는 타당해 보였다 — `src` 전체에 `next/image` import가 0건이니 optimizer는 쓰이지 않는다. 그러나 재빌드 후 `.next/standalone/node_modules/@img`에 `sharp-libvips-*`가 **그대로 남아 있었다.** Next는 optimizer 사용 여부와 무관하게 sharp를 트레이싱에 포함한다. 설정 한 줄로 산출물이 바뀔 것이라 믿고 확인하지 않았다면 "LGPL 제거함"이라고 잘못 보고할 뻔했다 | `outputFileTracingExcludes`로 `sharp`/`@img`를 명시적으로 제외한 뒤 재빌드해 실제 파일 0개를 확인하고, standalone 서버를 **기동해서** `/`가 307(인증 리다이렉트)로 응답하고 모듈 오류가 없음까지 확인했다. `build-check.yml`에 산출물과 이미지 양쪽에 대한 libvips 부재 단언을 추가했다. 판별자: 설정 플래그의 이름(`unoptimized`)이 산출물 구성까지 바꿔줄 것이라는 추정은 **트레이싱과 런타임 분기가 별개**라는 사실 앞에서 깨진다. 빌드 산출물에 관한 주장은 산출물을 `find`로 세서만 확정하고, 제외한 모듈이 실제로 필요 없었는지는 서버를 띄워 라우트 응답으로 확인한다 |
