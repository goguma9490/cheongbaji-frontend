/**
 * getRecommendedPolicies() 빠른 동작 확인용 스크립트.
 * 실행: npx ts-node getRecommendedPolicies.test.ts
 */
import { getRecommendedPolicies, Policy, RecommendationUser } from "./getRecommendedPolicies";

const today = new Date("2026-09-12");

const user: RecommendationUser = {
  age: 27,
  region: "서울",
  income: 2_000_000,
  employment_status: "미취업자",
  interests: ["일자리", "주거"],
};

const policies: Policy[] = [
  {
    policy_id: "P1",
    title: "서울 청년 구직활동 지원금 (완전 부합, 임박, 관심사 일치)",
    category: "일자리",
    min_age: 19,
    max_age: 34,
    target_region: "서울",
    max_income: 3_000_000,
    target_employment: "미취업자",
    support_amount: 3_000_000,
    deadline: "2026-09-15", // 오늘로부터 3일 후 -> 가장 임박
  },
  {
    policy_id: "P2",
    title: "전국 청년 월세 지원 (지원금 낮음, 마감 여유, 관심사 일치)",
    category: "주거",
    min_age: 19,
    max_age: 39,
    target_region: "전국",
    max_income: null,
    target_employment: null,
    support_amount: 1_200_000,
    deadline: "2026-12-31", // 여유 있음
  },
  {
    policy_id: "P3",
    title: "인천 청년 문화 바우처 (관심사 불일치, 지원금 최고, 상시모집)",
    category: "문화",
    min_age: 19,
    max_age: 34,
    target_region: "전국",
    max_income: null,
    target_employment: null,
    support_amount: 5_000_000,
    deadline: null, // 상시모집
  },
  {
    policy_id: "P4-FILTERED-AGE",
    title: "40세 이상 대상 (나이 조건 탈락)",
    category: "일자리",
    min_age: 40,
    max_age: 60,
    target_region: "전국",
    max_income: null,
    target_employment: null,
    support_amount: 9_000_000,
    deadline: "2026-09-13",
  },
  {
    policy_id: "P5-FILTERED-REGION",
    title: "부산 전용 (지역 조건 탈락)",
    category: "일자리",
    min_age: 19,
    max_age: 39,
    target_region: "부산",
    max_income: null,
    target_employment: null,
    support_amount: 9_000_000,
    deadline: "2026-09-13",
  },
  {
    policy_id: "P6-FILTERED-INCOME",
    title: "저소득 전용 (소득 조건 탈락)",
    category: "일자리",
    min_age: 19,
    max_age: 39,
    target_region: "전국",
    max_income: 1_000_000,
    target_employment: null,
    support_amount: 9_000_000,
    deadline: "2026-09-13",
  },
  {
    policy_id: "P7-FILTERED-EMPLOYMENT",
    title: "재직자 전용 (고용상태 조건 탈락)",
    category: "일자리",
    min_age: 19,
    max_age: 39,
    target_region: "전국",
    max_income: null,
    target_employment: "재직자",
    support_amount: 9_000_000,
    deadline: "2026-09-13",
  },
];

const result = getRecommendedPolicies(user, policies, today);

console.log("=== 추천 결과 ===");
for (const r of result) {
  console.log(
    `${r.rank_order}위  ${r.policy_id}  total=${r.total_score}  ` +
      `(지원금=${r.score_breakdown.support_score.toFixed(1)}, ` +
      `마감=${r.score_breakdown.deadline_score.toFixed(1)}, ` +
      `관심도=${r.score_breakdown.interest_score.toFixed(1)})  ` +
      r.title
  );
}

// --- 검증 ---
const ids = result.map((r) => r.policy_id);
console.assert(
  !ids.some((id) => id.startsWith("P4") || id.startsWith("P5") || id.startsWith("P6") || id.startsWith("P7")),
  "❌ Hard Filtering에서 걸러져야 할 정책이 결과에 포함됨"
);
console.assert(ids.length === 3, `❌ 통과해야 할 정책 수가 다름 (received ${ids.length})`);
console.assert(result[0].policy_id === "P1", "❌ 1위가 P1이 아님 (지원금+마감+관심도 모두 유리해야 함)");
console.assert(
  result.every((r) => r.total_score >= 0 && r.total_score <= 100),
  "❌ total_score가 0~100 범위를 벗어남"
);
console.assert(
  result.every((r, i) => i === 0 || result[i - 1].total_score >= r.total_score),
  "❌ 내림차순 정렬이 깨짐"
);
console.assert(
  result.every((r, i) => r.rank_order === i + 1),
  "❌ rank_order가 1부터 순차적으로 부여되지 않음"
);

console.log("\n모든 assertion 통과 시 위에 에러 로그가 없어야 합니다. ✅");
