'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  MapPin,
  Wallet,
  Briefcase,
  Heart,
  Search,
  SlidersHorizontal,
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
  Info,
  Bookmark,
  BookmarkCheck,
  LogIn,
  LogOut,
  Mail,
  Lock,
  Pencil,
  Save,
} from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

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
  target_region: string | null; // 서울/인천/경기 등 특정 지역명 (서비스가 수도권으로 한정되어 '전국'은 쓰지 않음)
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

function passesHardFilter(user: RecommendationUser, policy: Policy, today: Date): boolean {
  const ageOk =
    (policy.min_age == null || user.age >= policy.min_age) &&
    (policy.max_age == null || user.age <= policy.max_age);

  // 서비스가 서울/인천/경기로 한정되므로 '전국' 분류는 더 이상 사용하지 않는다.
  // (target_region이 null인 데이터는 지역 정보 미기재로 간주해 통과시킨다)
  const regionOk = policy.target_region == null || policy.target_region === user.region;

  const incomeOk = policy.max_income == null || user.income <= policy.max_income;

  const employmentOk =
    policy.target_employment == null ||
    policy.target_employment === '전체' ||
    policy.target_employment === user.employment_status;

  // ⚠️ 마감(deadline이 이미 지남) 정책은 더 이상 신청할 수 없으므로 추천 대상에서 제외.
  // (deadline이 null이면 상시모집으로 간주해 통과시킨다)
  const dday = getDday(policy.deadline, today);
  const deadlineOk = dday === null || dday >= 0;

  return ageOk && regionOk && incomeOk && employmentOk && deadlineOk;
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
  const passed = policies.filter((p) => passesHardFilter(user, p, today));
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
      target_region: '경기',
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
      target_region: '서울',
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
      target_region: '인천',
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

/* ============================================================
 * Supabase 실제 데이터 로딩
 * ------------------------------------------------------------
 * policies / policy_documents 테이블에서 실제 수집된 정책을 읽어와
 * Policy 타입으로 매핑한다. 실패하거나 0건이면 더미 데이터를 그대로 쓴다.
 * ============================================================ */

/* ============================================================
 * 카테고리(관심분야) 정규화
 * ------------------------------------------------------------
 * 수집 파이프라인 중 온통청년 API 쪽은 API 자체의 대분류명(lclsfNm 등)을
 * category로 그대로 저장하는데, 이 값이 앱이 쓰는 5개 관심분야(일자리/주거/
 * 금융/교육/문화)와 글자 그대로 일치하지 않으면("복지문화", "참여권리" 등)
 * 관심분야 필터·적합도 매칭에서 해당 정책이 통째로 빠져버린다.
 * DB 값이 이미 5개 카테고리 중 하나와 정확히 일치하면 그대로 쓰고,
 * 그렇지 않으면 제목/설명 텍스트의 키워드로 다시 분류한다.
 * ============================================================ */
const _CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ['주거', ['주택', '전세', '월세', '임차', '보증금', '입주', '주거', '이사']],
  ['일자리', ['취업', '채용', '구직', '일자리', '창업', '인턴', '고용']],
  ['교육', ['교육', '학비', '장학금', '수강', '자격증', '학자금', '강좌']],
  ['금융', ['대출', '이자', '적금', '저축', '보험', '환급', '금융']],
  ['문화', ['문화', '공연', '전시', '여행', '축제', '체육', '예술']],
];

function inferCategoryFromText(text: string): string | null {
  if (!text) return null;
  for (const [category, keywords] of _CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) return category;
  }
  return null;
}

function normalizeCategory(rawCategory: string | null | undefined, ...textParts: Array<string | null | undefined>): string {
  if (rawCategory && CATEGORY_OPTIONS.includes(rawCategory)) return rawCategory;
  const inferred = inferCategoryFromText(textParts.filter(Boolean).join(' '));
  return inferred ?? rawCategory ?? '기타';
}

async function fetchPoliciesFromSupabase(): Promise<Policy[]> {
  const { data: policyRows, error: policyError } = await supabase
    .from('policies')
    .select('*');
  if (policyError) throw policyError;

  const { data: docRows, error: docError } = await supabase
    .from('policy_documents')
    .select('*');
  if (docError) throw docError;

  const docsByPolicy: Record<string, PolicyDocument[]> = {};
  for (const d of docRows ?? []) {
    const list = docsByPolicy[d.policy_id] ?? (docsByPolicy[d.policy_id] = []);
    list.push({ document_name: d.document_name, is_required: d.is_essential ?? true });
  }

  return (policyRows ?? []).map((row: any) => ({
    policy_id: row.policy_id,
    title: row.title,
    category: normalizeCategory(row.category, row.title, row.summary, row.benefit_desc),
    organization: row.institution ?? '기관 정보 없음',
    description: row.summary ?? '',
    support_content: row.benefit_desc ?? row.summary ?? '',
    min_age: row.min_age,
    max_age: row.max_age,
    target_region: row.target_region,
    max_income: row.max_income,
    target_employment: row.target_employment,
    support_amount: row.max_benefit_amount,
    deadline: row.closing_date,
    source_url: row.apply_url,
    documents: docsByPolicy[row.policy_id] ?? [],
  }));
}

