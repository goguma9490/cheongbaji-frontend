#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
청바지(청년혜택은 바로 지금) - 청년정책 데이터 수집 파이프라인
===========================================================

온통청년 오픈API + 지자체(서울시 청년몽땅정보통 / 인천시 청년포털) 공고문을
requests + BeautifulSoup으로 수집하고, 비정형 텍스트에서 정규표현식(re)으로
나이 / 소득 / 마감일 / 구비서류를 뽑아 정제한 뒤 Supabase(Policy, Policy_Document)
에 upsert 합니다.

------------------------------------------------------------------
※ 스키마 관련 중요 안내
------------------------------------------------------------------
이 스크립트는 "Policy / Policy_Document" 테이블이 아래와 같은 컬럼을 가진다고
가정하고 작성되었습니다 (기획서에 명시된 7개 테이블 중 2개).
실제 Supabase에서 만든 컬럼명이 다르다면, 파일을 전체 수정할 필요 없이
아래 POLICY_COLUMNS / POLICY_DOCUMENT_COLUMNS 매핑값만 실제 컬럼명으로
바꿔주면 됩니다.

    Policy
      policy_id            text/varchar (PK, 예: 'ontong-R2024030720423')
      source               text  ('ontong_youth' | 'seoul_youth_portal' | 'incheon_youth_portal')
      title                text  (정책명)
      category             text  (정책 분류)
      organization         text  (주관/운영 기관)
      description          text  (정책 설명)
      support_content      text  (지원 내용)
      min_age              int4  (최소 연령)
      max_age              int4  (최대 연령)
      income_condition_raw text  (소득 조건 원문)
      max_income           int4  (월 소득 상한, 원 단위 정수)
      apply_start_date     date  (신청 시작일)
      apply_end_date       date  (신청 마감일 = 우리가 추출하는 deadline)
      apply_period_raw     text  (신청기간 원문)
      region               text  ('전국' | '서울' | '인천')
      source_url           text  (원문 링크)

    Policy_Document
      id           (PK, DB에서 자동 생성되는 identity/uuid라고 가정 - insert 시 값 안 넣음)
      policy_id    text/varchar (FK -> Policy.policy_id)
      document_name text (구비서류/제출서류 항목명)
      is_required   bool

Policy_id에는 반드시 UNIQUE 제약(또는 PK)이 있어야 upsert(on_conflict)가 동작합니다.

------------------------------------------------------------------
환경변수 (.env 혹은 실행 전 export)
------------------------------------------------------------------
    SUPABASE_URL                Supabase 프로젝트 URL
    SUPABASE_SERVICE_ROLE_KEY   Supabase 서비스 롤 키 (서버 파이프라인이므로 service_role 권장)
    ONTONG_YOUTH_API_KEY        온통청년 오픈API 인증키 (마이페이지 > OPEN API 에서 발급)

------------------------------------------------------------------
실행 방법
------------------------------------------------------------------
    pip install -r requirements.txt
    python collect_policies.py --selftest   # 정규식 추출 로직만 빠르게 검증
    python collect_policies.py              # 실제 수집 + Supabase 적재

------------------------------------------------------------------
※ 지자체 스크래핑 관련 안내
------------------------------------------------------------------
서울/인천 포털은 화면 개편이 잦고 목록 카드의 실제 class 명을 라이브 DOM에서
직접 확인해야 정확히 잡을 수 있습니다. 아래 SeoulYouthPortalCollector /
IncheonYouthPortalCollector의 *_SELECTOR 상수에 TODO로 표시해두었으니,
브라우저 개발자도구(F12)로 실제 셀렉터를 확인해 한 줄만 바꿔주면 됩니다.
셀렉터가 안 맞아도 상세 페이지 전체 텍스트(body_text)를 정규식 추출기에 넘기므로
나이/소득/마감일/구비서류 추출 자체는 계속 동작합니다.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

import requests  # type: ignore
from bs4 import BeautifulSoup

try:
    from supabase import create_client, Client
except ImportError:  # pragma: no cover
    create_client = None
    Client = None

try:
    from dotenv import load_dotenv

    load_dotenv()  # 같은 폴더의 .env 파일이 있으면 자동으로 읽어 환경변수로 등록
except ImportError:  # pragma: no cover
    pass


# ============================================================
# 0. 설정 (CONFIG)
# ============================================================

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
ONTONG_API_KEY = os.environ.get("ONTONG_YOUTH_API_KEY")

REQUEST_TIMEOUT = 10
REQUEST_DELAY_SEC = 0.5  # 서버 부담을 줄이기 위한 요청 간 딜레이
USER_AGENT = "Mozilla/5.0 (compatible; CheongbajiCollector/1.0)"

# 실제 Supabase 테이블/컬럼명이 다르면 이 두 매핑만 고치면 됩니다.
POLICY_TABLE = "policies"
POLICY_DOCUMENT_TABLE = "policy_documents"

