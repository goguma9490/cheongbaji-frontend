/**
 * 청바지(청년혜택은 바로 지금) - 정책 추천 알고리즘
 * 기말발표 보고서 3장에 명시된 추천 프로세스 구현:
 *   1차 Hard Filtering -> 2차 가중치 스코어링(100점 만점) -> 3차 정렬/랭킹
 *
 * 순수 함수로 작성되어 외부 I/O(DB 조회, API 호출 등)를 전혀 하지 않습니다.
 * user / policies는 이미 조회되어 메모리에 있는 배열이라고 가정합니다.
 *
 * ------------------------------------------------------------------
 * ※ 필드명 관련 안내
 * ------------------------------------------------------------------
 * Hard Filtering 4개 조건(min_age/max_age, target_region, max_income,
 * target_employment)은 문제에 명시된 필드명을 그대로 썼습니다.
 *
 * 2차 스코어링 중 "지원금"과 "마감(D-day)"에 쓰이는 실제 컬럼명은 이번 요청에
 * 명시되지 않아서, 아래 Policy 인터페이스에 `support_amount`(지원금, 원 단위)와
 * `deadline`(마감일, 'YYYY-MM-DD')이라는 이름으로 가정해두었습니다.
 * 실제 Policy 테이블/타입의 필드명이 다르면 Policy 인터페이스와
 * computeSupportScores() / computeDeadlineScores() 두 곳만 고치면 됩니다.
 * (예: collect_policies.py 파이프라인의 Policy.apply_end_date를 마감일로 쓴다면
 *  deadline 대신 apply_end_date를 참조하도록 바꿔주세요.)
 */

// ============================================================
// 타입 정의
// ============================================================

export interface RecommendationUser {
  age: number;
  region: string;
  income: number; // 월 소득 (원)
  employment_status: string;
  interests: string[]; // policy.category와 매칭되는 관심 카테고리 목록
}

export interface PolicyDocument {
  document_name: string;
  is_required?: boolean;
}

export interface Policy {
  policy_id: string;
  title: string;
  category: string;

  // --- 1차 Hard Filtering에 사용되는 필드 ---
  min_age: number | null;
  max_age: number | null;
  target_region: string | null; // '전국' 이거나 특정 지역명(예: '서울', '인천')
  max_income: number | null;
  target_employment: string | null; // 예: '재직자', '미취업자' 등. null이면 제한 없음

  // --- 2차 가중치 스코어링에 사용되는 필드 ---
  support_amount: number | null; // 지원금(원). 정액이 아닌 정책은 null 또는 0
  deadline: string | null; // 마감일 'YYYY-MM-DD'. 상시모집 등 마감일이 없으면 null

  documents?: PolicyDocument[]; // 제출 서류 목록 (DB에서 함께 조회해온 것)
}

export interface RecommendedPolicy extends Policy {
  total_score: number; // 0~100, 반올림된 최종 점수
  rank_order: number; // 1부터 시작하는 순위
  score_breakdown: {
    support_score: number; // 지원금 점수 (가중치 0.4 적용된 값, 0~40)
    deadline_score: number; // 마감 임박 점수 (가중치 0.3 적용된 값, 0~30)
    interest_score: number; // 관심도 일치 점수 (가중치 0.3 적용된 값, 0 또는 30)
  };
}

// ============================================================
// 1차 Hard Filtering
// ============================================================

function passesHardFilter(user: RecommendationUser, policy: Policy): boolean {
  const ageOk =
    (policy.min_age == null || user.age >= policy.min_age) &&
    (policy.max_age == null || user.age <= policy.max_age);

  const regionOk =
    policy.target_region == null ||
    policy.target_region === "전국" ||
    policy.target_region === user.region;

  const incomeOk = policy.max_income == null || user.income <= policy.max_income;

  const employmentOk =
    policy.target_employment == null ||
    policy.target_employment === user.employment_status;

  return ageOk && regionOk && incomeOk && employmentOk;
}

// ============================================================
// 2차 가중치 스코어링
// ============================================================

/** 오늘 날짜 기준 자정으로 시각을 맞춘다 (시/분/초 차이로 D-day가 흔들리지 않도록). */
function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 'YYYY-MM-DD' 마감일 -> 오늘 기준 D-day(정수, 남은 일수). 마감일이 없으면 null. */
function getDday(deadline: string | null, today: Date): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split("-").map(Number);
  if (!y || !m || !d) return null;
  const end = new Date(y, m - 1, d);
  const diffMs = end.getTime() - atMidnight(today).getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * 지원금 점수(0~100, 가중치 0.4 적용 전 단계는 별도 계산 후 곱함):
 * "전체 통과 정책 중 최대 지원금 대비 비율" -> (policy 지원금 / 통과 정책 중 최대 지원금) * 100
 * 지원금 정보가 없는(null) 정책은 0원으로 취급한다. 통과 정책 전체의 지원금이 0/null이면
 * 비교 기준이 없으므로 전부 0점 처리한다.
 */
