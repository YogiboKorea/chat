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
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
const pdfParse = require('pdf-extraction'); // ✅ 이걸로 변경 (변수명은 그대로 pdfParse 써도 됨)

// ✅ [중요] .env 파일 경로 명시적 지정
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ✅ 정적 FAQ 데이터 불러오기
const staticFaqList = require("./faq");

// ========== [환경 설정] ==========
const {
  ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET,
  DB_NAME, MONGODB_URI, CAFE24_MALLID, OPEN_URL, API_KEY,
  FINETUNED_MODEL = "gpt-3.5-turbo", CAFE24_API_VERSION = "2024-06-01",
  PORT = 5000, FTP_PUBLIC_BASE,
  FTP_HOST, FTP_USER, FTP_PASS
} = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;

// ========== [Express 초기화] ==========
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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB 제한
});

// 폴더가 없으면 생성
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// ========== [글로벌 상태] ==========
let pendingCoveringContext = false;
let allSearchableData = [...staticFaqList];

// 🤖 시스템 프롬프트
let currentSystemPrompt = `
1. 역할: 요기보(Yogibo)의 친절한 상담원입니다.
2. 태도: 공감하고 따뜻한 말투("~해요")를 사용하세요.
3. 원칙: [참고 정보]에 없는 내용은 지어내지 말고 모른다고 하세요.
`;

// ========== [상수: HTML 템플릿] ==========
const COUNSELOR_LINKS_HTML = `
<div style="margin-top: 15px;">
  📮 <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" style="color:#3b1e1e; font-weight:bold; text-decoration:underline; cursor:pointer;">카카오플친 연결하기 (팝업)</a><br>
  📮 <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" style="color:#03c75a; font-weight:bold; text-decoration:underline; cursor:pointer;">네이버톡톡 연결하기 (팝업)</a>
</div>
`;

const FALLBACK_MESSAGE_HTML = `
<div style="margin-top: 20px; border-top: 1px dashed #ddd; padding-top: 10px;">
  <span style="font-size:13px; color:#888;">원하시는 답변을 찾지 못하셨나요?</span>
  ${COUNSELOR_LINKS_HTML}
</div>
`;

const LOGIN_BTN_HTML = `
<div style="margin-top:15px;">
  <a href="/member/login.html" style="
    display: inline-block;
    padding: 8px 16px;
    background-color: #58b5ca;
    color: #ffffff;
    text-decoration: none;
    border-radius: 20px;
    font-weight: bold;
    font-size: 13px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  ">로그인 하러 가기 →</a>
</div>
`;

// ========== [데이터 로딩: companyData.json] ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
let companyData = {};
try {
  if (fs.existsSync(companyDataPath)) {
    companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));
  }
} catch (e) { console.error("companyData load fail", e); }

// ========== [MongoDB 관리 함수] ==========
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

// ✅ [RAG 로직 1] DB 데이터 갱신
async function updateSearchableData() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);

    // postItNotes 컬렉션에서 데이터 가져오기 (PDF 내용 포함)
    const notes = await db.collection("postItNotes").find({}).toArray();
    const dynamic = notes.map(n => ({ c: n.category || "etc", q: n.question, a: n.answer }));
    
    allSearchableData = [...staticFaqList, ...dynamic];
    console.log(`✅ 검색 데이터 갱신 완료: 총 ${allSearchableData.length}개 로드됨`);

    // 최신 시스템 프롬프트 적용
    const prompts = await db.collection("systemPrompts").find({}).sort({createdAt: -1}).limit(1).toArray();
    if (prompts.length > 0) {
        currentSystemPrompt = prompts[0].content; 
    }
  } catch (err) { console.error("데이터 갱신 실패:", err); } finally { await client.close(); }
}

