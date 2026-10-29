'use client';

import { useMemo, useState } from 'react';
import {
  Sparkles,
  MapPin,
  Wallet,
  Briefcase,
  Heart,
  Search,
  SlidersHorizontal,
  Filter,
  Clock,
  Award,
  X,
  ExternalLink,
  ChevronRight,
  CircleCheck,
  Circle,
  Home,
  Landmark,
  GraduationCap,
  Palette,
  Sparkle,
} from 'lucide-react';

/* ============================================================
 * 1. 타입 정의
 * ------------------------------------------------------------
 * getRecommendedPolicies.ts 에서 정의한 타입/알고리즘과 동일한 구조입니다.
 * 실제 연동 시에는 이 파일의 타입 정의와 아래 알고리즘 함수들을
 * '../lib/getRecommendedPolicies' 같은 공용 모듈에서 import 해서 쓰고,
 * 이 파일에서는 지우는 걸 추천합니다 (지금은 브라우저에서 바로 테스트할 수 있도록
 * 한 파일 안에 전부 포함시켰습니다).
 * ============================================================ */

interface RecommendationUser {
  age: number;
  region: string;
  income: number; // 월 소득 (원)
  employment_status: string;
  interests: string[];
}

interface PolicyDocument {
  document_name: string;
  is_required?: boolean;
}

interface Policy {
  policy_id: string;
  title: string;
  category: string;
  organization: string;
  description: string; // 정책 설명
  support_content: string; // 지원 내용 요약 (상세 모달용)

  // 1차 Hard Filtering 필드
  min_age: number | null;
  max_age: number | null;
  target_region: string | null; // '전국' 또는 특정 지역명
  max_income: number | null; // 월 소득 상한 (원)
  target_employment: string | null; // null이면 고용상태 무관

  // 2차 스코어링 필드
  support_amount: number | null; // 지원금 (원)
  deadline: string | null; // 'YYYY-MM-DD', 상시모집이면 null

  source_url: string;
  documents: PolicyDocument[];
}

interface RecommendedPolicy extends Policy {
  total_score: number;
  rank_order: number;
  score_breakdown: {
    support_score: number;
    deadline_score: number;
    interest_score: number;
  };
}

/* ============================================================
 * 2. 추천 알고리즘 (getRecommendedPolicies.ts 와 동일한 로직)
 * ============================================================ */

function passesHardFilter(user: RecommendationUser, policy: Policy): boolean {
  const ageOk =
    (policy.min_age == null || user.age >= policy.min_age) &&
    (policy.max_age == null || user.age <= policy.max_age);

  const regionOk =
    policy.target_region == null ||
    policy.target_region === '전국' ||
    policy.target_region === user.region;

  const incomeOk = policy.max_income == null || user.income <= policy.max_income;

  const employmentOk =
    policy.target_employment == null || policy.target_employment === user.employment_status;

  return ageOk && regionOk && incomeOk && employmentOk;
}

function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getDday(deadline: string | null, today: Date): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split('-').map(Number);
  if (!y || !m || !d) return null;
  const end = new Date(y, m - 1, d);
  const diffMs = end.getTime() - atMidnight(today).getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function computeSupportScores(passed: Policy[]): Map<string, number> {
  const maxAmount = passed.reduce((max, p) => Math.max(max, p.support_amount ?? 0), 0);
  const scores = new Map<string, number>();
  for (const p of passed) {
    const amount = p.support_amount ?? 0;
    scores.set(p.policy_id, maxAmount === 0 ? 0 : (amount / maxAmount) * 100);
  }
  return scores;
}

function computeDeadlineScores(passed: Policy[], today: Date): Map<string, number> {
  const entries = passed.map((p) => ({ id: p.policy_id, dday: getDday(p.deadline, today) }));
  const known = entries.map((e) => e.dday).filter((v): v is number => v !== null);
  const scores = new Map<string, number>();

  if (known.length === 0) {
    entries.forEach((e) => scores.set(e.id, 0));
    return scores;
  }

  const minDday = Math.min(...known);
  const maxDday = Math.max(...known);
  const range = maxDday - minDday;

  for (const { id, dday } of entries) {
    if (dday === null) {
      scores.set(id, 0);
      continue;
    }
    scores.set(id, range === 0 ? 100 : ((maxDday - dday) / range) * 100);
  }
  return scores;
}

