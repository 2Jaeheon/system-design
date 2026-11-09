# 진행 명령

훅이 제공한 CLI 절대 경로와 현재 `owner`, 실제 `userRef`를 사용한다. 원문을 인자나 임시 파일에 넣지 않는다. CLI 입력은 `--input`의 완성된 JSON 문자열이다. 경로와 JSON을 작은따옴표로 감싸고, JSON 안 작은따옴표는 `\u0027`로 바꾼다. 환경변수나 명령 치환, 파이프, 명령 연결로 호출하지 않는다.

## 최초 연결

- `settings --input '{}'`: 볼트와 기록 설정 조회. 없으면 `setup` 스킬을 따른다.
- `status --input '{"owner":{"host":"codex","sessionId":"실제 세션 ID"}}'`: 현재 채팅의 작업 조회.
- `setup`: `owner`, `obsidianVault`, `obsidianFolder`, `archiveEnabled`. 추가 원문 보관을 켤 때만 그 선택의 `userRef`도 필요하다.
- `start`: `title`, `projectRoot`, `owner`, 프로젝트 상대 경로인 `designDir`, `adrDir`, 볼트 상대 경로인 `obsidianNote`. 기존 프로젝트 설정을 재사용할 때만 경로 생략 가능. 처음 요청에 실제 설계 생각이 있으면 그 발화 참조를 `initialUserRef`에 넣고, 아직 물어야 할 질문 하나가 있으면 `firstQuestion`에 넣는다. 생각이 없는 호출이나 설정 선택을 설계 판단으로 처리하지 않는다.

`start`와 `advance`는 첫 질문을 반환한다. 첫 요청의 생각으로 현재 주제가 이미 정리됐다면 첫 `checkpoint`에 `initialUserRef`를 포함해 저장하고 이미 답한 질문을 다시 하지 않는다. 시작 뒤 새 발화가 있다면 그 최신 발화도 시간 순서로 포함한다. 별도 `question` 호출을 하지 않는다. CLI 기본 응답은 현재 상태, 버전, 필요한 문서 경로만 포함한다. 전체 내용은 복원이나 감사가 필요할 때 `detail:"full"`로 조회한다. `help`에는 필요한 `command` 하나만 지정한다.

## 주제 단위 저장

평소 대화에는 호출이 없다. 주제가 정리되면 `checkpoint`를 한 번 호출한다. 주제 중간 질문을 DB의 질문으로 매번 등록하지 않는다.

공통 필드:

- `workflowId`, `owner`: 현재 작업과 소유 세션
- `expectedRevision`: 훅 또는 마지막 성공 응답의 버전. 같은 대화에서 매번 상태를 재조회하지 않는다.
- `operationId`: 이번 저장의 고유 이름. 같은 입력 재시도에는 같은 값을 쓴다.

`checkpoint` 필드:

- `topic`: 이번에 정리한 주제 이름
- `interpretation`: 현재 단계의 짧은 누적 AI 해석
- `userRefs`: 마지막 저장 이후 이번 주제에 사용한 실제 사용자 발화 참조 목록. 시간 순서이며 시작 뒤의 가장 최근 발화까지 포함한다. 첫 주제에 한해 `start`에 등록한 `initialUserRef`를 포함할 수 있다. 시작 뒤 새 발화가 없으면 설정 선택 같은 시작 전 발화는 강제로 넣지 않는다. 사용자의 답이 바뀌었으면 최신 판단을 요약에 반영한다.
- `content`: 현재 단계의 설계 문서 전체. 원문 대화는 넣지 않는다.
- `nextQuestion`: 같은 단계에서 다음에 물을 질문 하나. 단계 이동 시에는 생략한다.
- `decisions`: 필요한 ADR 목록. 각 항목에 `title`, `background`, `choice`, `alternatives`, `reason`, `consequences`, `verification`, `revisit`, `stages`를 넣는다. 배열 필드는 `alternatives`, `consequences`, `stages`다. 이번 주제의 명확한 선택 근거인 `userRef`가 있으면 확정하고, 없으면 제안으로 둔다.
- `issues`, `learning`: 필요한 경우에만 목록으로 추가한다. 개별 형식은 `help`의 `issue`, `learning`으로 확인한다.
- `criteria`, `reviewSummary`, `advance:true`: 단계 완료 시에만 포함한다. 현재 단계의 모든 완료 기준을 검토한 뒤 이동한다. `advance`와 `nextQuestion`은 함께 쓰지 않는다.
- `nextStageQuestion`: `advance:true`로 다음 단계에 이동할 때만 사용한다. 앞선 대화를 바탕으로 다음에 검토할 주제 하나를 질문하며, 생략하면 단계별 기본 질문이 저장된다. 별도 `advance` 명령에도 같은 필드를 넣을 수 있다. 저장 결과의 대기 질문을 사용자에게 보여 준다.

답변 요약, 문서, ADR, 다음 질문, 개인 노트는 하나의 저장 작업으로 처리한다. 중요한 저장 실패 시 같은 작업의 DB 변경과 문서를 되돌린다. Obsidian만 실패하면 `obsidianPending`을 알리고 나중에 `sync`한다. 저장에 성공한 응답을 확인한 뒤 저장됐다고 말한다.

내용을 정리하는 중에 사용자가 중단하면, 아직 정하지 않은 조건을 미정으로 남긴 주제를 저장한 뒤 `pause`한다. 단계를 완료로 만들지 않는다. 대화 맥락이 사라지면 저장되지 않은 발화 참조를 만들어내지 않는다.

## 오류와 특수 작업

`ok:false`이면 오류 코드를 확인한다. 버전 충돌 때만 최신 상태를 다시 읽고 같은 변경을 중복 생성하지 않는다. 문서 충돌은 직접 수정 내용을 보존한다. 복구 중 필요한 오류 세부 정보는 짧은 응답에서도 생략하지 않는다.

`STATE_OPEN_FAILED`는 진행 정보를 열지 못했다는 뜻이다. 상태 폴더의 접근 권한과 DB 상태를 확인하고, 읽을 수 없는 정보를 없다고 단정하지 않는다. DB가 WAL 방식인 경우 읽기 전용 연결에도 필요한 보조 파일 접근이 없으면 조회가 실패할 수 있다. 상태를 복사하거나 경로를 바꾸어 훅을 우회하지 않는다.

이미 저장한 해석 수정, ADR 대체, 문서 복구, 인계와 구현 전환은 [개별 명령](cli-advanced.md)을 필요할 때만 읽는다. 새 작업의 단계 값은 `requirements`, `non-functional`, `entities`, `api`, `architecture`, `deep-dive`, `evaluation`이다.
