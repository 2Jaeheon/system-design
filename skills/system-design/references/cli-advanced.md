# 개별 변경과 복구 명령

일반 대화는 `checkpoint`를 사용한다. 이 문서는 저장한 기록의 수정, 복구, 인계, 구현 연결이 필요할 때만 읽는다. `answer`와 `question`을 매 답변마다 호출하지 않는다.

## 인터뷰와 설계 저장

이미 받은 답을 AI가 잘못 요약했다면 `answer-revise`에 기존 답변의 `userRef`, 바른 `interpretation`, 수정 `reason`을 넣는다. 이전 AI 해석과 수정 이유를 보존하고 검토 결과를 다시 확인한다. 새 사용자 답변을 만들거나 현재 기다리는 질문에 답한 것으로 처리하지 않는다. 사용자 의도가 모호하다면 요약을 임의로 고치지 말고 질문한다.

- `question`: `text`에 이번 질문 하나를 넣는다. 이미 답변을 기다리는 질문을 쉽게 바꿀 때만 `replace:true`를 사용한다. 다른 질문으로 조용히 바꾸지 않는다.
- `answer`: `questionId`, 질문 뒤에 나온 최신 `userRef`, `interpretation`을 전달한다. `interpretation`은 이번 답을 반영한 **현재 단계 전체의 짧은 AI 해석**이다. 원문 인용이나 사용자의 확정 결정으로 표시하지 않는다. 질문 이전의 발화나 침묵은 답변으로 사용할 수 없다. 설명이 필요하면 `needsExplanation:true`를 넣는다.
- `explain`: `summary`에 설명한 개념을 남긴다. `nextQuestion`으로 원래 판단을 쉬운 말로 다시 묻는다. 설명 사실만 남기며 사용자의 이해를 확정하지 않는다.
- `learning`: `kind`는 `explained`, `user_reported`, `user_explained` 중 하나다. `text`는 해당 사실의 짧은 기록이다. 뒤의 두 종류에는 실제 사용자 발화의 `userRef`가 필요하다.
- `issue`: 추가는 `action:"add"`, `text`, `stage`, `blocking`을 전달한다. 해결은 `action:"resolve"`, `id`, 판단을 확인한 `userRef`를 전달한다. 코드에서 확인할 사실은 먼저 확인하고, 사용자 판단이 필요한 질문만 남긴다. 해결되지 않은 중요한 판단을 비차단 항목으로 바꾸지 않는다.
- `design`: `content`에 현재 단계의 설계 Markdown을 전달한다. 원문 대화는 넣지 않는다. 문서를 수정하면 이전 검토 결과가 지워지므로 다시 검토한다.
- `review`: `criteria`와 `summary`로 기준별 근거를 남긴다. 문서 저장과 미해결 질문 확인을 먼저 끝낸다.
- `advance`: 기준을 충족한 현재 단계를 완료한다. 마지막 단계에서는 구현 요청 대기로 이동한다.
- `reopen`: `stages`에 영향을 받는 단계만 넣고 `reason`을 남긴다. 구현은 멈추고 해당 판단을 다시 검토한다. 기존 결정은 지우지 않는다.

단계 값은 `requirements`, `non-functional`, `entities`, `api`, `architecture`, `deep-dive`, `evaluation`이다.

## 결정과 문서 변경

ADR의 제목만 잘못 적었다면 `decision-retitle`에 `decisionId`, 바른 `title`, 수정 `reason`을 전달한다. 이전 제목은 진행 정보에 남고, 결정 본문과 확정 상태는 바뀌지 않는다. 선택 자체가 바뀐 경우에는 새 ADR을 만들고 기존 결정을 대체한다.

