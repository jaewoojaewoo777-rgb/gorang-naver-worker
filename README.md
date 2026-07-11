# gorang-naver-worker

네이버 플레이스는 공식 리뷰 API가 없어서, 사장님이 확장으로 캡처한 세션쿠키를 Playwright에
주입해 사업자센터 화면을 직접 조작(스크래핑/답변게시)하는 워커. `gorang-video-server`와 같은
패턴으로 별도 Railway 서비스로 배포하고, 메인 Next.js 앱(`lib/naver.js`)이 이 서버를 호출한다.

## ⚠️ 배포 전 필수: 셀렉터 검증

`server.js`의 `SELECTORS`/`URLS`는 실제 네이버 스마트플레이스 화면을 열어 검증하기 전까지는
추정치입니다. 네이버 UI가 자주 바뀌므로, 배포 전에 반드시:

1. 실제 사장님 계정으로 네이버 로그인 → 스마트플레이스 사업자센터 접속
2. 개발자도구로 리뷰 목록/답변 버튼/입력창의 실제 class명·구조 확인
3. `SELECTORS` 값을 실측값으로 교체
4. 로컬에서 `/verify` → `/reviews` → `/reply` 순서로 실제 쿠키 넣고 테스트

## 로컬 실행

```bash
npm install
npx playwright install chromium  # Docker 밖에서 로컬 테스트 시
NAVER_WORKER_SECRET=아무값 node server.js
```

## 환경변수

| 변수 | 설명 |
|---|---|
| `NAVER_WORKER_SECRET` | 메인 앱(`lib/naver.js`)과 공유하는 Bearer 토큰. Vercel의 `NAVER_WORKER_SECRET`과 동일해야 함 |
| `PORT` | Railway가 자동 주입 |

## 엔드포인트

- `POST /verify` — `{ cookies }` → `{ valid, placeName, placeId }`
- `POST /reviews` — `{ cookies, placeId }` → `{ reviews: [...] }`
- `POST /reply` — `{ cookies, placeId, reviewId, replyText }` → `{ ok: true }`
- `GET /health` — 헬스체크
