// fine_tuning_transform.js
const fs = require("fs");
const path = require("path");

const inputFilePath = path.join(__dirname, "json", "companyData.json");
const outputFilePath = path.join(__dirname, "fine_tuning_data.jsonl");

console.log("Input file path:", inputFilePath);
console.log("Output file path:", outputFilePath);

const rawData = JSON.parse(fs.readFileSync(inputFilePath, "utf-8"));

// 입력 데이터가 잘 불러와졌는지 확인 (예: 데이터 개수, 카테고리 이름 등)
console.log("Loaded data keys:", Object.keys(rawData));

const output = [];

// 각 카테고리별 데이터 순회
for (const category in rawData) {
  const items = rawData[category];
  for (const question in items) {
    let answer = items[question].answer || items[question].description || "";
    let additionalInfo = "";
    if (items[question].videoUrl) {
      additionalInfo += ` [Video URL: ${items[question].videoUrl}]`;
    }
    if (items[question].imageUrl) {
      additionalInfo += ` [Image URL: ${items[question].imageUrl}]`;
    }

    const prompt = `[${category}] ${question}`;
    const completion = `${answer}${additionalInfo}`;

    output.push({
      prompt,
      completion,
    });
  }
}

// 변환 결과 확인
console.log("Total prompt-completion pairs:", output.length);

fs.writeFileSync(
  outputFilePath,
  output.map((item) => JSON.stringify(item)).join("\n")
);
console.log("JSONL 파일이 생성되었습니다:", outputFilePath);