function computeInterestScore(user: RecommendationUser, policy: Policy): number {
  return user.interests.includes(policy.category) ? 100 : 0;
}

function getRecommendedPolicies(
  user: RecommendationUser,
  policies: Policy[],
  today: Date = new Date()
): RecommendedPolicy[] {
  const passed = policies.filter((p) => passesHardFilter(user, p));
  if (passed.length === 0) return [];

  const supportScores = computeSupportScores(passed);
  const deadlineScores = computeDeadlineScores(passed, today);

  const scored: RecommendedPolicy[] = passed.map((policy) => {
    const support_score = (supportScores.get(policy.policy_id) ?? 0) * 0.4;
    const deadline_score = (deadlineScores.get(policy.policy_id) ?? 0) * 0.3;
    const interest_score = computeInterestScore(user, policy) * 0.3;
    const total_score = Math.round(support_score + deadline_score + interest_score);

    return {
      ...policy,
      total_score,
      rank_order: 0,
      score_breakdown: { support_score, deadline_score, interest_score },
    };
  });

  scored.sort((a, b) => b.total_score - a.total_score);
  scored.forEach((p, idx) => {
    p.rank_order = idx + 1;
  });

  return scored;
}

/* ============================================================
 * 3. 더미 정책 데이터 (Step 1) - 오늘 날짜 기준 상대적인 마감일로 생성
 * ============================================================ */

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildDummyPolicies(): Policy[] {
  const today = new Date();

  return [
    {
      policy_id: 'seoul-wolse',
      title: '서울 청년 월세 지원',
      category: '주거',
      organization: '서울특별시',
      description: '서울에 거주하는 무주택 청년의 주거비 부담을 덜어주기 위한 월세 지원 사업입니다.',
      support_content: '매월 20만원씩 최대 12개월(총 240만원) 월세 지원',
      min_age: 19,
      max_age: 39,
      target_region: '서울',
      max_income: 3_000_000,
      target_employment: null,
      support_amount: 2_400_000,
      deadline: addDays(today, 6),
      source_url: 'https://youth.seoul.go.kr',
      documents: [
        { document_name: '임대차계약서 사본', is_required: true },
        { document_name: '주민등록등본', is_required: true },
        { document_name: '소득금액증명원', is_required: true },
        { document_name: '통장사본', is_required: false },
      ],
    },
    {
      policy_id: 'ontong-jikchum',
      title: '청년내일채움공제',
      category: '일자리',
      organization: '고용노동부',
      description: '중소기업에 재직 중인 청년의 장기근속과 자산형성을 지원하는 사업입니다.',
      support_content: '2년간 본인 400만원 + 기업·정부 지원금 적립, 만기 시 최대 1,600만원 수령',
      min_age: 19,
      max_age: 34,
      target_region: '전국',
      max_income: null,
      target_employment: '재직자',
      support_amount: 16_000_000,
      deadline: null, // 상시모집
      source_url: 'https://www.youthcenter.go.kr',
      documents: [
        { document_name: '재직증명서', is_required: true },
        { document_name: '고용보험 가입이력 확인서', is_required: true },
      ],
    },
    {
      policy_id: 'ontong-gujik',
      title: '청년 구직활동지원금',
      category: '일자리',
      organization: '고용노동부',
      description: '미취업 청년의 구직활동에 필요한 비용을 지원하는 사업입니다.',
      support_content: '월 50만원씩 최대 6개월(총 300만원) 지원',
      min_age: 19,
      max_age: 34,
      target_region: '전국',
      max_income: 2_500_000,
      target_employment: '미취업자',
      support_amount: 3_000_000,
      deadline: addDays(today, 12),
      source_url: 'https://www.work24.go.kr',
      documents: [
        { document_name: '신분증 사본', is_required: true },
        { document_name: '졸업증명서 또는 재학증명서', is_required: true },
        { document_name: '구직활동계획서', is_required: true },
      ],
    },
    {
      policy_id: 'incheon-jasan',
      title: '인천 청년 저축계좌',
      category: '금융',
      organization: '인천광역시',
      description: '인천 거주 청년의 사회 출발 자산 형성을 지원하는 매칭 저축 상품입니다.',
      support_content: '매월 10만원 저축 시 인천시가 10만원 매칭 지원 (3년 만기 시 최대 720만원)',
      min_age: 18,
      max_age: 39,
      target_region: '인천',
      max_income: 2_800_000,
      target_employment: null,
      support_amount: 6_000_000,
      deadline: addDays(today, 20),
      source_url: 'https://youth.incheon.go.kr',
      documents: [
        { document_name: '주민등록등본', is_required: true },
        { document_name: '가족관계증명서', is_required: true },
        { document_name: '통장사본', is_required: true },
      ],
    },
    {
      policy_id: 'gg-culture',
      title: '경기 청년 문화패스',
      category: '문화',
      organization: '경기도',
      description: '경기도 거주 청년에게 공연, 전시, 도서 구매 등에 쓸 수 있는 문화 바우처를 지원합니다.',
      support_content: '1인당 15만원 문화 바우처 지급',
      min_age: 19,
      max_age: 34,
      target_region: '경기',
      max_income: null,
      target_employment: null,
      support_amount: 150_000,
      deadline: addDays(today, 45),
      source_url: 'https://www.gg.go.kr',
      documents: [{ document_name: '주민등록등본', is_required: true }],
    },
    {
      policy_id: 'ontong-edu',
      title: '청년 취업역량강화 교육',
      category: '교육',
      organization: '한국고용정보원',
      description: '미취업 청년 대상 직무 교육 및 취업 컨설팅을 제공하는 프로그램입니다.',
      support_content: '교육비 전액 무료, 수료 시 취업 연계 지원',
      min_age: 19,
      max_age: 29,
      target_region: '전국',
      max_income: null,
      target_employment: '미취업자',
      support_amount: null,
      deadline: addDays(today, 3),
      source_url: 'https://www.youthcenter.go.kr',
      documents: [
        { document_name: '신분증 사본', is_required: true },
        { document_name: '참가신청서', is_required: true },
      ],
    },
  ];
}

