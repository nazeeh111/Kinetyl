"""Rational sign feasibility on an interval. No numerical root approximations.

Coefficients are in ascending power order. Strict inequalities are decided on
open sign cells, using a square-free Sturm sequence to count their boundaries.
An endpoint where a polynomial vanishes is handled by its first nonzero Taylor
coefficient. An overlap must include an open interval, so no algebraic-root
witness is required. The returned witness is an actual rational input time.
"""
from fractions import Fraction as F
from math import gcd, lcm


class PolynomialLimit(ValueError):
    pass


def trim(p):
    p = tuple(map(F, p))
    while len(p) > 1 and p[-1] == 0:
        p = p[:-1]
    return p or (F(0),)


def guard(p, budget):
    budget.spend(len(p))
    if len(p) > 13 or any(max(c.numerator.bit_length(), c.denominator.bit_length()) > 16384 for c in p):
        raise PolynomialLimit("Inconclusive: polynomial arithmetic limit exceeded")
    return trim(p)


def evaluate(p, x):
    v = F(0)
    for c in reversed(p):
        v = v * x + c
    return v


def derivative(p):
    return trim([i*c for i, c in enumerate(p)][1:])


def add(a, b):
    return trim([(a[i] if i < len(a) else 0) + (b[i] if i < len(b) else 0) for i in range(max(len(a), len(b)))])


def multiply(a, b, budget):
    out = [F(0)] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            budget.spend()
            out[i+j] += x*y
    return guard(out, budget)


def primitive(p, budget):
    """Positive rescaling only: preserve signs in the Sturm chain."""
    p = guard(p, budget)
    den = 1
    for c in p:
        den = lcm(den, c.denominator)
        if den.bit_length() > 16384:
            raise PolynomialLimit("Inconclusive: polynomial denominator limit exceeded")
    ints = [c.numerator * (den // c.denominator) for c in p]
    g = 0
    for c in ints:
        g = gcd(g, c)
    return guard([F(c // (g or 1)) for c in ints], budget)


def divide(a, b, budget):
    a, b = list(trim(a)), trim(b)
    if b == (0,):
        raise ZeroDivisionError("zero polynomial")
    q = [F(0)] * max(1, len(a)-len(b)+1)
    while len(a) >= len(b) and trim(a) != (0,):
        k, v = len(a)-len(b), a[-1]/b[-1]
        q[k] = v
        for i, c in enumerate(b):
            budget.spend()
            a[k+i] -= v*c
        a = list(guard(a, budget))
    return guard(q, budget), guard(a, budget)


def sturm(p, budget):
    p = primitive(p, budget)
    a, b = p, derivative(p)
    while b != (0,):
        _, r = divide(a, b, budget)
        a, b = b, primitive(r, budget)
    p, remainder = divide(p, a, budget)
    if remainder != (0,):
        raise PolynomialLimit("Inconclusive: polynomial gcd verification failed")
    chain = [primitive(p, budget)]
    if len(p) == 1:
        return chain
    chain.append(primitive(derivative(p), budget))
    while True:
        _, r = divide(chain[-2], chain[-1], budget)
        if r == (0,):
            return chain
        chain.append(primitive([-c for c in r], budget))


def variations(chain, x, budget):
    signs = []
    for p in chain:
        budget.spend(len(p))
        y = evaluate(p, x)
        if y:
            signs.append(1 if y > 0 else -1)
    return sum(a != b for a, b in zip(signs, signs[1:]))


def side_sign(p, x, direction, budget):
    while True:
        budget.spend(len(p))
        v = evaluate(p, x)
        if v:
            return 1 if v > 0 else -1
        if len(p) == 1:
            return 0
        p = tuple(direction*c for c in derivative(p))


def negative_witness(polynomials, start, end, budget):
    """Find t in [start,end] where every p(t)<0, or prove none exists.

    Resource exhaustion is an exception, never a no-overlap result.
    """
    ps = [guard(p, budget) for p in polynomials]
    if any(p == (0,) or (len(p) == 1 and p[0] >= 0) for p in ps):
        return None
    ps = [p for p in ps if len(p) > 1]
    if not ps:
        return start
    if start >= end:
        raise ValueError("Expected a positive interval")
    # Cheap interval Horner bounds avoid algebraic work on well-separated paths.
    def all_negative(t):
        budget.spend(sum(map(len, ps)))
        return all(evaluate(p, t) < 0 for p in ps)

    mid = (start + end)/2
    if all_negative(mid):
        return mid
    for p in ps:
        lo = hi = p[-1]
        for c in reversed(p[:-1]):
            budget.spend(4)
            vals = (lo*start, lo*end, hi*start, hi*end)
            lo, hi = min(vals)+c, max(vals)+c
        if lo >= 0:
            return None
    product = (F(1),)
    for p in ps:
        product = multiply(product, p, budget)
    chain = sturm(product, budget)
    stack = [(start, end)]
    while stack:
        a, b = stack.pop()
        budget.spend()
        if max(a.denominator.bit_length(), b.denominator.bit_length()) > 16384:
            raise PolynomialLimit("Inconclusive: root separation limit exceeded")
        m = (a+b)/2
        if all_negative(m):
            return m
        for x, side in ((a, 1), (b, -1)):
            if all(side_sign(p, x, side, budget) < 0 for p in ps):
                if all_negative(x):
                    return x
                # The one-sided sign proof ensures a rational witness exists.
                y = m
                while not all_negative(y):
                    budget.spend()
                    y = (x+y)/2
                    if y.denominator.bit_length() > 16384:
                        raise PolynomialLimit("Inconclusive: witness separation limit exceeded")
                return y
        roots = variations(chain, a, budget) - variations(chain, b, budget) - (evaluate(chain[0], b) == 0)
        if roots > 1:
            stack.extend(((m, b), (a, m)))
    return None


def bezier_power(values):
    a, b, c, d = map(F, values)
    return trim((a, 3*(b-a), 3*(a-2*b+c), -a+3*b-3*c+d))


def restrict(p, start, end):
    """p(start + (end-start)*u), without numerical approximation."""
    out = (F(0),)
    for c in reversed(p):
        result = [F(0)]*(len(out)+1)
        for i, x in enumerate(out):
            result[i] += start*x
            result[i+1] += (end-start)*x
        result[0] += c
        out = trim(result)
    return out
