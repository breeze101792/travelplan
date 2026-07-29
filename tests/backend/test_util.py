"""Tests for shared utility helpers - check_version, fmt_date, etc."""
from __future__ import annotations

import pytest
from backend.util import check_version, ok, err, fmt_date
from backend.util import parse_amount_to_cents as p2c
from backend.util import format_cents


class TestCheckVersion:
    def test_no_row_returns_none(self):
        assert check_version(None, {"expected_updated_at": "x"}) is None

    def test_no_expected_returns_none(self):
        row = {"id": 1, "updated_at": "2026-01-01T00:00:00"}
        assert check_version(row, {}) is None

    def test_expected_matches_returns_none(self):
        row = {"id": 1, "updated_at": "2026-01-01T00:00:00"}
        assert check_version(row, {"expected_updated_at": "2026-01-01T00:00:00"}) is None

    def test_mismatch_returns_conflict_dict(self):
        row = {"id": 1, "updated_at": "2026-01-01T00:00:00", "title": "Trip"}
        result = check_version(row, {"expected_updated_at": "2026-06-01T00:00:00"})
        assert result["error"] == "conflict"
        assert "modified by another user" in result["message"]
        assert result["current"] == row

    def test_row_without_updated_at_returns_none(self):
        row = {"id": 1}
        assert check_version(row, {"expected_updated_at": "x"}) is None


class TestOk:
    def test_ok_with_payload_dict(self, app):
        with app.app_context():
            rsp = ok({"x": 1})
            data = rsp.get_json()
            assert data["x"] == 1

    def test_ok_with_kwargs(self, app):
        with app.app_context():
            rsp = ok(x=1, y=2)
            data = rsp.get_json()
            assert data["x"] == 1
            assert data["y"] == 2

    def test_ok_with_non_dict_payload(self, app):
        with app.app_context():
            rsp = ok([1, 2, 3])
            data = rsp.get_json()
            assert data["data"] == [1, 2, 3]

    def test_ok_no_args(self, app):
        with app.app_context():
            rsp = ok()
            data = rsp.get_json()
            assert data == {}


class TestErr:
    def test_err_default_status(self, app):
        with app.app_context():
            rsp, status = err("bad request")
            assert status == 400
            assert rsp.get_json()["error"] == "bad request"

    def test_err_custom_status(self, app):
        with app.app_context():
            rsp, status = err("not found", 404)
            assert status == 404
            assert rsp.get_json()["error"] == "not found"


class TestFmtDate:
    def test_fmt_date_none(self):
        assert fmt_date(None) == ""

    def test_fmt_date_empty(self):
        assert fmt_date("") == ""

    def test_fmt_date_iso(self):
        assert fmt_date("2026-07-01") == "Jul 1, 2026"

    def test_fmt_date_invalid(self):
        assert fmt_date("not-a-date") == ""

    def test_fmt_date_from_date_obj(self):
        from datetime import date
        d = date(2026, 12, 25)
        assert fmt_date(d) == "Dec 25, 2026"


class TestParseAmountToCents:
    def test_p2c_int(self):
        assert p2c(100) == 100

    def test_p2c_string(self):
        assert p2c("120.00") == 12000

    def test_p2c_float(self):
        assert p2c(1.5) == 150

    def test_p2c_none_raises(self):
        with pytest.raises(ValueError):
            p2c(None)

    def test_p2c_bool_raises(self):
        with pytest.raises(ValueError):
            p2c(True)

    def test_p2c_invalid_string_raises(self):
        with pytest.raises(ValueError):
            p2c("abc")


class TestFormatCents:
    def test_format_cents_standard(self):
        assert format_cents(1500) == "15.00"

    def test_format_cents_zero_decimals(self):
        assert format_cents(3000, 0) == "3000"
