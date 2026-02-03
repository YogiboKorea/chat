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
  FINETUNED_MODEL = "gpt-4o-mini", CAFE24_API_VERSION = "2025-12-01",
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

// ✅ 상품 데이터 (추천 시스템용 하드코딩 데이터)
const yogiboProducts = [
    { id: "max", name: "요기보 맥스", category: "소파", price: 389000, features: ["2인용", "침대대용", "눕기"], 
      useCase: ["TV", "낮잠", "게임"], productUrl: "/product/요기보-맥스/39/category/427/display/1/" },
    { id: "midi", name: "요기보 미디", category: "소파", price: 329000, features: ["1인용", "원룸", "가성비"], 
      useCase: ["독서", "휴식", "게임"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%EB%AF%B8%EB%8B%88/54/category/507/display/1/" },
    { id: "mini", name: "요기보 미니", category: "소파", price: 229000, features: ["1인용", "소형", "아이들"],
       useCase: ["보조의자", "아이방"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%EC%84%9C%ED%8F%AC%ED%8A%B8/83/category/427/display/1/" },
    { id: "support", name: "요기보 서포트", category: "악세서리", price: 179000, features: ["등받이", "팔걸이", "수유쿠션"], 
      useCase: ["소파보조", "독서", "수유"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%EB%A1%A4-%EB%A7%A5%EC%8A%A4/89/category/507/display/1/" },
    { id: "roll", name: "요기보 롤 맥스", category: "악세서리", price: 199000, features: ["바디필로우", "긴베개"], 
      useCase: ["수면", "등받이"], productUrl: "https://yogibo.kr/product/detail.html?product_no=127" },
    { id: "lounger", name: "요기보 라운저", category: "소파", price: 269000, features: ["1인용", "등받이형", "게임"],
       useCase: ["게임", "영화"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%EB%9D%BC%EC%9A%B4%EC%A0%80/464/category/427/display/1/" },
    { id: "shorty", name: "요기보 슬림", category: "소파", price: 319000, features: ["1인용", "슬림", "공간절약"], 
      useCase: ["원룸", "휴식"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%EC%8A%AC%EB%A6%BC/450/category/427/display/1/" },
    { id: "pod", name: "요기보 팟", category: "소파", price: 329000, features: ["1인용", "물방울", "감싸는"], 
      useCase: ["독서", "명상"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%ED%8C%9F/67/category/427/display/1/ "},
      { id: "pyramid", name: "요기보 피라미드", category: "소파", price: 169000, features: ["1인용", "어린이", "아이들"], 
        useCase: ["독서", "명상"], productUrl: "https://yogibo.kr/product/%EC%9A%94%EA%B8%B0%EB%B3%B4-%ED%94%BC%EB%9D%BC%EB%AF%B8%EB%93%9C/70/category/427/display/1/ "},      
];

// ✅ 전역 변수
let pendingCoveringContext = false;
let allSearchableData = []; 

// ★ [시스템 프롬프트]
let currentSystemPrompt = `
1. 역할: 당신은 '요기보(Yogibo)'의 AI 상담원입니다.

2. ★ 중요 임무:
- 사용자 질문에 대해 아래 제공되는 [참고 정보]들을 꼼꼼히 읽고 답변을 작성하세요.
- [참고 정보]는 FAQ, 제품 매뉴얼, 회사 규정 등이 섞여 있습니다. 이 중에서 질문과 가장 관련 있는 내용을 찾아내세요.
- 답변은 반드시 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 동일한 문장이 없더라도, 여러 근거를 종합하면 논리적으로 답할 수 있는 경우에는
  "참고 정보 기준으로 종합하면" 형태로 설명하는 것은 허용합니다.
- 단, [참고 정보]에 없는 사실(전화번호/주소/정책/가격/기간/효과 등)을 새로 만들어내거나 추측하면 안 됩니다.
- 만약 (a) 관련 근거가 전혀 없거나, (b) 요기보와 무관한 내용(코딩/주식/날씨 등)이라면,
  절대 지어내지 말고 오직 "NO_CONTEXT"라고만 출력하세요.

3. 답변 스타일:
- 친절하고 전문적인 톤으로 답변하세요.
- 가능한 경우 (1) 핵심 답변 → (2) 근거 요약 → (3) 고객에게 확인할 질문 순서로 작성하세요.
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
`;

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

// ★ [핵심] 모든 데이터를 '검색 가능한 형태'로 통합하는 함수 (RAG)
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

    // 4. 모든 데이터 합치기
    allSearchableData = [...faqData, ...dbData, ...jsonData];
    
    // 시스템 프롬프트 업데이트
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) currentSystemPrompt = prompts[0].content; 
    
    console.log(`✅ [데이터 로드 완료] 총 ${allSearchableData.length}개의 지식 데이터가 준비되었습니다.`);

  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

// ★ 통합 검색 로직 (5점 이상이면 후보군으로 선정)
function findAllRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1); // 2글자 이상 키워드
  if (!kws.length && msg.length < 2) return [];

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
    
    // 1. 질문 완전 일치 (100점)
    if (q === cleanMsg) score += 100;
    // 2. 포함 관계 (50점)
    else if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 50;
    
    // 3. 키워드 매칭 (질문: 20점, 답변: 5점)
    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 20;
      if (item.a.toLowerCase().includes(cleanW)) score += 5;
    });

    return { ...item, score };
  });

   return scored
   .filter(i => i.score >= 12)
   .sort((a, b) => b.score - a.score)
   .slice(0, 6);
}

async function getLLMResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");

  const system = `${currentSystemPrompt}

[운영 규칙 - 매우 중요]
- 답변은 반드시 아래 [참고 정보]에서 근거가 확인되는 내용만 안내하세요.
- [참고 정보]에 없는 내용은 절대 추측하지 말고, "정확한 확인이 필요합니다"라고 말하세요.
- 고객에게 추가 확인이 필요한 정보(주문번호/구매처/제품명 등)가 있으면 먼저 요청하세요.

[참고 정보]
${txt || "정보 없음."}`;

  try {
    const res = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL, // gpt-4o-mini 권장
        temperature: 0.2,       // 추측/창작 억제
        top_p: 0.9,
        messages: [
          { role: "system", content: system },
          { role: "user", content: input }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    return res.data.choices?.[0]?.message?.content || "답변을 생성하지 못했습니다.";
  } catch (e) {
    return "답변 생성 중 문제가 발생했습니다.";
  }
}


// 유틸 함수들
function formatResponseText(text) { return text || ""; }
function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

// Cafe24 API 공통
async function apiRequest(method, url, data = {}, params = {}) {
    try {
      const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } });
      return res.data;
    } catch (error) {
      if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); }
      throw error;
    }
}

