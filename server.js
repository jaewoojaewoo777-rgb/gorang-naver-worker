// 고랑AI 네이버 플레이스 워커
//
// 네이버는 플레이스 리뷰 조회/답변 공식 API를 제공하지 않는다. 그래서 사장님이 크롬 확장으로
// 캡처해준 세션쿠키를 여기서 Playwright에 주입해, 네이버 스마트플레이스 사업자센터를
// 사람이 쓰듯 브라우저로 조작해서 리뷰를 긁어오고 답변을 게시한다.
//
// ⚠️ 2026-07-12 실제 화면 + HTML 덤프(마음스튜디오 계정)로 셀렉터 확정.
// 핵심 발견: 수정/삭제/등록 버튼은 <button>이 아니라 <a role="button">이고,
// data-pui-click-code 속성(rv.replyedit/rv.replydelete/rv.replyfold 등)이 class 해시보다
// 훨씬 안정적인 식별자. 리뷰 고유ID는 "결제 정보 상세 보기" 링크 안에 들어있음
// (/my/review/{id}/paymentInfo — 대문자 I 주의). 별점은 SVG 아이콘 뒤에 숫자가 텍스트로
// 붙어있어서(예: "별점5점") 정규식으로 추출 가능.

const express = require('express')
const { chromium } = require('playwright')

const app = express()
app.use(express.json({ limit: '5mb' }))

const PORT = process.env.PORT || 3000
const WORKER_SECRET = process.env.NAVER_WORKER_SECRET

// 실측 확인됨: https://new.smartplace.naver.com/bizes/place/{placeId}/reviews?bookingBusinessId={id}&menu=visitor
const URLS = {
  reviews: (placeId, bookingBusinessId) =>
    `https://new.smartplace.naver.com/bizes/place/${placeId}/reviews?bookingBusinessId=${bookingBusinessId}&menu=visitor`,
}

// 답글 글자수 제한 실측 확인됨: 최소 15자 ~ 최대 500자
const REPLY_MIN_LEN = 15
const REPLY_MAX_LEN = 500

