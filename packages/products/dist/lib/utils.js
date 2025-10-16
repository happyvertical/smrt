function t(r) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(r);
}
function n(r) {
  const e = typeof r == "string" ? new Date(r) : r;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(e);
}
function o(r) {
  return r.toLowerCase().replace(/[^\w ]+/g, "").replace(/ +/g, "-");
}
function a() {
  return Math.random().toString(36).substr(2, 9);
}
export {
  n as formatDate,
  t as formatPrice,
  a as generateId,
  o as slugify
};