POLICY_COLUMNS = {
    "policy_id": "policy_id",
    "title": "title",
    "category": "category",
    "organization": "institution",
    "description": "summary",
    "support_content": "benefit_desc",
    "min_age": "min_age",
    "max_age": "max_age",
    "max_income": "max_income",
    "support_amount": "max_benefit_amount",
    "target_employment": "target_employment",
    "target_education": "target_education",
    "apply_end_date": "closing_date",
    "region": "target_region",
    "source_url": "apply_url",
}

POLICY_DOCUMENT_COLUMNS = {
    "policy_id": "policy_id",
    "document_name": "document_name",
    "is_required": "is_essential",
}

# 2026년 기준 중위소득 (보건복지부 고시, 월 단위 원). 정책 문구에 가구원수가
# 명시되지 않은 경우 청년 1인가구를 기본값으로 사용해 "중위소득 N%"를 원 단위로 환산합니다.
MEDIAN_INCOME_2026 = {
    1: 2_564_238,
    2: 4_199_292,
    3: 5_359_036,
    4: 6_494_738,
    5: 7_556_719,
    6: 8_555_952,
}
DEFAULT_HOUSEHOLD_SIZE = 1

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("cheongbaji-collector")


# ============================================================
# 1. 데이터 모델
# ============================================================

@dataclass
class PolicyRecord:
    policy_id: str
    source: str
    title: str
    source_url: str = ""
    category: Optional[str] = None
    organization: Optional[str] = None
    description: Optional[str] = None
    support_content: Optional[str] = None
    min_age: Optional[int] = None
    max_age: Optional[int] = None
    income_condition_raw: Optional[str] = None
    max_income: Optional[int] = None
    support_amount: Optional[int] = None  # 지원금액(원 단위)
    target_employment: Optional[str] = None  # '전체' | '재직자' | '미취업자' | '자영업자'
    target_education: Optional[str] = None  # '전체' | '대학생' | '고졸이하'
    apply_start_date: Optional[str] = None  # 'YYYY-MM-DD'
    apply_end_date: Optional[str] = None    # 'YYYY-MM-DD' (마감일)
    apply_period_raw: Optional[str] = None
    region: Optional[str] = None
    documents: list = field(default_factory=list)  # List[str]


def _safe_int(value) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


# ============================================================
# 2. 정규식 기반 필드 추출 유틸  (요구사항 2, 3)
# ============================================================

_SEP = r"(?:[~\-–—∼～]|부터)"

_AGE_RANGE_RE = re.compile(rf"만?\s*(\d{{1,2}})\s*세\s*{_SEP}\s*(\d{{1,2}})\s*세?")
_AGE_MAX_ONLY_RE = re.compile(r"만?\s*(\d{1,2})\s*세\s*(?:이하|미만|까지)")
_AGE_MIN_ONLY_RE = re.compile(r"만?\s*(\d{1,2})\s*세\s*(?:이상|부터)")


def extract_age_range(text: str) -> tuple[Optional[int], Optional[int]]:
    """'만 19세 ~ 34세 이하' -> (19, 34) 형태로 나이 범위를 정수로 추출.

    범위 표현이 없으면 '~세 이하'(상한만) / '~세 이상'(하한만)을 각각 시도한다.
    """
    if not text:
        return None, None

    m = _AGE_RANGE_RE.search(text)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return min(a, b), max(a, b)

    min_age = None
    max_age = None
    m_max = _AGE_MAX_ONLY_RE.search(text)
    if m_max:
        max_age = int(m_max.group(1))
    m_min = _AGE_MIN_ONLY_RE.search(text)
    if m_min:
        min_age = int(m_min.group(1))
    return min_age, max_age


_INCOME_PERCENT_RE = re.compile(r"중위\s*소득\s*(\d{1,3})\s*%\s*(?:이하|미만)?")
_INCOME_MAN_WON_RE = re.compile(r"월\s*(?:평균)?\s*소득\s*([\d,]+(?:\.\d+)?)\s*만\s*원\s*(?:이하|미만)")
_INCOME_WON_RE = re.compile(r"월\s*(?:평균)?\s*소득\s*([\d,]{4,})\s*원\s*(?:이하|미만)")


def extract_max_income(
    text: str, household_size: int = DEFAULT_HOUSEHOLD_SIZE
) -> tuple[Optional[int], Optional[str]]:
    """소득 조건 문구에서 월 소득 상한(원 단위 정수)을 추출.

    - '중위소득 120% 이하'  -> 기준 중위소득(household_size인 가구) * 120% 로 환산
    - '월 250만원 이하'      -> 2,500,000
    - '월 2,500,000원 이하'  -> 2,500,000
    반환값: (max_income:int|None, 매칭된 원문 조각:str|None)
    """
    if not text:
        return None, None

    m = _INCOME_PERCENT_RE.search(text)
    if m:
        percent = int(m.group(1))
        base = MEDIAN_INCOME_2026.get(household_size, MEDIAN_INCOME_2026[DEFAULT_HOUSEHOLD_SIZE])
        value = round(base * percent / 100)
        return value, m.group(0).strip()

    m = _INCOME_MAN_WON_RE.search(text)
    if m:
        value = float(m.group(1).replace(",", "")) * 10_000
        return int(value), m.group(0).strip()

    m = _INCOME_WON_RE.search(text)
    if m:
        value = int(m.group(1).replace(",", ""))
        return value, m.group(0).strip()

    return None, None