const SELECTORS = {
  reviewItem: 'li[class*="Review_pui_review"]',
  authorName: 'span[class*="pui__NMi-Dp"]',
  visitDateRow: 'div[class*="pui__4rEbt5"]', // 카드 내 1번째=방문일, 2번째=작성일
  reviewTextBlock: 'div[class*="pui__vn15t2"]',
  ratingBox: 'div[class*="pui__6abRMf"]', // innerText가 "별점N점" 형태 (숫자는 svg 뒤 텍스트노드)
  paymentInfoLink: '[data-pui-click-code="rv.paymentinfo"]', // href에 리뷰 고유ID 포함
  existingReplyText: '[data-pui-click-code="rv.replyfold"]',
  existingReplyEditBtn: '[data-pui-click-code="rv.replyedit"]',
  existingReplyDeleteBtn: '[data-pui-click-code="rv.replydelete"]',
  replyTextarea: 'textarea',
  replySaveBtn: '[role="button"]:has-text("수정")', // 수정모드에서 저장 버튼
  // TODO(검증필요): 미답글 리뷰의 등록 버튼도 data-pui-click-code가 있을 가능성 높음 — 아직 실측 못함
  newReplySubmitBtn: '[role="button"]:has-text("등록")',
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

// React SPA라 초기 HTML엔 리뷰 목록이 없고 이후 별도 API 호출로 채워짐.
// networkidle은 네이버 쪽 백그라운드 통신이 안 끊겨서 거의 항상 타임아웃까지 다 기다리는
// 문제가 있었음(Vercel 함수 504의 주요 원인) → 리뷰 카드 셀렉터가 뜨는지 직접 기다리는 걸로 변경.
async function gotoReviews(page, placeId, bookingBusinessId) {
  await page.goto(URLS.reviews(placeId, bookingBusinessId), { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForSelector(SELECTORS.reviewItem, { timeout: 15000 }).catch(() => {})
}

// "결제 정보 상세 보기" 링크(/my/review/{id}/paymentinfo)에서 리뷰 고유ID 추출
async function extractReviewId(card) {
  const href = await card.locator(SELECTORS.paymentInfoLink).first().getAttribute('href').catch(() => null)
  // 실측: 경로가 paymentInfo(대문자 I) — 소문자로 잘못 넣어서 계속 매칭 실패했었음
  const match = href?.match(/\/review\/([a-f0-9]+)\/paymentInfo/i)
  return match ? match[1] : null
}

async function extractRating(card) {
  const text = await card.locator(SELECTORS.ratingBox).first().innerText().catch(() => '')
  // 실측: <svg>...</svg>5<span>점</span> — innerText가 "별점5점" 형태로 나옴
  const match = text.match(/(\d+)\s*점/)
  return match ? parseInt(match[1], 10) : null
}

app.post('/verify', requireAuth, async (req, res) => {
  const { cookies, placeId, bookingBusinessId } = req.body
  if (!Array.isArray(cookies) || !placeId || !bookingBusinessId) {
    return res.status(400).json({ error: 'cookies, placeId, bookingBusinessId 필요' })
  }

  try {
    const result = await withPage(cookies, async (page) => {
      await gotoReviews(page, placeId, bookingBusinessId)
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
      await gotoReviews(page, placeId, bookingBusinessId)
      if (isLoginRedirect(page)) throw new Error('세션 만료 — 확장에서 다시 연결 필요')

      // Next.js 쪽에서 어차피 배치(5개)만 처리하므로 여기서도 딱 그만큼만 스크래핑해서 시간을 아낀다
      const allCards = await page.locator(SELECTORS.reviewItem).all()
      const cards = allCards.slice(0, 6)
      const results = []

      for (const card of cards) {
        try {
          const id = await extractReviewId(card)
          if (!id) continue // 리뷰 고유ID 못 찾으면 스킵 (데이터 매칭 신뢰 못 함)

          const author = await card.locator(SELECTORS.authorName).first().innerText().catch(() => '익명')

          const dateRows = card.locator(SELECTORS.visitDateRow)
          const visitDate = await dateRows.nth(0).locator('time').first().innerText().catch(() => '')

          const textBlockRaw = await card.locator(SELECTORS.reviewTextBlock).first().innerText().catch(() => '')
          const text = textBlockRaw.replace(/더보기\s*$/, '').trim().slice(0, 1000)

          const hasReply = (await card.locator(SELECTORS.existingReplyEditBtn).count()) > 0
          const existingReply = hasReply
            ? await card.locator(SELECTORS.existingReplyText).first().innerText().catch(() => null)
            : null

          const rating = await extractRating(card)

          results.push({
            id,
            author,
            rating,
            text,
            date: visitDate,
            hasReply,
            existingReply,
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
      await gotoReviews(page, placeId, bookingBusinessId)
      if (isLoginRedirect(page)) throw new Error('세션 만료 — 확장에서 다시 연결 필요')

      const target = page
        .locator(SELECTORS.reviewItem)
        .filter({ has: page.locator(`a[href*="${reviewId}"]`) })
        .first()

      const hasExisting = (await target.locator(SELECTORS.existingReplyEditBtn).count()) > 0
      if (hasExisting) {
        // 기존 답글 수정 플로우
        await target.locator(SELECTORS.existingReplyEditBtn).first().click({ timeout: 10000 })
        const textarea = target.locator(SELECTORS.replyTextarea).first()
        await textarea.fill(replyText, { timeout: 10000 })
        await target.locator(SELECTORS.replySaveBtn).first().click({ timeout: 10000 })
      } else {
        // 미답글 리뷰는 트리거 클릭 없이 입력창이 이미 노출돼 있음
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

// 임시 진단용 엔드포인트 — 셀렉터 확정되면 지워도 됨.
app.post('/debug', requireAuth, async (req, res) => {
  const { cookies, placeId, bookingBusinessId } = req.body
  if (!Array.isArray(cookies) || !placeId || !bookingBusinessId) {
    return res.status(400).json({ error: 'cookies, placeId, bookingBusinessId 필요' })
  }

  try {
    const result = await withPage(cookies, async (page) => {
      await gotoReviews(page, placeId, bookingBusinessId)
      if (isLoginRedirect(page)) return { loginRedirect: true, url: page.url() }

      const cardCount = await page.locator(SELECTORS.reviewItem).count().catch(() => 0)
      const cards = page.locator(SELECTORS.reviewItem)
      let repliedCardHtml = null
      let unrepliedCardHtml = null
      const total = Math.min(cardCount, 10)
      const extractedIds = []
      for (let idx = 0; idx < total; idx++) {
        const card = cards.nth(idx)
        const hasEditBtn = (await card.locator(SELECTORS.existingReplyEditBtn).count()) > 0
        const id = await extractReviewId(card)
        const author = await card.locator(SELECTORS.authorName).first().innerText().catch((e) => `err:${e.message}`)
        extractedIds.push({ idx, id, author, hasEditBtn })
        if (hasEditBtn && !repliedCardHtml) repliedCardHtml = await card.innerHTML()
        else if (!hasEditBtn && !unrepliedCardHtml) unrepliedCardHtml = await card.innerHTML()
      }

      const html = await page.content()
      return {
        url: page.url(),
        title: await page.title(),
        htmlLength: html.length,
        cardCount,
        extractedIds,
        repliedCardHtml,
        unrepliedCardHtml,
      }
    })

    res.json(result)
  } catch (err) {
    console.error('[debug]', err)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (req, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`gorang-naver-worker listening on ${PORT}`))