// ✅ [RAG 로직 2] 검색
function findRelevantContent(msg) {
  const kws = msg.split(/\s+/).filter(w => w.length > 1);
  if (!kws.length) return [];
  console.log(`🔍 검색 시작: "${msg}"`);

  const scored = allSearchableData.map(item => {
    let score = 0;
    const q = (item.q || "").toLowerCase().replace(/\s+/g, "");
    const cleanMsg = msg.toLowerCase().replace(/\s+/g, "");
    
    // 질문에 키워드 포함 시 점수
    if (q.includes(cleanMsg) || cleanMsg.includes(q)) score += 20;
    
    // 키워드 매칭
    kws.forEach(w => {
      const cleanW = w.toLowerCase();
      if (item.q.toLowerCase().includes(cleanW)) score += 10; // 질문에 포함되면 높은 점수
      if (item.a.toLowerCase().includes(cleanW)) score += 3;  // 답변(내용)에 포함되면 낮은 점수
    });
    return { ...item, score };
  });

  // 점수 내림차순 정렬 후 상위 3개 추출
  return scored.filter(i => i.score >= 3).sort((a, b) => b.score - a.score).slice(0, 3);
}

// ✅ [GPT 호출]
async function getGPT3TurboResponse(input, context = []) {
  const txt = context.map(i => `Q: ${i.q}\nA: ${i.a}`).join("\n\n");
  const sys = `${currentSystemPrompt}\n\n[참고 정보]\n${txt || "관련된 정보가 없습니다."}`;
  try {
    const res = await axios.post(OPEN_URL, {
      model: FINETUNED_MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: input }]
    }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });
    return res.data.choices[0].message.content;
  } catch (e) { return "답변 생성 중 문제가 발생했습니다."; }
}

// ========== [유틸 함수] ==========
function formatResponseText(text) {
  if (!text) return "";
  let formatted = text;
  
  // 마크다운 링크 변환: [텍스트](주소) -> <a>태그
  formatted = formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, title, url) => {
      return `<a href="${url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${title}</a>`;
  });

  // 일반 URL 텍스트 변환
  formatted = formatted.replace(/(?<!href="|">)(https?:\/\/[^\s<)]+)/g, (url) => {
      return `<a href="${url}" target="_blank" style="color:#58b5ca; font-weight:bold; text-decoration:underline;">${url}</a>`;
  });

  return formatted;
}

function normalizeSentence(s) { return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); }
function containsOrderNumber(s) { return /\d{8}-\d{7}/.test(s); }
function isUserLoggedIn(id) { return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; }

// ========== [API: PDF 업로드 및 분석 (핵심 기능)] ==========
// upload.single('file') 미들웨어를 사용하여 파일 수신
app.post("/chat_send", upload.single('file'), async (req, res) => {
    const { role, content } = req.body;
    const client = new MongoClient(MONGODB_URI);

    try {
        await client.connect();
        const db = client.db(DB_NAME);

        // 1️⃣ PDF 파일이 업로드된 경우 (지식 학습)
        if (req.file && req.file.mimetype === 'application/pdf') {
            const dataBuffer = fs.readFileSync(req.file.path);
            const data = await pdfParse(dataBuffer);
            
            // 텍스트 정제 (줄바꿈 정리)
            const cleanText = data.text.replace(/\n\n+/g, '\n').trim();
            
            // ★ 중요: 텍스트 Chunking (500자 단위로 자르기)
            // 긴 문서를 통째로 넣으면 검색 정확도가 떨어지므로 작게 나눕니다.
            const chunkSize = 500; 
            const chunks = [];
            for (let i = 0; i < cleanText.length; i += chunkSize) {
                chunks.push(cleanText.substring(i, i + chunkSize));
            }

            // DB에 저장 (postItNotes 컬렉션 재활용)
            // 질문 필드에 '[PDF 학습]' 태그를 달아 구분합니다.
            const docs = chunks.map((chunk, index) => ({
                category: "pdf-knowledge",
                question: `[PDF 학습데이터] ${req.file.originalname} (Part ${index + 1})`, 
                answer: chunk, 
                createdAt: new Date()
            }));

            if (docs.length > 0) {
                await db.collection("postItNotes").insertMany(docs);
            }

            // 임시 파일 삭제
            fs.unlink(req.file.path, () => {});
            
            // 메모리 갱신 (즉시 검색 가능하게)
            await updateSearchableData();
            
            return res.json({ message: `PDF 분석 완료! 총 ${docs.length}개의 데이터로 학습되었습니다.` });
        }

        // 2️⃣ (옵션) 텍스트로 역할 설정하는 경우 (기존 유지)
        if (role && content) {
            const fullPrompt = `역할: ${role}\n지시사항: ${content}`;
            await db.collection("systemPrompts").insertOne({
                role, content: fullPrompt, createdAt: new Date()
            });
            currentSystemPrompt = fullPrompt;
            return res.json({ message: "LLM 역할 설정이 완료되었습니다." });
        }

        res.status(400).json({ error: "파일이나 내용이 없습니다." });

    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    } finally { 
        await client.close(); 
    }
});

