const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const levenshtein = require("fast-levenshtein");
const ExcelJS = require("exceljs");
require("dotenv").config();
const nodemailer = require('nodemailer');
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');

// ✅ 정적 FAQ 데이터 불러오기
const staticFaqList = require("./faq");

// ========== [환경 설정] ==========
const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo", CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000, FTP_PUBLIC_BASE,
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

// ========== [Express 초기화] ==========
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [글로벌 상태] ==========
let pendingCoveringContext = false;
let allSearchableData = [...staticFaqList];

// ========== [상수: 링크 및 버튼 HTML] ==========

// 1. 상담사 연결 (팝업)
const COUNSELOR_LINKS_HTML = `
<br><br>
📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline; cursor:pointer;">카카오플친 연결하기 (팝업)</a><br>
📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline; cursor:pointer;">네이버톡톡 연결하기 (팝업)</a>
`;

// 2. 답변 하단 기본 문구 (모르는 질문일 때만 사용)
const FALLBACK_MESSAGE_HTML = `
<br><br>
---------------------------------<br>
<strong>원하시는 답변을 찾지 못하셨나요? 상담사 연결을 도와드릴까요?</strong>
${COUNSELOR_LINKS_HTML}
`;

// 3. 로그인 버튼 (스타일 적용)
const LOGIN_BTN_HTML = `
<div style="margin-top:15px;">
  <a href="/member/login.html" style="
    display: inline-block;
    padding: 10px 20px;
    background-color: #58b5ca;
    color: #ffffff;
    text-decoration: none;
    border-radius: 25px;
    font-weight: bold;
    font-size: 14px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  ">로그인 페이지 이동하기 →</a>
</div>
`;

// ========== [시스템 프롬프트 설정] ==========
function convertPromptLinks(promptText) { return promptText; }

// ✅ [환각 방지 + 전화번호 지어내기 금지]
const basePrompt = `
1. 역할 및 말투
전문가 역할: 요기보(Yogibo) 브랜드의 전문 상담원입니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.
가독성: 답변 시 줄바꿈(Enter)을 자주 사용하여 읽기 편하게 작성하세요. 문단 사이에는 빈 줄을 하나 더 넣으세요.

2. ★ 답변 원칙 (매우 중요)
제공된 [참고 정보]에 있는 내용으로만 답변하세요.
"엔젤 비즈", "마이크로 비즈" 등 요기보 제품이 아닌 용어는 절대 사용하지 마세요.
전화번호나 주소 같은 중요 정보는 [참고 정보]에 없으면 절대 지어내지 마세요.
[참고 정보]에 없는 내용은 솔직하게 모른다고 답하세요.

3. ★ 추천 상품 가이드
고객이 추천 상품을 원할 경우 요기보의 대표상품 '맥스(Max)'를 우선 추천하세요.
또한 [참고 정보]에 있는 다른 제품들의 특징(사이즈, 용도)을 바탕으로 추천하세요.
`;
const YOGIBO_SYSTEM_PROMPT = convertPromptLinks(basePrompt);

// ========== [데이터 로딩] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try {
  if (fs.existsSync(companyDataPath)) {
    companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));
  }
} catch (e) { console.error("companyData load fail", e); }

// ========== [MongoDB 토큰 관리 함수] ==========
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

// ========== [Cafe24 API] ==========
async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } });
    return res.data;
  } catch (error) {
    if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); }
    throw error;
  }
}