// 배송 조회 API
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

// ★ [신규] 회원 구매 이력 조회 (최근 2개월)
async function getMemberPurchaseHistory(memberId) {
    if (!memberId || memberId === "null") return null;
    try {
        const today = new Date();
        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(today.getMonth() - 2); 

        const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
            member_id: memberId,
            start_date: twoMonthsAgo.toISOString().split('T')[0],
            end_date: today.toISOString().split('T')[0],
            limit: 20,
            embed: "items" 
        });

        if (!response.orders) return null;

        const history = { categories: [], products: [], colors: [] };
        response.orders.forEach(order => {
            order.items.forEach(item => {
                history.products.push(item.product_name);
                if (item.product_name.includes("맥스") || item.product_name.includes("미디") || item.product_name.includes("빈백")) history.categories.push("sofa");
                if (item.product_name.includes("서포트") || item.product_name.includes("롤")) history.categories.push("accessory");
                if (item.option_value) history.colors.push(item.option_value); 
            });
        });
        return history;
    } catch (e) {
        console.error("구매이력 조회 실패:", e.message);
        return null;
    }
}

// ★ [신규] AI 상품 추천 엔진
async function recommendProducts(userMsg, memberId) {
    const keywords = userMsg.toLowerCase();
    const purchaseHistory = await getMemberPurchaseHistory(memberId);
    
    // 점수 계산
    const scored = yogiboProducts.map(p => {
        let score = 0;
        let reasons = [];

        // (1) 키워드 매칭
        if (keywords.includes("게임") && p.useCase.includes("게임")) { score += 30; reasons.push("🎮 게임할 때 편해요"); }
        if (keywords.includes("잠") && p.useCase.includes("수면")) { score += 30; reasons.push("😴 꿀잠 보장"); }
        if (keywords.includes("원룸") && p.features.includes("원룸")) { score += 30; reasons.push("🏠 좁은 공간 활용 굿"); }
        if (keywords.includes("가족") && p.features.includes("2인용")) { score += 30; reasons.push("👨‍👩‍👧 가족과 함께"); }

        // (2) 구매 이력 기반 추천 (Cross-Selling)
        if (purchaseHistory) {
            const boughtSofa = purchaseHistory.categories.includes("sofa");
            const boughtAccessory = purchaseHistory.categories.includes("accessory");

            // 소파는 샀는데 악세서리가 없다면? -> 서포트 강력 추천
            if (boughtSofa && !boughtAccessory && p.category === "악세서리") {
                score += 50; 
                reasons.push("✨ 구매하신 빈백과 함께 쓰면 편안함이 2배!");
            }
            // 악세서리만 샀다면? -> 소파 추천
            if (!boughtSofa && boughtAccessory && p.category === "소파") {
                score += 40;
                reasons.push("✨ 가지고 계신 쿠션과 잘 어울리는 소파예요");
            }
        }

        if (p.id === "max" || p.id === "support") score += 10;
        return { ...p, score, reasons };
    });

    // 상위 3개 선정
    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3);
    
    // GPT에게 추천 멘트 작성 요청
    const prompt = `
    당신은 요기보 세일즈 매니저입니다.
    고객 질문: "${userMsg}"
    구매 이력: ${purchaseHistory ? JSON.stringify(purchaseHistory.products) : "없음"}
    추천 상품 목록:
    ${top3.map(p => `- ${p.name} (${p.price}원): ${p.reasons.join(", ")}`).join("\n")}
    
    위 정보를 바탕으로 고객에게 자연스럽게 상품을 추천하는 멘트를 작성해주세요.
    구매 이력이 있다면 "지난번 구매하신 OO과 함께 쓰시면 좋아요" 같은 멘트를 꼭 넣어주세요.
    `;

    try {
      const gptRes = await axios.post(OPEN_URL, {
        model: FINETUNED_MODEL,
        temperature: 0.5,
        messages: [
          { role: "system", content: "당신은 요기보 상담원입니다. 근거 없는 단정/과장 표현은 피하고, 제공된 정보 범위에서만 추천 멘트를 작성하세요." },
          { role: "user", content: prompt }
        ]
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });
      
        let answer = gptRes.data.choices[0].message.content;
        const buttons = top3.map(p => `<a href="${p.productUrl}" target="_blank" class="consult-btn" style="background:#58b5ca; color:#fff; display:inline-block; margin:5px; text-decoration:none;">🛍️ ${p.name} 보러가기</a>`).join("");
        return answer + "<br><br>" + buttons;
    } catch (e) { return "추천 상품을 불러오는 중 오류가 발생했습니다."; }
}