function computeSupportScores(passedPolicies: Policy[]): Map<string, number> {
  const maxAmount = passedPolicies.reduce(
    (max, p) => Math.max(max, p.support_amount ?? 0),
    0
  );

  const scores = new Map<string, number>();
  for (const p of passedPolicies) {
    const amount = p.support_amount ?? 0;
    const score = maxAmount === 0 ? 0 : (amount / maxAmount) * 100;
    scores.set(p.policy_id, score);
  }
  return scores;
}

/**
 * 마감 임박 점수(0~100): D-day가 가장 작은(=가장 임박한) 정책이 100점,
 * 가장 큰(=가장 여유있는) 정책이 0점이 되도록 통과 정책들 사이에서 선형 정규화한다.
 * ("가까울수록 높은 점수"라는 조건만 명시되어 있어, 통과 집합 내 상대 비교 방식을
 *  지원금 점수와 동일한 방식으로 적용했다.)
 * 마감일이 없는 정책(상시모집 등)은 긴급도가 없다고 보아 0점 처리한다.
 * 이미 마감일이 지난 경우(D-day 음수)는 가장 긴급한 값으로 취급되어 자연스럽게
 * 100점 쪽에 가깝게 계산된다.
 */
function computeDeadlineScores(passedPolicies: Policy[], today: Date): Map<string, number> {
  const ddayEntries = passedPolicies.map((p) => ({
    policy_id: p.policy_id,
    dday: getDday(p.deadline, today),
  }));

  const knownDdays = ddayEntries
    .map((e) => e.dday)
    .filter((v): v is number => v !== null);

  const scores = new Map<string, number>();

  if (knownDdays.length === 0) {
    ddayEntries.forEach((e) => scores.set(e.policy_id, 0));
    return scores;
  }

  const minDday = Math.min(...knownDdays);
  const maxDday = Math.max(...knownDdays);
  const range = maxDday - minDday;

  for (const { policy_id, dday } of ddayEntries) {
    if (dday === null) {
      scores.set(policy_id, 0);
      continue;
    }
    const score = range === 0 ? 100 : ((maxDday - dday) / range) * 100;
    scores.set(policy_id, score);
  }

  return scores;
}

/** 관심도 일치 점수: user.interests에 policy.category가 포함되면 100점, 아니면 0점. */
function computeInterestScore(user: RecommendationUser, policy: Policy): number {
  return user.interests.includes(policy.category) ? 100 : 0;
}

// ============================================================
// 메인 함수
// ============================================================

/**
 * 사용자 조건에 맞는 정책을 1차 필터링 -> 2차 스코어링 -> 3차 정렬/랭킹 순으로
 * 추천 리스트를 만들어 반환한다.
 *
 * @param user     추천 대상 사용자 정보
 * @param policies DB에서 조회해온 정책(+ 제출서류) 배열
 * @param today    기준 날짜 (테스트 용이성을 위해 주입 가능, 기본값은 현재 시각)
 */
export function getRecommendedPolicies(
  user: RecommendationUser,
  policies: Policy[],
  today: Date = new Date()
): RecommendedPolicy[] {
  // 1차: Hard Filtering
  const passed = policies.filter((policy) => passesHardFilter(user, policy));
  if (passed.length === 0) {
    return [];
  }

  // 2차: 가중치 스코어링 (100점 만점)
  const supportScores = computeSupportScores(passed);
  const deadlineScores = computeDeadlineScores(passed, today);

  const scored: RecommendedPolicy[] = passed.map((policy) => {
    const supportScoreRaw = supportScores.get(policy.policy_id) ?? 0;
    const deadlineScoreRaw = deadlineScores.get(policy.policy_id) ?? 0;
    const interestScoreRaw = computeInterestScore(user, policy);

    const support_score = supportScoreRaw * 0.4;
    const deadline_score = deadlineScoreRaw * 0.3;
    const interest_score = interestScoreRaw * 0.3;

    const total_score = Math.round(support_score + deadline_score + interest_score);

    return {
      ...policy,
      total_score,
      rank_order: 0, // 정렬 후 채움
      score_breakdown: { support_score, deadline_score, interest_score },
    };
  });

  // 3차: 정렬 및 랭킹 (total_score 내림차순)
  scored.sort((a, b) => b.total_score - a.total_score);
  scored.forEach((policy, idx) => {
    policy.rank_order = idx + 1;
  });

  return scored;
}
