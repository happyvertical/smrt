var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var _Account_decorators, _init, _a, _AccountTransaction_decorators, _init2, _b, _AccountTransactionEntry_decorators, _init3, _c;
import { SmrtObject, smrt, SmrtCollection } from "@smrt/core";
_Account_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class Account extends (_a = SmrtObject) {
  // id, slug, name inherited from SmrtObject
  type = "asset";
  currency = "USD";
  // Default to USD, should be set explicitly
  parentId = "";
  // FK to parent Account (nullable for root accounts)
  description = "";
  metadata = "";
  // JSON metadata (stored as text)
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.type !== void 0) this.type = options.type;
    if (options.currency !== void 0) this.currency = options.currency;
    if (options.parentId !== void 0) this.parentId = options.parentId;
    if (options.description !== void 0)
      this.description = options.description;
    if (options.metadata !== void 0) {
      if (typeof options.metadata === "string") {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata() {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }
  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data) {
    this.metadata = JSON.stringify(data);
  }
  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates) {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }
  /**
   * Get the parent account
   *
   * @returns Parent Account instance or null
   */
  async getParent() {
    if (!this.parentId) return null;
    const { AccountCollection: AccountCollection2 } = await Promise.resolve().then(() => AccountCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.get({ id: this.parentId });
  }
  /**
   * Get immediate child accounts
   *
   * @returns Array of child Account instances
   */
  async getChildren() {
    const { AccountCollection: AccountCollection2 } = await Promise.resolve().then(() => AccountCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.list({ where: { parentId: this.id } });
  }
  /**
   * Get all ancestor accounts (recursive)
   *
   * @returns Array of ancestor accounts from root to immediate parent
   */
  async getAncestors() {
    const ancestors = [];
    let currentAccount = this;
    while (currentAccount && currentAccount.parentId) {
      const parent = await currentAccount.getParent();
      if (!parent) break;
      ancestors.unshift(parent);
      currentAccount = parent;
    }
    return ancestors;
  }
  /**
   * Get all descendant accounts (recursive)
   *
   * @returns Array of all descendant accounts
   */
  async getDescendants() {
    const children = await this.getChildren();
    const descendants = [...children];
    for (const child of children) {
      const childDescendants = await child.getDescendants();
      descendants.push(...childDescendants);
    }
    return descendants;
  }
  /**
   * Get root account (top-level account with no parent)
   *
   * @returns Root account instance
   */
  async getRootAccount() {
    const ancestors = await this.getAncestors();
    return ancestors.length > 0 ? ancestors[0] : this;
  }
  /**
   * Get full hierarchy for this account
   *
   * @returns Object with ancestors, current, and descendants
   */
  async getHierarchy() {
    const [ancestors, descendants] = await Promise.all([
      this.getAncestors(),
      this.getDescendants()
    ]);
    return {
      ancestors,
      current: this,
      descendants
    };
  }
  /**
   * Check if account is a root account (no parent)
   *
   * @returns True if parentId is empty
   */
  isRoot() {
    return !this.parentId;
  }
  /**
   * Get the depth of this account in the hierarchy
   *
   * @returns Number of ancestors (0 for root accounts)
   */
  async getDepth() {
    const ancestors = await this.getAncestors();
    return ancestors.length;
  }
  /**
   * Get all transaction entries for this account
   *
   * @returns Array of AccountTransactionEntry instances
   */
  async getTransactionEntries() {
    const { AccountTransactionEntryCollection: AccountTransactionEntryCollection2 } = await Promise.resolve().then(() => AccountTransactionEntryCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountTransactionEntryCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.list({ where: { accountId: this.id } });
  }
  /**
   * Calculate the balance for this account
   * Sum of all transaction entries (debits positive, credits negative)
   *
   * @returns Balance in smallest currency unit (e.g., cents)
   */
  async getBalance() {
    const entries = await this.getTransactionEntries();
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }
}
_init = __decoratorStart(_a);
Account = __decorateElement(_init, 0, "Account", _Account_decorators, Account);
__runInitializers(_init, 1, Account);
_AccountTransaction_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class AccountTransaction extends (_b = SmrtObject) {
  // id inherited from SmrtObject
  // Note: slug and name not typically used for transactions
  date = /* @__PURE__ */ new Date();
  description = "";
  metadata = "";
  // JSON metadata (stored as text)
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.date !== void 0) this.date = options.date;
    if (options.description !== void 0)
      this.description = options.description;
    if (options.metadata !== void 0) {
      if (typeof options.metadata === "string") {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata() {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }
  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data) {
    this.metadata = JSON.stringify(data);
  }
  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates) {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }
  /**
   * Get all entries for this transaction
   *
   * @returns Array of AccountTransactionEntry instances
   */
  async getEntries() {
    const { AccountTransactionEntryCollection: AccountTransactionEntryCollection2 } = await Promise.resolve().then(() => AccountTransactionEntryCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountTransactionEntryCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.list({ where: { transactionId: this.id } });
  }
  /**
   * Calculate the total balance of all entries
   * For balanced transactions, this should be zero
   *
   * @returns Sum of all entry amounts (debits positive, credits negative)
   */
  async getBalance() {
    const entries = await this.getEntries();
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }
  /**
   * Check if this transaction is balanced
   * In double-entry accounting, balanced means debits = credits (sum = 0)
   *
   * @returns True if sum of all entries equals zero
   */
  async isBalanced() {
    const balance = await this.getBalance();
    return balance === 0;
  }
  /**
   * Get total debits (positive amounts)
   *
   * @returns Sum of all positive entry amounts
   */
  async getTotalDebits() {
    const entries = await this.getEntries();
    return entries.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
  }
  /**
   * Get total credits (negative amounts, returned as positive)
   *
   * @returns Sum of all negative entry amounts (as positive number)
   */
  async getTotalCredits() {
    const entries = await this.getEntries();
    return Math.abs(
      entries.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum + entry.amount, 0)
    );
  }
  /**
   * Get entries grouped by currency
   *
   * @returns Map of currency codes to arrays of entries
   */
  async getEntriesByCurrency() {
    const entries = await this.getEntries();
    const byCurrency = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const currency = entry.currency || "UNKNOWN";
      if (!byCurrency.has(currency)) {
        byCurrency.set(currency, []);
      }
      byCurrency.get(currency)?.push(entry);
    }
    return byCurrency;
  }
}
_init2 = __decoratorStart(_b);
AccountTransaction = __decorateElement(_init2, 0, "AccountTransaction", _AccountTransaction_decorators, AccountTransaction);
__runInitializers(_init2, 1, AccountTransaction);
_AccountTransactionEntry_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
let _AccountTransactionEntry = class _AccountTransactionEntry extends (_c = SmrtObject) {
  // id inherited from SmrtObject
  // Note: slug and name not typically used for transaction entries
  transactionId = "";
  // FK to AccountTransaction
  accountId = "";
  // FK to Account
  amount = 0;
  // Integer in smallest currency unit (e.g., cents)
  currency = "USD";
  // ISO 4217 currency code
  description = "";
  // Optional entry-specific description
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.transactionId !== void 0)
      this.transactionId = options.transactionId;
    if (options.accountId !== void 0) this.accountId = options.accountId;
    if (options.amount !== void 0) this.amount = options.amount;
    if (options.currency !== void 0) this.currency = options.currency;
    if (options.description !== void 0)
      this.description = options.description;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
  /**
   * Get the transaction this entry belongs to
   *
   * @returns AccountTransaction instance or null
   */
  async getTransaction() {
    if (!this.transactionId) return null;
    const { AccountTransactionCollection: AccountTransactionCollection2 } = await Promise.resolve().then(() => AccountTransactionCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountTransactionCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.get({ id: this.transactionId });
  }
  /**
   * Get the account this entry affects
   *
   * @returns Account instance or null
   */
  async getAccount() {
    if (!this.accountId) return null;
    const { AccountCollection: AccountCollection2 } = await Promise.resolve().then(() => AccountCollection$1);
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await AccountCollection2.create({
      persistence,
      db,
      ai,
      fs,
      _className
    });
    return await collection.get({ id: this.accountId });
  }
  /**
   * Check if this entry is a debit
   *
   * @returns True if amount is positive
   */
  isDebit() {
    return this.amount > 0;
  }
  /**
   * Check if this entry is a credit
   *
   * @returns True if amount is negative
   */
  isCredit() {
    return this.amount < 0;
  }
  /**
   * Get the absolute amount value
   *
   * @returns Absolute value of amount
   */
  getAbsoluteAmount() {
    return Math.abs(this.amount);
  }
  /**
   * Format amount as currency string
   * Converts from smallest unit (cents) to standard format
   *
   * @param locale - Optional locale for formatting (default: 'en-US')
   * @returns Formatted currency string
   */
  formatAmount(locale = "en-US") {
    const standardAmount = this.amount / 100;
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: this.currency
      }).format(standardAmount);
    } catch {
      return `${this.currency} ${standardAmount.toFixed(2)}`;
    }
  }
  /**
   * Create a debit entry helper
   * Static factory method for creating debit entries
   *
   * @param options - Entry options with positive amount
   * @returns New AccountTransactionEntry instance
   */
  static createDebit(options) {
    return new _AccountTransactionEntry({
      ...options,
      amount: Math.abs(options.amount)
      // Ensure positive
    });
  }
  /**
   * Create a credit entry helper
   * Static factory method for creating credit entries
   *
   * @param options - Entry options with amount (will be made negative)
   * @returns New AccountTransactionEntry instance
   */
  static createCredit(options) {
    return new _AccountTransactionEntry({
      ...options,
      amount: -Math.abs(options.amount)
      // Ensure negative
    });
  }
};
_init3 = __decoratorStart(_c);
_AccountTransactionEntry = __decorateElement(_init3, 0, "AccountTransactionEntry", _AccountTransactionEntry_decorators, _AccountTransactionEntry);
__runInitializers(_init3, 1, _AccountTransactionEntry);
let AccountTransactionEntry = _AccountTransactionEntry;
class AccountCollection extends SmrtCollection {
  static _itemClass = Account;
  /**
   * Get accounts by type
   *
   * @param type - Account type (asset, liability, equity, revenue, expense)
   * @returns Array of Account instances
   */
  async getByType(type) {
    return await this.list({ where: { type } });
  }
  /**
   * Get accounts by currency
   *
   * @param currency - ISO 4217 currency code
   * @returns Array of Account instances
   */
  async getByCurrency(currency) {
    return await this.list({ where: { currency } });
  }
  /**
   * Get root accounts (accounts with no parent)
   *
   * @returns Array of root Account instances
   */
  async getRootAccounts() {
    const allAccounts = await this.list({});
    return allAccounts.filter((account) => !account.parentId);
  }
  /**
   * Get child accounts of a parent
   *
   * @param parentId - Parent account ID
   * @returns Array of child Account instances
   */
  async getChildren(parentId) {
    return await this.list({ where: { parentId } });
  }
  /**
   * Get all accounts of a specific type and currency
   *
   * @param type - Account type
   * @param currency - Currency code
   * @returns Array of Account instances
   */
  async getByTypeAndCurrency(type, currency) {
    return await this.list({ where: { type, currency } });
  }
  /**
   * Search accounts by name (case-insensitive partial match)
   *
   * @param searchTerm - Search term
   * @returns Array of matching Account instances
   */
  async searchByName(searchTerm) {
    const allAccounts = await this.list({});
    const lowerSearch = searchTerm.toLowerCase();
    return allAccounts.filter(
      (account) => account.name.toLowerCase().includes(lowerSearch)
    );
  }
  /**
   * Get account hierarchy tree structure
   * Returns root accounts with nested children
   *
   * @returns Array of root accounts with children property
   */
  async getHierarchyTree() {
    const allAccounts = await this.list({});
    const accountMap = /* @__PURE__ */ new Map();
    const roots = [];
    for (const account of allAccounts) {
      accountMap.set(account.id, { ...account, children: [] });
    }
    for (const account of allAccounts) {
      const node = accountMap.get(account.id);
      if (account.parentId && accountMap.has(account.parentId)) {
        accountMap.get(account.parentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }
}
const AccountCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AccountCollection
}, Symbol.toStringTag, { value: "Module" }));
class AccountTransactionCollection extends SmrtCollection {
  static _itemClass = AccountTransaction;
  /**
   * Get transactions by date range
   *
   * @param startDate - Start of date range
   * @param endDate - End of date range
   * @returns Array of AccountTransaction instances
   */
  async getByDateRange(startDate, endDate) {
    const allTransactions = await this.list({});
    return allTransactions.filter(
      (transaction) => transaction.date >= startDate && transaction.date <= endDate
    );
  }
  /**
   * Get transactions on a specific date
   *
   * @param date - Date to filter by
   * @returns Array of AccountTransaction instances
   */
  async getByDate(date) {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    return await this.getByDateRange(startOfDay, endOfDay);
  }
  /**
   * Search transactions by description (case-insensitive partial match)
   *
   * @param searchTerm - Search term
   * @returns Array of matching AccountTransaction instances
   */
  async searchByDescription(searchTerm) {
    const allTransactions = await this.list({});
    const lowerSearch = searchTerm.toLowerCase();
    return allTransactions.filter(
      (transaction) => transaction.description.toLowerCase().includes(lowerSearch)
    );
  }
  /**
   * Get recent transactions
   *
   * @param limit - Maximum number of transactions to return
   * @returns Array of recent AccountTransaction instances
   */
  async getRecent(limit = 10) {
    const allTransactions = await this.list({});
    return allTransactions.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
  }
  /**
   * Get transactions for current month
   *
   * @returns Array of AccountTransaction instances
   */
  async getCurrentMonth() {
    const now = /* @__PURE__ */ new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);
    return await this.getByDateRange(startOfMonth, endOfMonth);
  }
  /**
   * Get transactions for current year
   *
   * @returns Array of AccountTransaction instances
   */
  async getCurrentYear() {
    const now = /* @__PURE__ */ new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const endOfYear = new Date(now.getFullYear(), 11, 31);
    endOfYear.setHours(23, 59, 59, 999);
    return await this.getByDateRange(startOfYear, endOfYear);
  }
}
const AccountTransactionCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AccountTransactionCollection
}, Symbol.toStringTag, { value: "Module" }));
class AccountTransactionEntryCollection extends SmrtCollection {
  static _itemClass = AccountTransactionEntry;
  /**
   * Get entries for a specific transaction
   *
   * @param transactionId - Transaction ID
   * @returns Array of AccountTransactionEntry instances
   */
  async getByTransactionId(transactionId) {
    return await this.list({ where: { transactionId } });
  }
  /**
   * Get entries for a specific account
   *
   * @param accountId - Account ID
   * @returns Array of AccountTransactionEntry instances
   */
  async getByAccountId(accountId) {
    return await this.list({ where: { accountId } });
  }
  /**
   * Get entries by currency
   *
   * @param currency - ISO 4217 currency code
   * @returns Array of AccountTransactionEntry instances
   */
  async getByCurrency(currency) {
    return await this.list({ where: { currency } });
  }
  /**
   * Get debit entries only (positive amounts)
   *
   * @returns Array of debit AccountTransactionEntry instances
   */
  async getDebits() {
    const allEntries = await this.list({});
    return allEntries.filter((entry) => entry.amount > 0);
  }
  /**
   * Get credit entries only (negative amounts)
   *
   * @returns Array of credit AccountTransactionEntry instances
   */
  async getCredits() {
    const allEntries = await this.list({});
    return allEntries.filter((entry) => entry.amount < 0);
  }
  /**
   * Get entries within amount range
   *
   * @param minAmount - Minimum amount (inclusive)
   * @param maxAmount - Maximum amount (inclusive)
   * @returns Array of AccountTransactionEntry instances
   */
  async getByAmountRange(minAmount, maxAmount) {
    const allEntries = await this.list({});
    return allEntries.filter(
      (entry) => entry.amount >= minAmount && entry.amount <= maxAmount
    );
  }
  /**
   * Calculate total for account
   *
   * @param accountId - Account ID
   * @returns Sum of all entry amounts for the account
   */
  async calculateAccountTotal(accountId) {
    const entries = await this.getByAccountId(accountId);
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }
  /**
   * Calculate total for transaction
   *
   * @param transactionId - Transaction ID
   * @returns Sum of all entry amounts for the transaction
   */
  async calculateTransactionTotal(transactionId) {
    const entries = await this.getByTransactionId(transactionId);
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }
  /**
   * Get entries grouped by account
   *
   * @returns Map of account IDs to arrays of entries
   */
  async groupByAccount() {
    const allEntries = await this.list({});
    const grouped = /* @__PURE__ */ new Map();
    for (const entry of allEntries) {
      if (!grouped.has(entry.accountId)) {
        grouped.set(entry.accountId, []);
      }
      grouped.get(entry.accountId)?.push(entry);
    }
    return grouped;
  }
  /**
   * Get entries grouped by currency
   *
   * @returns Map of currency codes to arrays of entries
   */
  async groupByCurrency() {
    const allEntries = await this.list({});
    const grouped = /* @__PURE__ */ new Map();
    for (const entry of allEntries) {
      if (!grouped.has(entry.currency)) {
        grouped.set(entry.currency, []);
      }
      grouped.get(entry.currency)?.push(entry);
    }
    return grouped;
  }
}
const AccountTransactionEntryCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  AccountTransactionEntryCollection
}, Symbol.toStringTag, { value: "Module" }));
export {
  Account,
  AccountCollection,
  AccountTransaction,
  AccountTransactionCollection,
  AccountTransactionEntry,
  AccountTransactionEntryCollection
};
//# sourceMappingURL=index.js.map
