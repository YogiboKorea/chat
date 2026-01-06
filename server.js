const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const ExcelJS = require("exceljs");
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
const pdfParse = require('pdf-extraction');

// .env 설정 로드
require("dotenv").config({ path: path.join(__dirname, ".env") });
const staticFaqList = require("./faq");

const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo", CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000, FTP_PUBLIC_BASE, YOGIBO_FTP, YOGIBO_FTP_ID, YOGIBO_FTP_PW
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ✅ 파일 업로드 설정 (Multer)
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
});
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// ✅ 글로벌 변수 (통합 검색 데이터)
let pendingCoveringContext = false;
let allSearchableData = []; 

// ★ [시스템 프롬프트] GPT에게 "판단" 역할을 부여
let currentSystemPrompt = `
1. 역할: 당신은 '요기보(Yogibo)'의 AI 상담원입니다.
2. ★ 중요 임무:
   - 사용자 질문에 대해 아래 제공되는 [참고 정보]들을 꼼꼼히 읽어보고 답변을 작성하세요.
   - [참고 정보]는 FAQ, 제품 매뉴얼, 회사 규정 등이 섞여 있습니다. 이 중에서 질문과 가장 관련 있는 내용을 찾아내세요.
   - **만약 [참고 정보]를 다 읽어봐도 질문에 대한 답을 찾을 수 없거나, 요기보와 전혀 관련 없는 내용(코딩, 주식, 날씨 등)이라면, 절대 지어내지 말고 오직 "NO_CONTEXT"라고만 출력하세요.**
3. 답변 스타일:
   - 친절하고 전문적인 톤으로 답변하세요.
   - 링크는 [버튼명](URL) 형식으로, 이미지는 <img src="..."> 태그를 그대로 유지하세요.
`;

// ========== HTML 템플릿 ==========
const COUNSELOR_LINKS_HTML = `
<div class="consult-container">
  <p style="font-weight:bold; margin-bottom:8px; font-size:14px; color:#e74c3c;">
    <i class="fa-solid fa-triangle-exclamation"></i> 정확한 정보 확인이 필요합니다.
  </p>
  <p style="font-size:13px; color:#555; margin-bottom:15px; line-height:1.4;">
    죄송합니다. 현재 데이터베이스에서 정확한 답변을 찾지 못했습니다.<br>
    사람의 확인이 필요한 내용일 수 있으니, 아래 버튼을 눌러 <b>상담사</b>에게 문의해주세요.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`


// ========== HTML 템플릿 ==========
const COUNSELOR_LINKS_HTML_CALL = `
<div class="consult-container" style="">
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao" style="cursor:pointer">>
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver" style="cursor:pointer">>
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`
;

const FALLBACK_MESSAGE_HTML = `<div style="margin-top: 10px;">${COUNSELOR_LINKS_HTML}</div>`;
const LOGIN_BTN_HTML = `<div style="margin-top:15px;"><a href="/member/login.html" class="consult-btn" style="background:#58b5ca; color:#fff; justify-content:center;">로그인 하러 가기 →</a></div>`;

// JSON 데이터 로드
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try { 
    if (fs.existsSync(companyDataPath)) {
        companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8")); 
    }
} catch (e) { console.error("companyData load error:", e); }

// MongoDB 연결 및 토큰 관리
const tokenCollectionName = "tokens";
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const doc = await client.db(DB_NAME).collection(tokenCollectionName).findOne({});
    if (doc) { accessToken = doc.accessToken; refreshToken = doc.refreshToken; }
    else { await saveTokensToDB(accessToken, refreshToken); }
  } finally { await client.close(); }
}
async function saveTokensToDB(at, rt) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).collection(tokenCollectionName).updateOne({}, { $set: { accessToken: at, refreshToken: rt, updatedAt: new Date() } }, { upsert: true });
  } finally { await client.close(); }
}
async function refreshAccessToken() { await getTokensFromDB(); return accessToken; }

