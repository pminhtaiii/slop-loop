"""Tests for Calculator operations."""
import pytest
from src.calculator import Calculator, CalculationError


def test_add():
    calc = Calculator()
    assert calc.add(2, 3) == 5
    assert calc.add(-1, 1) == 0


def test_subtract():
    calc = Calculator()
    assert calc.subtract(5, 3) == 2
    assert calc.subtract(0, 4) == -4


def test_multiply():
    calc = Calculator()
    assert calc.multiply(4, 3) == 12
    assert calc.multiply(-2, 3) == -6


def test_divide_normal():
    calc = Calculator()
    assert calc.divide(10, 2) == 5
    assert calc.divide(9, 3) == 3


def test_divide_zero():
    calc = Calculator()
    with pytest.raises(CalculationError, match="Cannot divide by zero"):
        calc.divide(10, 0)