_DATE_RE = re.compile(r"(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?")


def extract_deadline(text: str) -> Optional[str]:
    """본문에서 날짜를 모두 찾아 YYYY-MM-DD로 정규화하고, 그중 가장 마지막(=보통
    '시작일 ~ 마감일'에서 마감일) 날짜를 반환한다. 날짜가 없으면 None
    ('상시모집', '예산 소진 시까지' 등).
    """
    if not text:
        return None

    dates = []
    for y, mo, d in _DATE_RE.findall(text):
        try:
            dates.append(date(int(y), int(mo), int(d)))
        except ValueError:
            continue
    if not dates:
        return None
    return max(dates).isoformat()


_DOC_SECTION_RE = re.compile(
    r"(?:구비\s*서류|제출\s*서류|첨부\s*서류)\s*[:：]?\s*(.+?)"
    r"(?=(?:\n\s*\n)|신청\s*방법|문의\s*처|접수\s*방법|접수\s*기간|유의\s*사항|담당\s*부서|$)",
    re.S,
)
_DOC_ITEM_SPLIT_RE = re.compile(r"(?:^|\s)(?:[①-⑩]|\d{1,2}\s*[.)]|[-·•‣])\s*")


def extract_required_documents(text: str) -> list[str]:
    """본문의 '구비서류' / '제출서류' / '첨부서류' 섹션을 찾아 항목 리스트로 분리한다.

    번호(1. 2. / ①② ) 또는 불릿(-, ·, •), 줄바꿈 등 여러 표기를 모두 지원한다.
    """
    if not text:
        return []

    m = _DOC_SECTION_RE.search(text)
    if not m:
        return []

    # 줄바꿈을 공백으로 통일한 뒤 번호/불릿 기준으로만 분리한다.
    # (줄바꿈과 불릿이 함께 있을 때 순서 문제로 불릿이 덜 제거되는 것을 방지)
    section = re.sub(r"[\r\n]+", " ", m.group(1)).strip()
    raw_items = _DOC_ITEM_SPLIT_RE.split(section)
    items = []
    for it in raw_items:
        it = re.sub(r"\s+", " ", it).strip(" .,")
        if it and len(it) > 1:
            items.append(it)
    return items


# ------------------------------------------------------------------
# 인천청년포털 전용 보조 추출기: <title> 태그 기반 제목 정리, 카테고리 추론,
# 본문 영역(네비게이션 제외) 추출, 지원금액 추출
# ------------------------------------------------------------------

_CONTENT_SECTION_RE = re.compile(
    r"사업개요\s*(.+?)(?=문\s*의\s*처|담당\s*부서|\[목록\]|$)",
    re.S,
)

_SUPPORT_AMOUNT_RE = re.compile(
    r"(?:최대|지원\s*금액|지급액)\s*[^0-9]{0,10}?([\d,]+(?:\.\d+)?)\s*만\s*원"
)
_ANY_MAN_WON_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*만\s*원")

_CATEGORY_KEYWORDS = [
    ("주거", ["주택", "전세", "월세", "임차", "보증금", "입주", "주거", "이사"]),
    ("일자리", ["취업", "채용", "구직", "일자리", "창업", "인턴", "고용"]),
    ("교육", ["교육", "학비", "장학금", "수강", "자격증", "학자금", "강좌"]),
    ("금융", ["대출", "이자", "적금", "저축", "보험", "환급", "금융"]),
    ("문화", ["문화", "공연", "전시", "여행", "축제", "체육", "예술"]),
]


def extract_title_from_title_tag(soup: BeautifulSoup, fallback: str) -> str:
    """<title> 태그(예: '인천청년정책-실제제목 | 인천청년포털>...')에서
    사이트명/경로를 떼어내고 실제 정책명만 뽑아낸다."""
    if not soup.title or not soup.title.string:
        return fallback
    raw = soup.title.string.split("|")[0].strip()
    if raw.startswith("인천청년정책-"):
        raw = raw[len("인천청년정책-"):].strip()
    return raw or fallback


def infer_category(text: str) -> Optional[str]:
    """제목+본문 텍스트에 포함된 키워드로 정책 카테고리를 추론한다.
    일치하는 키워드가 없으면 None (호출부에서 '기타'로 대체)."""
    if not text:
        return None
    for category, keywords in _CATEGORY_KEYWORDS:
        if any(kw in text for kw in keywords):
            return category
    return None