// ========== [RAG 로직] ==========
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const notes = await client.db(DB_NAME).collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({ c: n.category || "etc", q: n.question, a: n.answer }));
    allSearchableData = [...staticFaqList, ...dynamic];
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개 로드됨 (정적 ${staticFaqList.length} + 포스트잇 ${dynamic.length})`);
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

// ✅ [수정] 검색 로직 완화 및 로그 추가
function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];

  console.log(`🔍 검색 시작: "${msg}" (키워드: ${kws})`);

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const a = (item.a || "").toLowerCase();
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");

    // 질문 전체 포함 시 가산점
    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 20;

    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 10;
      if (item.a.toLowerCase().includes(cleanW)) score += 1;
    });

    return { ...item, score };
  });

  // ✅ 기준 점수 완화 (10 -> 5) : 키워드가 하나라도(특히 질문에) 포함되면 가져오도록 함
  const results = scored.filter(i => i.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3);
  
  console.log(`📊 검색 결과: ${results.length}개 발견`);
  if(results.length > 0) console.log(`   👉 1위: Q: ${results[0].q} / Score: ${results[0].score}`);

  return results;
}

async function getGPT3TurboResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const sys = `${YOGIBO_SYSTEM_PROMPT}\n[참고 정보]\n${txt || "정보 없음."}`;
  try {
    const res = await axios.post(OPEN_URL, {
      model: FINETUNED_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: input }]
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content;
  } catch (e) { return "답변 생성 중 문제가 발생했습니다."; }
}

// ========== [유틸 함수: 텍스트 포맷팅] ==========
function formatResponseText(text) {
  if (!text) return "";
  let formatted = text.replace(/([가-힣]+)[.]\s/g, '$1.\n\n'); 
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  formatted = formatted.replace(urlRegex, function(url) {
    let cleanUrl = url.replace(/[.,]$/, ''); 
    return `<a href="${cleanUrl}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${cleanUrl}</a>`;
  });
  return formatted;
}

function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }

// ✅ [로그인 체크]
function isUserLoggedIn(id) {
  if (!id) return false;
  if (id === "null") return false;
  if (id === "undefined") return false;
  if (String(id).trim() === "") return false;
  return true;
}

// ========== [배송 조회 함수] ==========
async function getOrderShippingInfo(id) {
  const today = new Date();
  const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10
  });
}

// ✅ [배송 상세 조회 + 송장 링크]
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    console.log(`[배송조회] ${orderId}:`, JSON.stringify(response));

    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" },
        "0023": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" }
      };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      shipment.shipping_company_name = carrierInfo.name;
      if (shipment.tracking_no && carrierInfo.url) {
        shipment.tracking_url = carrierInfo.url + shipment.tracking_no;
      } else {
        shipment.tracking_url = null;
      }
      return shipment;
    }
    return null;
  } catch (error) {
    console.error("Error fetching shipment:", error.message);
    throw error;
  }
}

