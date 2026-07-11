// 고랑AI 네이버 플레이스 워커
//
// 네이버는 플레이스 리뷰 조회/답변 공식 API를 제공하지 않는다. 그래서 사장님이 크롬 확장으로
// 캡처해준 세션쿠키를 여기서 Playwright에 주입해, 네이버 스마트플레이스 사업자센터를
// 사람이 쓰듯 브라우저로 조작해서 리뷰를 긁어오고 답변을 게시한다.
//
// ⚠️ 2026-07-11 실제 화면 캡처(마음스튜디오 계정)로 URL 구조/버튼 문구는 확인됨.
// 다만 리뷰 카드 컨테이너의 실제 class/속성은 DevTools 없이는 못 봐서 텍스트 기반 셀렉터로
// 추정 구현했다. 실제 쿠키로 /reviews 한 번 돌려보고 결과가 비거나 이상하면 이 부분부터 의심할 것.

const express = require('express')
const { chromium } = require('playwright')

const app = express()
app.use(express.json({ limit: '5mb' }))

const PORT = process.env.PORT || 3000
const WORKER_SECRET = process.env.NAVER_WORKER_SECRET

// 실측 확인됨 (2026-07-11, 마음스튜디오 예시):
// https://new.smartplace.naver.com/bizes/place/5176498/reviews?bookingBusinessId=1663323&menu=visitor
// placeId(URL 경로)와 bookingBusinessId(쿼리)는 서로 다른 값이라 둘 다 필요하다.
const URLS = {
  reviews: (placeId, bookingBusinessId) =>
    `https://new.smartplace.naver.com/bizes/place/${placeId}/reviews?bookingBusinessId=${bookingBusinessId}&menu=visitor`,
}

// 답글 글자수 제한 실측 확인됨: 최소 15자 ~ 최대 500자
const REPLY_MIN_LEN = 15
const REPLY_MAX_LEN = 500

const SELECTORS = {
  // 로그인 세션 만료 시 nid.naver.com으로 리다이렉트됨 (page.url()로 판별, 아래 isLoginRedirect 참고)

  // 리뷰 카드 컨테이너: 실제 class명 미확인. "방문일"이 모든 리뷰 카드에 공통으로 찍혀있는 걸
  // 이용해 그 텍스트를 포함하는 블록을 카드 단위로 취급하는 임시 방편.
  // TODO(검증필요): DevTools로 실제 리뷰 카드 class/data-* 확인 후 안정적인 셀렉터로 교체.
  reviewItem: 'div:has(> :text("방문일"))',

  // 별점: "★5" 형태로 붉은 별 아이콘 옆에 숫자가 붙어서 렌더링됨 (실측 확인)
  reviewRatingText: 'text=/★\\s*\\d/',

  // 기존 답글 있는 카드: 사업장 이름(마음스튜디오 등) + "수정"/"삭제" 버튼 쌍으로 식별 (실측 확인)
  existingReplyEditBtn: 'button:has-text("수정")',
  existingReplyDeleteBtn: 'button:has-text("삭제")',

  // 답글 수정 시 나오는 텍스트영역 + 저장/취소 버튼 (실측 확인: "수정"=저장, "닫기"=취소)
  replyTextarea: 'textarea',
  replySaveBtn: 'button:has-text("수정")',
  replyCancelBtn: 'button:has-text("닫기")',

  // 미답글 리뷰는 별도 트리거 클릭 없이 빈 textarea + "등록"/"닫기" 버튼이 바로 노출됨 (실측 확인, 2026-07-11)
  newReplySubmitBtn: 'button:has-text("등록")',
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  if (!WORKER_SECRET || auth !== `Bearer ${WORKER_SECRET}`) {
    return res.status(401).json({ error: '인증 실패' })
  }
  next()
}

function isLoginRedirect(page) {
  return page.url().includes('nid.naver.com')
}

// Chrome cookies.getAll() 형식 → Playwright addCookies() 형식으로 변환
function toPlaywrightCookies(cookies) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expirationDate || -1,
    secure: c.secure !== false,
    httpOnly: false, // getAll()로는 httpOnly 값 조회는 가능하나 그대로 전달
  }))
}

let browserPromise = null
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true })
  }
  return browserPromise
}

async function withPage(cookies, fn) {
  const browser = await getBrowser()
  const context = await browser.newContext({ locale: 'ko-KR' })
  try {
    await context.addCookies(toPlaywrightCookies(cookies))
    const page = await context.newPage()
    return await fn(page)
  } finally {
    await context.close()
  }
}