// ========== [Cafe24 API 관련 함수 생략없이 포함] ==========
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
  const today = new Date();
  const start = new Date(); start.setDate(today.getDate() - 14);
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
      const carrierMap = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" },
        "0023": { name: "경동 택배", url: "https://kdexp.com/service/delivery/tracking.do?barcode=" }
      };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      shipment.shipping_company_name = carrierInfo.name;
      shipment.tracking_url = (shipment.tracking_no && carrierInfo.url) ? carrierInfo.url + shipment.tracking_no : null;
      return shipment;
    }
    return null;
  } catch (error) { throw error; }
}

// ========== [규칙 기반 답변 로직 (findAnswer)] ==========
async function findAnswer(userInput, memberId) {
    const normalized = normalizeSentence(userInput);
    
    if (normalized.includes("상담사 연결") || normalized.includes("상담원 연결")) return { text: `상담사와 연결을 도와드리겠습니다.${COUNSELOR_LINKS_HTML}` };
    if (normalized.includes("고객센터") && (normalized.includes("번호") || normalized.includes("전화"))) return { text: "요기보 고객센터 전화번호는 **02-557-0920** 입니다. 😊\n운영시간: 평일 10:00 ~ 17:30 (점심시간 12:00~13:00)" };
    if (normalized.includes("장바구니")) return isUserLoggedIn(memberId) ? { text: `${memberId}님의 장바구니로 이동하시겠어요?\n<a href="/order/basket.html" style="color:#58b5ca; font-weight:bold;">🛒 장바구니 바로가기</a>` } : { text: `장바구니를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    if (normalized.includes("회원정보") || normalized.includes("정보수정")) return isUserLoggedIn(memberId) ? { text: `회원정보 변경은 마이페이지에서 가능합니다.\n<a href="/member/modify.html" style="color:#58b5ca; font-weight:bold;">🔧 회원정보 수정하기</a>` } : { text: `회원정보를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    
    if (containsOrderNumber(normalized)) {
        if (isUserLoggedIn(memberId)) {
            try {
                const orderId = normalized.match(/\d{8}-\d{7}/)[0];
                const ship = await getShipmentDetail(orderId);
                if (ship) {
                    let trackingDisplay = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold;">${ship.tracking_no}</a>` : ship.tracking_no) : "등록 대기중";
                    return { text: `주문번호 <strong>${orderId}</strong>의 배송 상태는 <strong>${ship.status || "배송 준비중"}</strong>입니다.\n🚚 택배사: ${ship.shipping_company_name}\n📄 송장번호: ${trackingDisplay}` };
                }
                return { text: "해당 주문번호의 배송 정보를 찾을 수 없습니다." };
            } catch (e) { return { text: "조회 오류가 발생했습니다." }; }
        }
        return { text: `조회를 위해 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }
    const isTracking = (normalized.includes("배송") || normalized.includes("주문")) && (normalized.includes("조회") || normalized.includes("확인") || normalized.includes("언제") || normalized.includes("어디"));
    if (isTracking && !containsOrderNumber(normalized)) {
        if (isUserLoggedIn(memberId)) {
          try {
            const data = await getOrderShippingInfo(memberId);
            if (data.orders?.[0]) {
              const t = data.orders[0];
              const ship = await getShipmentDetail(t.order_id);
              if (ship) {
                 let trackingDisplay = ship.tracking_no ? (ship.tracking_url ? `<a href="${ship.tracking_url}" target="_blank" style="color:#58b5ca; font-weight:bold;">${ship.tracking_no}</a>` : ship.tracking_no) : "등록 대기중";
                 return { text: `최근 주문(<strong>${t.order_id}</strong>)은 <strong>${ship.shipping_company_name}</strong> 배송 중입니다.\n📄 송장번호: ${trackingDisplay}` };
              }
              return { text: "최근 주문 확인 중입니다." };
            }
            return { text: "최근 2주 내 주문 내역이 없습니다." };
          } catch (e) { return { text: "조회 실패." }; }
        }
        return { text: `배송정보를 확인하시려면 로그인이 필요합니다.${LOGIN_BTN_HTML}` };
    }

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

// ========== [메인 Chat 요청 처리] ==========
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
    gptAnswer = formatResponseText(gptAnswer);

    if (docs.length > 0) {
        const bestDoc = docs[0];
        if (bestDoc.a.includes("<iframe") && !gptAnswer.includes("<iframe")) {
            const iframes = bestDoc.a.match(/<iframe.*<\/iframe>/g);
            if (iframes) gptAnswer += "\n<br><br>" + iframes.join("\n<br>");
        }
        if (bestDoc.a.includes("<img") && !gptAnswer.includes("<img")) {
            const imgs = bestDoc.a.match(/<img.*?>/g);
            if (imgs) gptAnswer += "\n<br><br>" + imgs.join("\n<br>");
        }
    }

    if (docs.length === 0) gptAnswer += FALLBACK_MESSAGE_HTML;

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

// ========== [기존 API들] ==========
app.get("/postIt", async (req, res) => {
    const p = parseInt(req.query.page)||1; const l=300;
    try { const c=new MongoClient(MONGODB_URI); await c.connect();
      const f = req.query.category?{category:req.query.category}:{};
      const n = await c.db(DB_NAME).collection("postItNotes").find(f).sort({_id:-1}).skip((p-1)*l).limit(l).toArray();
      await c.close(); res.json({notes:n, currentPage:p});
    } catch(e){res.status(500).json({error:e.message})}
});

app.post("/postIt", async(req,res)=>{ 
    try{const c=new MongoClient(MONGODB_URI);await c.connect();
    await c.db(DB_NAME).collection("postItNotes").insertOne({...req.body,createdAt:new Date()});
    await c.close();
    await updateSearchableData(); 
    res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} 
});

app.put("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").updateOne({_id:new ObjectId(req.params.id)},{$set:{...req.body,updatedAt:new Date()}});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });
app.delete("/postIt/:id", async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();await c.db(DB_NAME).collection("postItNotes").deleteOne({_id:new ObjectId(req.params.id)});await c.close();await updateSearchableData();res.json({message:"OK"})}catch(e){res.status(500).json({error:e.message})} });

app.post('/api/:_any/uploads/image', upload.single('file'), async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'}); const c=new ftp.Client();
  try{await c.access({host:process.env.FTP_HOST,user:process.env.FTP_USER,password:process.env.FTP_PASS,secure:false});
    const dir=`yogibo/${dayjs().format('YYYY/MM/DD')}`; await c.cd('web/img/temple/uploads').catch(()=>{}); await c.ensureDir(dir); await c.uploadFrom(req.file.path,req.file.filename);
    res.json({url:`${FTP_PUBLIC_BASE}/uploads/${dir}/${req.file.filename}`.replace(/([^:]\/)\/+/g,'$1')});
  }catch(e){res.status(500).json({error:e.message})}finally{c.close();fs.unlink(req.file.path,()=>{})}
});

app.get('/chatConnet', async(req,res)=>{ try{const c=new MongoClient(MONGODB_URI);await c.connect();const d=await c.db(DB_NAME).collection("conversationLogs").find({}).toArray();await c.close();
  const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Log');ws.columns=[{header:'ID',key:'m'},{header:'Date',key:'d'},{header:'Log',key:'c'}];
  d.forEach(r=>ws.addRow({m:r.memberId||'Guest',d:r.date,c:JSON.stringify(r.conversation)}));
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition","attachment; filename=log.xlsx");
  await wb.xlsx.write(res);res.end();}catch(e){res.status(500).send("Err")} });

// ========== [서버 실행] ==========
(async function initialize() {
  try {
    console.log("🟡 서버 시작...");
    await getTokensFromDB();
    await updateSearchableData(); 
    app.listen(PORT, () => console.log(`🚀 실행 완료: ${PORT}`));
  } catch (err) { console.error("❌ 초기화 오류:", err.message); process.exit(1); }
})();