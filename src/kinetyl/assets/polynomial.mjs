/* Exact rational sign feasibility. MIT. Coefficients use ascending powers.
 * No approximate roots or sampled clearance claims. A returned witness is an
 * actual rational time; resource limits throw, never imply no intersection.
 */
export class PolynomialLimit extends Error {}

export function polynomialTools(Q) {
  const Z = new Q(0n), O = new Q(1n), T = new Q(2n);
  const abs = n => n < 0n ? -n : n;
  const bits = n => abs(n).toString(2).length;
  function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; }
  const zero = p => p.length === 1 && p[0].eq(Z);
  function trim(p) { const out = [...p]; while (out.length > 1 && out.at(-1).eq(Z)) out.pop(); return out.length ? out : [Z]; }
  function guard(p, budget) {
    budget.spend(p.length);
    if (p.length > 13 || p.some(c => Math.max(bits(c.n), bits(c.d)) > 16384)) throw new PolynomialLimit('Inconclusive: polynomial arithmetic limit exceeded');
    return trim(p);
  }
  function evaluate(p, x) { let value = Z; for (let i = p.length - 1; i >= 0; i--) value = value.mul(x).add(p[i]); return value; }
  function derivative(p) { return trim(p.slice(1).map((c, i) => c.mul(new Q(BigInt(i + 1))))); }
  function add(a, b) { return trim(Array.from({length: Math.max(a.length, b.length)}, (_, i) => (a[i] ?? Z).add(b[i] ?? Z))); }
  function multiply(a, b, budget) {
    const out = Array(a.length + b.length - 1).fill(Z);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { budget.spend(); out[i + j] = out[i + j].add(a[i].mul(b[j])); }
    return guard(out, budget);
  }
  function primitive(input, budget) {
    const p = guard(input, budget); let denominator = 1n;
    for (const c of p) {
      denominator = denominator / gcd(denominator, c.d) * c.d;
      if (bits(denominator) > 16384) throw new PolynomialLimit('Inconclusive: polynomial denominator limit exceeded');
    }
    const ints = p.map(c => c.n * (denominator / c.d)); let divisor = 0n;
    for (const c of ints) divisor = gcd(divisor, c);
    return guard(ints.map(c => new Q(c / (divisor || 1n))), budget);
  }
  function divide(first, second, budget) {
    let a = trim(first); const b = trim(second);
    if (zero(b)) throw new Error('Zero polynomial divisor');
    const quotient = Array(Math.max(1, a.length - b.length + 1)).fill(Z);
    while (a.length >= b.length && !zero(a)) {
      const k = a.length - b.length, value = a.at(-1).div(b.at(-1)); quotient[k] = value;
      for (let i = 0; i < b.length; i++) { budget.spend(); a[k + i] = a[k + i].sub(value.mul(b[i])); }
      a = guard(a, budget);
    }
    return [guard(quotient, budget), guard(a, budget)];
  }
  function sturm(input, budget) {
    let p = primitive(input, budget), a = p, b = derivative(p);
    while (!zero(b)) { const [, remainder] = divide(a, b, budget); a = b; b = primitive(remainder, budget); }
    const [squarefree, remainder] = divide(p, a, budget);
    if (!zero(remainder)) throw new Error('Invalid square-free polynomial remainder');
    p = squarefree; const chain = [primitive(p, budget)];
    if (p.length === 1) return chain;
    chain.push(primitive(derivative(p), budget));
    while (true) {
      const [, r] = divide(chain.at(-2), chain.at(-1), budget);
      if (zero(r)) return chain;
      chain.push(primitive(r.map(c => c.neg()), budget));
    }
  }
  function variations(chain, x, budget) {
    const signs = [];
    for (const p of chain) { budget.spend(p.length); const s = evaluate(p, x).cmp(Z); if (s) signs.push(s); }
    return signs.slice(1).filter((s, i) => s !== signs[i]).length;
  }
  function sideSign(input, x, direction, budget) {
    let p = input;
    while (true) {
      budget.spend(p.length); const s = evaluate(p, x).cmp(Z);
      if (s) return s;
      if (p.length === 1) return 0;
      p = derivative(p).map(c => direction > 0 ? c : c.neg());
    }
  }
  function negativeWitness(polynomials, start, end, budget) {
    let ps = polynomials.map(p => guard(p, budget));
    if (ps.some(p => p.length === 1 && p[0].cmp(Z) >= 0)) return null;
    ps = ps.filter(p => p.length > 1);
    if (!ps.length) return start;
    if (start.cmp(end) >= 0) throw new Error('Expected a positive polynomial interval');
    function allNegative(t) { budget.spend(ps.reduce((sum, p) => sum + p.length, 0)); return ps.every(p => evaluate(p, t).cmp(Z) < 0); }
    const mid = start.add(end).div(T);
    if (allNegative(mid)) return mid;
    // Interval Horner bounds cheaply exclude well-separated paths.
    for (const p of ps) {
      let lo = p.at(-1), hi = lo;
      for (let i = p.length - 2; i >= 0; i--) {
        budget.spend(4); const values = [lo.mul(start), lo.mul(end), hi.mul(start), hi.mul(end)].sort((a, b) => a.cmp(b));
        lo = values[0].add(p[i]); hi = values.at(-1).add(p[i]);
      }
      if (lo.cmp(Z) >= 0) return null;
    }
    let product = [O]; for (const p of ps) product = multiply(product, p, budget);
    const chain = sturm(product, budget), stack = [[start, end]];
    while (stack.length) {
      const [a, b] = stack.pop(); budget.spend();
      if (Math.max(bits(a.d), bits(b.d)) > 16384) throw new PolynomialLimit('Inconclusive: root separation limit exceeded');
      const m = a.add(b).div(T);
      if (allNegative(m)) return m;
      for (const [x, side] of [[a, 1], [b, -1]]) {
        if (ps.every(p => sideSign(p, x, side, budget) < 0)) {
          if (allNegative(x)) return x;
          // The one-sided Taylor signs prove a rational witness exists nearby.
          let y = m;
          while (!allNegative(y)) {
            budget.spend(); y = x.add(y).div(T);
            if (bits(y.d) > 16384) throw new PolynomialLimit('Inconclusive: witness separation limit exceeded');
          }
          return y;
        }
      }
      const roots = variations(chain, a, budget) - variations(chain, b, budget) - (evaluate(chain[0], b).eq(Z) ? 1 : 0);
      if (roots > 1) stack.push([m, b], [a, m]);
    }
    return null;
  }
  function bezierPower([a, b, c, d]) {
    const three = new Q(3n);
    return trim([a, b.sub(a).mul(three), a.sub(b.mul(T)).add(c).mul(three), a.neg().add(b.mul(three)).sub(c.mul(three)).add(d)]);
  }
  function restrict(p, start, end) {
    let out = [Z]; const delta = end.sub(start);
    for (let j = p.length - 1; j >= 0; j--) {
      const result = Array(out.length + 1).fill(Z);
      for (let i = 0; i < out.length; i++) { result[i] = result[i].add(start.mul(out[i])); result[i + 1] = result[i + 1].add(delta.mul(out[i])); }
      result[0] = result[0].add(p[j]); out = trim(result);
    }
    return out;
  }
  return {negativeWitness, bezierPower, restrict, evaluate, add};
}