// ========== [★ 핵심 로직: findAnswer] ==========
async function findAnswer(userInput, memberId) {
  const normalized = normalizeSentence(userInput);

  // 1. 상담사 연결
  if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) {
    return { text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}` };
  }

  // 2. [안전장치] 고객센터 전화번호 (검색 실패 대비 하드코딩)
  if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) {
      return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊<br>운영시간: 평일 10:00 ~ 17:30 (점심시간 12:00~13:00)" };
  }

  // 3. 매장 안내
  if (normalized.includes("오프라인 매장") || normalized.includes("매장안내")) {
    return { text: `가까운 매장을 안내해 드립니다.<br><a href="/why.stroe.html" target="_blank">매장안내 바로가기</a>` };
  }

  // 4. 내 아이디 조회
  if (normalized.includes("내 아이디") || normalized.includes("아이디 조회")) {
    return isUserLoggedIn(memberId)
      ? { text: `안녕하세요 ${memberId} 고객님, 무엇을 도와드릴까요?` }
      : { text: `로그인이 필요한 서비스입니다.<br>아래 버튼을 눌러 로그인해주세요.${LOGIN_BTN_HTML}` };
  }

  // 5. 주문번호로 배송 조회
  if (containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const orderId = normalized.match(/\d{8}-\d{7}/)[0];
        const ship = await getShipmentDetail(orderId);
        if (ship) {
            const status = ship.status || "배송 준비중";
            let trackingDisplay = "등록 대기중";
            if (ship.tracking_no) {
                if (ship.tracking_url) {
                    trackingDisplay = `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${ship.tracking_no}</a> (클릭)`;
                } else {
                    trackingDisplay = ship.tracking_no;
                }
            }
            return {
                text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${status}</strong>입니다.<br>
                       🚚 택배사: ${ship.shipping_company_name}<br>
                       📄 송장번호: ${trackingDisplay}`
            };
        } else {
            return { text: "해당 주문번호의 배송 정보를 찾을 수 없습니다." };
        }
      } catch (e) { return { text: "조회 오류가 발생했습니다." }; }
    }
    return { text: `정확한 조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
  }

  // 6. 일반 배송/주문 조회 (조건 강화)
  const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && 
                     (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
  const isFAQ = normalized.includes("비용") || normalized.includes("비") || normalized.includes("주소") || normalized.includes("변경");

  if (isTracking && !isFAQ && !containsOrderNumber(normalized)) {
    if (isUserLoggedIn(memberId)) {
      try {
        const data = await getOrderShippingInfo(memberId);
        if (data.orders?.[0]) {
          const t = data.orders[0];
          const ship = await getShipmentDetail(t.order_id);
          if (ship) {
             let trackingDisplay = "등록 대기중";
             if (ship.tracking_no) {
                 if (ship.tracking_url) {
                     trackingDisplay = `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${ship.tracking_no}</a>`;
                 } else {
                     trackingDisplay = ship.tracking_no;
                 }
             }
             return { text: `최근 주문(<strong>${t.order_id}</strong>)은 <strong>${ship.shipping_company_name}</strong> 배송 중입니다.<br>📄 송장번호: ${trackingDisplay}` };
          }
          return { text: "최근 주문 확인 중입니다." };
        }
        return { text: "최근 2주 내 주문 내역이 없습니다." };
      } catch (e) { return { text: "조회 실패." }; }
    } else {
      return { text: `배송정보를 확인하시려면 로그인이 필요합니다.<br>아래 버튼을 이용해 주세요.${LOGIN_BTN_HTML}` };
    }
  }

  // [JSON 하드코딩 로직들]

  // (1) 커버링
  if (pendingCoveringContext) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (types.includes(normalized)) {
      const key = `${normalized} 커버링 방법을 알고 싶어`;
      pendingCoveringContext = false;
      if (companyData.covering?.[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    }
  }
  if (normalized.includes("커버링") && normalized.includes("방법")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const found = types.find(t => normalized.includes(t));
    if (found) {
      const key = `${found} 커버링 방법을 알고 싶어`;
      if (companyData.covering?.[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
    } else {
      pendingCoveringContext = true;
      return { text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 슬림 등)" };
    }
  }

  // (2) 사이즈
  if (normalized.includes("사이즈") || normalized.includes("크기")) {
    const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    for (let t of types) {
      if (normalized.includes(t) && companyData.sizeInfo?.[`${t} 사이즈 또는 크기.`]) {
        return { text: formatResponseText(companyData.sizeInfo[`${t} 사이즈 또는 크기.`].description), imageUrl: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].imageUrl };
      }
    }
  }

  // (3) 비즈 안내
  if (normalized.includes("비즈") || normalized.includes("충전재") || normalized.includes("알갱이")) {
    const actionKeywords = ["충전", "방법", "넣는", "보충", "리필", "세탁", "버리", "폐기", "교체", "구매", "파는"];
    if (actionKeywords.some(keyword => normalized.includes(keyword))) {
        return null; // 검색 로직으로 이동
    }

    let key = null;
    if (normalized.includes("프리미엄 플러스")) key = "프리미엄 플러스 비즈 에 대해 알고 싶어";
    else if (normalized.includes("프리미엄")) key = "프리미엄 비즈 에 대해 알고 싶어";
    else if (normalized.includes("스탠다드")) key = "스탠다드 비즈 에 대해 알고 싶어";
    
    if (key && companyData.biz?.[key]) { return { text: formatResponseText(companyData.biz[key].description) }; }
    // 단순 '비즈 종류' 문의에 대한 답변
    return {
      text: formatResponseText(`요기보의 정품 비즈(충전재)는 3가지 종류가 있습니다. 😊. 
        1️⃣ 스탠다드 비즈: 전세계 빈백소파에 가장 많이 사용 되는 충전재입니다. 편안함과 부드러운 사용감에 초점이 맞춰져 있어요. Yogibo의 트랜스포밍 기능을 사용하는데 최적화 되어있는 비즈입니다.. 
        2️⃣ 프리미엄 비즈: Yogibo에서 개발하여, 국내 독점으로 사용하고 있는 신소재(HRF)에요. 스탠다드 비즈의 부드러움과 편안함을 유지하고, 복원력과 내구성은 월등히 업그레이드 한 비즈입니다.. 
        3️⃣ 프리미엄 플러스: 스탠다드 비즈 대비 복원력과 내구성이 10배 이상 업그레이드 된 차세대 비즈에요. 집 뿐만 아니라 많은 사람들이 이용하는 공용 공간에 최적화된 비즈입니다.`)
    };
  }

  // (4) 추천 상품
  if (normalized.includes("추천") || normalized.includes("인기")) {
      const maxInfo = companyData.sizeInfo?.["맥스 사이즈 또는 크기."];
      if (maxInfo) {
          return {
              text: formatResponseText(`요기보의 베스트셀러, 맥스(Max)를 추천드려요! 👍. 가장 인기 있는 사이즈로, 침대/소파/의자 등 다양하게 활용 가능합니다. ${maxInfo.description}`),
              imageUrl: maxInfo.imageUrl
          };
      }
  }

  // (5) 기타 정보
  if (companyData.goodsInfo) {
    let b=null, m=6; for(let k in companyData.goodsInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.goodsInfo[k];}}
    if(b) return { text: formatResponseText(Array.isArray(b.description)?b.description.join("\n"):b.description), imageUrl: b.imageUrl };
  }
  if (companyData.homePage) {
    let b=null, m=5; for(let k in companyData.homePage){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.homePage[k];}}
    if(b) return { text: formatResponseText(b.description) };
  }
  if (companyData.asInfo) {
    let b=null, m=8; for(let k in companyData.asInfo){const d=levenshtein.get(normalized,normalizeSentence(k));if(d<m){m=d;b=companyData.asInfo[k];}}
    if(b) return { text: formatResponseText(b.description) };
  }

  return null;
}

// ========== [Chat 요청 처리] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    // 1. 규칙(JSON/API) 답변 시도
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
      if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
      return res.json(ruleAnswer);
    }

    // 2. 규칙 없으면 RAG + GPT
    const docs = findRelevantContent(message);
    let gptAnswer = await getGPT3TurboResponse(message, docs);
    gptAnswer = formatResponseText(gptAnswer);

    // ✅ 검색된 정보가 없을 때만 상담사 연결 버튼 부착
    if (docs.length === 0) {
        gptAnswer += FALLBACK_MESSAGE_HTML;
    }

    await saveConversationLog(memberId, message, gptAnswer);
    res.json({ text: gptAnswer, videoHtml: null });

  } catch (e) {
    console.error(e);
    res.status(500).json({ text: "오류가 발생했습니다." });
  }
});

async function saveConversationLog(mid, uMsg, bRes) {
  const client = new MongoClient(MONGODB_URI);
  try { await client.connect();
    await client.db(DB_NAME).collection("conversationLogs").updateOne(
      { memberId: mid || null, date: new Date().toISOString().split("T")[0] },
      { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } },
      { upsert: true }
    );
  } finally { await client.close(); }
}

// ========== [기타 API들 (기존 유지)] ==========
app.get("/postIt", async (req, res) => {
  const p = parseInt(req.query.page)||1; const l=300;
  try { const c=new MongoClient(MONGODB_URI); await c.connect();
    const f = req.query.category?{category:req.query.category}:{};
    const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray();
    const t = await c.db(DB_NAME).collection("postItNotes").countDocuments(f);
    await c.close(); res.json({notes:n, totalCount:t, currentPage:p});
  } catch(e){res.status(500).json({error:e.message})}
});
app.post("/postIt", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.put("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").updateOne({_id:new ObjectId(req.params.id)},{$set:{...req.body,updatedAt:new Date()}});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.delete("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").deleteOne({_id:new ObjectId(req.params.id)});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });

app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close();
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}];
  d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)}));
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx");
  await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

const upload = multer({storage:multer.diskStorage({destination:(r,f,c)=>c(null,path.join(__dirname,'uploads')),filename:(r,f,c)=>c(null,`${Date.now()}_${f.originalname}`)}),limits:{fileSize:5*1024*1024}});
const transporter = nodemailer.createTransport({host:SMTP_HOST,port:Number(SMTP_PORT),secure:SMTP_SECURE==='true',auth:{user:SMTP_USER,pass:SMTP_PASS}});
app.post('/send-email', upload.single('attachment'), async(req,res)=>{ try{
  await transporter.sendMail({from:req.body.companyName,to:'contact@yogico.kr',replyTo:req.body.companyEmail,subject:`Contact: ${req.body.companyName}`,text:req.body.message,attachments:req.file?[{path:req.file.path}]:[]});
  res.json({success:true});}catch(e){res.status(500).json({success:false,error:e.message})} });

app.post('/api/:_any/uploads/image', upload.single('file'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'}); const c=new ftp.Client();
  try{await c.access({host:process.env.FTP_HOST,user:process.env.FTP_USER,password:process.env.FTP_PASS,secure:false});
    const dir=`yogibo/${dayjs().format('YYYY/MM/DD')}`; await c.cd('web/img/temple/uploads').catch(()=>{}); await c.ensureDir(dir); await c.uploadFrom(req.file.path,req.file.filename);
    res.json({url:`${FTP_PUBLIC_BASE}/uploads/${dir}/${req.file.filename}`.replace(/([^:]\/)\/+/g,'$1')});
  }catch(e){res.status(500).json({error:e.message})}finally{c.close();fs.unlink(req.file.path,()=>{})}
});

const runDb=async(cb)=>{const c=new MongoClient(MONGODB_URI);await c.connect();try{return await cb(c.db(DB_NAME))}finally{await c.close()}};
const EC='eventTemple';
const nb=blocks=>blocks.map(b=>(b?.type==='video'?{...b,autoplay:!!b.autoplay}:b));
app.post('/api/:_any/eventTemple',async(req,res)=>{try{const p={...req.body,createdAt:new Date()};if(p.content?.blocks)p.content.blocks=nb(p.content.blocks);const r=await runDb(db=>db.collection(EC).insertOne(p));res.json({_id:r.insertedId,...p})}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple',async(req,res)=>{try{const l=await runDb(db=>db.collection(EC).find({mallId:CAFE24_MALLID}).sort({createdAt:-1}).toArray());res.json(l)}catch(e){res.status(500).json({error:'Err'})}});
app.get('/api/:_any/eventTemple/:id',async(req,res)=>{try{const d=await runDb(db=>db.collection(EC).findOne({_id:new ObjectId(req.params.id)}));res.json(d)}catch(e){res.status(500).json({error:'Err'})}});
app.put('/api/:_any/eventTemple/:id',async(req,res)=>{try{const s={...req.body,updatedAt:new Date()};if(s.content?.blocks)s.content.blocks=nb(s.content.blocks);delete s._id;await runDb(db=>db.collection(EC).updateOne({_id:new ObjectId(req.params.id)},{$set:s}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});
app.delete('/api/:_any/eventTemple/:id',async(req,res)=>{try{await runDb(db=>db.collection(EC).deleteOne({_id:new ObjectId(req.params.id)}));res.json({success:true})}catch(e){res.status(500).json({error:'Err'})}});



// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작...");
    await getTokensFromDB();
    await updateSearchableData();
    app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`));
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();