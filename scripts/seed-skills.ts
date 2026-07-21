/**
 * Seed sample skills. Existing skills with the same name are left untouched,
 * so local edits survive re-runs.
 *
 *   pnpm tsx --env-file=.env.local scripts/seed-skills.ts
 */
process.env.STAGE ??= "local";

interface SampleSkill {
  name: string;
  description: string;
  content: string;
}

const SAMPLE_SKILLS: SampleSkill[] = [
  {
    name: "conversation",
    description: "Natural, helpful conversation style for Korean users",
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
    description: "Craft detailed image generation prompts from user ideas",
    content: `# 이미지 생성 프롬프트 스킬

사용자의 아이디어를 이미지 생성 모델이 잘 이해하는 프롬프트로 다듬는 지침이에요.
직접 이미지를 만드는 대신, 바로 사용할 수 있는 완성된 프롬프트를 산출물로 제공해요.

## 프롬프트 구성 요소
좋은 이미지 프롬프트는 다음 순서로 구성해요:
1. **주제** — 무엇을 그릴지 한 문장으로 명확하게 (인물, 사물, 장면)
2. **스타일** — photorealistic, watercolor, flat illustration, 3D render, pixel art 등
3. **구도** — close-up, wide shot, bird's eye view, rule of thirds 등
4. **조명과 분위기** — golden hour, soft studio lighting, neon, moody 등
5. **품질 키워드** — highly detailed, sharp focus, 8k 등 (2~3개면 충분해요)

## 작성 규칙
- 최종 프롬프트는 **영어**로 작성해요 (대부분의 이미지 모델이 영어에 최적화).
- 쉼표로 구분된 구문 나열보다 자연스러운 문장 1~2개 + 스타일 키워드가 좋아요.
- 피해야 할 요소가 있으면 negative prompt를 별도로 정리해요.
- 사람 얼굴, 브랜드 로고, 실존 인물 묘사 요청은 정책에 어긋날 수 있음을 안내해요.

## 산출물 형식
\`\`\`
Prompt: <영어 프롬프트>
Negative prompt: <선택, 영어>
권장 비율: <1:1 | 16:9 | 9:16 등>
\`\`\`
프롬프트 아래에 어떤 선택을 왜 했는지 한두 문장으로 설명해요.`,
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