// ★ [핵심] 모든 데이터를 '검색 가능한 형태'로 통합하는 함수
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    
    // 1. DB에서 PostIt(일반문의, PDF) 데이터 가져오기
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dbData = notes.map(n => ({ 
        source: "DB", 
        category: n.category || "general", 
        q: n.question, 
        a: n.answer 
    }));

    // 2. FAQ 파일 데이터 가져오기
    const faqData = staticFaqList.map(f => ({
        source: "FAQ",
        category: "faq",
        q: f.q,
        a: f.a
    }));

    // 3. companyData.json 데이터도 검색 가능하게 변환
    let jsonData = [];
    if (companyData.covering) {
        Object.keys(companyData.covering).forEach(key => {
            jsonData.push({ source: "JSON", category: "covering", q: key, a: companyData.covering[key].answer });
        });
    }
    if (companyData.sizeInfo) {
        Object.keys(companyData.sizeInfo).forEach(key => {
            jsonData.push({ source: "JSON", category: "size", q: key, a: companyData.sizeInfo[key].description });
        });
    }

        // ★ 중복 제거 (질문 기준)
    const seen = new Set();
    allSearchableData = [...faqData, ...dbData, ...jsonData].filter(item => {
        const key = item.q.toLowerCase().replace(/\s+/g, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // 4. 모든 데이터 합치기
    allSearchableData = [...faqData, ...dbData, ...jsonData];
    
    // 시스템 프롬프트 업데이트
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) currentSystemPrompt = prompts[0].content; 
    
    console.log(`✅ [데이터 로드 완료] 총 ${allSearchableData.length}개의 지식 데이터가 준비되었습니다.`);

  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}
// ★ [개선된 검색 로직]
function findAllRelevantContent(msg) {
    const kws = msg.split(/\s+/).filter(w => w.length > 1);
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "").replace(/[?!！？.]/g, "");
    
    // 1. 의도 분류 (카테고리 힌트)
    const intentMap = {
      size: ["사이즈", "크기", "규격", "치수"],
      covering: ["커버링", "씌우", "교체방법"],
      laundry: ["세탁", "빨래", "건조"],
      delivery: ["배송", "배달", "수령"],
      refund: ["환불", "반품", "교환"],
      service: ["AS", "수리", "고장", "불량"]
    };
    
    let detectedIntent = null;
    for (const [intent, keywords] of Object.entries(intentMap)) {
      if (keywords.some(k => cleanMsg.includes(k))) {
        detectedIntent = intent;
        break;
      }
    }
  
    const scored = allSearchableData.map(item => {
      let score = 0;
      const q = (item.q || "").toLowerCase().replace(/\s+/g, "").replace(/[?!！？.]/g, "");
      const a = (item.a || "").toLowerCase();
      const category = item.category || "";
      
      // ★ 카테고리 일치 보너스 (30점)
      if (detectedIntent && category.includes(detectedIntent)) {
        score += 30;
      }
      
      // ★ 질문 완전 일치 (100점)
      if (q === cleanMsg) score += 100;
      
      // ★ 핵심 키워드 조합 매칭 (50점)
      // 예: "맥스" + "사이즈" 둘 다 있어야 높은 점수
      const matchedKws = kws.filter(w => q.includes(w.toLowerCase()));
      if (matchedKws.length >= 2) {
        score += 50;
      } else if (matchedKws.length === 1 && kws.length === 1) {
        score += 30; // 단일 키워드지만 전체 일치
      }
      
      // ★ 부분 포함 (기존보다 낮은 점수)
      kws.forEach(w => {
        const cleanW = w.toLowerCase();
        if (q.includes(cleanW)) score += 10; // 20 → 10으로 낮춤
        // 답변 매칭은 제외 (노이즈 원인)
      });
  
      return { ...item, score };
    });
  
    // ★ 임계값 상향 (5 → 25점)
    // ★ 상위 3개로 제한 (5 → 3개)
    return scored
      .filter(i => i.score >= 25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }
  

// ★ [2단계 검증 시스템]
async function getGPT3TurboResponse(input, context = []) {
    if (context.length === 0) return "NO_CONTEXT";
  
    // ────────────────────────────────────────
    // 1단계: GPT에게 "관련 있는 데이터 번호"만 물어봄
    // ────────────────────────────────────────
    const candidateList = context.map((item, idx) => 
      `${idx + 1}. ${item.q}`
    ).join("\n");
  
    const filterPrompt = `사용자 질문: "${input}"
  
  아래 후보 중 이 질문에 답변하는 데 **직접적으로 관련 있는 번호**만 골라주세요.
  관련 없으면 "없음"이라고 답하세요.
  
  [후보 목록]
  ${candidateList}
  
  답변 형식: 숫자만 (예: 1 또는 1,3)`;
  
    try {
      // 가벼운 필터링용 호출 (토큰 적게 사용)
      const filterRes = await axios.post(OPEN_URL, {
        model: "gpt-3.5-turbo",  // 저렴한 모델로 필터링
        messages: [{ role: "user", content: filterPrompt }],
        temperature: 0,
        max_tokens: 20  // 숫자만 받으면 되니까 짧게
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
  
      const filterAnswer = filterRes.data.choices[0].message.content.trim();
      
      // "없음"이면 바로 NO_CONTEXT
      if (filterAnswer === "없음" || filterAnswer.toLowerCase() === "none") {
        return "NO_CONTEXT";
      }
  
      // ────────────────────────────────────────
      // 2단계: 선택된 데이터만 가지고 최종 답변 생성
      // ────────────────────────────────────────
      const selectedIndexes = filterAnswer.match(/\d+/g)?.map(n => parseInt(n) - 1) || [];
      const filteredContext = selectedIndexes
        .filter(i => i >= 0 && i < context.length)
        .map(i => context[i]);
  
      // 필터링 후 남은 게 없으면
      if (filteredContext.length === 0) {
        return "NO_CONTEXT";
      }
  
      // 검증된 데이터만으로 답변 생성
      const contextText = filteredContext
        .map((item, idx) => `[정보 ${idx + 1}]\nQ: ${item.q}\nA: ${item.a}`)
        .join("\n\n");
  
      const finalPrompt = `${currentSystemPrompt}\n\n[참고 정보]\n${contextText}`;
  
      const res = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: finalPrompt },
          { role: "user", content: input }
        ],
        temperature: 0
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
  
      return res.data.choices[0].message.content;
  
    } catch (e) {
      console.error("GPT 호출 오류:", e.message);
      return "오류가 발생했습니다.";
    }
  }
  



// 유틸 함수들
function formatResponseText(text) { return text || ""; }
function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

// Cafe24 API 관련 함수
async function apiRequest(method, url, data = {}, params = {}) {
    try {
      const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } });
      return res.data;
    } catch (error) {
      if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); }
      throw error;
    }
}
async function getOrderShippingInfo(id) {
  const today = new Date(); const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10
  });
}
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = { "0019": { name: "롯데 택배" }, "0039": { name: "경동 택배" }, "0023": { name: "경동 택배" } };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사" };
      shipment.shipping_company_name = carrierInfo.name;
      return shipment;
    } return null;
  } catch (error) { throw error; }
}