/* ============================================================
 * 2-1. 로그인 사용자의 "스크랩/체크리스트" 저장 (user_scrap_checklist 테이블)
 * ------------------------------------------------------------
 * 로그인하지 않은 상태에서는 documentChecks/scrappedIds가 메모리(React state)
 * 에만 있어서 새로고침하면 사라진다. 로그인한 사용자는 Supabase의
 * user_scrap_checklist 테이블(user_id + policy_id 당 1행, RLS로 본인 행만
 * 접근 가능)에 저장해서 기기를 바꾸거나 새로고침해도 유지되게 한다.
 * ============================================================ */

interface ChecklistRow {
  policy_id: string;
  is_scrapped: boolean;
  checked_documents: string[];
}

async function fetchUserChecklist(userId: string): Promise<Record<string, ChecklistRow>> {
  const { data, error } = await supabase
    .from('user_scrap_checklist')
    .select('policy_id, is_scrapped, checked_documents')
    .eq('user_id', userId);
  if (error) {
    console.error('체크리스트를 불러오지 못했습니다:', error);
    return {};
  }
  const map: Record<string, ChecklistRow> = {};
  for (const row of data ?? []) {
    map[row.policy_id] = {
      policy_id: row.policy_id,
      is_scrapped: row.is_scrapped ?? false,
      checked_documents: row.checked_documents ?? [],
    };
  }
  return map;
}

async function upsertUserChecklist(
  userId: string,
  policyId: string,
  patch: Partial<Pick<ChecklistRow, 'is_scrapped' | 'checked_documents'>>
) {
  const { error } = await supabase.from('user_scrap_checklist').upsert(
    {
      user_id: userId,
      policy_id: policyId,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,policy_id' }
  );
  if (error) {
    console.error('체크리스트 저장에 실패했습니다:', error);
  }
}

/* ============================================================
 * 2-2. 로그인 사용자의 "프로필 입력값" 저장 (user_profile 테이블)
 * ------------------------------------------------------------
 * [맞춤 정책 찾기]를 누른 시점의 입력값(나이/지역/소득/취업상태/관심분야)을
 * 저장해서, 로그인 상태로 다시 방문했을 때 입력폼과 검색결과가 그대로
 * 복원되도록 한다. (로그아웃 상태에서는 기존처럼 기본값으로 시작)
 * ============================================================ */

async function fetchUserProfile(userId: string): Promise<RecommendationUser | null> {
  const { data, error } = await supabase
    .from('user_profile')
    .select('age, region, income, employment_status, interests')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('프로필을 불러오지 못했습니다:', error);
    return null;
  }
  if (!data) return null;
  return {
    age: data.age,
    region: data.region,
    income: data.income,
    employment_status: data.employment_status,
    interests: data.interests ?? [],
  };
}

