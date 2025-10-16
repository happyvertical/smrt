const tn = 1, en = 2, nn = 16, rn = 1, sn = 4, ln = 8, fn = 16, un = 2, E = Symbol(), qt = !1;
var he = Array.isArray, pe = Array.prototype.indexOf, an = Array.from, Ot = Object.defineProperty, wt = Object.getOwnPropertyDescriptor, de = Object.prototype, we = Array.prototype, Ee = Object.getPrototypeOf;
function ge(t) {
  for (var e = 0; e < t.length; e++)
    t[e]();
}
function Ut() {
  var t, e, n = new Promise((r, s) => {
    t = r, e = s;
  });
  return { promise: n, resolve: t, reject: e };
}
const b = 2, Yt = 4, kt = 8, K = 16, j = 32, X = 64, Bt = 128, R = 256, ut = 512, g = 1024, T = 2048, L = 4096, F = 8192, $ = 16384, Vt = 32768, Ht = 65536, Ct = 1 << 17, ye = 1 << 18, _t = 1 << 19, me = 1 << 20, mt = 1 << 21, vt = 1 << 22, B = 1 << 23, Et = Symbol("$state"), on = Symbol("legacy props"), W = new class extends Error {
  name = "StaleReactionError";
  message = "The reaction that called `getAbortSignal()` was re-run or destroyed";
}();
function be() {
  throw new Error("https://svelte.dev/e/async_derived_orphan");
}
function xe() {
  throw new Error("https://svelte.dev/e/effect_update_depth_exceeded");
}
function _n(t) {
  throw new Error("https://svelte.dev/e/props_invalid_value");
}
function Te() {
  throw new Error("https://svelte.dev/e/state_descriptors_fixed");
}
function ke() {
  throw new Error("https://svelte.dev/e/state_prototype_fixed");
}
function Ae() {
  throw new Error("https://svelte.dev/e/state_unsafe_mutation");
}
function Kt(t) {
  return t === this.v;
}
function Re(t, e) {
  return t != t ? e == e : t !== e || t !== null && typeof t == "object" || typeof t == "function";
}
function Gt(t) {
  return !Re(t, this.v);
}
let Se = !1, O = null;
function at(t) {
  O = t;
}
function vn(t, e = !1, n) {
  O = {
    p: O,
    c: null,
    e: null,
    s: t,
    x: null,
    l: null
  };
}
function hn(t) {
  var e = (
    /** @type {ComponentContext} */
    O
  ), n = e.e;
  if (n !== null) {
    e.e = null;
    for (var r of n)
      Ke(r);
  }
  return O = e.p, /** @type {T} */
  {};
}
function Wt() {
  return !0;
}
let Y = [];
function Zt() {
  var t = Y;
  Y = [], ge(t);
}
function Pe(t) {
  if (Y.length === 0 && !et) {
    var e = Y;
    queueMicrotask(() => {
      e === Y && Zt();
    });
  }
  Y.push(t);
}
function Ie() {
  for (; Y.length > 0; )
    Zt();
}
const Oe = /* @__PURE__ */ new WeakMap();
function Ce(t) {
  var e = v;
  if (e === null)
    return _.f |= B, t;
  if ((e.f & Vt) === 0) {
    if ((e.f & Bt) === 0)
      throw !e.parent && t instanceof Error && zt(t), t;
    e.b.error(t);
  } else
    ot(t, e);
}
function ot(t, e) {
  for (; e !== null; ) {
    if ((e.f & Bt) !== 0)
      try {
        e.b.error(t);
        return;
      } catch (n) {
        t = n;
      }
    e = e.parent;
  }
  throw t instanceof Error && zt(t), t;
}
function zt(t) {
  const e = Oe.get(t);
  e && (Ot(t, "message", {
    value: e.message
  }), Ot(t, "stack", {
    value: e.stack
  }));
}
const it = /* @__PURE__ */ new Set();
let w = null, gt = null, A = null, Nt = /* @__PURE__ */ new Set(), S = [], ht = null, bt = !1, et = !1;
class nt {
  /**
   * The current values of any sources that are updated in this batch
   * They keys of this map are identical to `this.#previous`
   * @type {Map<Source, any>}
   */
  current = /* @__PURE__ */ new Map();
  /**
   * The values of any sources that are updated in this batch _before_ those updates took place.
   * They keys of this map are identical to `this.#current`
   * @type {Map<Source, any>}
   */
  #n = /* @__PURE__ */ new Map();
  /**
   * When the batch is committed (and the DOM is updated), we need to remove old branches
   * and append new ones by calling the functions added inside (if/each/key/etc) blocks
   * @type {Set<() => void>}
   */
  #r = /* @__PURE__ */ new Set();
  /**
   * The number of async effects that are currently in flight
   */
  #t = 0;
  /**
   * A deferred that resolves when the batch is committed, used with `settled()`
   * TODO replace with Promise.withResolvers once supported widely enough
   * @type {{ promise: Promise<void>, resolve: (value?: any) => void, reject: (reason: unknown) => void } | null}
   */
  #u = null;
  /**
   * Async effects inside a newly-created `<svelte:boundary>`
   * — these do not prevent the batch from committing
   * @type {Effect[]}
   */
  #s = [];
  /**
   * Template effects and `$effect.pre` effects, which run when
   * a batch is committed
   * @type {Effect[]}
   */
  #l = [];
  /**
   * The same as `#render_effects`, but for `$effect` (which runs after)
   * @type {Effect[]}
   */
  #e = [];
  /**
   * Block effects, which may need to re-run on subsequent flushes
   * in order to update internal sources (e.g. each block items)
   * @type {Effect[]}
   */
  #f = [];
  /**
   * Deferred effects (which run after async work has completed) that are DIRTY
   * @type {Effect[]}
   */
  #a = [];
  /**
   * Deferred effects that are MAYBE_DIRTY
   * @type {Effect[]}
   */
  #o = [];
  /**
   * A set of branches that still exist, but will be destroyed when this batch
   * is committed — we skip over these during `process`
   * @type {Set<Effect>}
   */
  skipped_effects = /* @__PURE__ */ new Set();
  /**
   *
   * @param {Effect[]} root_effects
   */
  process(e) {
    S = [], gt = null, this.apply();
    for (const l of e)
      this.#c(l);
    if (this.#t === 0) {
      var n = A;
      this.#_();
      var r = this.#l, s = this.#e;
      this.#l = [], this.#e = [], this.#f = [], gt = this, w = null, A = n, Dt(r), Dt(s), gt = null, this.#u?.resolve();
    } else
      this.#i(this.#l), this.#i(this.#e), this.#i(this.#f);
    A = null;
    for (const l of this.#s)
      st(l);
    this.#s = [];
  }
  /**
   * Traverse the effect tree, executing effects or stashing
   * them for later execution as appropriate
   * @param {Effect} root
   */
  #c(e) {
    e.f ^= g;
    for (var n = e.first; n !== null; ) {
      var r = n.f, s = (r & (j | X)) !== 0, l = s && (r & g) !== 0, i = l || (r & F) !== 0 || this.skipped_effects.has(n);
      if (!i && n.fn !== null) {
        s ? n.f ^= g : (r & Yt) !== 0 ? this.#e.push(n) : (r & g) === 0 && ((r & vt) !== 0 && n.b?.is_pending() ? this.#s.push(n) : pt(n) && ((n.f & K) !== 0 && this.#f.push(n), st(n)));
        var a = n.first;
        if (a !== null) {
          n = a;
          continue;
        }
      }
      var f = n.parent;
      for (n = n.next; n === null && f !== null; )
        n = f.next, f = f.parent;
    }
  }
  /**
   * @param {Effect[]} effects
   */
  #i(e) {
    for (const n of e)
      ((n.f & T) !== 0 ? this.#a : this.#o).push(n), m(n, g);
    e.length = 0;
  }
  /**
   * Associate a change to a given source with the current
   * batch, noting its previous and current values
   * @param {Source} source
   * @param {any} value
   */
  capture(e, n) {
    this.#n.has(e) || this.#n.set(e, n), this.current.set(e, e.v), A?.set(e, e.v);
  }
  activate() {
    w = this;
  }
  deactivate() {
    w = null, A = null;
  }
  flush() {
    if (S.length > 0) {
      if (this.activate(), Xt(), w !== null && w !== this)
        return;
    } else this.#t === 0 && this.#_();
    this.deactivate();
    for (const e of Nt)
      if (Nt.delete(e), e(), w !== null)
        break;
  }
  /**
   * Append and remove branches to/from the DOM
   */
  #_() {
    for (const e of this.#r)
      e();
    if (this.#r.clear(), it.size > 1) {
      this.#n.clear();
      let e = !0;
      for (const n of it) {
        if (n === this) {
          e = !1;
          continue;
        }
        const r = [];
        for (const [l, i] of this.current) {
          if (n.current.has(l))
            if (e && i !== n.current.get(l))
              n.current.set(l, i);
            else
              continue;
          r.push(l);
        }
        if (r.length === 0)
          continue;
        const s = [...n.current.keys()].filter((l) => !this.current.has(l));
        if (s.length > 0) {
          for (const l of r)
            $t(l, s);
          if (S.length > 0) {
            w = n, n.apply();
            for (const l of S)
              n.#c(l);
            S = [], n.deactivate();
          }
        }
      }
      w = null;
    }
    it.delete(this);
  }
  increment() {
    this.#t += 1;
  }
  decrement() {
    this.#t -= 1;
    for (const e of this.#a)
      m(e, T), H(e);
    for (const e of this.#o)
      m(e, L), H(e);
    this.flush();
  }
  /** @param {() => void} fn */
  add_callback(e) {
    this.#r.add(e);
  }
  settled() {
    return (this.#u ??= Ut()).promise;
  }
  static ensure() {
    if (w === null) {
      const e = w = new nt();
      it.add(w), et || nt.enqueue(() => {
        w === e && e.flush();
      });
    }
    return w;
  }
  /** @param {() => void} task */
  static enqueue(e) {
    Pe(e);
  }
  apply() {
  }
}
function Ne(t) {
  var e = et;
  et = !0;
  try {
    for (var n; ; ) {
      if (Ie(), S.length === 0 && (w?.flush(), S.length === 0))
        return ht = null, /** @type {T} */
        n;
      Xt();
    }
  } finally {
    et = e;
  }
}
function Xt() {
  var t = Z;
  bt = !0;
  try {
    var e = 0;
    for (Mt(!0); S.length > 0; ) {
      var n = nt.ensure();
      if (e++ > 1e3) {
        var r, s;
        De();
      }
      n.process(S), D.clear();
    }
  } finally {
    bt = !1, Mt(t), ht = null;
  }
}
function De() {
  try {
    xe();
  } catch (t) {
    ot(t, ht);
  }
}
let U = null;
function Dt(t) {
  var e = t.length;
  if (e !== 0) {
    for (var n = 0; n < e; ) {
      var r = t[n++];
      if ((r.f & ($ | F)) === 0 && pt(r) && (U = [], st(r), r.deps === null && r.first === null && r.nodes_start === null && (r.teardown === null && r.ac === null ? fe(r) : r.fn = null), U?.length > 0)) {
        D.clear();
        for (const s of U)
          st(s);
        U = [];
      }
    }
    U = null;
  }
}
function $t(t, e) {
  if (t.reactions !== null)
    for (const n of t.reactions) {
      const r = n.f;
      (r & b) !== 0 ? $t(
        /** @type {Derived} */
        n,
        e
      ) : (r & (vt | K)) !== 0 && Jt(n, e) && (m(n, T), H(
        /** @type {Effect} */
        n
      ));
    }
}
function Jt(t, e) {
  if (t.deps !== null) {
    for (const n of t.deps)
      if (e.includes(n) || (n.f & b) !== 0 && Jt(
        /** @type {Derived} */
        n,
        e
      ))
        return !0;
  }
  return !1;
}
function H(t) {
  for (var e = ht = t; e.parent !== null; ) {
    e = e.parent;
    var n = e.f;
    if (bt && e === v && (n & K) !== 0)
      return;
    if ((n & (X | j)) !== 0) {
      if ((n & g) === 0) return;
      e.f ^= g;
    }
  }
  S.push(e);
}
function Fe(t, e, n) {
  const r = Qt;
  if (e.length === 0) {
    n(t.map(r));
    return;
  }
  var s = w, l = (
    /** @type {Effect} */
    v
  ), i = Me();
  Promise.all(e.map((a) => /* @__PURE__ */ je(a))).then((a) => {
    i();
    try {
      n([...t.map(r), ...a]);
    } catch (f) {
      (l.f & $) === 0 && ot(f, l);
    }
    s?.deactivate(), xt();
  }).catch((a) => {
    ot(a, l);
  });
}
function Me() {
  var t = v, e = _, n = O, r = w;
  return function() {
    z(t), M(e), at(n), r?.activate();
  };
}
function xt() {
  z(null), M(null), at(null);
}
// @__NO_SIDE_EFFECTS__
function Qt(t) {
  var e = b | T, n = _ !== null && (_.f & b) !== 0 ? (
    /** @type {Derived} */
    _
  ) : null;
  return v === null || n !== null && (n.f & R) !== 0 ? e |= R : v.f |= _t, {
    ctx: O,
    deps: null,
    effects: null,
    equals: Kt,
    f: e,
    fn: t,
    reactions: null,
    rv: 0,
    v: (
      /** @type {V} */
      E
    ),
    wv: 0,
    parent: n ?? v,
    ac: null
  };
}
// @__NO_SIDE_EFFECTS__
function je(t, e) {
  let n = (
    /** @type {Effect | null} */
    v
  );
  n === null && be();
  var r = (
    /** @type {Boundary} */
    n.b
  ), s = (
    /** @type {Promise<V>} */
    /** @type {unknown} */
    void 0
  ), l = Rt(
    /** @type {V} */
    E
  ), i = !_, a = /* @__PURE__ */ new Map();
  return Ge(() => {
    var f = Ut();
    s = f.promise;
    try {
      Promise.resolve(t()).then(f.resolve, f.reject).then(xt);
    } catch (d) {
      f.reject(d), xt();
    }
    var u = (
      /** @type {Batch} */
      w
    ), o = r.is_pending();
    i && (r.update_pending_count(1), o || (u.increment(), a.get(u)?.reject(W), a.delete(u), a.set(u, f)));
    const c = (d, h = void 0) => {
      if (o || u.activate(), h)
        h !== W && (l.f |= B, Tt(l, h));
      else {
        (l.f & B) !== 0 && (l.f ^= B), Tt(l, d);
        for (const [p, J] of a) {
          if (a.delete(p), p === u) break;
          J.reject(W);
        }
      }
      i && (r.update_pending_count(-1), o || u.decrement());
    };
    f.promise.then(c, (d) => c(null, d || "unknown"));
  }), He(() => {
    for (const f of a.values())
      f.reject(W);
  }), new Promise((f) => {
    function u(o) {
      function c() {
        o === s ? f(l) : u(s);
      }
      o.then(c, c);
    }
    u(s);
  });
}
// @__NO_SIDE_EFFECTS__
function pn(t) {
  const e = /* @__PURE__ */ Qt(t);
  return e.equals = Gt, e;
}
function te(t) {
  var e = t.effects;
  if (e !== null) {
    t.effects = null;
    for (var n = 0; n < e.length; n += 1)
      lt(
        /** @type {Effect} */
        e[n]
      );
  }
}
function Le(t) {
  for (var e = t.parent; e !== null; ) {
    if ((e.f & b) === 0)
      return (
        /** @type {Effect} */
        e
      );
    e = e.parent;
  }
  return null;
}
function At(t) {
  var e, n = v;
  z(Le(t));
  try {
    te(t), e = _e(t);
  } finally {
    z(n);
  }
  return e;
}
function ee(t) {
  var e = At(t);
  if (t.equals(e) || (t.v = e, t.wv = oe()), !ft)
    if (A !== null)
      A.set(t, t.v);
    else {
      var n = (N || (t.f & R) !== 0) && t.deps !== null ? L : g;
      m(t, n);
    }
}
const D = /* @__PURE__ */ new Map();
function Rt(t, e) {
  var n = {
    f: 0,
    // TODO ideally we could skip this altogether, but it causes type errors
    v: t,
    reactions: null,
    equals: Kt,
    rv: 0,
    wv: 0
  };
  return n;
}
// @__NO_SIDE_EFFECTS__
function C(t, e) {
  const n = Rt(t);
  return Xe(n), n;
}
// @__NO_SIDE_EFFECTS__
function dn(t, e = !1, n = !0) {
  const r = Rt(t);
  return e || (r.equals = Gt), r;
}
function q(t, e, n = !1) {
  _ !== null && // since we are untracking the function inside `$inspect.with` we need to add this check
  // to ensure we error if state is set inside an inspect effect
  (!P || (_.f & Ct) !== 0) && Wt() && (_.f & (b | K | vt | Ct)) !== 0 && !I?.includes(t) && Ae();
  let r = n ? Q(e) : e;
  return Tt(t, r);
}
function Tt(t, e) {
  if (!t.equals(e)) {
    var n = t.v;
    ft ? D.set(t, e) : D.set(t, n), t.v = e;
    var r = nt.ensure();
    r.capture(t, n), (t.f & b) !== 0 && ((t.f & T) !== 0 && At(
      /** @type {Derived} */
      t
    ), m(t, (t.f & R) === 0 ? g : L)), t.wv = oe(), ne(t, T), v !== null && (v.f & g) !== 0 && (v.f & (j | X)) === 0 && (k === null ? $e([t]) : k.push(t));
  }
  return e;
}
function yt(t) {
  q(t, t.v + 1);
}
function ne(t, e) {
  var n = t.reactions;
  if (n !== null)
    for (var r = n.length, s = 0; s < r; s++) {
      var l = n[s], i = l.f, a = (i & T) === 0;
      a && m(l, e), (i & b) !== 0 ? ne(
        /** @type {Derived} */
        l,
        L
      ) : a && ((i & K) !== 0 && U !== null && U.push(
        /** @type {Effect} */
        l
      ), H(
        /** @type {Effect} */
        l
      ));
    }
}
function Q(t) {
  if (typeof t != "object" || t === null || Et in t)
    return t;
  const e = Ee(t);
  if (e !== de && e !== we)
    return t;
  var n = /* @__PURE__ */ new Map(), r = he(t), s = /* @__PURE__ */ C(0), l = V, i = (a) => {
    if (V === l)
      return a();
    var f = _, u = V;
    M(null), Lt(l);
    var o = a();
    return M(f), Lt(u), o;
  };
  return r && n.set("length", /* @__PURE__ */ C(
    /** @type {any[]} */
    t.length
  )), new Proxy(
    /** @type {any} */
    t,
    {
      defineProperty(a, f, u) {
        (!("value" in u) || u.configurable === !1 || u.enumerable === !1 || u.writable === !1) && Te();
        var o = n.get(f);
        return o === void 0 ? o = i(() => {
          var c = /* @__PURE__ */ C(u.value);
          return n.set(f, c), c;
        }) : q(o, u.value, !0), !0;
      },
      deleteProperty(a, f) {
        var u = n.get(f);
        if (u === void 0) {
          if (f in a) {
            const o = i(() => /* @__PURE__ */ C(E));
            n.set(f, o), yt(s);
          }
        } else
          q(u, E), yt(s);
        return !0;
      },
      get(a, f, u) {
        if (f === Et)
          return t;
        var o = n.get(f), c = f in a;
        if (o === void 0 && (!c || wt(a, f)?.writable) && (o = i(() => {
          var h = Q(c ? a[f] : E), p = /* @__PURE__ */ C(h);
          return p;
        }), n.set(f, o)), o !== void 0) {
          var d = tt(o);
          return d === E ? void 0 : d;
        }
        return Reflect.get(a, f, u);
      },
      getOwnPropertyDescriptor(a, f) {
        var u = Reflect.getOwnPropertyDescriptor(a, f);
        if (u && "value" in u) {
          var o = n.get(f);
          o && (u.value = tt(o));
        } else if (u === void 0) {
          var c = n.get(f), d = c?.v;
          if (c !== void 0 && d !== E)
            return {
              enumerable: !0,
              configurable: !0,
              value: d,
              writable: !0
            };
        }
        return u;
      },
      has(a, f) {
        if (f === Et)
          return !0;
        var u = n.get(f), o = u !== void 0 && u.v !== E || Reflect.has(a, f);
        if (u !== void 0 || v !== null && (!o || wt(a, f)?.writable)) {
          u === void 0 && (u = i(() => {
            var d = o ? Q(a[f]) : E, h = /* @__PURE__ */ C(d);
            return h;
          }), n.set(f, u));
          var c = tt(u);
          if (c === E)
            return !1;
        }
        return o;
      },
      set(a, f, u, o) {
        var c = n.get(f), d = f in a;
        if (r && f === "length")
          for (var h = u; h < /** @type {Source<number>} */
          c.v; h += 1) {
            var p = n.get(h + "");
            p !== void 0 ? q(p, E) : h in a && (p = i(() => /* @__PURE__ */ C(E)), n.set(h + "", p));
          }
        if (c === void 0)
          (!d || wt(a, f)?.writable) && (c = i(() => /* @__PURE__ */ C(void 0)), q(c, Q(u)), n.set(f, c));
        else {
          d = c.v !== E;
          var J = i(() => Q(u));
          q(c, J);
        }
        var Pt = Reflect.getOwnPropertyDescriptor(a, f);
        if (Pt?.set && Pt.set.call(o, u), !d) {
          if (r && typeof f == "string") {
            var It = (
              /** @type {Source<number>} */
              n.get("length")
            ), dt = Number(f);
            Number.isInteger(dt) && dt >= It.v && q(It, dt + 1);
          }
          yt(s);
        }
        return !0;
      },
      ownKeys(a) {
        tt(s);
        var f = Reflect.ownKeys(a).filter((c) => {
          var d = n.get(c);
          return d === void 0 || d.v !== E;
        });
        for (var [u, o] of n)
          o.v !== E && !(u in a) && f.push(u);
        return f;
      },
      setPrototypeOf() {
        ke();
      }
    }
  );
}
var wn, qe, Ue;
function En(t = "") {
  return document.createTextNode(t);
}
// @__NO_SIDE_EFFECTS__
function Ye(t) {
  return qe.call(t);
}
// @__NO_SIDE_EFFECTS__
function re(t) {
  return Ue.call(t);
}
function gn(t, e) {
  return /* @__PURE__ */ Ye(t);
}
function yn(t, e = 1, n = !1) {
  let r = t;
  for (; e--; )
    r = /** @type {TemplateNode} */
    /* @__PURE__ */ re(r);
  return r;
}
function mn(t) {
  t.textContent = "";
}
function bn() {
  return !1;
}
let Ft = !1;
function Be() {
  Ft || (Ft = !0, document.addEventListener(
    "reset",
    (t) => {
      Promise.resolve().then(() => {
        if (!t.defaultPrevented)
          for (
            const e of
            /**@type {HTMLFormElement} */
            t.target.elements
          )
            e.__on_r?.();
      });
    },
    // In the capture phase to guarantee we get noticed of it (no possiblity of stopPropagation)
    { capture: !0 }
  ));
}
function St(t) {
  var e = _, n = v;
  M(null), z(null);
  try {
    return t();
  } finally {
    M(e), z(n);
  }
}
function xn(t, e, n, r = n) {
  t.addEventListener(e, () => St(n));
  const s = t.__on_r;
  s ? t.__on_r = () => {
    s(), r(!0);
  } : t.__on_r = () => r(!0), Be();
}
function Ve(t, e) {
  var n = e.last;
  n === null ? e.last = e.first = t : (n.next = t, t.prev = n, e.last = t);
}
function G(t, e, n, r = !0) {
  var s = v;
  s !== null && (s.f & F) !== 0 && (t |= F);
  var l = {
    ctx: O,
    deps: null,
    nodes_start: null,
    nodes_end: null,
    f: t | T,
    first: null,
    fn: e,
    last: null,
    next: null,
    parent: s,
    b: s && s.b,
    prev: null,
    teardown: null,
    transitions: null,
    wv: 0,
    ac: null
  };
  if (n)
    try {
      st(l), l.f |= Vt;
    } catch (f) {
      throw lt(l), f;
    }
  else e !== null && H(l);
  if (r) {
    var i = l;
    if (n && i.deps === null && i.teardown === null && i.nodes_start === null && i.first === i.last && // either `null`, or a singular child
    (i.f & _t) === 0 && (i = i.first), i !== null && (i.parent = s, s !== null && Ve(i, s), _ !== null && (_.f & b) !== 0 && (t & X) === 0)) {
      var a = (
        /** @type {Derived} */
        _
      );
      (a.effects ??= []).push(i);
    }
  }
  return l;
}
function He(t) {
  const e = G(kt, null, !1);
  return m(e, g), e.teardown = t, e;
}
function Ke(t) {
  return G(Yt | me, t, !1);
}
function Ge(t) {
  return G(vt | _t, t, !0);
}
function Tn(t, e = 0) {
  return G(kt | e, t, !0);
}
function kn(t, e = [], n = []) {
  Fe(e, n, (r) => {
    G(kt, () => t(...r.map(tt)), !0);
  });
}
function An(t, e = 0) {
  var n = G(K | e, t, !0);
  return n;
}
function Rn(t, e = !0) {
  return G(j | _t, t, !0, e);
}
function se(t) {
  var e = t.teardown;
  if (e !== null) {
    const n = ft, r = _;
    jt(!0), M(null);
    try {
      e.call(null);
    } finally {
      jt(n), M(r);
    }
  }
}
function le(t, e = !1) {
  var n = t.first;
  for (t.first = t.last = null; n !== null; ) {
    const s = n.ac;
    s !== null && St(() => {
      s.abort(W);
    });
    var r = n.next;
    (n.f & X) !== 0 ? n.parent = null : lt(n, e), n = r;
  }
}
function We(t) {
  for (var e = t.first; e !== null; ) {
    var n = e.next;
    (e.f & j) === 0 && lt(e), e = n;
  }
}
function lt(t, e = !0) {
  var n = !1;
  (e || (t.f & ye) !== 0) && t.nodes_start !== null && t.nodes_end !== null && (Ze(
    t.nodes_start,
    /** @type {TemplateNode} */
    t.nodes_end
  ), n = !0), le(t, e && !n), ct(t, 0), m(t, $);
  var r = t.transitions;
  if (r !== null)
    for (const l of r)
      l.stop();
  se(t);
  var s = t.parent;
  s !== null && s.first !== null && fe(t), t.next = t.prev = t.teardown = t.ctx = t.deps = t.fn = t.nodes_start = t.nodes_end = t.ac = null;
}
function Ze(t, e) {
  for (; t !== null; ) {
    var n = t === e ? null : (
      /** @type {TemplateNode} */
      /* @__PURE__ */ re(t)
    );
    t.remove(), t = n;
  }
}
function fe(t) {
  var e = t.parent, n = t.prev, r = t.next;
  n !== null && (n.next = r), r !== null && (r.prev = n), e !== null && (e.first === t && (e.first = r), e.last === t && (e.last = n));
}
function Sn(t, e) {
  var n = [];
  ie(t, n, !0), ze(n, () => {
    lt(t), e && e();
  });
}
function ze(t, e) {
  var n = t.length;
  if (n > 0) {
    var r = () => --n || e();
    for (var s of t)
      s.out(r);
  } else
    e();
}
function ie(t, e, n) {
  if ((t.f & F) === 0) {
    if (t.f ^= F, t.transitions !== null)
      for (const i of t.transitions)
        (i.is_global || n) && e.push(i);
    for (var r = t.first; r !== null; ) {
      var s = r.next, l = (r.f & Ht) !== 0 || (r.f & j) !== 0;
      ie(r, e, l ? n : !1), r = s;
    }
  }
}
function Pn(t) {
  ue(t, !0);
}
function ue(t, e) {
  if ((t.f & F) !== 0) {
    t.f ^= F, (t.f & g) === 0 && (m(t, T), H(t));
    for (var n = t.first; n !== null; ) {
      var r = n.next, s = (n.f & Ht) !== 0 || (n.f & j) !== 0;
      ue(n, s ? e : !1), n = r;
    }
    if (t.transitions !== null)
      for (const l of t.transitions)
        (l.is_global || e) && l.in();
  }
}
let Z = !1;
function Mt(t) {
  Z = t;
}
let ft = !1;
function jt(t) {
  ft = t;
}
let _ = null, P = !1;
function M(t) {
  _ = t;
}
let v = null;
function z(t) {
  v = t;
}
let I = null;
function Xe(t) {
  _ !== null && (I === null ? I = [t] : I.push(t));
}
let y = null, x = 0, k = null;
function $e(t) {
  k = t;
}
let ae = 1, rt = 0, V = rt;
function Lt(t) {
  V = t;
}
let N = !1;
function oe() {
  return ++ae;
}
function pt(t) {
  var e = t.f;
  if ((e & T) !== 0)
    return !0;
  if ((e & L) !== 0) {
    var n = t.deps, r = (e & R) !== 0;
    if (n !== null) {
      var s, l, i = (e & ut) !== 0, a = r && v !== null && !N, f = n.length;
      if ((i || a) && (v === null || (v.f & $) === 0)) {
        var u = (
          /** @type {Derived} */
          t
        ), o = u.parent;
        for (s = 0; s < f; s++)
          l = n[s], (i || !l?.reactions?.includes(u)) && (l.reactions ??= []).push(u);
        i && (u.f ^= ut), a && o !== null && (o.f & R) === 0 && (u.f ^= R);
      }
      for (s = 0; s < f; s++)
        if (l = n[s], pt(
          /** @type {Derived} */
          l
        ) && ee(
          /** @type {Derived} */
          l
        ), l.wv > t.wv)
          return !0;
    }
    (!r || v !== null && !N) && m(t, g);
  }
  return !1;
}
function ce(t, e, n = !0) {
  var r = t.reactions;
  if (r !== null && !I?.includes(t))
    for (var s = 0; s < r.length; s++) {
      var l = r[s];
      (l.f & b) !== 0 ? ce(
        /** @type {Derived} */
        l,
        e,
        !1
      ) : e === l && (n ? m(l, T) : (l.f & g) !== 0 && m(l, L), H(
        /** @type {Effect} */
        l
      ));
    }
}
function _e(t) {
  var e = y, n = x, r = k, s = _, l = N, i = I, a = O, f = P, u = V, o = t.f;
  y = /** @type {null | Value[]} */
  null, x = 0, k = null, N = (o & R) !== 0 && (P || !Z || _ === null), _ = (o & (j | X)) === 0 ? t : null, I = null, at(t.ctx), P = !1, V = ++rt, t.ac !== null && (St(() => {
    t.ac.abort(W);
  }), t.ac = null);
  try {
    t.f |= mt;
    var c = (
      /** @type {Function} */
      t.fn
    ), d = c(), h = t.deps;
    if (y !== null) {
      var p;
      if (ct(t, x), h !== null && x > 0)
        for (h.length = x + y.length, p = 0; p < y.length; p++)
          h[x + p] = y[p];
      else
        t.deps = h = y;
      if (!N || // Deriveds that already have reactions can cleanup, so we still add them as reactions
      (o & b) !== 0 && /** @type {import('#client').Derived} */
      t.reactions !== null)
        for (p = x; p < h.length; p++)
          (h[p].reactions ??= []).push(t);
    } else h !== null && x < h.length && (ct(t, x), h.length = x);
    if (Wt() && k !== null && !P && h !== null && (t.f & (b | L | T)) === 0)
      for (p = 0; p < /** @type {Source[]} */
      k.length; p++)
        ce(
          k[p],
          /** @type {Effect} */
          t
        );
    return s !== null && s !== t && (rt++, k !== null && (r === null ? r = k : r.push(.../** @type {Source[]} */
    k))), (t.f & B) !== 0 && (t.f ^= B), d;
  } catch (J) {
    return Ce(J);
  } finally {
    t.f ^= mt, y = e, x = n, k = r, _ = s, N = l, I = i, at(a), P = f, V = u;
  }
}
function Je(t, e) {
  let n = e.reactions;
  if (n !== null) {
    var r = pe.call(n, t);
    if (r !== -1) {
      var s = n.length - 1;
      s === 0 ? n = e.reactions = null : (n[r] = n[s], n.pop());
    }
  }
  n === null && (e.f & b) !== 0 && // Destroying a child effect while updating a parent effect can cause a dependency to appear
  // to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
  // allows us to skip the expensive work of disconnecting and immediately reconnecting it
  (y === null || !y.includes(e)) && (m(e, L), (e.f & (R | ut)) === 0 && (e.f ^= ut), te(
    /** @type {Derived} **/
    e
  ), ct(
    /** @type {Derived} **/
    e,
    0
  ));
}
function ct(t, e) {
  var n = t.deps;
  if (n !== null)
    for (var r = e; r < n.length; r++)
      Je(t, n[r]);
}
function st(t) {
  var e = t.f;
  if ((e & $) === 0) {
    m(t, g);
    var n = v, r = Z;
    v = t, Z = !0;
    try {
      (e & K) !== 0 ? We(t) : le(t), se(t);
      var s = _e(t);
      t.teardown = typeof s == "function" ? s : null, t.wv = ae;
      var l;
      qt && Se && (t.f & T) !== 0 && t.deps;
    } finally {
      Z = r, v = n;
    }
  }
}
async function In() {
  await Promise.resolve(), Ne();
}
function tt(t) {
  var e = t.f, n = (e & b) !== 0;
  if (_ !== null && !P) {
    var r = v !== null && (v.f & $) !== 0;
    if (!r && !I?.includes(t)) {
      var s = _.deps;
      if ((_.f & mt) !== 0)
        t.rv < rt && (t.rv = rt, y === null && s !== null && s[x] === t ? x++ : y === null ? y = [t] : (!N || !y.includes(t)) && y.push(t));
      else {
        (_.deps ??= []).push(t);
        var l = t.reactions;
        l === null ? t.reactions = [_] : l.includes(_) || l.push(_);
      }
    }
  } else if (n && /** @type {Derived} */
  t.deps === null && /** @type {Derived} */
  t.effects === null) {
    var i = (
      /** @type {Derived} */
      t
    ), a = i.parent;
    a !== null && (a.f & R) === 0 && (i.f ^= R);
  }
  if (ft) {
    if (D.has(t))
      return D.get(t);
    if (n) {
      i = /** @type {Derived} */
      t;
      var f = i.v;
      return ((i.f & g) === 0 && i.reactions !== null || ve(i)) && (f = At(i)), D.set(i, f), f;
    }
  } else if (n) {
    if (i = /** @type {Derived} */
    t, A?.has(i))
      return A.get(i);
    pt(i) && ee(i);
  }
  if (A?.has(t))
    return A.get(t);
  if ((t.f & B) !== 0)
    throw t.v;
  return t.v;
}
function ve(t) {
  if (t.v === E) return !0;
  if (t.deps === null) return !1;
  for (const e of t.deps)
    if (D.has(e) || (e.f & b) !== 0 && ve(
      /** @type {Derived} */
      e
    ))
      return !0;
  return !1;
}
function On(t) {
  var e = P;
  try {
    return P = !0, t();
  } finally {
    P = e;
  }
}
const Qe = -7169;
function m(t, e) {
  t.f = t.f & Qe | e;
}
export {
  on as $,
  tn as A,
  nn as B,
  re as C,
  ie as D,
  Ht as E,
  mn as F,
  ze as G,
  xn as H,
  F as I,
  In as J,
  On as K,
  Tn as L,
  gt as M,
  wt as N,
  _n as O,
  sn as P,
  Q,
  q as R,
  $ as S,
  un as T,
  E as U,
  Qt as V,
  ln as W,
  rn as X,
  fn as Y,
  ft as Z,
  Et as _,
  z as a,
  kn as a0,
  hn as a1,
  vn as a2,
  yn as a3,
  gn as a4,
  C as a5,
  _ as b,
  v as c,
  Ot as d,
  wn as e,
  En as f,
  Ye as g,
  An as h,
  he as i,
  Rn as j,
  w as k,
  bn as l,
  tt as m,
  pn as n,
  an as o,
  Sn as p,
  Pe as q,
  Pn as r,
  M as s,
  He as t,
  Tt as u,
  dn as v,
  St as w,
  Rt as x,
  en as y,
  lt as z
};
