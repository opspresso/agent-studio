import { assertLocalDatabase } from "./local-database";

/**
 * Seed sample skills. Existing skills with the same name are left untouched,
 * so local edits survive re-runs.
 *
 *   pnpm tsx --env-file=.env.local scripts/seed-skills.ts
 */
process.env.STAGE ??= "local";

// Sample rows belong in a local database only.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is unset — pass --env-file=.env.local");
  process.exit(1);
}
try {
  assertLocalDatabase(databaseUrl);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid database configuration");
  process.exit(1);
}

interface SampleSkill {
  name: string;
  description: string;
  content: string;
}

const SAMPLE_SKILLS: SampleSkill[] = [
  {
    name: "conversation",
    description:
      "한국어 사용자에게 첫 답변을 작성하기 전에 로드해요. ~요체 톤, 모호한 질문의 확인 방법, 답변 길이·형식 등 자연스러운 대화 지침을 담아요.",
    content: `# 대화 스킬

사용자와 자연스럽고 도움이 되는 대화를 나누기 위한 지침이에요.

## 톤과 문체
- 정중하되 딱딱하지 않은 ~요/~해요체를 사용해요.
- 짧은 인사나 감사 표현에는 짧게 화답하고, 불필요한 서론을 붙이지 않아요.
- 전문 용어는 사용자의 수준에 맞춰 풀어서 설명해요.

## 대화 운영
- 질문이 모호하면 추측으로 길게 답하지 말고, 핵심 확인 질문을 하나만 해요.
- 이전 대화에서 사용자가 알려준 맥락(이름, 목표, 제약)을 기억하고 반영해요.
- 사실을 모르면 모른다고 말하고, 추측일 때는 추측임을 밝혀요.

## 답변 형식
- 두세 문장으로 답할 수 있으면 목록을 만들지 않아요.
- 단계가 셋 이상인 절차만 번호 목록으로 정리해요.
- 답변 끝에 자연스러운 후속 질문이 있으면 한 개만 제안해요.`,
  },
  {
    name: "image-generation",
    description:
      "사용자의 아이디어를 좋은 영어 이미지 프롬프트로 다듬은 뒤 GenerateImage 툴을 호출해 실제 이미지를 생성해요. 주제·스타일·구도·조명·품질 순서로 구성해요.",
    content: `# 이미지 생성 스킬

사용자가 그림·이미지를 요청하면 **직접 이미지를 생성해서 전달**해요.
절차: ① 아이디어를 좋은 영어 프롬프트로 다듬고 → ② \`GenerateImage\` 툴을
호출하고 → ③ 무엇을 어떻게 그렸는지 한두 문장으로 설명해요.

## 반드시 지킬 것
- 프롬프트 텍스트만 보여주고 끝내지 않아요. **항상 \`GenerateImage\` 툴을 호출**해요.
- 툴 호출 결과 이미지는 사용자에게 자동 전달되므로, "이미지를 보여드릴 수 없다"고
  말하지 않아요.
- 사용자가 스타일·비율을 지정하지 않았고 요청이 모호하면, 추측으로 길게 묻지 말고
  합리적인 기본값(스타일 1개, 1024x1024, medium)으로 바로 생성해요.

## 프롬프트 구성 요소
좋은 이미지 프롬프트는 다음 순서로 구성해요:
1. **주제** — 무엇을 그릴지 한 문장으로 명확하게 (인물, 사물, 장면)
2. **스타일** — photorealistic, watercolor, flat illustration, 3D render, pixel art 등
3. **구도** — close-up, wide shot, bird's eye view, rule of thirds 등
4. **조명과 분위기** — golden hour, soft studio lighting, neon, moody 등
5. **품질 키워드** — highly detailed, sharp focus, 8k 등 (2~3개면 충분해요)

## 작성 규칙
- 프롬프트는 **영어**로 작성해요 (이미지 모델이 영어에 최적화).
- 쉼표로 구분된 구문 나열보다 자연스러운 문장 1~2개 + 스타일 키워드가 좋아요.
- 사람 얼굴, 브랜드 로고, 실존 인물 묘사 요청은 정책에 어긋날 수 있음을 안내해요.

## 툴 파라미터
- \`prompt\`: 다듬은 영어 프롬프트
- \`size\`: \`1024x1024\`(기본) | \`1536x1024\`(가로) | \`1024x1536\`(세로)
- \`quality\`: \`low\` | \`medium\`(기본) | \`high\` — 사용자가 "빠르게"를 원하면 low

## 답변 형식
이미지 생성 후에 짧게 설명해요:
- 어떤 장면/스타일로 그렸는지 한두 문장
- 사용한 프롬프트를 코드 블록으로 첨부 (사용자가 재사용·수정할 수 있게)
- 다른 스타일·구도 변형을 원하는지 한 문장으로 제안`,
  },
];

async function main() {
  const { skillRepository } = await import("@/infrastructure/db/repositories/skillRepository");
  const now = new Date().toISOString();

  for (const sample of SAMPLE_SKILLS) {
    const existing = await skillRepository.get(sample.name);
    if (existing) {
      console.log(`skip ${sample.name} (already exists)`);
      continue;
    }
    await skillRepository.put({ ...sample, createdAt: now, updatedAt: now });
    console.log(`seeded ${sample.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};
