"""Simple calculator module with basic arithmetic operations."""


class CalculationError(Exception):
    """Custom exception raised for invalid calculator operations."""
    pass


class Calculator:
    """Performs basic arithmetic calculations."""

    def add(self, a, b):
        return a + b

    def subtract(self, a, b):
        return a - b

    def multiply(self, a, b):
        return a * b

    def divide(self, a, b):
        return a / b