async function saveUserProfile(userId: string, profile: RecommendationUser) {
  const { error } = await supabase.from('user_profile').upsert(
    {
      user_id: userId,
      age: profile.age,
      region: profile.region,
      income: profile.income, // 프로필 입력폼과 동일하게 '만원' 단위로 저장 (activeProfile의 원 단위가 아님)
      employment_status: profile.employment_status,
      interests: profile.interests,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) {
    console.error('프로필 저장에 실패했습니다:', error);
  }
}

const DEFAULT_DRAFT_PROFILE: RecommendationUser = {
  age: 27,
  region: '서울',
  income: 200, // 만원 단위로 입력받음 (활성 프로필에서는 *10000 하여 사용)
  employment_status: '미취업자',
  interests: ['일자리', '주거'],
};

const DUMMY_POLICIES = buildDummyPolicies();

const REGION_OPTIONS = ['서울', '인천', '경기'];
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

/* ⚠️ '지원 내용'(support_content)을 통째로 보여주던 것을, 공고문 원문에서 ○/□/■/◆
 * 불릿이나 줄바꿈으로 나뉘는 첫 번째 항목(보통 '사업 내용'에 해당)만 한눈에 보이는
 * 핵심 요약으로 우선 보여주고, 나머지 전체 내용은 '전체 내용 보기' 토글로 펼쳐 볼 수
 * 있게 한다(정보를 숨기는 게 아니라 기본 노출 분량만 줄이는 것). */
function summarizeSupportContent(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';

  const segments = trimmed
    .split(/\r?\n|(?=[○□■◆])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = segments[0] ?? trimmed;

  const MAX_LEN = 60;
  return first.length > MAX_LEN ? `${first.slice(0, MAX_LEN)}…` : first;
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

  chips.push(policy.target_region ?? '지역 무관');
  chips.push(formatIncomeCondition(policy.max_income));
  chips.push(policy.target_employment ?? '고용상태 무관');

  return chips;
}

/* ============================================================
 * 5. 메인 컴포넌트
 * ============================================================ */

type SortOption = 'score' | 'deadline' | 'amount';
type ViewMode = 'recommended' | 'all';

export default function CheongbajiPage() {
  const today = useMemo(() => new Date(), []);

  // 정책 데이터 (Step 1 더미 데이터를 기본 state로 사용, 추후 Supabase 연동 시
  // setPolicies(실제로 조회한 배열) 형태로 교체하면 됩니다)
  const [policies, setPolicies] = useState<Policy[]>(DUMMY_POLICIES);
  const [dataSource, setDataSource] = useState<'loading' | 'supabase' | 'dummy'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchPoliciesFromSupabase()
      .then((rows) => {
        if (cancelled) return;
        if (rows.length > 0) {
          setPolicies(rows);
          setDataSource('supabase');
        } else {
          setDataSource('dummy');
        }
      })
      .catch((err) => {
        console.error('Supabase 정책 데이터를 불러오지 못했습니다:', err);
        if (!cancelled) setDataSource('dummy');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 입력 중인 프로필 (컨트롤된 폼 state)
  const [draftProfile, setDraftProfile] = useState<RecommendationUser>(DEFAULT_DRAFT_PROFILE);

  // [맞춤 정책 찾기] 버튼을 눌렀을 때만 갱신되는 "적용된" 프로필
  const [activeProfile, setActiveProfile] = useState<RecommendationUser>({
    ...DEFAULT_DRAFT_PROFILE,
    income: DEFAULT_DRAFT_PROFILE.income * 10_000,
  });
  const [isSearching, setIsSearching] = useState(false);

  // 프로필 저장/수정 상태:
  // - profileSaved: 로그인 사용자의 저장된 프로필이 서버에 있는지
  // - isEditingProfile: 지금 입력폼을 고칠 수 있는 상태인지 (저장된 프로필이
  //   있으면 기본적으로 잠겨있다가 [수정]을 눌러야 고칠 수 있음. 비로그인
  //   사용자나 아직 저장된 프로필이 없는 신규 사용자는 항상 고칠 수 있음)
  // - savedProfile: [취소]를 눌렀을 때 되돌릴 "마지막으로 저장된 값"
  const [profileSaved, setProfileSaved] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(true);
  const [savedProfile, setSavedProfile] = useState<RecommendationUser | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // 결과 대시보드 상태
  const [sortOption, setSortOption] = useState<SortOption>('score');

  // 정책명/기관명으로 검색 (대소문자 구분 없이, 앞뒤 공백 무시)
  const [searchQuery, setSearchQuery] = useState('');

  // '추천 결과'(적합도 0점 숨김) / '전체 목록'(0점 포함 전체) 뷰 전환
  const [viewMode, setViewMode] = useState<ViewMode>('recommended');

  // 상세 모달 상태
  const [selectedPolicy, setSelectedPolicy] = useState<RecommendedPolicy | null>(null);
  const [documentChecks, setDocumentChecks] = useState<Record<string, Set<string>>>({});
  // '지원 내용' 요약 토글 상태 (정책을 바꿔서 열 때마다 다시 요약 상태로 초기화)
  const [supportExpanded, setSupportExpanded] = useState(false);
  useEffect(() => {
    setSupportExpanded(false);
  }, [selectedPolicy?.policy_id]);

  // ---- 로그인 상태 ----
  const [session, setSession] = useState<Session | null>(null);
  // 로그인한 사용자가 저장된 프로필을 아직 수정 중이 아닐 때만 입력폼을 잠근다.
  const profileLocked = !!session && profileSaved && !isEditingProfile;
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // ---- 관심 정책 체크·스크랩 ----
  // 로그인한 사용자는 Supabase(user_scrap_checklist)에서 불러와 기기를 바꿔도
  // 유지되고, 로그아웃 상태에서는 이 세션(새로고침 전까지)에서만 유지된다.
  const [scrappedIds, setScrappedIds] = useState<Set<string>>(new Set());
  const [showOnlyScrapped, setShowOnlyScrapped] = useState(false);

  useEffect(() => {
    if (!session) {
      // 로그아웃된 경우 서버에 저장된 적 없는 로컬 상태만 남기고 끝.
      return;
    }
    let cancelled = false;
    fetchUserChecklist(session.user.id).then((map) => {
      if (cancelled) return;
      const nextChecks: Record<string, Set<string>> = {};
      const nextScrapped = new Set<string>();
      for (const [policyId, row] of Object.entries(map)) {
        nextChecks[policyId] = new Set(row.checked_documents);
        if (row.is_scrapped) nextScrapped.add(policyId);
      }
      setDocumentChecks(nextChecks);
      setScrappedIds(nextScrapped);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // ---- 저장된 프로필 복원 ----
  // 로그인하면 마지막으로 [맞춤 정책 찾기]를 눌렀을 때의 입력값을 불러와서
  // 입력폼(draftProfile)과 검색결과(activeProfile)를 둘 다 복원한다.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchUserProfile(session.user.id).then((saved) => {
      if (cancelled) return;
      if (saved) {
        setDraftProfile(saved);
        setActiveProfile({ ...saved, income: saved.income * 10_000 });
        setSavedProfile(saved);
        setProfileSaved(true);
        // 저장된 값이 있으면 실수로 건드리지 않도록 기본적으로 잠긴 채로 보여준다.
        setIsEditingProfile(false);
      } else {
        // 아직 저장된 프로필이 없는 신규 로그인 사용자는 바로 입력할 수 있어야 한다.
        setProfileSaved(false);
        setIsEditingProfile(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const recommended = useMemo(
    () => getRecommendedPolicies(activeProfile, policies, today),
    [activeProfile, policies, today]
  );

  // 결과 목록에 별도의 "관심 분야 필터"를 두지 않고, 프로필에서 고른 관심 분야를
  // 그대로 적용한다 (관심 분야를 하나도 고르지 않았다면 전체 카테고리를 보여준다).
  //
  // '추천 결과' 뷰: 적합도 0점짜리는 사실상 추천이라고 보기 어려워서 숨긴다.
  // '전체 목록' 뷰: 0점짜리도 포함해서(관심 분야 필터도 끄고) 하드 필터를
  // 통과한 정책을 전부 보여준다 - 적합도 0점이라 추천엔 안 뜨지만 조건상
  // 신청은 가능한 정책을 찾아볼 수 있게 하기 위함.
  const displayedResults = useMemo(() => {
    let list = recommended;
    if (viewMode === 'recommended') {
      list = list.filter((p) => p.total_score > 0);
      if (activeProfile.interests.length > 0) {
        list = list.filter((p) => activeProfile.interests.includes(p.category));
      }
    }
    if (showOnlyScrapped) {
      list = list.filter((p) => scrappedIds.has(p.policy_id));
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (p) => p.title.toLowerCase().includes(query) || p.organization.toLowerCase().includes(query)
      );
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
  }, [
    recommended,
    activeProfile.interests,
    sortOption,
    today,
    viewMode,
    showOnlyScrapped,
    scrappedIds,
    searchQuery,
  ]);

  // 정책이 많을 때 전부 한 번에 렌더링하지 않고 "더보기" 버튼으로 끊어서 보여준다.
  const RESULTS_PAGE_SIZE = 10;
  const [visibleCount, setVisibleCount] = useState(RESULTS_PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(RESULTS_PAGE_SIZE);
  }, [displayedResults]);
  const visibleResults = useMemo(
    () => displayedResults.slice(0, visibleCount),
    [displayedResults, visibleCount]
  );

  // 시너지 추천 카드: '주거+일자리' 고정이 아니라, 내가 선택한 관심분야 중
  // 적합도가 가장 높은 서로 다른 카테고리 2개를 조합한다.
  // (관심분야만으로 2개를 채우지 못하면, 나머지는 전체 추천 중 적합도 높은 다른 카테고리로 보충)
  const synergyPackage = useMemo(() => {
    const uniqueInterests = activeProfile.interests.filter((c, i, arr) => arr.indexOf(c) === i);

    const picks: RecommendedPolicy[] = [];
    const usedCategories = new Set<string>();

    for (const category of uniqueInterests) {
      if (picks.length >= 2) break;
      const match = recommended.find((p) => p.category === category && !usedCategories.has(p.category));
      if (match) {
        picks.push(match);
        usedCategories.add(match.category);
      }
    }

    if (picks.length < 2) {
      for (const p of recommended) {
        if (picks.length >= 2) break;
        if (!usedCategories.has(p.category)) {
          picks.push(p);
          usedCategories.add(p.category);
        }
      }
    }

    if (picks.length < 2) return null;
    const [first, second] = picks;
    return { first, second, total: (first.support_amount ?? 0) + (second.support_amount ?? 0) };
  }, [recommended, activeProfile.interests]);

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
    // 주의: 여기서는 더 이상 서버에 자동 저장하지 않는다. [맞춤 정책 찾기]는
    // 그때그때 입력값으로 검색만 해보는 버튼이고, 서버에 실제로 저장(=다음
    // 로그인 때도 복원됨)하는 건 [저장] 버튼(handleSaveProfile)을 눌렀을
    // 때만 일어난다 - 예전에는 검색할 때마다 자동으로 저장돼서, "내가 수정
    // 중인 값"과 "실제로 저장된 값"을 구분할 방법이 없었다.
  }

  // [수정] 버튼: 저장된 프로필을 고칠 수 있게 입력폼을 잠금 해제한다.
  function handleStartEditProfile() {
    setIsEditingProfile(true);
  }

  // [취소] 버튼: 수정 중이던 내용을 버리고 마지막으로 저장된 값으로 되돌린다.
  function handleCancelEditProfile() {
    if (savedProfile) {
      setDraftProfile(savedProfile);
    }
    setIsEditingProfile(false);
  }

  // [저장] 버튼: 지금 입력폼(draftProfile)을 서버에 실제로 저장하고 다시 잠근다.
  async function handleSaveProfile() {
    if (!session) return;
    setIsSavingProfile(true);
    try {
      await saveUserProfile(session.user.id, draftProfile);
      setSavedProfile(draftProfile);
      setProfileSaved(true);
      setIsEditingProfile(false);
      // 저장 = 지금 입력값을 확정한다는 뜻이므로, 검색 결과도 함께 최신화한다
      // (저장만 하고 [맞춤 정책 찾기]를 따로 안 눌러도 화면이 바로 반영됨).
      setActiveProfile({ ...draftProfile, income: draftProfile.income * 10_000 });
    } finally {
      setIsSavingProfile(false);
    }
  }

  // 관심 분야는 '내 프로필' 저장/수정 박스에 안 묶여있는 별도의 즉시-적용
  // 필터다(수정 잠금 여부와 무관하게 항상 바로 바뀜). 그래서:
  // 1) draftProfile과 activeProfile(=실제 추천/적합도 계산에 쓰이는 값)을
  //    둘 다 바로 갱신해서 [맞춤 정책 찾기]를 누르지 않아도 결과에 즉시
  //    반영되고,
  // 2) 로그인 상태에서 이미 저장된 프로필이 있으면 그 자리에서 바로 서버에도
  //    반영한다. 단, 지금 나이/지역/소득/취업상태를 수정 중이라 draftProfile
  //    에 아직 저장 안 한 값이 섞여 있을 수 있으므로, draftProfile을 그대로
  //    저장해버리면 그 미저장 수정값까지 같이 새어나가 저장돼버린다(저장
  //    버튼을 따로 둔 의미가 없어짐). 그래서 draftProfile이 아니라 마지막
  //    으로 실제 저장된 값(savedProfile)을 기준으로 interests만 바꿔서
  //    저장한다. (아직 한 번도 저장한 적 없는 신규 사용자는 savedProfile이
  //    없으므로 이 즉시-저장은 건너뛰고, 나중에 처음 [저장]을 누를 때
  //    draftProfile에 이미 반영된 interests가 함께 저장된다.)
  function toggleInterest(category: string) {
    const has = draftProfile.interests.includes(category);
    const nextInterests = has
      ? draftProfile.interests.filter((c) => c !== category)
      : [...draftProfile.interests, category];

    setDraftProfile((prev) => ({ ...prev, interests: nextInterests }));
    setActiveProfile((prev) => ({ ...prev, interests: nextInterests }));

    if (session && savedProfile) {
      const payload: RecommendationUser = { ...savedProfile, interests: nextInterests };
      setSavedProfile(payload);
      saveUserProfile(session.user.id, payload);
    }
  }

  // ⚠️ setState의 updater 함수 안에서 네트워크 요청(upsertUserChecklist)을
  // 직접 호출하지 않는다 - React(개발 모드의 Strict Mode)는 updater 함수를
  // 두 번 호출할 수 있어서, 그 안에 side effect를 두면 저장 요청이 중복
  // 전송될 수 있다. 다음 값을 먼저 계산해서 setState에는 순수하게 넘기고,
  // 저장 요청은 그 바깥에서 한 번만 실행한다.
  function toggleDocumentCheck(policyId: string, documentName: string) {
    const nextSet = new Set(documentChecks[policyId] ?? []);
    if (nextSet.has(documentName)) nextSet.delete(documentName);
    else nextSet.add(documentName);

    setDocumentChecks((prev) => ({ ...prev, [policyId]: nextSet }));
    if (session) {
      upsertUserChecklist(session.user.id, policyId, { checked_documents: Array.from(nextSet) });
    }
  }

  function toggleScrap(policyId: string) {
    const willScrap = !scrappedIds.has(policyId);

    setScrappedIds((prev) => {
      const next = new Set(prev);
      if (willScrap) next.add(policyId);
      else next.delete(policyId);
      return next;
    });
    if (session) {
      upsertUserChecklist(session.user.id, policyId, { is_scrapped: willScrap });
    }
  }

  async function handleAuthSubmit() {
    setAuthSubmitting(true);
    setAuthError(null);
    setAuthNotice(null);
    try {
      if (authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
        if (data.session) {
          // 이메일 확인이 꺼져있는 프로젝트라면 가입 즉시 로그인된다.
          setShowAuthModal(false);
        } else {
          setAuthNotice('가입 확인 메일을 보냈어요. 메일함을 확인하고 링크를 눌러주세요.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
        setShowAuthModal(false);
      }
      setAuthPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : '로그인/가입 중 문제가 발생했어요.');
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    // 로그아웃하면 이 기기에만 남아있던 스크랩/체크/프로필 상태도 함께 비운다
    // (다음 로그인 시 서버에 저장된 값으로 다시 채워짐 - 공용 기기에서 이전
    // 계정의 입력값이 남아있지 않도록).
    setDocumentChecks({});
    setScrappedIds(new Set());
    setDraftProfile(DEFAULT_DRAFT_PROFILE);
    setActiveProfile({ ...DEFAULT_DRAFT_PROFILE, income: DEFAULT_DRAFT_PROFILE.income * 10_000 });
    setProfileSaved(false);
    setIsEditingProfile(true);
    setSavedProfile(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* ============ 상단: 로고 + 시너지 추천 카드 ============ */}
      <header className="bg-gradient-to-br from-indigo-600 to-blue-600 text-white">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-6 w-6" />
              <h1 className="text-xl font-bold sm:text-2xl">청바지: 청년혜택은 바로 지금</h1>
            </div>

            {/* 로그인하면 체크·스크랩이 기기를 바꿔도 저장된다 */}
            {session ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="hidden text-indigo-100 sm:inline">{session.user.email}</span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 font-medium ring-1 ring-white/20 transition hover:bg-white/20"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  로그아웃
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAuthError(null);
                  setAuthNotice(null);
                  setShowAuthModal(true);
                }}
                className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium ring-1 ring-white/20 transition hover:bg-white/20"
              >
                <LogIn className="h-3.5 w-3.5" />
                로그인
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-indigo-100">
            내 조건에 딱 맞는 청년 정책을 한 번에 찾아드려요.
          </p>

          {synergyPackage ? (
            <div className="mt-5 rounded-2xl bg-white/10 p-4 backdrop-blur-sm ring-1 ring-white/20 sm:p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-indigo-100">
                <Sparkle className="h-4 w-4" />
                회원님의 이번 달 최적 패키지 ({synergyPackage.first.category}+{synergyPackage.second.category})
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[synergyPackage.first, synergyPackage.second].map((p) => (
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
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">내 프로필</h2>
            {profileLocked && (
              <span className="flex items-center gap-1 text-xs font-medium text-slate-400">
                <Lock className="h-3.5 w-3.5" />
                저장됨 · 수정하려면 [수정]을 눌러주세요
              </span>
            )}
          </div>

          <div
            className={`mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 ${
              profileLocked ? 'opacity-60' : ''
            }`}
          >
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
                  disabled={profileLocked}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({ ...prev, age: Number(e.target.value) }))
                  }
                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-indigo-600 disabled:cursor-not-allowed"
                />
                <input
                  type="number"
                  value={draftProfile.age}
                  disabled={profileLocked}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({ ...prev, age: Number(e.target.value) || 0 }))
                  }
                  className="w-16 shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
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
                disabled={profileLocked}
                onChange={(e) => setDraftProfile((prev) => ({ ...prev, region: e.target.value }))}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
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
                disabled={profileLocked}
                onChange={(e) =>
                  setDraftProfile((prev) => ({ ...prev, income: Number(e.target.value) || 0 }))
                }
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
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
                      disabled={profileLocked}
                      onClick={() => setDraftProfile((prev) => ({ ...prev, employment_status: opt }))}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed ${
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

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSearch}
              disabled={isSearching}
              className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
            >
              <Search className="h-4 w-4" />
              {isSearching ? '찾는 중...' : '맞춤 정책 찾기'}
            </button>

            {/* 저장: 로그인 상태에서 잠겨있지 않을 때(수정 중이거나, 아직 저장된
                프로필이 없는 신규 사용자)만 보여준다. 눌러야만 실제로 서버에
                저장된다 - [맞춤 정책 찾기]는 그때그때 미리보기일 뿐 더 이상
                자동으로 저장하지 않는다. */}
            {session && !profileLocked && (
              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={isSavingProfile}
                className="flex items-center justify-center gap-2 rounded-xl border border-indigo-600 px-4 py-3 text-sm font-semibold text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {isSavingProfile ? '저장 중...' : '저장'}
              </button>
            )}

            {/* 취소: 저장된 값이 있는 상태에서 수정 중일 때만 - 되돌릴 대상이
                있어야 의미가 있으므로 신규 사용자에게는 보이지 않는다. */}
            {session && profileSaved && isEditingProfile && (
              <button
                type="button"
                onClick={handleCancelEditProfile}
                disabled={isSavingProfile}
                className="flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-500 transition hover:bg-slate-50"
              >
                취소
              </button>
            )}

            {/* 수정: 저장된 프로필이 잠겨있을 때만 - 눌러야 입력폼이 풀린다. */}
            {profileLocked && (
              <button
                type="button"
                onClick={handleStartEditProfile}
                className="flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                <Pencil className="h-4 w-4" />
                수정
              </button>
            )}
          </div>

          {!session && (
            <p className="mt-2 text-xs text-slate-400">
              로그인하면 이 프로필이 저장돼서, 다음에 와도 다시 입력할 필요 없어요.
            </p>
          )}
          {session && !profileSaved && (
            <p className="mt-2 text-xs text-slate-400">
              [저장]을 눌러야 이 프로필이 서버에 저장돼요. 저장해두면 다음에 로그인했을 때도 그대로 불러올 수 있어요.
            </p>
          )}
        </section>

        {/* ============ 관심 분야 (즉시 적용되는 독립 필터) ============ */}
        {/* 나이/지역/소득/취업상태와 달리 관심 분야는 자주 바꿔보고 싶은
            값이라, [저장]/[수정]에 묶인 '내 프로필' 박스 밖에 따로 두고
            누르는 즉시 결과에 반영되게 한다(toggleInterest 참고). */}
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            <Heart className="h-4 w-4 text-slate-400" />
            관심 분야 (복수 선택 · 바로 적용돼요)
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
        </section>

        {/* ============ 결과 대시보드 ============ */}
        <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          {/* 좌측: 필터 */}
          {/* 결과를 따로 거르는 "관심 분야 필터"는 두지 않는다 — 위 프로필의 "관심 분야"
              선택이 이미 displayedResults에 그대로 반영되므로, 같은 역할을 하는
              체크박스를 두 번 두는 대신 정렬 옵션만 남긴다. */}
          <aside className="h-fit rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Search className="h-4 w-4 text-slate-400" />
              검색
            </div>
            <div className="relative mt-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="정책명, 기관명으로 검색"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-7 text-sm"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="검색어 지우기"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="mt-5 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
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
            <p className="mb-1 text-xs font-medium text-indigo-500">
              {dataSource === 'loading' && '실제 정책 데이터를 불러오는 중...'}
              {dataSource === 'supabase' && '실제 Supabase 데이터 기준'}
              {dataSource === 'dummy' && '예시(더미) 데이터 기준'}
            </p>

            {/* 추천 결과(적합도 0점 숨김) / 전체 목록(0점 포함) 탭 전환 */}
            <div className="mb-3 flex gap-1.5 rounded-xl bg-slate-100 p-1 text-sm font-medium">
              <button
                type="button"
                onClick={() => setViewMode('recommended')}
                className={`flex-1 rounded-lg px-3 py-1.5 transition ${
                  viewMode === 'recommended'
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                추천 결과
              </button>
              <button
                type="button"
                onClick={() => setViewMode('all')}
                className={`flex-1 rounded-lg px-3 py-1.5 transition ${
                  viewMode === 'all' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                전체 목록 ({recommended.length}건)
              </button>
            </div>

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-500">
                {viewMode === 'recommended' ? (
                  <>
                    총 <span className="font-semibold text-slate-900">{displayedResults.length}개</span>의 맞춤 정책을 찾았어요.
                  </>
                ) : (
                  <>
                    적합도 0점인 정책도 포함해서, 조건(나이·지역·소득·취업상태·마감일)에 맞는 정책을 전부
                    보여드려요. 총 <span className="font-semibold text-slate-900">{displayedResults.length}개</span>.
                  </>
                )}
              </p>

              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-600">
                <input
                  type="checkbox"
                  checked={showOnlyScrapped}
                  onChange={(e) => setShowOnlyScrapped(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <BookmarkCheck className="h-3.5 w-3.5 text-indigo-500" />
                스크랩한 정책만
              </label>
            </div>

            {!session && (
              <p className="mb-3 text-xs text-slate-400">
                체크·스크랩은 로그인하면 기기를 바꾸거나 새로고침해도 저장돼요.
              </p>
            )}

            {displayedResults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
                {searchQuery.trim()
                  ? `'${searchQuery.trim()}'에 대한 검색 결과가 없어요.`
                  : showOnlyScrapped
                  ? '스크랩한 정책이 없어요. 정책 카드의 북마크 아이콘을 눌러 스크랩해보세요.'
                  : viewMode === 'recommended'
                  ? '조건에 맞는 정책이 없어요. 프로필을 조정하고 다시 찾아보세요.'
                  : '조건에 맞는 정책이 없어요. 프로필(나이·지역·소득·취업상태)을 조정해보세요.'}
              </div>
            ) : (
              <div className="space-y-3">
                {visibleResults.map((policy) => {
                  const dday = getDdayLabel(policy.deadline, today);
                  const isScrapped = scrappedIds.has(policy.policy_id);
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

                        <button
                          type="button"
                          onClick={() => toggleScrap(policy.policy_id)}
                          aria-label={isScrapped ? '스크랩 해제' : '스크랩하기'}
                          className={`ml-auto flex items-center justify-center rounded-full p-1.5 transition ${
                            isScrapped
                              ? 'text-indigo-600 hover:bg-indigo-50'
                              : 'text-slate-300 hover:bg-slate-100 hover:text-slate-500'
                          }`}
                        >
                          {isScrapped ? (
                            <BookmarkCheck className="h-4 w-4" />
                          ) : (
                            <Bookmark className="h-4 w-4" />
                          )}
                        </button>
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

                {visibleCount < displayedResults.length && (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + RESULTS_PAGE_SIZE)}
                    className="w-full rounded-xl border border-slate-300 bg-white py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    더보기 ({displayedResults.length - visibleCount}개 더 있어요)
                  </button>
                )}
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
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => toggleScrap(selectedPolicy.policy_id)}
                  aria-label={scrappedIds.has(selectedPolicy.policy_id) ? '스크랩 해제' : '스크랩하기'}
                  className={`rounded-full p-1.5 transition ${
                    scrappedIds.has(selectedPolicy.policy_id)
                      ? 'text-indigo-600 hover:bg-indigo-50'
                      : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                  }`}
                >
                  {scrappedIds.has(selectedPolicy.policy_id) ? (
                    <BookmarkCheck className="h-5 w-5" />
                  ) : (
                    <Bookmark className="h-5 w-5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedPolicy(null)}
                  className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  aria-label="닫기"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-4 text-sm">
              <div>
                <p className="font-semibold text-slate-900">지원 내용</p>
                {/* ⚠️ break-words 추가: 모달 안 긴 안내문도 고정폭 안에서 줄바꿈되도록 함 */}
                <p className="mt-1 break-words text-slate-600">
                  {supportExpanded
                    ? selectedPolicy.support_content
                    : summarizeSupportContent(selectedPolicy.support_content)}
                </p>
                {summarizeSupportContent(selectedPolicy.support_content) !==
                  selectedPolicy.support_content.trim() && (
                  <button
                    type="button"
                    onClick={() => setSupportExpanded((prev) => !prev)}
                    className="mt-1.5 text-xs font-semibold text-indigo-600 hover:underline"
                  >
                    {supportExpanded ? '간단히 보기' : '전체 내용 보기'}
                  </button>
                )}
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
                {selectedPolicy.documents.length === 0 ? (
                  <div className="mt-1.5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-slate-500">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                    <p>
                      공고문에서 제출 서류 정보를 찾지 못했어요. 아래 ‘공식 사이트에서 신청하기’를
                      눌러 직접 확인해주세요.
                    </p>
                  </div>
                ) : (
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
                )}
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

      {/* ============ 로그인 / 회원가입 모달 ============ */}
      {showAuthModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
          onClick={() => setShowAuthModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">
                {authMode === 'login' ? '로그인' : '회원가입'}
              </h3>
              <button
                type="button"
                onClick={() => setShowAuthModal(false)}
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                aria-label="닫기"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              로그인하면 체크·스크랩이 기기를 바꾸거나 새로고침해도 저장돼요.
            </p>

            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                handleAuthSubmit();
              }}
            >
              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600">
                  <Mail className="h-3.5 w-3.5" />
                  이메일
                </span>
                <input
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="you@example.com"
                />
              </label>
              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-600">
                  <Lock className="h-3.5 w-3.5" />
                  비밀번호
                </span>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="6자 이상"
                />
              </label>

              {authError && <p className="text-sm text-rose-600">{authError}</p>}
              {authNotice && <p className="text-sm text-emerald-600">{authNotice}</p>}

              <button
                type="submit"
                disabled={authSubmitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
              >
                <LogIn className="h-4 w-4" />
                {authSubmitting ? '처리 중...' : authMode === 'login' ? '로그인' : '회원가입'}
              </button>
            </form>

            <button
              type="button"
              onClick={() => {
                setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'));
                setAuthError(null);
                setAuthNotice(null);
              }}
              className="mt-3 w-full text-center text-sm font-medium text-indigo-600 hover:underline"
            >
              {authMode === 'login' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
