# -*- coding: utf-8 -*-
"""함수형 문제용 실행기.

solution.py 를 불러와 solution(*args) 를 한 번 호출하고 결과를 JSON으로 돌려준다.
solution.py 자체에는 아무것도 심지 않는다 — 제출하는 파일과 글자 하나 다르지 않아야 한다.

stdin  : {"path": "...", "args": ["[1,2]", "3"], "expected": "6"}
stdout : {"passed": bool, "actual": "...", "expected": "...",
          "stdout": "...", "error": null | "트레이스백"}
"""

import ast
import importlib.util
import io
import json
import sys
import traceback


def parse_literal(text):
    """표에서 긁어온 값 문자열을 파이썬 값으로 만든다.

    프로그래머스 표는 불린을 `true` / `false` 로 적어서 ast.literal_eval 이 깨진다.
    그래서 JSON을 먼저 시도한다 — 문자열("abc"), 배열, 중첩 배열, 숫자까지 전부 받는다.
    파이썬 고유 표기('홑따옴표', None, 튜플)는 그 다음 ast 가 받는다.
    """
    text = text.strip()
    if not text:
        raise ValueError("값이 비어 있습니다.")
    try:
        return json.loads(text)
    except Exception:
        pass
    try:
        return ast.literal_eval(text)
    except Exception as exc:
        raise ValueError("값을 해석하지 못했습니다: %s (%s)" % (text, exc))


def equal(a, b):
    """채점용 비교. 실수만 미세 오차를 허용하고 나머지는 그대로 비교한다."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b if isinstance(a, bool) and isinstance(b, bool) else a == b
    if isinstance(a, float) or isinstance(b, float):
        try:
            return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
        except TypeError:
            return False
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
    return a == b


def main():
    # 셸에 따라 앞에 BOM이 붙어 오는 경우가 있어 떼고 읽는다.
    payload = json.loads(sys.stdin.read().lstrip("﻿"))
    result = {"passed": False, "actual": None, "expected": None, "stdout": "", "error": None}

    # 인자·기대값 해석은 사용자 코드와 무관한 단계라 따로 잡아 준다.
    try:
        args = [parse_literal(a) for a in payload.get("args", [])]
        expected = parse_literal(payload["expected"])
        result["expected"] = repr(expected)
    except ValueError as exc:
        result["error"] = str(exc)
        emit(result)
        return

    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        spec = importlib.util.spec_from_file_location("user_solution", payload["path"])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        fn = getattr(module, "solution", None)
        if fn is None:
            raise AttributeError("solution.py 에 solution 함수가 없습니다.")

        actual = fn(*args)
        result["actual"] = repr(actual)
        result["passed"] = equal(actual, expected)
    except Exception:
        result["error"] = traceback.format_exc()
    finally:
        sys.stdout = real_stdout
        # 사용자가 찍은 print 는 결과와 섞이지 않게 따로 담는다 — 디버깅에 필요하다.
        result["stdout"] = captured.getvalue()

    emit(result)


def emit(result):
    # ensure_ascii=True 로 순수 ASCII만 내보내 콘솔 인코딩 문제를 원천 차단한다.
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