// ========== [규칙 기반 답변 & 추천 라우팅] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // 1️⃣ 상담사 연결 요청 → 버튼만 반환
  if (counselorTriggers.some(t => normalized.includes(t))) {
    return { text: COUNSELOR_BUTTONS_ONLY_HTML };
  }

  // 2️⃣ ★ 추천 질문 감지
  const recommendKeywords = ["추천", "뭐가 좋", "어떤게 좋", "골라", "선택", "뭐 사"];
  if (recommendKeywords.some(k => normalized.includes(k))) {
    const recommendResult = await recommendProducts(userInput, memberId);
    return { text: recommendResult };
  }


  // ================= 상담사 연결 (전역 상수) =================

// 상담사 버튼만 표시하는 HTML
const COUNSELOR_BUTTONS_ONLY_HTML = `
<div class="consult-container" style="padding-top:0;">
  <a href="javascript:void(0)"
     onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');"
     class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>

  <a href="javascript:void(0)"
     onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');"
     class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`;

// 상담사 연결 트리거 문구
const counselorTriggers = [
  "상담사", "상담원",
  "상담사 연결", "상담원 연결",
  "사람 상담", "직원 연결",
  "카톡 상담", "카카오 상담",
  "네이버 상담", "톡톡 상담"
];


  // 3️⃣ 주문번호 직접 입력 배송 조회
  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) {
          return {
            text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.`
          };
        }
        return { text: "해당 주문번호의 정보를 찾을 수 없습니다." };
      } catch (e) {
        return { text: "조회 중 오류가 발생했습니다." };
      }
    }
    return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  // 4️⃣ 일반 배송 조회 문장
  const isTracking =
    (normalized.includes("배송") || normalized.includes("주문")) &&
    (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));

  if (isTracking) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          return {
            text: `최근 주문(<strong>${data.orders[0].order_id}</strong>)을 확인했습니다.`
          };
        }
        return { text: "최근 주문 내역이 없습니다." };
      } catch (e) {
        return { text: "조회 실패." };
      }
    }
    return { text: `배송정보 확인을 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  return null;
}





// 대화 로그 저장
async function saveConversationLog(mid, uMsg, bRes) {
    const client = new MongoClient(MONGODB_URI);
    try { 
        await client.connect(); 
        await client.db(DB_NAME).collection("conversationLogs").updateOne(
            { memberId: mid || null, date: new Date().toISOString().split("T")[0] }, 
            { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } }, 
            { upsert: true }
        ); 
    } catch(e) { console.error(e); } finally { await client.close(); }
}
// ========== [메인 Chat] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    // 1) 규칙 및 추천 확인
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    // 2) 통합 데이터 검색
    const docs = findAllRelevantContent(message);

    const bestScore = docs.length > 0 ? docs[0].score : 0;

    // ✅ 3) 근거(문서) 없으면 LLM 호출 금지: 바로 핸드오프
    if (!docs || docs.length === 0 || bestScore < 12) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    // ✅ 4) LLM 답변 생성 (4o-mini 권장 + temperature 낮춤)
    let gptAnswer = await getLLMResponse(message, docs); // <- 함수명 교체
    gptAnswer = formatResponseText(gptAnswer);

    // ✅ 5) 혹시 모를 안전장치(모델이 NO_CONTEXT 등 반환 시)
    if (gptAnswer.includes("NO_CONTEXT")) {
      const fallback = `정확한 정보 확인이 필요합니다.${FALLBACK_MESSAGE_HTML}`;
      await saveConversationLog(memberId, message, fallback);
      return res.json({ text: fallback });
    }

    await saveConversationLog(memberId, message, gptAnswer);
    return res.json({ text: gptAnswer });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "오류가 발생했습니다." });
  }
});


