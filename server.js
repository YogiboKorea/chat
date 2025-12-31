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

// ✅ 파일 업로드 설정
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
});
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

let pendingCoveringContext = false;
let allSearchableData = [...staticFaqList];

// ★ [핵심 수정] 시스템 프롬프트: 모르는 건 절대 아는 척 금지 + 암호(NO_CONTEXT_FOUND) 사용
let currentSystemPrompt = `
1. 역할: 당신은 글로벌 라이프스타일 브랜드 '요기보(Yogibo)'의 전문 상담원입니다.
2. 태도: 고객에게 공감하며 따뜻하고 친절한 말투("~해요", "~인가요?")를 사용하세요.
3. ★ 절대 원칙 (가장 중요): 
   - 반드시 아래 제공되는 [참고 정보]에 있는 내용만으로 답변하세요.
   - [참고 정보]에 없는 제품(예: 롤 메이트)이나 주제(예: 배터리 충전)에 대해 물어보면, 당신의 배경지식으로 지어내지 마세요.
   - [참고 정보]로 답변할 수 없는 경우, 구차한 변명 대신 딱 한 단어만 출력하세요: "NO_CONTEXT_FOUND"
4. 중요 지식: '빈백'은 가방이 아니라 소파입니다.
5. 포맷: 
   - 링크는 [버튼명](URL) 형식으로 작성하세요.
   - HTML 태그는 변경하지 말고 그대로 출력하세요.
`;

// ========== 상담사 연결 링크 (클래스 기반) ==========
const COUNSELOR_LINKS_HTML = `
<div class="consult-container">
  <p style="font-weight:bold; margin-bottom:10px; font-size:14px;">👩‍💻 상담사 연결이 필요하신가요?</p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡
  </a>
  <p class="consult-text">운영시간: 평일 10:00 ~ 17:30 (점심 12:00~13:00)</p>
</div>
`;

// ★ [수정] 모르는 질문일 때 나가는 기본 멘트
const FALLBACK_MESSAGE_HTML = `
<div style="margin-top: 15px;">
  <span style="font-size:14px; color:#333; font-weight:bold;">죄송합니다. 문의하신 내용에 대한 정확한 정보가 확인되지 않습니다. 😥</span>
  <br><br>
  <span style="font-size:13px; color:#666;">정확한 답변을 원하실 경우, 아래 상담 채널을 이용해 주시면 친절히 안내해 드리겠습니다.</span>
  ${COUNSELOR_LINKS_HTML}
</div>
`;

const LOGIN_BTN_HTML = `
<div style="margin-top:15px;">
  <a href="/member/login.html" class="consult-btn" style="background:#58b5ca; color:#fff; justify-content:center;">로그인 하러 가기 →</a>
</div>
`;

// (이하 DB 연결 및 유틸리티 함수들은 동일)
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try { if (fs.existsSync(companyDataPath)) companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8")); } catch (e) {}

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

async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({ c: n.category || "etc", q: n.question, a: n.answer }));
    allSearchableData = [...staticFaqList, ...dynamic];
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) currentSystemPrompt = prompts[0].content; 
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length && msg.length < 2) return [];
  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 30;
    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 15;
      if (item.a.toLowerCase().includes(cleanW)) score += 5;
    });
    const dbKeywords = (item.q || "").split(/\s+/).filter(w => w.length > 1);
    dbKeywords.forEach(dbK => { if (msg.includes(dbK)) score += 10; });
    return { ...item, score };
  });
  return scored.filter(i => i.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3);
}

// ✅ [수정] GPT 호출 (NO_CONTEXT_FOUND 처리를 위해 약간 수정)
async function getGPT3TurboResponse(input, context = []) {
  if (context.length === 0) return "NO_CONTEXT_FOUND"; // 검색 결과 없으면 바로 암호 리턴

  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const sys = `${currentSystemPrompt}\n\n[참고 정보]\n${txt}`;

  try {
    const res = await axios.post(OPEN_URL, {
      model: FINETUNED_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: input }], temperature: 0
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    
    return res.data.choices[0].message.content;
  } catch (e) { return "오류가 발생했습니다."; }
}

function formatResponseText(text) { return text || ""; }
function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

// ... (PDF, 이미지 업로드, 수정, 삭제 API는 기존과 동일하여 생략, 그대로 두시면 됩니다) ...
// (기존 코드의 app.post('/chat_send'...), app.post('/upload_knowledge_image'...) 등등 유지)
// 여기서는 지면 관계상 생략하지만, 실제 파일에는 꼭 있어야 합니다.
// (이전 답변의 API 코드들을 그대로 복사해서 사용하세요.)

