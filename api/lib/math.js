// api/lib/math.js — a real expression evaluator.
//
// WHY THIS EXISTS
// ────────────────
// Two calculators existed and both were wrong:
//   · api/server.js   — `String(expr).replace(/[^0-9+\-*/.()% ]/g,'')` then
//     `new Function(...)`. `sqrt(2)` became `(2)`; `sin(30)` became `(30)`.
//   · public_html/hivv-tools.py — `eval()` with a regex-cleaned string. Works,
//     but `eval` on model output is a code-execution primitive wearing a
//     calculator's clothes.
//
// This module parses the expression with a hand-written recursive-descent
// parser and evaluates it over plain numbers. There is NO `eval`, NO
// `new Function`, and NO property access — the grammar simply cannot
// express anything but arithmetic.
//
// Grammar (precedence low → high):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/' | '%' | 'imul') unary)*
//   unary   := ('+' | '-') unary | power
//   power   := atom ('^' unary)?            ← right-associative
//   atom    := number | constant | func '(' args ')' | '(' expr ')'
//
// Examples:
//   evaluate('2+2')                     → 4
//   evaluate('sqrt(2)')                 → 1.4142135623730951
//   evaluate('(1+2)*3^2')              → 27
//   evaluate('factorial(5)')            → 120
//   evaluate('hypot(3,4)')              → 5
//   evaluate('deg(asin(1))')            → 90
//
// Results are rounded to 12 significant digits so 0.1+0.2 prints 0.3 and
// not 0.30000000000000004 — a model reading that back will otherwise
// "correct" it into a wrong answer.

const MAX_LEN = 4096;
const MAX_DEPTH = 64;

// ── constants ────────────────────────────────────────────────────────────────
const CONSTANTS = {
    pi: Math.PI,
    π: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
    phi: (1 + Math.sqrt(5)) / 2,
};

// ── functions ────────────────────────────────────────────────────────────────
const FUNCS = {
    // arithmetic
    abs: Math.abs,
    sign: Math.sign,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    trunc: Math.trunc,
    min: (...a) => Math.min(...a),
    max: (...a) => Math.max(...a),
    sum: (...a) => a.reduce((x, y) => x + y, 0),
    prod: (...a) => a.reduce((x, y) => x * y, 1),
    hypot: (...a) => Math.hypot(...a),
    gcd: (...a) => {
        const nums = a.map((n) => Math.abs(Math.trunc(n)));
        const gcd2 = (x, y) => (y === 0 ? x : gcd2(y, x % y));
        return nums.reduce((x, y) => gcd2(x, y));
    },
    lcm: (...a) => {
        const nums = a.map((n) => Math.abs(Math.trunc(n)));
        const gcd2 = (x, y) => (y === 0 ? x : gcd2(y, x % y));
        return nums.reduce((x, y) => (x / gcd2(x, y)) * y);
    },
    factorial: (n) => {
        const k = Math.trunc(n);
        if (k < 0) throw new Error('factorial of a negative number');
        if (k > 170) throw new Error('factorial argument too large (max 170)');
        let r = 1;
        for (let i = 2; i <= k; i++) r *= i;
        return r;
    },
    // powers & logs
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    pow: Math.pow,
    exp: Math.exp,
    ln: Math.log,
    // log(x) is the natural log; log(x, base) is log-base — like a pocket calculator.
    log: (x, base) => (base === undefined ? Math.log(x) : Math.log(x) / Math.log(base)),
    log10: Math.log10,
    log2: Math.log2,
    // trigonometry (radians)
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    atan2: Math.atan2,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    // angle conversion
    deg: (x) => (x * 180) / Math.PI,
    rad: (x) => (x * Math.PI) / 180,
    // integers
    imul: (a, b) => Math.imul(Math.trunc(a), Math.trunc(b)),
    clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
};

// ── tokenizer ────────────────────────────────────────────────────────────────
function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        // number
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            const start = i;
            while (i < n && /[0-9]/.test(src[i])) i++;
            if (src[i] === '.') { i++; while (i < n && /[0-9]/.test(src[i])) i++; }
            if (src[i] === 'e' || src[i] === 'E') {
                const save = i;
                i++;
                if (src[i] === '+' || src[i] === '-') i++;
                if (/[0-9]/.test(src[i] || '')) { while (i < n && /[0-9]/.test(src[i])) i++; }
                else i = save;   // "2e" → 2, then 'e' as a constant
            }
            const raw = src.slice(start, i);
            const val = Number(raw);
            if (!Number.isFinite(val)) throw new Error(`bad number '${raw}'`);
            tokens.push({ t: 'num', v: val });
            continue;
        }
        // identifier
        if (/[A-Za-z_π]/.test(c)) {
            const start = i;
            while (i < n && /[A-Za-z0-9_π]/.test(src[i])) i++;
            const name = src.slice(start, i);
            tokens.push({ t: 'id', v: name });
            continue;
        }
        // operators / punctuation
        if ('+-*/%^(),'.includes(c)) { tokens.push({ t: c }); i++; continue; }
        throw new Error(`unexpected character '${c}'`);
    }
    tokens.push({ t: 'end' });
    return tokens;
}