function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];

  const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();

    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 30;

    kws.forEach(w => {
      const cw = w.toLowerCase();
      if ((item.q || "").toLowerCase().includes(cw)) score += 8;
      if (a.includes(cw)) score += 1;
    });

    return { ...item, score };
  });

  // ✅ 임계값 상향: 약한 매칭 제거
  return scored
    .filter(i => i.score >= 12)     // 기존 5 → 12
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);                   // top3 → top6
}



// ========== [파일 및 데이터 관리 API] ==========

// 1. PDF/텍스트 파일 업로드
app.post("/chat_send", upload.single('file'), async (req, res) => {
    const { role, content } = req.body;
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect(); const db = client.db(DB_NAME);
        if (req.file) {
            req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
            if (req.file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(req.file.path); 
                const data = await pdfParse(dataBuffer);
                const cleanText = data.text.replace(/\n\n+/g, '\n').replace(/\s+/g, ' ').trim();
                const chunks = []; 
                for (let i = 0; i < cleanText.length; i += 500) chunks.push(cleanText.substring(i, i + 500));
                const docs = chunks.map((chunk, index) => ({ category: "pdf-knowledge", question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, answer: chunk, createdAt: new Date() }));
                if (docs.length > 0) await db.collection("postItNotes").insertMany(docs);
                fs.unlink(req.file.path, () => {}); 
                await updateSearchableData(); 
                return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
            }
        }
        if (role && content) {
            const fullPrompt = `역할: ${role}\n지시사항: ${content}`;
            await db.collection("systemPrompts").insertOne({ role, content: fullPrompt, createdAt: new Date() });
            currentSystemPrompt = fullPrompt;
            return res.json({ message: "LLM 역할 설정이 완료되었습니다." });
        }
        res.status(400).json({ error: "파일이나 내용이 없습니다." });
    } catch (e) { if (req.file) fs.unlink(req.file.path, () => {}); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 2. 이미지 지식 업로드
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
        await client.connect(); await client.db(DB_NAME).collection("postItNotes").insertOne({ category: "image-knowledge", question: keyword, answer: `<img src="${imageUrl}" style="max-width:100%; border-radius:10px; margin-top:10px;">`, createdAt: new Date() });
        fs.unlink(req.file.path, () => {}); ftpClient.close(); await updateSearchableData();
        res.json({ message: "이미지 지식 등록 완료" });
    } catch (e) { if (req.file) fs.unlink(req.file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 3. 게시글 수정
app.put("/postIt/:id", upload.single('image'), async (req, res) => {
    const { id } = req.params; const { question, answer } = req.body; const file = req.file;
    const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME); let newAnswer = answer;
        if (file) {
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
        await updateSearchableData(); res.json({ message: "수정 완료" });
    } catch (e) { if (file) fs.unlink(file.path, () => {}); ftpClient.close(); res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 4. 게시글 삭제
app.delete("/postIt/:id", async(req, res) => { 
    const { id } = req.params; const client = new MongoClient(MONGODB_URI); const ftpClient = new ftp.Client();
    try {
        await client.connect(); const db = client.db(DB_NAME);
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
        await updateSearchableData(); res.json({ message: "OK" });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

// 5. 게시글 조회
app.get("/postIt", async (req, res) => {
    const p = parseInt(req.query.page)||1; const l=300;
    try { const c=new MongoClient(MONGODB_URI); await c.connect(); const f = req.query.category?{category:req.query.category}:{}; const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray(); await c.close(); res.json({notes:n, currentPage:p}); } catch(e){res.status(500).json({error:e.message})}
});

// 6. 게시글 등록
app.post("/postIt", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect(); await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()}); await c.close(); await updateSearchableData(); res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });

// 7. 엑셀 다운로드
app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close(); const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}]; d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)})); res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx"); await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

// 서버 실행
(async function initialize() {
  try { 
      console.log("🟡 서버 시작..."); 
      await getTokensFromDB(); 
      await updateSearchableData(); 
      app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`)); 
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();