def extract_main_content(text: str, max_len: int = 1500) -> str:
    """전체 페이지 텍스트에서 '사업개요' ~ '문의처'/'담당부서'/'[목록]' 사이,
    즉 메뉴/버튼을 뺀 실제 정책 설명 부분만 뽑아낸다. 못 찾으면 앞부분을 그대로 쓴다."""
    if not text:
        return ""
    m = _CONTENT_SECTION_RE.search(text)
    content = m.group(1) if m else text
    content = re.sub(r"\s+", " ", content).strip()
    return content[:max_len]


def extract_support_amount(text: str) -> Optional[int]:
    """'연간 최대 300만원' 같은 문구에서 지원금액(원 단위)을 추출한다."""
    if not text:
        return None
    m = _SUPPORT_AMOUNT_RE.search(text)
    if not m:
        m = _ANY_MAN_WON_RE.search(text)
    if not m:
        return None
    try:
        return int(float(m.group(1).replace(",", "")) * 10_000)
    except ValueError:
        return None


_EMPLOYMENT_KEYWORDS = [
    ("미취업자", ["미취업자", "구직자", "실업자", "취업준비생"]),
    ("재직자", ["재직자", "근로자", "직장인", "취업자"]),
    ("자영업자", ["자영업자", "소상공인"]),
]

_EDUCATION_KEYWORDS = [
    ("대학생", ["대학생", "대학원생", "재학생"]),
    ("고졸이하", ["고등학교 졸업", "고졸"]),
]


def infer_employment_target(text: str) -> str:
    """본문에서 특정 고용상태 제한 키워드를 찾으면 그 값을, 못 찾으면
    '전체'(= 제한없음, 누구나 지원 가능)를 반환한다. target_region의 '전국'과
    같은 방식으로, null 대신 명시적인 문자열을 넣기 위한 함수."""
    if text:
        for label, keywords in _EMPLOYMENT_KEYWORDS:
            if any(kw in text for kw in keywords):
                return label
    return "전체"


def infer_education_target(text: str) -> str:
    """본문에서 특정 학력/재학 조건 키워드를 찾으면 그 값을, 못 찾으면
    '전체'(= 제한없음)를 반환한다."""
    if text:
        for label, keywords in _EDUCATION_KEYWORDS:
            if any(kw in text for kw in keywords):
                return label
    return "전체"


# ============================================================
# 3. 수집기 (requests + BeautifulSoup)  (요구사항 1)
# ============================================================

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT})


