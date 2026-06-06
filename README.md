# 한우 올인원 — 설치형 앱(PWA) 패키지

지금까지 설계한 기능(개체 관리·일괄등록, 시세/우시장, 손익 대시보드, 계획교배,
문자 자동저장, AI 어시스턴트 + AI 설정)을 하나의 설치형 웹앱으로 합친 패키지입니다.

## 들어있는 파일
- `index.html` — 앱 본체 (모든 화면 + AI 설정)
- `manifest.json` — 앱 정보(이름·아이콘·전체화면)
- `sw.js` — 서비스워커(오프라인 동작)
- `icon-192.png`, `icon-512.png` — 앱 아이콘
- `match_cases.sql` — AI 사례 검색용 벡터DB 스키마(pgvector)
- `hanwoo-ai-engine.ts` — AI 엔진(무료/유료 라우팅 + 학습)
- `hanwoo-integrations.ts` — 시세 오픈API + 공판장 문자 파싱
- `한우올인원_경영출하보고서.html` — 프린터 출력용 보고서

## 휴대폰에 "앱처럼" 설치하는 법
PWA는 HTTPS로 서비스돼야 설치됩니다. 가장 쉬운 방법:

1. 위 파일들(특히 index.html, manifest.json, sw.js, 아이콘)을 한 폴더에 둔다.
2. 무료 정적 호스팅에 올린다 — 예: GitHub Pages, Netlify, Vercel, Cloudflare Pages.
3. 휴대폰 브라우저로 그 주소를 연다.
   - **안드로이드(Chrome)**: 하단 "홈 화면에 앱 설치" 버튼 또는 메뉴 → "앱 설치"
   - **아이폰(Safari)**: 공유 → "홈 화면에 추가"
4. 홈 화면 아이콘으로 전체화면 앱처럼 실행되고, 오프라인에서도 열립니다.

> 로컬 테스트만 할 경우: `npx serve` 또는 `python3 -m http.server` 로 띄워도
> 화면 확인은 되지만, 설치/오프라인은 HTTPS 도메인에서 가장 안정적입니다.

## 다음 단계(실서비스화)
- 데이터 저장: Supabase(PostgreSQL) + 로컬 SQLite 동기화 연결
- AI: `hanwoo-ai-engine.ts`에 실제 Gemini/Claude 키 연결, `match_cases.sql` 적용
- 시세·문자: `hanwoo-integrations.ts`의 KAMIS/축평원 키 발급 후 연동
- 네이티브 배포가 필요하면 이 PWA를 Capacitor로 감싸 Play스토어/App스토어 등록 가능

## 주의
백신·질병·시세·손익 수치는 예시·기준값이며 지역/시점에 따라 변동합니다.
진단·처방은 수의사, 공공 API 명세는 공공데이터포털에서 최종 확인하세요.
