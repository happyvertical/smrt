import { t as Te, q as Ae, w as Ce, d as Ne, s as te, a as le, i as ue, b as Me, c as Z, g as De, e as Le, T as Oe, f as z, h as fe, E as Re, j as Y, k as U, U as Be, l as de, r as ae, p as _e, m as M, n as he, o as me, u as je, v as Ue, x as ne, y as Ve, I as J, z as be, A as Fe, B as He, C as qe, D as We, F as Ye, G as Ze, H as ge, J as ze, K as re, L as pe, M as Ge, N as Xe, O as Je, P as Ke, Q as ee, R as Qe, S as $e, V as ea, W as aa, X as ra, Y as ta, Z as la, _ as na, $ as ia, a0 as L, a1 as xe, a2 as Ee, a3 as w, a4 as E, a5 as sa } from "./runtime-EeMZGCYM.js";
const va = "5";
typeof window < "u" && ((window.__svelte ??= {}).v ??= /* @__PURE__ */ new Set()).add(va);
let oa = !1;
const ca = /* @__PURE__ */ new Set(), ua = /* @__PURE__ */ new Set();
function fa(e, a, r, t = {}) {
  function n(l) {
    if (t.capture || _a.call(a, l), !l.cancelBubble)
      return Ce(() => r?.call(this, l));
  }
  return e.startsWith("pointer") || e.startsWith("touch") || e === "wheel" ? Ae(() => {
    a.addEventListener(e, n, t);
  }) : a.addEventListener(e, n, t), n;
}
function da(e, a, r, t, n) {
  var l = { capture: t, passive: n }, i = fa(e, a, r, l);
  (a === document.body || // @ts-ignore
  a === window || // @ts-ignore
  a === document || // Firefox has quirky behavior, it can happen that we still get "canplay" events when the element is already removed
  a instanceof HTMLMediaElement) && Te(() => {
    a.removeEventListener(e, i, l);
  });
}
function ye(e) {
  for (var a = 0; a < e.length; a++)
    ca.add(e[a]);
  for (var r of ua)
    r(e);
}
let ie = null;
function _a(e) {
  var a = this, r = (
    /** @type {Node} */
    a.ownerDocument
  ), t = e.type, n = e.composedPath?.() || [], l = (
    /** @type {null | Element} */
    n[0] || e.target
  );
  ie = e;
  var i = 0, u = ie === e && e.__root;
  if (u) {
    var h = n.indexOf(u);
    if (h !== -1 && (a === document || a === /** @type {any} */
    window)) {
      e.__root = a;
      return;
    }
    var f = n.indexOf(a);
    if (f === -1)
      return;
    h <= f && (i = h);
  }
  if (l = /** @type {Element} */
  n[i] || e.target, l !== a) {
    Ne(e, "currentTarget", {
      configurable: !0,
      get() {
        return l || r;
      }
    });
    var p = Me, y = Z;
    te(null), le(null);
    try {
      for (var v, d = []; l !== null; ) {
        var s = l.assignedSlot || l.parentNode || /** @type {any} */
        l.host || null;
        try {
          var c = l["__" + t];
          if (c != null && (!/** @type {any} */
          l.disabled || // DOM could've been updated already by the time this is reached, so we check this as well
          // -> the target could not have been disabled because it emits the event in the first place
          e.target === l))
            if (ue(c)) {
              var [_, ...k] = c;
              _.apply(l, [e, ...k]);
            } else
              c.call(l, e);
        } catch (o) {
          v ? d.push(o) : v = o;
        }
        if (e.cancelBubble || s === a || s === null)
          break;
        l = s;
      }
      if (v) {
        for (let o of d)
          queueMicrotask(() => {
            throw o;
          });
        throw v;
      }
    } finally {
      e.__root = a, delete e.currentTarget, te(p), le(y);
    }
  }
}
function ha(e) {
  var a = document.createElement("template");
  return a.innerHTML = e.replaceAll("<!>", "<!---->"), a.content;
}
function Se(e, a) {
  var r = (
    /** @type {Effect} */
    Z
  );
  r.nodes_start === null && (r.nodes_start = e, r.nodes_end = a);
}
// @__NO_SIDE_EFFECTS__
function N(e, a) {
  var r = (a & Oe) !== 0, t, n = !e.startsWith("<!>");
  return () => {
    t === void 0 && (t = ha(n ? e : "<!>" + e), t = /** @type {Node} */
    De(t));
    var l = (
      /** @type {TemplateNode} */
      r || Le ? document.importNode(t, !0) : t.cloneNode(!0)
    );
    return Se(l, l), l;
  };
}
function se(e = "") {
  {
    var a = z(e + "");
    return Se(a, a), a;
  }
}
function T(e, a) {
  e !== null && e.before(
    /** @type {Node} */
    a
  );
}
function R(e, a) {
  var r = a == null ? "" : typeof a == "object" ? a + "" : a;
  r !== (e.__t ??= e.nodeValue) && (e.__t = r, e.nodeValue = r + "");
}
function D(e, a, r = !1) {
  var t = e, n = null, l = null, i = Be, u = r ? Re : 0, h = !1;
  const f = (d, s = !0) => {
    h = !0, v(s, d);
  };
  var p = null;
  function y() {
    p !== null && (p.lastChild.remove(), t.before(p), p = null);
    var d = i ? n : l, s = i ? l : n;
    d && ae(d), s && _e(s, () => {
      i ? l = null : n = null;
    });
  }
  const v = (d, s) => {
    if (i !== (i = d)) {
      var c = de(), _ = t;
      if (c && (p = document.createDocumentFragment(), p.append(_ = z())), i ? n ??= s && Y(() => s(_)) : l ??= s && Y(() => s(_)), c) {
        var k = (
          /** @type {Batch} */
          U
        ), o = i ? n : l, b = i ? l : n;
        o && k.skipped_effects.delete(o), b && k.skipped_effects.add(b), k.add_callback(y);
      } else
        y();
    }
  };
  fe(() => {
    h = !1, a(f), h || v(null, null);
  }, u);
}
function ma(e, a) {
  return a;
}
function ba(e, a, r) {
  for (var t = e.items, n = [], l = a.length, i = 0; i < l; i++)
    We(a[i].e, n, !0);
  var u = l > 0 && n.length === 0 && r !== null;
  if (u) {
    var h = (
      /** @type {Element} */
      /** @type {Element} */
      r.parentNode
    );
    Ye(h), h.append(
      /** @type {Element} */
      r
    ), t.clear(), O(e, a[0].prev, a[l - 1].next);
  }
  Ze(n, () => {
    for (var f = 0; f < l; f++) {
      var p = a[f];
      u || (t.delete(p.k), O(e, p.prev, p.next)), be(p.e, !u);
    }
  });
}
function ga(e, a, r, t, n, l = null) {
  var i = e, u = { flags: a, items: /* @__PURE__ */ new Map(), first: null };
  {
    var h = (
      /** @type {Element} */
      e
    );
    i = h.appendChild(z());
  }
  var f = null, p = !1, y = /* @__PURE__ */ new Map(), v = he(() => {
    var _ = r();
    return ue(_) ? _ : _ == null ? [] : me(_);
  }), d, s;
  function c() {
    pa(
      s,
      d,
      u,
      y,
      i,
      n,
      a,
      t,
      r
    ), l !== null && (d.length === 0 ? f ? ae(f) : f = Y(() => l(i)) : f !== null && _e(f, () => {
      f = null;
    }));
  }
  fe(() => {
    s ??= /** @type {Effect} */
    Z, d = /** @type {V[]} */
    M(v);
    var _ = d.length;
    if (!(p && _ === 0)) {
      p = _ === 0;
      var k, o, b, S;
      if (de()) {
        var A = /* @__PURE__ */ new Set(), m = (
          /** @type {Batch} */
          U
        );
        for (o = 0; o < _; o += 1) {
          b = d[o], S = t(b, o);
          var x = u.items.get(S) ?? y.get(S);
          x ? we(x, b, o) : (k = ke(
            null,
            u,
            null,
            null,
            b,
            S,
            o,
            n,
            a,
            r,
            !0
          ), y.set(S, k)), A.add(S);
        }
        for (const [I, C] of u.items)
          A.has(I) || m.skipped_effects.add(C.e);
        m.add_callback(c);
      } else
        c();
      M(v);
    }
  });
}
function pa(e, a, r, t, n, l, i, u, h) {
  var f = a.length, p = r.items, y = r.first, v = y, d, s = null, c = [], _ = [], k, o, b, S;
  for (S = 0; S < f; S += 1) {
    if (k = a[S], o = u(k, S), b = p.get(o), b === void 0) {
      var A = t.get(o);
      if (A !== void 0) {
        t.delete(o), p.set(o, A);
        var m = s ? s.next : v;
        O(r, s, A), O(r, A, m), K(A, m, n), s = A;
      } else {
        var x = v ? (
          /** @type {TemplateNode} */
          v.e.nodes_start
        ) : n;
        s = ke(
          x,
          r,
          s,
          s === null ? r.first : s.next,
          k,
          o,
          S,
          l,
          i,
          h
        );
      }
      p.set(o, s), c = [], _ = [], v = s.next;
      continue;
    }
    if (we(b, k, S), (b.e.f & J) !== 0 && ae(b.e), b !== v) {
      if (d !== void 0 && d.has(b)) {
        if (c.length < _.length) {
          var I = _[0], C;
          s = I.prev;
          var B = c[0], j = c[c.length - 1];
          for (C = 0; C < c.length; C += 1)
            K(c[C], I, n);
          for (C = 0; C < _.length; C += 1)
            d.delete(_[C]);
          O(r, B.prev, j.next), O(r, s, B), O(r, j, I), v = I, s = j, S -= 1, c = [], _ = [];
        } else
          d.delete(b), K(b, v, n), O(r, b.prev, b.next), O(r, b, s === null ? r.first : s.next), O(r, s, b), s = b;
        continue;
      }
      for (c = [], _ = []; v !== null && v.k !== o; )
        (v.e.f & J) === 0 && (d ??= /* @__PURE__ */ new Set()).add(v), _.push(v), v = v.next;
      if (v === null)
        continue;
      b = v;
    }
    c.push(b), s = b, v = b.next;
  }
  if (v !== null || d !== void 0) {
    for (var V = d === void 0 ? [] : me(d); v !== null; )
      (v.e.f & J) === 0 && V.push(v), v = v.next;
    var G = V.length;
    if (G > 0) {
      var q = f === 0 ? n : null;
      ba(r, V, q);
    }
  }
  e.first = r.first && r.first.e, e.last = s && s.e;
  for (var X of t.values())
    be(X.e);
  t.clear();
}
function we(e, a, r, t) {
  je(e.v, a), e.i = r;
}
function ke(e, a, r, t, n, l, i, u, h, f, p) {
  var y = (h & Fe) !== 0, v = (h & He) === 0, d = y ? v ? Ue(n, !1, !1) : ne(n) : n, s = (h & Ve) === 0 ? i : ne(i), c = {
    i: s,
    v: d,
    k: l,
    a: null,
    // @ts-expect-error
    e: null,
    prev: r,
    next: t
  };
  try {
    if (e === null) {
      var _ = document.createDocumentFragment();
      _.append(e = z());
    }
    return c.e = Y(() => u(
      /** @type {Node} */
      e,
      d,
      s,
      f
    ), oa), c.e.prev = r && r.e, c.e.next = t && t.e, r === null ? p || (a.first = c) : (r.next = c, r.e.next = c.e), t !== null && (t.prev = c, t.e.prev = c.e), c;
  } finally {
  }
}
function K(e, a, r) {
  for (var t = e.next ? (
    /** @type {TemplateNode} */
    e.next.e.nodes_start
  ) : r, n = a ? (
    /** @type {TemplateNode} */
    a.e.nodes_start
  ) : r, l = (
    /** @type {TemplateNode} */
    e.e.nodes_start
  ); l !== null && l !== t; ) {
    var i = (
      /** @type {TemplateNode} */
      qe(l)
    );
    n.before(l), l = i;
  }
}
function O(e, a, r) {
  a === null ? e.first = r : (a.next = r, a.e.next = r && r.e), r !== null && (r.prev = a, r.e.prev = a && a.e);
}
const ve = [...` 	
\r\f \v\uFEFF`];
function xa(e, a, r) {
  var t = "" + e;
  if (r) {
    for (var n in r)
      if (r[n])
        t = t ? t + " " + n : n;
      else if (t.length)
        for (var l = n.length, i = 0; (i = t.indexOf(n, i)) >= 0; ) {
          var u = i + l;
          (i === 0 || ve.includes(t[i - 1])) && (u === t.length || ve.includes(t[u])) ? t = (i === 0 ? "" : t.substring(0, i)) + t.substring(u + 1) : i = u;
        }
  }
  return t === "" ? null : t;
}
function oe(e, a, r, t, n, l) {
  var i = e.__className;
  if (i !== r || i === void 0) {
    var u = xa(r, t, l);
    u == null ? e.removeAttribute("class") : e.className = u, e.__className = r;
  } else if (l && n !== l)
    for (var h in l) {
      var f = !!l[h];
      (n == null || f !== !!n[h]) && e.classList.toggle(h, f);
    }
  return l;
}
function H(e, a, r = a) {
  var t = /* @__PURE__ */ new WeakSet();
  ge(e, "input", async (n) => {
    var l = n ? e.defaultValue : e.value;
    if (l = Q(e) ? $(l) : l, r(l), U !== null && t.add(U), await ze(), l !== (l = a())) {
      var i = e.selectionStart, u = e.selectionEnd, h = e.value.length;
      if (e.value = l ?? "", u !== null) {
        var f = e.value.length;
        i === u && u === h && f > h ? (e.selectionStart = f, e.selectionEnd = f) : (e.selectionStart = i, e.selectionEnd = Math.min(u, f));
      }
    }
  }), // If we are hydrating and the value has since changed,
  // then use the updated value from the input instead.
  // If defaultValue is set, then value == defaultValue
  // TODO Svelte 6: remove input.value check and set to empty string?
  re(a) == null && e.value && (r(Q(e) ? $(e.value) : e.value), U !== null && t.add(U)), pe(() => {
    var n = a();
    if (e === document.activeElement) {
      var l = (
        /** @type {Batch} */
        Ge ?? U
      );
      if (t.has(l))
        return;
    }
    Q(e) && n === $(e.value) || e.type === "date" && !n && !e.value || n !== e.value && (e.value = n ?? "");
  });
}
function Ea(e, a, r = a) {
  ge(e, "change", (t) => {
    var n = t ? e.defaultChecked : e.checked;
    r(n);
  }), // If we are hydrating and the value has since changed,
  // then use the update value from the input instead.
  // If defaultChecked is set, then checked == defaultChecked
  re(a) == null && r(e.checked), pe(() => {
    var t = a();
    e.checked = !!t;
  });
}
function Q(e) {
  var a = e.type;
  return a === "number" || a === "range";
}
function $(e) {
  return e === "" ? null : +e;
}
let W = !1;
function ya(e) {
  var a = W;
  try {
    return W = !1, [e(), W];
  } finally {
    W = a;
  }
}
function ce(e, a, r, t) {
  var n = (r & aa) !== 0, l = (r & ta) !== 0, i = (
    /** @type {V} */
    t
  ), u = !0, h = () => (u && (u = !1, i = l ? re(
    /** @type {() => V} */
    t
  ) : (
    /** @type {V} */
    t
  )), i), f;
  if (n) {
    var p = na in e || ia in e;
    f = Xe(e, a)?.set ?? (p && a in e ? (o) => e[a] = o : void 0);
  }
  var y, v = !1;
  n ? [y, v] = ya(() => (
    /** @type {V} */
    e[a]
  )) : y = /** @type {V} */
  e[a], y === void 0 && t !== void 0 && (y = h(), f && (Je(), f(y)));
  var d;
  if (d = () => {
    var o = (
      /** @type {V} */
      e[a]
    );
    return o === void 0 ? h() : (u = !0, o);
  }, (r & Ke) === 0)
    return d;
  if (f) {
    var s = e.$$legacy;
    return (
      /** @type {() => V} */
      (function(o, b) {
        return arguments.length > 0 ? ((!b || s || v) && f(b ? d() : o), o) : d();
      })
    );
  }
  var c = !1, _ = ((r & ra) !== 0 ? ea : he)(() => (c = !1, d()));
  n && M(_);
  var k = (
    /** @type {Effect} */
    Z
  );
  return (
    /** @type {() => V} */
    (function(o, b) {
      if (arguments.length > 0) {
        const S = b ? M(_) : n ? ee(o) : o;
        return Qe(_, S), c = !0, i !== void 0 && (i = S), o;
      }
      return la && c || (k.f & $e) !== 0 ? _.v : M(_);
    })
  );
}
var Sa = /* @__PURE__ */ N('<div class="product-manufacturer svelte-11ja2cl"> </div>'), wa = /* @__PURE__ */ N('<div class="product-model svelte-11ja2cl"> </div>'), ka = /* @__PURE__ */ N('<p class="product-description svelte-11ja2cl"> </p>'), Ia = /* @__PURE__ */ N('<div class="product-category svelte-11ja2cl"> </div>'), Pa = /* @__PURE__ */ N('<span class="tag svelte-11ja2cl"> </span>'), Ta = /* @__PURE__ */ N('<div class="product-tags svelte-11ja2cl"></div>'), Aa = (e, a) => a.onEdit?.(a.product), Ca = /* @__PURE__ */ N('<button type="button" class="edit-btn svelte-11ja2cl">Edit</button>'), Na = (e, a) => a.onDelete?.(a.product.id), Ma = /* @__PURE__ */ N('<button type="button" class="delete-btn svelte-11ja2cl">Delete</button>'), Da = /* @__PURE__ */ N('<div class="product-card svelte-11ja2cl"><div class="product-header svelte-11ja2cl"><h3 class="product-name svelte-11ja2cl"> </h3> <!></div> <!> <!> <div class="product-meta svelte-11ja2cl"><!> <!></div> <div class="product-actions svelte-11ja2cl"><!> <!></div></div>');
function Ua(e, a) {
  Ee(a, !0);
  var r = Da(), t = E(r), n = E(t), l = E(n), i = w(n, 2);
  {
    var u = (m) => {
      var x = Sa(), I = E(x);
      L(() => R(I, a.product.manufacturer)), T(m, x);
    };
    D(i, (m) => {
      a.product.manufacturer && m(u);
    });
  }
  var h = w(t, 2);
  {
    var f = (m) => {
      var x = wa(), I = E(x);
      L(() => R(I, `Model: ${a.product.model ?? ""}`)), T(m, x);
    };
    D(h, (m) => {
      a.product.model && m(f);
    });
  }
  var p = w(h, 2);
  {
    var y = (m) => {
      var x = ka(), I = E(x);
      L(() => R(I, a.product.description)), T(m, x);
    };
    D(p, (m) => {
      a.product.description && m(y);
    });
  }
  var v = w(p, 2), d = E(v);
  {
    var s = (m) => {
      var x = Ia(), I = E(x);
      L(() => R(I, `Category: ${a.product.category ?? ""}`)), T(m, x);
    };
    D(d, (m) => {
      a.product.category && m(s);
    });
  }
  var c = w(d, 2);
  {
    var _ = (m) => {
      var x = Ta();
      ga(x, 21, () => a.product.tags, ma, (I, C) => {
        var B = Pa(), j = E(B);
        L(() => R(j, M(C))), T(I, B);
      }), T(m, x);
    };
    D(c, (m) => {
      a.product.tags && a.product.tags.length > 0 && m(_);
    });
  }
  var k = w(v, 2), o = E(k);
  {
    var b = (m) => {
      var x = Ca();
      x.__click = [Aa, a], T(m, x);
    };
    D(o, (m) => {
      a.onEdit && m(b);
    });
  }
  var S = w(o, 2);
  {
    var A = (m) => {
      var x = Ma();
      x.__click = [Na, a], T(m, x);
    };
    D(S, (m) => {
      a.onDelete && m(A);
    });
  }
  L(() => R(l, a.product.name)), T(e, r), xe();
}
ye(["click"]);
var La = /* @__PURE__ */ N('<span class="error-message svelte-1hh5ovx"> </span>'), Oa = /* @__PURE__ */ N('<span class="error-message svelte-1hh5ovx"> </span>'), Ra = /* @__PURE__ */ N('<button type="button" class="cancel-btn svelte-1hh5ovx">Cancel</button>'), Ba = /* @__PURE__ */ N('<form class="product-form svelte-1hh5ovx"><div class="form-group svelte-1hh5ovx"><label for="name" class="svelte-1hh5ovx">Product Name *</label> <input id="name" type="text" placeholder="Enter product name"/> <!></div> <div class="form-group svelte-1hh5ovx"><label for="description" class="svelte-1hh5ovx">Description</label> <textarea id="description" class="form-textarea svelte-1hh5ovx" placeholder="Product description (optional)" rows="3"></textarea></div> <div class="form-row svelte-1hh5ovx"><div class="form-group svelte-1hh5ovx"><label for="price" class="svelte-1hh5ovx">Price *</label> <input id="price" type="number" step="0.01" min="0" placeholder="0.00"/> <!></div> <div class="form-group svelte-1hh5ovx"><label for="category" class="svelte-1hh5ovx">Category</label> <input id="category" type="text" class="form-input svelte-1hh5ovx" placeholder="Product category"/></div></div> <div class="form-group svelte-1hh5ovx"><label for="tags" class="svelte-1hh5ovx">Tags</label> <input id="tags" type="text" class="form-input svelte-1hh5ovx" placeholder="tag1, tag2, tag3"/> <small class="form-hint svelte-1hh5ovx">Separate tags with commas</small></div> <div class="form-group svelte-1hh5ovx"><label class="checkbox-label svelte-1hh5ovx"><input type="checkbox" class="form-checkbox svelte-1hh5ovx"/> In Stock</label></div> <div class="form-actions svelte-1hh5ovx"><!> <button type="submit" class="submit-btn svelte-1hh5ovx"><!></button></div></form>');
function Va(e, a) {
  Ee(a, !0);
  const r = ce(a, "product", 19, () => ({})), t = ce(a, "loading", 3, !1), n = ee({
    name: r().name || "",
    description: r().description || "",
    price: r().price || 0,
    inStock: r().inStock ?? !0,
    category: r().category || "",
    tags: r().tags?.join(", ") || ""
  });
  let l = sa(ee({}));
  var i = Ba(), u = E(i), h = w(E(u), 2);
  let f;
  var p = w(h, 2);
  {
    var y = (g) => {
      var P = La(), F = E(P);
      L(() => R(F, M(l).name)), T(g, P);
    };
    D(p, (g) => {
      M(l).name && g(y);
    });
  }
  var v = w(u, 2), d = w(E(v), 2), s = w(v, 2), c = E(s), _ = w(E(c), 2);
  let k;
  var o = w(_, 2);
  {
    var b = (g) => {
      var P = Oa(), F = E(P);
      L(() => R(F, M(l).price)), T(g, P);
    };
    D(o, (g) => {
      M(l).price && g(b);
    });
  }
  var S = w(c, 2), A = w(E(S), 2), m = w(s, 2), x = w(E(m), 2), I = w(m, 2), C = E(I), B = E(C), j = w(I, 2), V = E(j);
  {
    var G = (g) => {
      var P = Ra();
      P.__click = function(...F) {
        a.onCancel?.apply(this, F);
      }, L(() => P.disabled = t()), T(g, P);
    };
    D(V, (g) => {
      a.onCancel && g(G);
    });
  }
  var q = w(V, 2), X = E(q);
  {
    var Ie = (g) => {
      var P = se("Saving...");
      T(g, P);
    }, Pe = (g) => {
      var P = se();
      L(() => R(P, r().id ? "Update Product" : "Create Product")), T(g, P);
    };
    D(X, (g) => {
      t() ? g(Ie) : g(Pe, !1);
    });
  }
  L(
    (g, P) => {
      h.disabled = t(), f = oe(h, 1, "form-input svelte-1hh5ovx", null, f, g), d.disabled = t(), _.disabled = t(), k = oe(_, 1, "form-input svelte-1hh5ovx", null, k, P), A.disabled = t(), x.disabled = t(), B.disabled = t(), q.disabled = t();
    },
    [
      () => ({ error: M(l).name }),
      () => ({ error: M(l).price })
    ]
  ), da("submit", i, handleSubmit), H(h, () => n.name, (g) => n.name = g), H(d, () => n.description, (g) => n.description = g), H(_, () => n.price, (g) => n.price = g), H(A, () => n.category, (g) => n.category = g), H(x, () => n.tags, (g) => n.tags = g), Ea(B, () => n.inStock, (g) => n.inStock = g), T(e, i), xe();
}
ye(["click"]);
export {
  Ua as ProductCard,
  Va as ProductForm
};