const DUMMY_POLICIES = buildDummyPolicies();

const REGION_OPTIONS = ['서울', '인천', '경기', '전국'];
const EMPLOYMENT_OPTIONS = ['미취업자', '재직자', '자영업자', '학생'];
const CATEGORY_OPTIONS = ['일자리', '주거', '금융', '교육', '문화'];

const CATEGORY_ICON: Record<string, typeof Home> = {
  주거: Home,
  일자리: Briefcase,
  금융: Landmark,
  교육: GraduationCap,
  문화: Palette,
};

/* ============================================================
 * 4. 포맷 헬퍼
 * ============================================================ */

function formatWon(amount: number | null): string {
  if (amount == null || amount === 0) return '별도 지원금 없음';
  return `${amount.toLocaleString('ko-KR')}원`;
}

function formatIncomeCondition(maxIncome: number | null): string {
  if (maxIncome == null) return '소득 제한 없음';
  return `월소득 ${maxIncome.toLocaleString('ko-KR')}원 이하`;
}

function getDdayLabel(deadline: string | null, today: Date): { label: string; urgent: boolean } {
  const dday = getDday(deadline, today);
  if (dday === null) return { label: '상시모집', urgent: false };
  if (dday < 0) return { label: '마감', urgent: false };
  if (dday === 0) return { label: 'D-Day', urgent: true };
  return { label: `D-${dday}`, urgent: dday <= 7 };
}

function getEligibilityChips(policy: Policy): string[] {
  const chips: string[] = [];

  if (policy.min_age != null || policy.max_age != null) {
    const min = policy.min_age ?? 0;
    const max = policy.max_age;
    chips.push(max != null ? `만 ${min}~${max}세` : `만 ${min}세 이상`);
  } else {
    chips.push('연령 제한 없음');
  }

  chips.push(policy.target_region ?? '전국');
  chips.push(formatIncomeCondition(policy.max_income));
  chips.push(policy.target_employment ?? '고용상태 무관');

  return chips;
}

/* ============================================================
 * 5. 메인 컴포넌트
 * ============================================================ */

type SortOption = 'score' | 'deadline' | 'amount';