app.post("/chat_send", upload.single('file'), async (req, res) => {
    const { role, content } = req.body;
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect(); const db = client.db(DB_NAME);
        if (req.file) req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        if (req.file && req.file.mimetype === 'application/pdf') {
            const dataBuffer = fs.readFileSync(req.file.path); const data = await pdfParse(dataBuffer);
            const cleanText = data.text.replace(/\n\n+/g, '\n').replace(/\s+/g, ' ').trim();
            const chunks = []; for (let i = 0; i < cleanText.length; i += 500) chunks.push(cleanText.substring(i, i + 500));
            const docs = chunks.map((chunk, index) => ({ category: "pdf-knowledge", question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, answer: chunk, createdAt: new Date() }));
            if (docs.length > 0) await db.collection("postItNotes").insertMany(docs);
            fs.unlink(req.file.path, () => {}); await updateSearchableData();
            return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
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
        await db.collection("postItNotes").deleteOne({ _id: new ObjectId(id) }); await updateSearchableData(); res.json({ message: "OK" });
    } catch(e) { res.status(500).json({ error: e.message }); } finally { await client.close(); }
});

async function apiRequest(method, url, data = {}, params = {}) {
    try { const res = await axios({ method, url, data, params, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Cafe24-Api-Version': CAFE24_API_VERSION } }); return res.data; } 
    catch (error) { if (error.response?.status === 401) { await refreshAccessToken(); return apiRequest(method, url, data, params); } throw error; }
}
async function getOrderShippingInfo(id) {
  const today = new Date(); const start = new Date(); start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, { member_id: id, start_date: start.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 10 });
}
async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = { "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" }, "0039": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" }, "0023": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" } };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      shipment.shipping_company_name = carrierInfo.name; shipment.tracking_url = (shipment.tracking_no && carrierInfo.url) ? carrierInfo.url + shipment.tracking_no : null;
      return shipment;
    } return null;
  } catch (error) { throw error; }
}