// ── parser + evaluator (recursive descent) ───────────────────────────────────
class Parser {
    constructor(tokens) {
        this.toks = tokens;
        this.pos = 0;
        this.depth = 0;
    }
    peek() { return this.toks[this.pos]; }
    next() { return this.toks[this.pos++]; }
    expect(t) {
        const tok = this.next();
        if (tok.t !== t) throw new Error(`expected '${t}' but found '${tok.v !== undefined ? tok.v : tok.t}'`);
        return tok;
    }
    enter() {
        if (++this.depth > MAX_DEPTH) throw new Error('expression nested too deeply');
    }
    leave() { this.depth--; }

    parseExpr() {
        this.enter();
        let left = this.parseTerm();
        for (;;) {
            const t = this.peek();
            if (t.t === '+' || t.t === '-') {
                this.next();
                const right = this.parseTerm();
                left = t.t === '+' ? left + right : left - right;
            } else break;
        }
        this.leave();
        return left;
    }

    parseTerm() {
        this.enter();
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (t.t === '*' || t.t === '/' || t.t === '%') {
                this.next();
                const right = this.parseUnary();
                if (t.t === '*') left *= right;
                else if (t.t === '/') {
                    if (right === 0) throw new Error('division by zero');
                    left /= right;
                } else {
                    if (right === 0) throw new Error('modulo by zero');
                    left %= right;
                }
            } else break;
        }
        this.leave();
        return left;
    }

    parseUnary() {
        this.enter();
        const t = this.peek();
        if (t.t === '-') { this.next(); const v = this.parseUnary(); this.leave(); return -v; }
        if (t.t === '+') { this.next(); const v = this.parseUnary(); this.leave(); return v; }
        const v = this.parsePower();
        this.leave();
        return v;
    }

    parsePower() {
        this.enter();
        const base = this.parseAtom();
        const t = this.peek();
        if (t.t === '^') {
            this.next();
            const exp = this.parseUnary();     // right-associative
            this.leave();
            return Math.pow(base, exp);
        }
        this.leave();
        return base;
    }

    parseAtom() {
        const tok = this.next();
        if (tok.t === 'num') return tok.v;
        if (tok.t === '(') {
            const v = this.parseExpr();
            this.expect(')');
            return v;
        }
        if (tok.t === 'id') {
            const name = tok.v;
            const lower = name.toLowerCase();
            if (this.peek().t === '(') {
                this.next();               // consume '('
                const args = [];
                if (this.peek().t !== ')') {
                    for (;;) {
                        args.push(this.parseExpr());
                        if (this.peek().t === ',') { this.next(); continue; }
                        break;
                    }
                }
                this.expect(')');
                const fn = FUNCS[lower];
                if (!fn) throw new Error(`unknown function '${name}'`);
                return fn(...args);
            }
            if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
            if (Object.prototype.hasOwnProperty.call(CONSTANTS, lower)) return CONSTANTS[lower];
            throw new Error(`unknown name '${name}'`);
        }
        throw new Error(`unexpected '${tok.v !== undefined ? tok.v : tok.t}'`);
    }
}

// ── result shaping ──────────────────────────────────────────────────────────

// 12 significant digits: enough for any human/AI answer, short of the
// float-noise tail (0.30000000000000004 → 0.3).
function tidy(n) {
    if (!Number.isFinite(n)) return n;
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return n;
    const r = Number(n.toPrecision(12));
    return Object.is(r, -0) ? 0 : r;
}

/**
 * Evaluate a math expression.
 * @param {string} expr
 * @returns {{ ok: true, result: number, expression: string }
 *          | { ok: false, error: string, expression: string }}
 */
function evaluate(expr) {
    const src = String(expr == null ? '' : expr).trim();
    if (!src) return { ok: false, error: 'expression is empty', expression: src };
    if (src.length > MAX_LEN) return { ok: false, error: `expression too long (>${MAX_LEN} chars)`, expression: src.slice(0, 80) };
    try {
        const parser = new Parser(tokenize(src));
        const value = parser.parseExpr();
        const end = parser.peek();
        if (end.t !== 'end') throw new Error(`unexpected '${end.v !== undefined ? end.v : end.t}'`);
        if (!Number.isFinite(value)) {
            if (Number.isNaN(value)) {
                return { ok: false, error: 'math domain error (e.g. the square root of a negative number)', expression: src };
            }
            return { ok: false, error: 'result overflowed to infinity', expression: src };
        }
        return { ok: true, result: tidy(value), expression: src };
    } catch (e) {
        return { ok: false, error: String(e.message || e), expression: src };
    }
}

/** The function names this evaluator understands (for tool descriptions). */
function functionNames() {
    return Object.keys(FUNCS).sort();
}

module.exports = { evaluate, functionNames, CONSTANTS, FUNCS, MAX_LEN };