def http_get(url: str, params: dict | None = None, max_retries: int = 3) -> requests.Response:
    last_exc = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = _session.get(url, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp
        except requests.RequestException as exc:
            last_exc = exc
            logger.warning("요청 실패(%d/%d) %s: %s", attempt, max_retries, url, exc)
            time.sleep(1.5 * attempt)
    raise last_exc  # type: ignore[misc]


class BaseCollector:
    source_name = "base"

    def fetch(self) -> list[PolicyRecord]:
        raise NotImplementedError


class OntongYouthCollector(BaseCollector):
    """온통청년 오픈API 수집기.

    엔드포인트/파라미터명은 https://www.youthcenter.go.kr/cmnFooter/openapiIntro/oaiDoc
    에 안내된 값을 기준으로 하되, 응답 필드의 정확한 코드값은 API 승인 후 내려받는
    'API코드정보.xlsx'로 반드시 재확인하세요. 아래 parse_item()은 흔히 쓰이는
    필드명을 후보로 두고 여러 이름을 순서대로 시도하도록(get()) 방어적으로 작성했습니다.
    """

    source_name = "ontong_youth"
    LIST_URL = "https://www.youthcenter.go.kr/opi/youthPlcyList.do"

    def __init__(self, api_key: str | None = None, page_size: int = 100):
        self.api_key = api_key or ONTONG_API_KEY
        self.page_size = page_size

    def fetch_page(self, page_index: int) -> tuple[list[dict], int]:
        params = {
            "openApiVlak": self.api_key,
            "display": self.page_size,
            "pageIndex": page_index,
            "rtnType": "json",
        }
        resp = http_get(self.LIST_URL, params=params)
        try:
            data = resp.json()
        except ValueError:
            logger.warning("온통청년 API 응답이 JSON이 아닙니다(XML일 수 있음) - 이 페이지는 건너뜁니다.")
            return [], 0

        result = data.get("result", data) if isinstance(data, dict) else {}
        items = (
            result.get("youthPolicyList")
            or result.get("youthPolicyDtlList")
            or result.get("list")
            or []
        )
        total = (
            (result.get("pagging") or {}).get("totCount")
            or result.get("totalCount")
            or len(items)
        )
        return items, int(total or 0)

    @staticmethod
    def _pick(item: dict, *keys):
        for k in keys:
            v = item.get(k)
            if v not in (None, ""):
                return v
        return None

    def parse_item(self, item: dict) -> PolicyRecord:
        pick = lambda *keys: self._pick(item, *keys)  # noqa: E731

        title = pick("plcyNm", "polyBizSjnm", "title") or "(제목없음)"
        raw_id = pick("plcyNo", "bizId", "id") or hashlib.md5(str(title).encode()).hexdigest()[:10]
        description = pick("plcyExplnCn", "polyItcnCn", "description") or ""
        support_content = pick("plcySprtCn", "sportContent") or ""
        organization = pick("sprvsnInstCdNm", "operInstCdNm", "rgtrInstCdNm")
        category = pick("lclsfNm", "mclsfNm", "plcyKywdNm")
        apply_period_raw = pick("aplyYmd", "rqutPrdCn") or ""
        income_field_raw = pick("earnEtcCn")

        combined_text = " ".join(
            str(x)
            for x in [
                description,
                support_content,
                apply_period_raw,
                income_field_raw,
                pick("addAplyQlfcCndCn"),
            ]
            if x
        )

        min_age = _safe_int(item.get("sprtTrgtMinAge"))
        max_age = _safe_int(item.get("sprtTrgtMaxAge"))
        if min_age is None or max_age is None:
            re_min, re_max = extract_age_range(combined_text)
            min_age = min_age if min_age is not None else re_min
            max_age = max_age if max_age is not None else re_max

        max_income, income_condition_raw = extract_max_income(combined_text)
        if not income_condition_raw:
            income_condition_raw = income_field_raw

        deadline = None
        end_ymd = pick("aplyEndYmd")
        if end_ymd and re.match(r"^\d{8}$", str(end_ymd)):
            s = str(end_ymd)
            deadline = f"{s[:4]}-{s[4:6]}-{s[6:8]}"
        if not deadline:
            deadline = extract_deadline(apply_period_raw) or extract_deadline(combined_text)

        start_date = None
        start_ymd = pick("aplyBgngYmd")
        if start_ymd and re.match(r"^\d{8}$", str(start_ymd)):
            s = str(start_ymd)
            start_date = f"{s[:4]}-{s[4:6]}-{s[6:8]}"

        documents_source_text = pick("sbmsnDcmntCn") or combined_text
        documents = extract_required_documents(documents_source_text) or extract_required_documents(
            combined_text
        )

        return PolicyRecord(
            policy_id=f"ontong-{raw_id}",
            source=self.source_name,
            title=title,
            source_url=pick("refUrlAddr1", "aplyUrlAddr") or "https://www.youthcenter.go.kr",
            category=category,
            organization=organization,
            description=description,
            support_content=support_content,
            min_age=min_age,
            max_age=max_age,
            income_condition_raw=income_condition_raw,
            max_income=max_income,
            apply_start_date=start_date,
            apply_end_date=deadline,
            apply_period_raw=apply_period_raw,
            region="전국",
            documents=documents,
        )

    def fetch(self) -> list[PolicyRecord]:
        if not self.api_key:
            logger.warning("ONTONG_YOUTH_API_KEY가 없어 온통청년 수집을 건너뜁니다.")
            return []

        records: list[PolicyRecord] = []
        page = 1
        while True:
            items, total = self.fetch_page(page)
            if not items:
                break
            for item in items:
                try:
                    records.append(self.parse_item(item))
                except Exception:
                    logger.exception("온통청년 항목 파싱 실패: %s", item.get("plcyNo"))
            logger.info("온통청년 %d페이지 수집 완료 (누적 %d건 / 전체 %s건)", page, len(records), total)
            if len(items) < self.page_size or (total and len(records) >= total):
                break
            page += 1
            time.sleep(REQUEST_DELAY_SEC)
        return records


class SeoulYouthPortalCollector(BaseCollector):
    """서울시 청년몽땅정보통(youth.seoul.go.kr) HTML 스크레이핑 수집기.

    TODO: LIST_ITEM_SELECTOR / TITLE_SELECTOR 는 실제 배포 전 브라우저
    개발자도구(F12 > Elements)에서 목록 카드의 class 명을 확인해 맞춰주세요.
    셀렉터가 조금 어긋나도 상세 페이지는 전체 텍스트를 정규식 추출기에 넘기므로
    나이/소득/마감일/구비서류 추출 자체는 계속 동작합니다.
    """

    source_name = "seoul_youth_portal"
    BASE_URL = "https://youth.seoul.go.kr"
    LIST_URL = BASE_URL + "/infoData/plcyInfo/list.do"
    LIST_KEY = "2309150002"  # 목록 페이지 식별용 쿼리 파라미터(사이트 구조상 고정값)

    LIST_ITEM_SELECTOR = "ul.plcyListWrap > li, div.plcyList .card, .board-list li"  # TODO 확인
    TITLE_SELECTOR = "a.tit, .tit a, a"

    def __init__(self, max_pages: int = 3):
        self.max_pages = max_pages

    def fetch_list_page(self, page_no: int) -> list[tuple[str, str]]:
        resp = http_get(self.LIST_URL, params={"key": self.LIST_KEY, "pageIndex": page_no})
        soup = BeautifulSoup(resp.text, "html.parser")
        items = soup.select(self.LIST_ITEM_SELECTOR)
        links: list[tuple[str, str]] = []
        for it in items:
            a = it.select_one(self.TITLE_SELECTOR) or it.find("a")
            if not a or not a.get("href"):
                continue
            href = a["href"]
            title = a.get_text(strip=True)
            if href.startswith("javascript"):
                continue
            detail_url = href if href.startswith("http") else self.BASE_URL + href
            links.append((title, detail_url))
        return links

    def fetch_detail(self, title: str, url: str) -> PolicyRecord:
        resp = http_get(url)
        soup = BeautifulSoup(resp.text, "html.parser")
        body_text = soup.get_text("\n", strip=True)

        min_age, max_age = extract_age_range(body_text)
        max_income, income_raw = extract_max_income(body_text)
        deadline = extract_deadline(body_text)
        documents = extract_required_documents(body_text)

        policy_id = "seoul-" + hashlib.md5(url.encode()).hexdigest()[:12]
        return PolicyRecord(
            policy_id=policy_id,
            source=self.source_name,
            title=title or "(제목없음)",
            source_url=url,
            region="서울",
            description=body_text[:1000],
            min_age=min_age,
            max_age=max_age,
            income_condition_raw=income_raw,
            max_income=max_income,
            apply_end_date=deadline,
            documents=documents,
        )

    def fetch(self) -> list[PolicyRecord]:
        records: list[PolicyRecord] = []
        for page in range(1, self.max_pages + 1):
            try:
                links = self.fetch_list_page(page)
            except Exception:
                logger.exception("서울 청년포털 목록 페이지 요청 실패: page=%d", page)
                break
            if not links:
                break
            for title, url in links:
                try:
                    records.append(self.fetch_detail(title, url))
                except Exception:
                    logger.exception("서울 청년포털 상세 파싱 실패: %s", url)
                time.sleep(REQUEST_DELAY_SEC)
            logger.info("서울 청년포털 %d페이지 수집 완료 (누적 %d건)", page, len(records))
        return records


class IncheonYouthPortalCollector(BaseCollector):
    """인천시 청년포털(youth.incheon.go.kr) HTML 스크레이핑 수집기.

    목록: /youthpolicy/youthPolicyInfoList.do?pgno=N
    상세: /youthpolicy/youthPolicyInfoDetail.do?poly_seq=N
    """

    source_name = "incheon_youth_portal"
    BASE_URL = "https://youth.incheon.go.kr"
    LIST_URL = BASE_URL + "/youthpolicy/youthPolicyInfoList.do"
    DETAIL_URL = BASE_URL + "/youthpolicy/youthPolicyInfoDetail.do"

    def __init__(self, max_pages: int = 3):
        self.max_pages = max_pages

    def fetch_list_page(self, page_no: int) -> list[str]:
        resp = http_get(self.LIST_URL, params={"pgno": page_no})
        soup = BeautifulSoup(resp.text, "html.parser")
        seqs: set[str] = set()

        for a in soup.find_all("a", href=True):
            m = re.search(r"poly_seq=(\d+)", a["href"])
            if m:
                seqs.add(m.group(1))

        # onclick="fnDetail('123')" 형태의 JS 클릭 이벤트도 함께 시도
        for tag in soup.find_all(onclick=True):
            m = re.search(r"poly_seq['\"]?\s*[:=]\s*['\"]?(\d+)", tag["onclick"])
            if m:
                seqs.add(m.group(1))

        return sorted(seqs, key=int)

    def fetch_detail(self, poly_seq: str) -> PolicyRecord:
        url = f"{self.DETAIL_URL}?poly_seq={poly_seq}"
        resp = http_get(self.DETAIL_URL, params={"poly_seq": poly_seq})
        soup = BeautifulSoup(resp.text, "html.parser")

        title = extract_title_from_title_tag(soup, fallback=f"인천청년정책-{poly_seq}")
        body_text = soup.get_text("\n", strip=True)
        main_content = extract_main_content(body_text)

        # 나이/소득/마감일/구비서류/지원금액은 전체 페이지 텍스트가 아니라
        # '사업개요~문의처' 구간(main_content)만 보고 뽑는다. 전체 텍스트에는
        # 사이트 공통 안내문구(예: "기준 중위소득 60% 이하 모의계산" 같은
        # 사이트 전반에 깔린 배너 문구)가 섞여 있어서, 이걸 그대로 쓰면 이
        # 정책과 무관한 값이 엉뚱하게 뽑히는 문제가 있었다.
        min_age, max_age = extract_age_range(main_content)
        max_income, income_raw = extract_max_income(main_content)
        deadline = extract_deadline(main_content)
        documents = extract_required_documents(main_content)
        support_amount = extract_support_amount(main_content)
        category = infer_category(title + " " + main_content)
        target_employment = infer_employment_target(main_content)
        target_education = infer_education_target(main_content)

        return PolicyRecord(
            policy_id=f"incheon-{poly_seq}",
            source=self.source_name,
            title=title,
            source_url=url,
            region="인천",
            category=category,
            description=main_content,
            support_amount=support_amount,
            target_employment=target_employment,
            target_education=target_education,
            min_age=min_age,
            max_age=max_age,
            income_condition_raw=income_raw,
            max_income=max_income,
            apply_end_date=deadline,
            documents=documents,
        )

    def fetch(self) -> list[PolicyRecord]:
        records: list[PolicyRecord] = []
        for page in range(1, self.max_pages + 1):
            try:
                seqs = self.fetch_list_page(page)
            except Exception:
                logger.exception("인천 청년포털 목록 페이지 요청 실패: page=%d", page)
                break
            if not seqs:
                break
            for seq in seqs:
                try:
                    records.append(self.fetch_detail(seq))
                except Exception:
                    logger.exception("인천 청년포털 상세 파싱 실패: poly_seq=%s", seq)
                time.sleep(REQUEST_DELAY_SEC)
            logger.info("인천 청년포털 %d페이지 수집 완료 (누적 %d건)", page, len(records))
        return records


# ============================================================
# 4. Supabase 일괄 upsert  (요구사항 4)
# ============================================================

def get_supabase_client() -> "Client":
    if create_client is None:
        raise RuntimeError("supabase-py가 설치되어 있지 않습니다. `pip install supabase` 후 다시 실행하세요.")
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수를 설정해주세요.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def _map_columns(data: dict, column_map: dict) -> dict:
    return {column_map[k]: v for k, v in data.items() if k in column_map and v is not None}


def _cap(value, max_len: int = 95):
    """글자 수가 max_len을 넘으면 잘라낸다 (DB 컬럼 길이 제한 대응)."""
    if value is None:
        return None
    s = str(value)
    return s if len(s) <= max_len else s[:max_len]


def upsert_policies(client: "Client", records: list[PolicyRecord], batch_size: int = 200) -> int:
    rows = []
    for r in records:
        row = _map_columns(
            {
                "policy_id": r.policy_id,
                "source": r.source,
                "title": r.title,
                "category": r.category or "기타",
                "organization": r.organization or "미상",
                "description": r.description,
                "support_content": r.support_content or r.description,
                "min_age": r.min_age if r.min_age is not None else 19,
                "max_age": r.max_age if r.max_age is not None else 39,
                "income_condition_raw": r.income_condition_raw,
                "max_income": r.max_income,
                "support_amount": r.support_amount,
                "target_employment": r.target_employment,
                "target_education": r.target_education,
                "apply_start_date": r.apply_start_date,
                "apply_end_date": r.apply_end_date,
                "apply_period_raw": r.apply_period_raw,
                "region": r.region,
                "source_url": r.source_url,
            },
            POLICY_COLUMNS,
        )
        rows.append(row)

    pk_col = POLICY_COLUMNS["policy_id"]
    for i in range(0, len(rows), batch_size):
        chunk = rows[i : i + batch_size]
        client.table(POLICY_TABLE).upsert(chunk, on_conflict=pk_col).execute()
        logger.info("Policy upsert %d~%d / %d건 완료", i + 1, i + len(chunk), len(rows))
    return len(rows)


def upsert_policy_documents(client: "Client", records: list[PolicyRecord], batch_size: int = 200) -> int:
    fk_col = POLICY_DOCUMENT_COLUMNS["policy_id"]

    # 정책별 서류 목록은 재수집 시 최신 상태로 덮어쓰기 위해, 서류가 있는
    # policy_id에 한해 기존 행을 지우고 다시 insert 합니다.
    policy_ids_with_docs = list({r.policy_id for r in records if r.documents})
    if policy_ids_with_docs:
        client.table(POLICY_DOCUMENT_TABLE).delete().in_(fk_col, policy_ids_with_docs).execute()

    rows = []
    for r in records:
        for doc_name in r.documents:
            row = _map_columns(
                {
                    "policy_id": r.policy_id,
                    "document_name": doc_name,
                    "is_required": True,
                },
                POLICY_DOCUMENT_COLUMNS,
            )
            rows.append(row)

    for i in range(0, len(rows), batch_size):
        chunk = rows[i : i + batch_size]
        client.table(POLICY_DOCUMENT_TABLE).insert(chunk).execute()
        logger.info("Policy_Document insert %d~%d / %d건 완료", i + 1, i + len(chunk), len(rows))
    return len(rows)


# ============================================================
# 5. 메인 파이프라인
# ============================================================

def run() -> None:
    collectors: list[BaseCollector] = [
        OntongYouthCollector(),
        SeoulYouthPortalCollector(max_pages=int(os.environ.get("SEOUL_MAX_PAGES", 3))),
        IncheonYouthPortalCollector(max_pages=int(os.environ.get("INCHEON_MAX_PAGES", 3))),
    ]

    all_records: list[PolicyRecord] = []
    for collector in collectors:
        logger.info("=== %s 수집 시작 ===", collector.source_name)
        try:
            records = collector.fetch()
        except Exception:
            logger.exception("%s 수집 중 오류 발생 - 건너뜁니다.", collector.source_name)
            continue
        logger.info("=== %s 수집 완료: %d건 ===", collector.source_name, len(records))
        all_records.extend(records)

    if not all_records:
        logger.warning("수집된 정책이 없습니다. 종료합니다.")
        return

    # 같은 policy_id가 여러 페이지에서 중복으로 수집될 수 있으므로,
    # Supabase에 보내기 전에 policy_id 기준으로 중복을 한 번 제거한다(마지막 값만 유지).
    dedup: dict[str, PolicyRecord] = {}
    for r in all_records:
        dedup[r.policy_id] = r
    all_records = list(dedup.values())
    logger.info("중복 제거 후 최종 %d건", len(all_records))

    client = get_supabase_client()
    n_policies = upsert_policies(client, all_records)
    n_docs = upsert_policy_documents(client, all_records)
    logger.info("완료: Policy %d건, Policy_Document %d건 upsert", n_policies, n_docs)


# ============================================================
# 6. 정규식 추출기 자체 테스트 (--selftest)
# ============================================================

def _run_regex_selftests() -> None:
    print("[나이] '만 19세 ~ 34세 이하' ->", extract_age_range("지원대상: 만 19세 ~ 34세 이하 청년"))
    print("[나이] '만 39세 이하' ->", extract_age_range("만 39세 이하 무주택 청년"))
    print("[나이] '만 18세 이상' ->", extract_age_range("만 18세 이상 대학생"))

    income1 = extract_max_income("가구소득 기준 중위소득 120% 이하")
    print("[소득] '중위소득 120% 이하' -> max_income={}, 근거={}".format(*income1))

    income2 = extract_max_income("월 소득 250만원 이하인 자")
    print("[소득] '월 250만원 이하' -> max_income={}, 근거={}".format(*income2))

    income3 = extract_max_income("신청자 본인의 월 소득 2,500,000원 이하")
    print("[소득] '월 2,500,000원 이하' -> max_income={}, 근거={}".format(*income3))

    print(
        "[마감일] '신청기간 2026.09.01. ~ 2026.09.30.' ->",
        extract_deadline("신청기간 2026.09.01. ~ 2026.09.30. 까지 접수"),
    )
    print("[마감일] '상시모집' ->", extract_deadline("접수기간: 상시모집(예산 소진 시 마감)"))

    doc_text = (
        "■ 제출서류: 1. 신청서 1부 2. 주민등록등본 1부 3. 통장사본 1부\n\n"
        "신청방법: 온라인 접수"
    )
    print("[구비서류]", extract_required_documents(doc_text))

    doc_text2 = "구비서류\n- 재직증명서\n- 소득금액증명원\n- 가족관계증명서\n\n문의처: 02-000-0000"
    print("[구비서류]", extract_required_documents(doc_text2))

    print(
        "[제목정리] ->",
        extract_title_from_title_tag(
            BeautifulSoup(
                "<title>인천청년정책-아이플러스(i+) 집드림_1.0 이자지원 | 인천청년포털</title>",
                "html.parser",
            ),
            fallback="(제목없음)",
        ),
    )
    print("[카테고리추론] '전세 보증금 이자 지원' ->", infer_category("전세 보증금 이자 지원"))
    print("[지원금액] '연간 최대 300만원/가구' ->", extract_support_amount("연간 최대 300만원/가구 지원"))
    print("[고용상태] '미취업 청년 구직자 대상' ->", infer_employment_target("미취업 청년 구직자 대상"))
    print("[고용상태] (조건 없음) ->", infer_employment_target("만 19세 이상 인천시민 누구나"))
    print("[학력] '대학생 재학생 대상' ->", infer_education_target("대학생 재학생 대상"))

    assert extract_age_range("만 19세 ~ 34세 이하")[0] == 19
    assert extract_age_range("만 19세 ~ 34세 이하")[1] == 34
    assert extract_deadline("신청기간 2026.09.01. ~ 2026.09.30. 까지") == "2026-09-30"
    assert extract_max_income("월 소득 2,500,000원 이하")[0] == 2_500_000
    assert extract_required_documents(doc_text) == ["신청서 1부", "주민등록등본 1부", "통장사본 1부"]
    assert infer_category("전세 보증금 이자 지원") == "주거"
    assert extract_support_amount("연간 최대 300만원/가구 지원") == 3_000_000
    assert infer_employment_target("미취업 청년 구직자 대상") == "미취업자"
    assert infer_employment_target("만 19세 이상 인천시민 누구나") == "전체"
    assert infer_education_target("대학생 재학생 대상") == "대학생"
    print("\n모든 self-test 통과 ✅")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="청바지 청년정책 수집 파이프라인")
    parser.add_argument("--selftest", action="store_true", help="정규식 추출기만 빠르게 검증하고 종료")
    args = parser.parse_args()

    if args.selftest:
        _run_regex_selftests()
    else:
        run()