// ========== [규칙 답변 로직] ==========
async function findAnswer(userInput, memberId) {
    const normalized = normalizeSentence(userInput);
    if (normalized.includes("상담사") || normalized.includes("상담원") || normalized.includes("사람")) return { text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}` };
    if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊\n운영시간: 평일 10:00 ~ 17:30 (점심시간 12:00~13:00)" };
    if (normalized.includes("장바구니")) return isUserLoggedIn(memberId) ? { text: `${memberId}님의 장바구니로 이동하시겠어요?\n<a href="/order/basket.html" style="color:#58b5ca; font-weight:bold;">🛒 장바구니 바로가기</a>` } : { text: `장바구니를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    if (normalized.includes("회원정보") || normalized.includes("정보수정")) return isUserLoggedIn(memberId) ? { text: `회원정보 변경은 마이페이지에서 가능합니다.\n<a href="/member/modify.html" style="color:#58b5ca; font-weight:bold;">🔧 회원정보 수정하기</a>` } : { text: `회원정보를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    
    // (배송 로직 생략 - 그대로 사용)
    if (containsOrderNumber(normalized)) {
        if (isUserLoggedIn(memberId)) {
            try {
                const orderId = normalized.match(/\d{8}-\d{7}/)[0]; const ship = await getShipmentDetail(orderId);
                if (ship) {
                    let trackingDisplay = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold;">${ship.tracking_no}</a>` : ship.tracking_no) : "등록 대기중";
                    return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.\n🚚 택배사: ${ship.shipping_company_name}\n📄 송장번호: ${trackingDisplay}` };
                } return { text: "해당 주문번호의 배송 정보를 찾을 수 없습니다." };
            } catch (e) { return { text: "조회 오류가 발생했습니다." }; }
        } return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }
    const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
    if (isTracking && !containsOrderNumber(normalized)) {
        if (isUserLoggedIn(memberId)) {
          try {
            const data = await getOrderShippingInfo(memberId);
            if (data.orders?.[0]) {
              const t = data.orders[0]; const ship = await getShipmentDetail(t.order_id);
              if (ship) {
                 let trackingDisplay = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold;">${ship.tracking_no}</a>` : ship.tracking_no) : "등록 대기중";
                 return { text: `최근 주문(<strong>${t.order_id}</strong>)은 <strong>${ship.shipping_company_name}</strong> 배송 중입니다.\n📄 송장번호: ${trackingDisplay}` };
              } return { text: "최근 주문 확인 중입니다." };
            } return { text: "최근 2주 내 주문 내역이 없습니다." };
          } catch (e) { return { text: "조회 실패." }; }
        } return { text: `배송정보를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }
    // (기타 covering, sizeInfo 로직 생략 - 그대로 사용)
    if (companyData.covering) {
        if (pendingCoveringContext) {
            const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드", "롤 미디", "롤 맥스", "카터필러 롤"];
            if (types.includes(normalized)) {
                const key = `${normalized} 커버링 방법을 알고 싶어`;
                pendingCoveringContext = false;
                if (companyData.covering[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
            }
        }
        if (normalized.includes("커버링") && normalized.includes("방법")) {
            const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드", "롤 미디", "롤 맥스", "카터필러 롤"];
            const found = types.find(t => normalized.includes(t));
            if (found) {
                const key = `${found} 커버링 방법을 알고 싶어`;
                if (companyData.covering[key]) return { text: formatResponseText(companyData.covering[key].answer), videoHtml: `<iframe width="100%" height="auto" src="${companyData.covering[key].videoUrl}" frameborder="0" allowfullscreen></iframe>` };
            } else {
                pendingCoveringContext = true;
                return { text: "어떤 제품의 커버링 방법을 알고 싶으신가요? (예: 맥스, 더블, 슬림 등)" };
            }
        }
    }
    if (companyData.sizeInfo) {
        if (normalized.includes("사이즈") || normalized.includes("크기")) {
            const types = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드", "허기보"];
            for (let t of types) {
                if (normalized.includes(t) && companyData.sizeInfo[`${t} 사이즈 또는 크기.`]) {
                    return { text: formatResponseText(companyData.sizeInfo[`${t} 사이즈 또는 크기.`].description), imageUrl: companyData.sizeInfo[`${t} 사이즈 또는 크기.`].imageUrl };
                }
            }
        }
    }
    return null;
}

// ========== [메인 Chat] ==========
app.post("/chat", async (req, res) => {
  const { message, memberId } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  try {
    const ruleAnswer = await findAnswer(message, memberId);
    if (ruleAnswer) {
       if (message !== "내 아이디") await saveConversationLog(memberId, message, ruleAnswer.text);
       return res.json(ruleAnswer);
    }

    const docs = findRelevantContent(message);
    let gptAnswer = await getGPT3TurboResponse(message, docs);
    
    // ★ [핵심] 암호(NO_CONTEXT_FOUND)가 오면 Fallback 메시지로 교체
    if (gptAnswer.includes("NO_CONTEXT_FOUND")) {
        gptAnswer = FALLBACK_MESSAGE_HTML;
    } else {
        // 정상 답변일 경우 이미지/영상 복구 로직 실행
        if (docs.length > 0) {
            const bestDoc = docs[0];
            if (bestDoc.a.includes("<iframe") && !gptAnswer.includes("<iframe")) { const iframes = bestDoc.a.match(/<iframe.*<\/iframe>/g); if (iframes) gptAnswer += "\n" + iframes.join("\n"); }
            if (bestDoc.a.includes("<img") && !gptAnswer.includes("<img")) { const imgs = bestDoc.a.match(/<img.*?>/g); if (imgs) gptAnswer += "\n" + imgs.join("\n"); }
        }
    }

    const finalAnswer = formatResponseText(gptAnswer);
    await saveConversationLog(memberId, message, finalAnswer);
    res.json({ text: finalAnswer, videoHtml: null });

  } catch (e) { console.error(e); res.status(500).json({ text: "오류가 발생했습니다." }); }
});

// (로그 저장, 엑셀 다운로드, 서버 시작 코드는 동일)
async function saveConversationLog(mid, uMsg, bRes) {
    const client = new MongoClient(MONGODB_URI);
    try { await client.connect(); await client.db(DB_NAME).collection("conversationLogs").updateOne({ memberId: mid || null, date: new Date().toISOString().split("T")[0] }, { $push: { conversation: { userMessage: uMsg, botResponse: bRes, createdAt: new Date() } } }, { upsert: true }); } finally { await client.close(); }
}
app.get("/postIt", async (req, res) => {
    const p = parseInt(req.query.page)||1; const l=300;
    try { const c=new MongoClient(MONGODB_URI); await c.connect(); const f = req.query.category?{category:req.query.category}:{}; const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray(); await c.close(); res.json({notes:n, currentPage:p}); } catch(e){res.status(500).json({error:e.message})}
});
app.post("/postIt", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect(); await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()}); await c.close(); await updateSearchableData(); res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close(); const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}]; d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)})); res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx"); await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

(async function initialize() {
  try { console.log("🟡 서버 시작..."); await getTokensFromDB(); await updateSearchableData(); app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`)); } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();