// ========== [규칙 기반 답변] ==========
async function findAnswer(userInput, memberId) {
    const normalized = normalizeSentence(userInput);
    
    // ★ 1. 금지어 필터 (토큰 절약 & 엉뚱한 답변 차단)
    const blockKeywords = ["파이썬", "python", "노드", "node", "자바", "코딩", "sql", "mysql", "db", "주식", "비트코인", "날씨", "정치", "게임", "영화", "맛집"];
    for (let badWord of blockKeywords) {
        if (normalized.toLowerCase().includes(badWord)) {
            return { text: `죄송합니다. 저는 **요기보(Yogibo)** 제품 상담만 도와드릴 수 있어요. 😅<br>요기보에 대해 궁금한 점이 있다면 물어봐 주세요!` };
        }
    }

    // 2. 상담사 연결
    if (normalized.includes("상담사") || normalized.includes("상담원") || normalized.includes("사람")|| normalized.includes("상담사 연결")|| normalized.includes("고객센터 연결")|| normalized.includes("고객센터 연결 해줘")) {
        return { text: `전문 상담사와 연결해 드리겠습니다.${COUNSELOR_LINKS_HTML_CALL}` };
    }

    // 3. 충전 = 비즈 리필
    if (normalized.includes("충전")) {
        return { text: `비즈 충전을 찾으시는걸까요? 해당 링크를 통해 자세한 내용을 확인하실수 있습니다.<br><a href="https://yogibo.kr/event/yogibo/biz_cover.html" target="_blank">[비즈 충전방법]</a>` };
    }

    // 4. 상품 검색 링크 생성
    const productKeywords = ["슬림", "맥스", "더블", "미디", "미니", "팟", "드롭", "피라미드", "라운저", "줄라", "쇼티", "롤", "서포트", "카터필러", "바디필로우", "스퀴지보", "트레이보", "모듈라", "플랜트"];
    for (const product of productKeywords) {
        if (normalized.includes(product)) {
            if (normalized.includes("url") || normalized.includes("주소") || normalized.includes("링크") || normalized.includes("검색") || normalized.includes("찾아") || normalized.includes("보여") || normalized.includes("살래") || normalized.includes("구매") || normalized.includes("알고") || normalized.includes("정보")) {
                const searchKeyword = `요기보 ${product}`;
                const searchUrl = `http://yogibo.kr/product/search.html?order_by=favor&banner_action=&keyword=${encodeURIComponent(searchKeyword)}`;
                return { text: `찾으시는 <b>'${product}'</b> 정보를 찾았습니다.<br>아래 링크에서 확인해 보세요! 👇<br><br><a href="${searchUrl}" target="_blank" class="consult-btn" style="background:#58b5ca; color:#fff; justify-content:center; text-decoration:none;">🔍 ${product} 검색 결과 보기</a>` };
            }
        }
    }

    // 5. 일반 규칙
    if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊 (평일 10:00~17:30)" };
    if (normalized.includes("장바구니")) return isUserLoggedIn(memberId) ? { text: `${memberId}님의 장바구니로 이동합니다.<br><a href="/order/basket.html">🛒 바로가기</a>` } : { text: `로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    
    // 6. 배송 조회 (로그인 체크 및 API 호출 포함)
    if (containsOrderNumber(normalized)) {
        if (isUserLoggedIn(memberId)) {
            try {
                const orderId = normalized.match(/\d{8}-\d{7}/)[0]; const ship = await getShipmentDetail(orderId);
                if (ship) return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.` };
                return { text: "해당 주문번호의 정보를 찾을 수 없습니다." };
            } catch (e) { return { text: "조회 중 오류가 발생했습니다." }; }
        } return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }
    const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
    if (isTracking) {
        if (isUserLoggedIn(memberId)) {
          try {
            const data = await getOrderShippingInfo(memberId);
            if (data.orders?.[0]) return { text: `최근 주문(<strong>${data.orders[0].order_id}</strong>)을 확인했습니다.` };
            return { text: "최근 주문 내역이 없습니다." };
          } catch (e) { return { text: "조회 실패." }; }
        } return { text: `배송정보 확인을 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }

    return null;
}

// ========== [★누락되었던 함수 복구] 대화 로그 저장 함수 ==========
async function saveConversationLog(mid, uMsg, bRes) {
    const client = new MongoClient(MONGODB_URI);
    try { 
        await client.connect(); 
        await client.db(DB_NAME).collection("conversationLogs").updateOne(
            { memberId: mid || null, date: new Date().toISOString().split("T")[0] }, 
            { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } }, 
            { upsert: true }
        ); 
    } catch(e) { console.error("로그 저장 실패:", e); } 
    finally { await client.close(); }
}

// ========== [메인 Chat] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    // 1단계: 규칙 & 금지어 확인
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
       if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
       return res.json(ruleAnswer);
    }

    // 2단계: 통합 데이터 검색 (문턱 5점 - 아주 낮게 설정해서 일단 다 긁어모음)
    const docs = findAllRelevantContent(message);
    
    let gptAnswer = "";
    
    // ★ [철벽 방어] 그래도 검색된 게 하나도 없다? -> 진짜 없는 거임 -> API 호출 금지
    if (docs.length === 0) {
        gptAnswer = FALLBACK_MESSAGE_HTML;
    } else {
        // ★ [판단] GPT에게 "이 데이터들 중에 답이 있니?" 라고 물어봄
        gptAnswer = await getGPT3TurboResponse(message, docs);
        
        // GPT가 "NO_CONTEXT" (답 없음) 이라고 판단하면 -> Fallback
        if (gptAnswer.includes("NO_CONTEXT")) {
            gptAnswer = FALLBACK_MESSAGE_HTML;
        } else {
            // 답이 있으면 이미지 복구 로직 실행
            if (docs.length > 0) {
                const bestDoc = docs[0]; // 가장 점수 높은 문서 기준
                if (bestDoc.a.includes("<iframe") && !gptAnswer.includes("<iframe")) { const iframes = bestDoc.a.match(/<iframe.*<\/iframe>/g); if (iframes) gptAnswer += "\n" + iframes.join("\n"); }
                if (bestDoc.a.includes("<img") && !gptAnswer.includes("<img")) { const imgs = bestDoc.a.match(/<img.*?>/g); if (imgs) gptAnswer += "\n" + imgs.join("\n"); }
            }
        }
    }

    const finalAnswer = formatResponseText(gptAnswer);
    await saveConversationLog(memberId, message, finalAnswer);
    res.json({ text: finalAnswer, videoHtml: null });

  } catch (e) { console.error(e); res.status(500).json({ text: "오류가 발생했습니다." }); }
});

// ========== [파일 및 데이터 관리 API] ==========

// 1. PDF/텍스트 파일 업로드 및 분석
app.post("/chat_send", upload.single('file'), async (req, res) => {
    const { role, content } = req.body;
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect(); const db = client.db(DB_NAME);
        
        // PDF 파일 처리
        if (req.file) {
            req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
            if (req.file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(req.file.path); 
                const data = await pdfParse(dataBuffer);
                const cleanText = data.text.replace(/\n\n+/g, '\n').replace(/\s+/g, ' ').trim();
                
                // 500자 단위 분할
                const chunks = []; 
                for (let i = 0; i < cleanText.length; i += 500) chunks.push(cleanText.substring(i, i + 500));
                
                const docs = chunks.map((chunk, index) => ({ 
                    category: "pdf-knowledge", 
                    question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, 
                    answer: chunk, 
                    createdAt: new Date() 
                }));
                
                if (docs.length > 0) await db.collection("postItNotes").insertMany(docs);
                fs.unlink(req.file.path, () => {}); 
                await updateSearchableData(); // 데이터 갱신
                return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
            }
        }
        
        // 롤(프롬프트) 설정
        if (role && content) {
            const fullPrompt = `역할: ${role}\n지시사항: ${content}`;
            await db.collection("systemPrompts").insertOne({ role, content: fullPrompt, createdAt: new Date() });
            currentSystemPrompt = fullPrompt;
            return res.json({ message: "LLM 역할 설정이 완료되었습니다." });
        }
        res.status(400).json({ error: "파일이나 내용이 없습니다." });
    } catch (e) { 
        if (req.file) fs.unlink(req.file.path, () => {}); 
        res.status(500).json({ error: e.message }); 
    } finally { await client.close(); }
});

// 2. 이미지 지식 업로드 (FTP)
app.post("/upload_knowledge_image", upload.single('image'), async (req, res) => {
    const { keyword } = req.body;
    const client = new MongoClient(MONGODB_URI);
    const ftpClient = new ftp.Client();
    if (!req.file || !keyword) return res.status(400).json({ error: "필수 정보 누락" });
    
    req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    
    try {
        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
        try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
        
        const safeFilename = `${Date.now()}_${Math.floor(Math.random()*1000)}.jpg`;
        await ftpClient.uploadFrom(req.file.path, safeFilename);
        
        const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
        const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
        
        await client.connect(); 
        await client.db(DB_NAME).collection("postItNotes").insertOne({ 
            category: "image-knowledge", 
            question: keyword, 
            answer: `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`, 
            createdAt: new Date() 
        });
        
        fs.unlink(req.file.path, () => {}); 
        ftpClient.close(); 
        await updateSearchableData(); // 데이터 갱신
        res.json({ message: "이미지 지식 등록 완료" });
    } catch (e) { 
        if (req.file) fs.unlink(req.file.path, () => {}); 
        ftpClient.close(); 
        res.status(500).json({ error: e.message }); 
    } finally { await client.close(); }
});

// 3. 게시글 수정
app.put("/postIt/:id", upload.single('image'), async (req, res) => {
    const { id } = req.params; const { question, answer } = req.body; const file = req.file;
    const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME); let newAnswer = answer;
        if (file) {
            // 이미지 수정 시 FTP 업로드 로직 동일
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const safeFilename = `${Date.now()}_edit.jpg`;
            const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
            await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
            try { await ftpClient.ensureDir("web"); await ftpClient.ensureDir("chat"); } catch (dirErr) { await ftpClient.cd("/"); await ftpClient.ensureDir("www"); await ftpClient.ensureDir("chat"); }
            await ftpClient.uploadFrom(file.path, safeFilename);
            const remotePath = "web/chat"; const publicBase = FTP_PUBLIC_BASE || `http://${cleanFtpHost}`;
            const imageUrl = `${publicBase}/${remotePath}/${safeFilename}`.replace(/([^:]\/)\/+/g, '$1');
            newAnswer = `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`;
            fs.unlink(file.path, () => {}); ftpClient.close();
        }
        await db.collection("postItNotes").updateOne({ _id: new ObjectId(id) }, { $set: { question, answer: newAnswer, updatedAt: new Date() } });
        await updateSearchableData(); 
        res.json({ message: "수정 완료" });
    } catch (e) { if (file) fs.unlink(file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 4. 게시글 삭제
app.delete("/postIt/:id", async(req, res) => { 
    const { id } = req.params; const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME);
        // 이미지 파일이 있다면 FTP에서도 삭제 시도
        const targetPost = await db.collection("postItNotes").findOne({ _id: new ObjectId(id) });
        if (targetPost) {
            const imgMatch = targetPost.answer && targetPost.answer.match(/src="([^"]+)"/);
            if (imgMatch) {
                const fullUrl = imgMatch[1]; const filename = fullUrl.split('/').pop();
                if (filename) {
                    try {
                        const cleanFtpHost = YOGIBO_FTP.replace(/^(http:\/\/|https:\/\/|ftp:\/\/)/, '').replace(/\/$/, '');
                        await ftpClient.access({ host: cleanFtpHost, user: YOGIBO_FTP_ID, password: YOGIBO_FTP_PW, secure: false });
                        await ftpClient.remove(`web/chat/${filename}`).catch(async () => { await ftpClient.remove(`www/chat/${filename}`).catch(() => {}); });
                        ftpClient.close();
                    } catch (ftpErr) { ftpClient.close(); }
                }
            }
        }
        await db.collection("postItNotes").deleteOne({ _id: new ObjectId(id) }); 
        await updateSearchableData(); 
        res.json({ message: "OK" });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 5. 게시글 조회 (페이징)
app.get("/postIt", async (req, res) => {
    const p = parseInt(req.query.page)||1; const l=300;
    try { 
        const c=new MongoClient(MONGODB_URI); await c.connect(); 
        const f = req.query.category?{category:req.query.category}:{}; 
        const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray(); 
        await c.close(); res.json({notes:n, currentPage:p}); 
    } catch(e){res.status(500).json({error:e.message})}
});

// 6. 게시글 등록
app.post("/postIt", async(req,res)=>{ 
    try{
        const c=new MongoClient(MONGODB_URI);await c.connect(); 
        await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()}); 
        await c.close(); await updateSearchableData(); 
        res.json({message:"OK"})
    }catch(e){res.status(500).json({error:e.message})} 
});

// 7. 대화 로그 엑셀 다운로드
app.get('/chatConnet', async(req,res)=>{ 
    try{
        const c=new MongoClient(MONGODB_URI);await c.connect();
        const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close(); 
        const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');
        ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}]; 
        d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)})); 
        res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition","attachment; filename=log.xlsx"); 
        await wb.xlsx.write(res);res.end();
    }catch(e){res.status(500).send("Err")} 
});

// 서버 시작
(async function initialize() {
  try { 
      console.log("🟡 서버 시작..."); 
      await getTokensFromDB(); 
      await updateSearchableData(); // 여기서 모든 데이터 통합 로드
      app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`)); 
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();