// placeId/bookingBusinessId는 확장에서 사장님이 리뷰 페이지를 열어둔 상태의 탭 URL에서 직접
// 파싱해오므로(연동 시점에 결정), 여기서는 그 값이 실제로 유효한 세션인지만 확인한다.
app.post('/verify', requireAuth, async (req, res) => {
  const { cookies, placeId, bookingBusinessId } = req.body
  if (!Array.isArray(cookies) || !placeId || !bookingBusinessId) {
    return res.status(400).json({ error: 'cookies, placeId, bookingBusinessId 필요' })
  }

  try {
    const result = await withPage(cookies, async (page) => {
      await page.goto(URLS.reviews(placeId, bookingBusinessId), {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      })

      if (isLoginRedirect(page)) return { valid: false }

      const reviewCount = await page.locator(SELECTORS.reviewItem).count().catch(() => 0)
      return { valid: true, placeId, reviewCountSeen: reviewCount }
    })

    res.json(result)
  } catch (err) {
    console.error('[verify]', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/reviews', requireAuth, async (req, res) => {
  const { cookies, placeId, bookingBusinessId } = req.body
  if (!Array.isArray(cookies) || !placeId || !bookingBusinessId) {
    return res.status(400).json({ error: 'cookies, placeId, bookingBusinessId 필요' })
  }

  try {
    const reviews = await withPage(cookies, async (page) => {
      await page.goto(URLS.reviews(placeId, bookingBusinessId), {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      })
      if (isLoginRedirect(page)) throw new Error('세션 만료 — 확장에서 다시 연결 필요')

      await page.waitForSelector(SELECTORS.reviewItem, { timeout: 10000 }).catch(() => {})

      const items = await page.locator(SELECTORS.reviewItem).all()
      const results = []

      for (const item of items) {
        try {
          const fullText = await item.innerText().catch(() => '')
          if (!fullText.includes('방문일')) continue // 리뷰 카드가 아닌 중첩 div 제외

          // 작성자: "방문일" 줄 이전의 첫 줄을 이름으로 취급 (실측: 이름 다음 줄이 "리뷰 N·사진 M·K번째 방문")
          const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean)
          const visitLineIdx = lines.findIndex((l) => l.startsWith('방문일'))
          const author = visitLineIdx > 0 ? lines[0] : '익명'
          const visitLine = visitLineIdx >= 0 ? lines[visitLineIdx] : ''

          const ratingMatch = fullText.match(/★\s*(\d)/)
          const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : null

          const hasReply =
            (await item.locator(SELECTORS.existingReplyEditBtn).count()) > 0 &&
            (await item.locator(SELECTORS.existingReplyDeleteBtn).count()) > 0

          // 리뷰 본문: "더보기" 등 UI 문구를 제외한 나머지 텍스트 (부정확할 수 있음 — TODO 검증)
          const text = lines
            .filter((l) => !['더보기', '수정', '삭제', '닫기'].includes(l))
            .join(' ')
            .slice(0, 1000)

          // 리뷰 고유 ID: data-id 등을 못 찾아서 작성자+방문일 조합으로 대체 (실측 후 개선 필요)
          const id = `${author}_${visitLine}`.replace(/\s+/g, '').slice(0, 200)

          results.push({
            id,
            author,
            rating,
            text,
            date: visitLine,
            hasReply,
            existingReply: null, // TODO(검증필요): 기존 답글 텍스트만 정확히 뽑는 셀렉터 필요
          })
        } catch (e) {
          console.error('[reviews] 항목 파싱 실패:', e.message)
        }
      }

      return results
    })

    res.json({ reviews })
  } catch (err) {
    console.error('[reviews]', err)
    res.status(500).json({ error: err.message })
  }
})

app.post('/reply', requireAuth, async (req, res) => {
  const { cookies, placeId, bookingBusinessId, reviewId, replyText } = req.body
  if (!Array.isArray(cookies) || !placeId || !bookingBusinessId || !reviewId || !replyText) {
    return res.status(400).json({ error: 'cookies, placeId, bookingBusinessId, reviewId, replyText 필요' })
  }
  if (replyText.length < REPLY_MIN_LEN || replyText.length > REPLY_MAX_LEN) {
    return res.status(400).json({ error: `답글은 ${REPLY_MIN_LEN}~${REPLY_MAX_LEN}자여야 합니다 (현재 ${replyText.length}자)` })
  }

  try {
    await withPage(cookies, async (page) => {
      await page.goto(URLS.reviews(placeId, bookingBusinessId), { waitUntil: 'domcontentloaded', timeout: 20000 })
      if (isLoginRedirect(page)) throw new Error('세션 만료 — 확장에서 다시 연결 필요')

      const authorKey = reviewId.split('_')[0]
      const target = page.locator(SELECTORS.reviewItem).filter({ hasText: authorKey }).first()

      const hasExisting = (await target.locator(SELECTORS.existingReplyEditBtn).count()) > 0
      if (hasExisting) {
        // 기존 답글 수정 플로우 (실측 확인됨)
        await target.locator(SELECTORS.existingReplyEditBtn).first().click({ timeout: 10000 })
        const textarea = target.locator(SELECTORS.replyTextarea).first()
        await textarea.fill(replyText, { timeout: 10000 })
        await target.locator(SELECTORS.replySaveBtn).first().click({ timeout: 10000 })
      } else {
        // 미답글 리뷰는 트리거 클릭 없이 입력창이 이미 노출돼 있음 (실측 확인, 2026-07-11)
        const textarea = target.locator(SELECTORS.replyTextarea).first()
        await textarea.fill(replyText, { timeout: 10000 })
        await target.locator(SELECTORS.newReplySubmitBtn).first().click({ timeout: 10000 })
      }
    })

    res.json({ ok: true })
  } catch (err) {
    console.error('[reply]', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (req, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`gorang-naver-worker listening on ${PORT}`))