- `decision-propose`: `title`, `background`, `choice`, `alternatives`, `reason`, `consequences`, `verification`, `revisit`, `stages`로 ADR 제안을 저장한다. 대안과 영향은 문자열 목록이다. 관련 질문과 세션 참조, 설계 문서, 코드 위치와 검증 근거를 배경 및 검증 항목에서 연결한다.
- `decision-accept`: `decisionId`와 해당 선택을 분명히 밝힌 `userRef`로 확정한다. AI 추천이나 일반적인 긍정만으로 선택을 확정하지 않는다.
- `decision-supersede`: 기존 `decisionId`, 이미 확정한 새 `replacementId`, 변경을 확인한 `userRef`를 전달한다. 이전 ADR을 보존하며 관련 단계를 다시 연다.
- `reconcile`: 직접 수정된 내용을 읽고 사용자와 의미를 확인한 뒤 `artifactId`, 현재 `observedHash`, `userRef`, `meaning:"unchanged"` 또는 `"changed"`를 전달한다. 프로젝트 설계의 의미가 달라졌다면 `stages`도 필요하다. 내용을 모른 채 현재 해시만 승인하지 않는다.
- `recover`: 저장 중단 뒤 파일 변경이 발견되면 `status`의 `pendingRecovery`를 확인한다. 각 `documents`의 파일을 실제로 읽고 사용자와 확인한 뒤, 공통 변경 입력에 `pendingOperationId`, 확인한 `documents`, `userRef`, 영향을 받는 `stages`를 넣는다. 각 문서는 `{path, observedHash}`이며 파일이 없으면 해시는 `null`이다. 현재 파일을 그대로 보존하고 관련 단계를 다시 검토한다. 중단된 저장이나 결정이 완료됐다고 추정하지 않는다.
- `sync`: Obsidian 기록을 다시 반영한다. 실패하면 `obsidianPending`을 알리고 원본 설계 작업은 계속한다.

ADR 제안에는 관련 설계 문서와 인터뷰 위치가 자동으로 연결된다. 코드나 측정 자료가 판단 근거라면 `decision-propose`의 `references`에 짧은 설명과 링크를 추가한다. `verify`에서 결정 번호를 연결하면 실제 완료 조건별 검증 결과가 해당 ADR에도 반영된다. 측정 계획을 실제 측정 결과처럼 적지 않는다.

## 중단, 인계와 구현

- `pause`와 `resume`: 같은 소유 세션에서 단계와 질문을 보존해 중단하거나 이어간다.
- `handoff`: 현재 소유 세션에서 사용자 요청의 `userRef`와 받는 세션의 `to:{host,sessionId}`를 전달한다. 다른 세션의 ID를 추측하지 않는다. 이전 소유자는 이후 조회만 할 수 있다.
- `implement`: 설계 완료 이후 별도로 받은 명확한 구현 요청의 `userRef`, `scope`, `acceptance` 목록을 전달한다. 다시 검토한 설계에서 이전 구현을 이어갈 때 `continuation:true`를 쓸 수 있으나 범위와 완료 조건이 같아야 한다.
- `verify`: `checks`에 `{criterion, result, evidence}`를 넣는다. `criterion`은 완료 조건의 0부터 시작하는 번호, `result`는 `passed`, `failed`, `not_run` 중 하나다. 매번 현재 전체 검증 결과를 전달한다. `implementedDecisionIds`와 `verifiedDecisionIds`는 실제 구현 및 검증된 ADR에만 사용한다.
- `complete`: 모든 완료 조건에 실제 통과 근거가 있을 때 실행한다. 실행하지 않은 검증이나 예상값을 성공으로 바꾸지 않는다.
- `grant`: 차단 결과의 `fingerprint`와 사용자가 그 호출을 허용한 `userRef`를 전달한다. 현재 작업의 정확한 호출 한 번에만 적용한다. 제품 코드 수정이나 포괄적인 도구 사용 권한을 얻기 위한 수단이 아니다.

원문 추가 보관을 선택하면 훅이 해당 작업의 이후 사용자 입력을 개인 위치에 보관한다. 기본 진행에는 `archive` 명령이 필요하지 않다. 원문을 CLI 인자에 실어 별도 저장하거나 과거 세션 전체를 내보내지 않는다.

## 검토 기준 입력

현재 단계의 기준 키는 각 단계 안내와 `help`에 있다. `criteria`의 각 값은 `{status:"met", evidence:"근거"}`다. 아직 실측할 수 없는 기능 및 비기능 요구사항의 `evidence` 기준과 상세 검토의 `validation` 기준에만 `status:"deferred"`와 구체적인 `verification` 계획을 허용한다. 설계를 바꿀 미해결 판단을 측정 보류로 숨기지 않는다. 기준의 이름을 바꾸거나 새 이름으로 기존 기준을 우회하지 않는다.

코드가 확인하는 것은 기록 구조와 진행 조건이다. 근거의 의미가 충분한지는 대화에서 검토해야 한다. 기준이 충족되지 않아 거부된 명령을 직접 DB 수정이나 별도 파일 쓰기로 우회하지 않는다.