export default function CheongbajiPage() {
  const today = useMemo(() => new Date(), []);

  // 정책 데이터 (Step 1 더미 데이터를 기본 state로 사용, 추후 Supabase 연동 시
  // setPolicies(실제로 조회한 배열) 형태로 교체하면 됩니다)
  const [policies] = useState<Policy[]>(DUMMY_POLICIES);

  // 입력 중인 프로필 (컨트롤된 폼 state)
  const [draftProfile, setDraftProfile] = useState<RecommendationUser>({
    age: 27,
    region: '서울',
    income: 200, // 만원 단위로 입력받음 (아래에서 *10000 하여 사용)
    employment_status: '미취업자',
    interests: ['일자리', '주거'],
  });

  // [맞춤 정책 찾기] 버튼을 눌렀을 때만 갱신되는 "적용된" 프로필
  const [activeProfile, setActiveProfile] = useState<RecommendationUser>({
    ...draftProfile,
    income: draftProfile.income * 10_000,
  });
  const [isSearching, setIsSearching] = useState(false);

  // 결과 대시보드 상태
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  const [sortOption, setSortOption] = useState<SortOption>('score');

  // 상세 모달 상태
  const [selectedPolicy, setSelectedPolicy] = useState<RecommendedPolicy | null>(null);
  const [documentChecks, setDocumentChecks] = useState<Record<string, Set<string>>>({});

  const recommended = useMemo(
    () => getRecommendedPolicies(activeProfile, policies, today),
    [activeProfile, policies, today]
  );

  const displayedResults = useMemo(() => {
    let list = recommended;
    if (categoryFilter.size > 0) {
      list = list.filter((p) => categoryFilter.has(p.category));
    }
    const sorted = [...list];
    if (sortOption === 'score') {
      sorted.sort((a, b) => b.total_score - a.total_score);
    } else if (sortOption === 'deadline') {
      sorted.sort((a, b) => {
        const da = getDday(a.deadline, today);
        const db = getDday(b.deadline, today);
        if (da === null && db === null) return 0;
        if (da === null) return 1; // 상시모집은 뒤로
        if (db === null) return -1;
        return da - db;
      });
    } else if (sortOption === 'amount') {
      sorted.sort((a, b) => (b.support_amount ?? 0) - (a.support_amount ?? 0));
    }
    return sorted;
  }, [recommended, categoryFilter, sortOption, today]);

  // 시너지 추천 카드: 추천 목록 중 가장 순위 높은 '주거' + '일자리' 정책 조합
  const synergyPackage = useMemo(() => {
    const housing = recommended.find((p) => p.category === '주거');
    const job = recommended.find((p) => p.category === '일자리');
    if (!housing || !job) return null;
    return { housing, job, total: (housing.support_amount ?? 0) + (job.support_amount ?? 0) };
  }, [recommended]);

  function handleSearch() {
    setIsSearching(true);
    const normalized: RecommendationUser = {
      ...draftProfile,
      income: draftProfile.income * 10_000,
    };
    // 실제 API 호출이 아니므로 짧은 지연만 주어 "검색 중" 느낌을 살림
    window.setTimeout(() => {
      setActiveProfile(normalized);
      setIsSearching(false);
    }, 300);
  }

  function toggleInterest(category: string) {
    setDraftProfile((prev) => {
      const has = prev.interests.includes(category);
      return {
        ...prev,
        interests: has ? prev.interests.filter((c) => c !== category) : [...prev.interests, category],
      };
    });
  }

  function toggleCategoryFilter(category: string) {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function toggleDocumentCheck(policyId: string, documentName: string) {
    setDocumentChecks((prev) => {
      const current = new Set(prev[policyId] ?? []);
      if (current.has(documentName)) current.delete(documentName);
      else current.add(documentName);
      return { ...prev, [policyId]: current };
    });
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* ============ 상단: 로고 + 시너지 추천 카드 ============ */}
      <header className="bg-gradient-to-br from-indigo-600 to-blue-600 text-white">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-6 w-6" />
            <h1 className="text-xl font-bold sm:text-2xl">청바지: 청년혜택은 바로 지금</h1>
          </div>
          <p className="mt-1 text-sm text-indigo-100">
            내 조건에 딱 맞는 청년 정책을 한 번에 찾아드려요.
          </p>

          {synergyPackage ? (
            <div className="mt-5 rounded-2xl bg-white/10 p-4 backdrop-blur-sm ring-1 ring-white/20 sm:p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-indigo-100">
                <Sparkle className="h-4 w-4" />
                회원님의 이번 달 최적 패키지 ({synergyPackage.housing.category}+{synergyPackage.job.category})
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[synergyPackage.housing, synergyPackage.job].map((p) => (
                  <div key={p.policy_id} className="rounded-xl bg-white/95 p-3 text-slate-900">
                    <p className="text-xs font-medium text-indigo-600">{p.category}</p>
                    <p className="mt-0.5 truncate text-sm font-semibold">{p.title}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatWon(p.support_amount)}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm">
                두 정책을 함께 신청하면 최대{' '}
                <span className="text-base font-bold">{synergyPackage.total.toLocaleString('ko-KR')}원</span>{' '}
                까지 받을 수 있어요.
              </p>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl bg-white/10 p-4 text-sm text-indigo-100 ring-1 ring-white/20">
              프로필을 입력하고 [맞춤 정책 찾기]를 눌러보시면, 함께 받을 수 있는 최적의 정책 조합을 찾아드려요.
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {/* ============ 프로필 입력 영역 ============ */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-900">내 프로필</h2>

          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {/* 나이 */}
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                나이
              </label>
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={14}
                  max={45}
                  value={draftProfile.age}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({ ...prev, age: Number(e.target.value) }))
                  }
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-600"
                />
                <input
                  type="number"
                  value={draftProfile.age}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({ ...prev, age: Number(e.target.value) || 0 }))
                  }
                  className="w-16 shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                />
                <span className="shrink-0 text-sm text-slate-500">세</span>
              </div>
            </div>

            {/* 지역 */}
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <MapPin className="h-4 w-4 text-slate-400" />
                지역
              </label>
              <select
                value={draftProfile.region}
                onChange={(e) => setDraftProfile((prev) => ({ ...prev, region: e.target.value }))}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {REGION_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            {/* 월소득 */}
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <Wallet className="h-4 w-4 text-slate-400" />
                월소득 (만원)
              </label>
              <input
                type="number"
                min={0}
                value={draftProfile.income}
                onChange={(e) =>
                  setDraftProfile((prev) => ({ ...prev, income: Number(e.target.value) || 0 }))
                }
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                placeholder="예: 200"
              />
            </div>

            {/* 취업상태 */}
            <div>
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <Briefcase className="h-4 w-4 text-slate-400" />
                취업상태
              </label>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {EMPLOYMENT_OPTIONS.map((opt) => {
                  const active = draftProfile.employment_status === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setDraftProfile((prev) => ({ ...prev, employment_status: opt }))}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                        active
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 관심 분야 */}
          <div className="mt-5">
            <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
              <Heart className="h-4 w-4 text-slate-400" />
              관심 분야 (복수 선택)
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((category) => {
                const checked = draftProfile.interests.includes(category);
                const Icon = CATEGORY_ICON[category] ?? Heart;
                return (
                  <label
                    key={category}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition ${
                      checked
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                        : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleInterest(category)}
                      className="hidden"
                    />
                    <Icon className="h-3.5 w-3.5" />
                    {category}
                  </label>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={handleSearch}
            disabled={isSearching}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60 sm:w-auto"
          >
            <Search className="h-4 w-4" />
            {isSearching ? '찾는 중...' : '맞춤 정책 찾기'}
          </button>
        </section>

        {/* ============ 결과 대시보드 ============ */}
        <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          {/* 좌측: 필터 */}
          <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Filter className="h-4 w-4 text-slate-400" />
              관심 분야 필터
            </div>
            <div className="mt-3 space-y-2">
              {CATEGORY_OPTIONS.map((category) => {
                const checked = categoryFilter.has(category);
                return (
                  <label key={category} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCategoryFilter(category)}
                      className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                    />
                    {category}
                  </label>
                );
              })}
            </div>
            {categoryFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setCategoryFilter(new Set())}
                className="mt-3 text-xs font-medium text-indigo-600 hover:underline"
              >
                필터 초기화
              </button>
            )}

            <div className="mt-6 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <SlidersHorizontal className="h-4 w-4 text-slate-400" />
              정렬
            </div>
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as SortOption)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="score">적합도 순</option>
              <option value="deadline">마감임박 순</option>
              <option value="amount">지원금 순</option>
            </select>
          </aside>

          {/* 우측: 추천 카드 리스트 */}
          {/* ⚠️ min-w-0 추가: grid의 1fr 칸은 기본 min-width:auto라서, 안의 긴(끊김 없는) 텍스트가
              칸 폭을 강제로 늘려 레이아웃 전체가 깨지는 문제가 있었음 (상세보기 버튼이 화면 밖으로 밀려남) */}
          <div className="min-w-0">
            <p className="mb-3 text-sm text-slate-500">
              총 <span className="font-semibold text-slate-900">{displayedResults.length}개</span>의 맞춤 정책을 찾았어요.
            </p>

            {displayedResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
                조건에 맞는 정책이 없어요. 프로필을 조정하고 다시 찾아보세요.
              </div>
            ) : (
              <div className="space-y-3">
                {displayedResults.map((policy) => {
                  const dday = getDdayLabel(policy.deadline, today);
                  return (
                    <div
                      key={policy.policy_id}
                      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md sm:p-5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-indigo-600 px-2 text-xs font-bold text-white">
                          {policy.rank_order}위
                        </span>
                        <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          <Award className="h-3 w-3" />
                          적합도 {policy.total_score}점
                        </span>
                        <span
                          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                            dday.urgent ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          <Clock className="h-3 w-3" />
                          {dday.label}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                          {policy.category}
                        </span>
                      </div>

                      <h3 className="mt-2 text-base font-semibold text-slate-900">{policy.title}</h3>
                      {/* ⚠️ break-words 추가: 끊김 없는 긴 URL/안내문도 카드 폭 안에서 줄바꿈되도록 함 */}
                      <p className="mt-1 line-clamp-2 break-words text-sm text-slate-500">{policy.description}</p>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-medium text-indigo-600">{formatWon(policy.support_amount)}</p>
                        <button
                          type="button"
                          onClick={() => setSelectedPolicy(policy)}
                          className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                        >
                          상세보기
                          <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* ============ 상세 조회 모달 ============ */}
      {selectedPolicy && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
          onClick={() => setSelectedPolicy(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-600">
                  {selectedPolicy.category}
                </span>
                <h3 className="mt-2 text-lg font-bold text-slate-900">{selectedPolicy.title}</h3>
                <p className="text-sm text-slate-500">{selectedPolicy.organization}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPolicy(null)}
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="닫기"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-sm">
              <div>
                <p className="font-semibold text-slate-900">지원 내용</p>
                {/* ⚠️ break-words 추가: 모달 안 긴 안내문도 고정폭 안에서 줄바꿈되도록 함 */}
                <p className="mt-1 break-words text-slate-600">{selectedPolicy.support_content}</p>
              </div>

              <div>
                <p className="font-semibold text-slate-900">신청 자격</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {getEligibilityChips(selectedPolicy).map((chip) => (
                    <span key={chip} className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">
                      {chip}
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <p className="font-semibold text-slate-900">필수 제출 서류</p>
                <ul className="mt-1.5 space-y-1.5">
                  {selectedPolicy.documents.map((doc) => {
                    const checkedSet = documentChecks[selectedPolicy.policy_id];
                    const done = checkedSet ? checkedSet.has(doc.document_name) : false;
                    return (
                      <li key={doc.document_name}>
                        <button
                          type="button"
                          onClick={() => toggleDocumentCheck(selectedPolicy.policy_id, doc.document_name)}
                          className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:bg-slate-50"
                        >
                          {done ? (
                            <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-slate-300" />
                          )}
                          <span className={`break-words ${done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                            {doc.document_name}
                          </span>
                          {doc.is_required === false && (
                            <span className="ml-auto shrink-0 text-xs text-slate-400">선택</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>

            <a
              href={selectedPolicy.source_url}
              target="_blank"
              rel="noreferrer"
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700"
            >
              공식 사이트에서 신청하기
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}