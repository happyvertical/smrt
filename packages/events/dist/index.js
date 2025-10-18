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
var _Event_decorators, _init, _a, _EventParticipant_decorators, _init2, _b, _EventSeries_decorators, _init3, _c, _EventType_decorators, _init4, _d;
import { SmrtObject, smrt, SmrtCollection } from "@smrt/core";
_Event_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class Event extends (_a = SmrtObject) {
  // id, slug, name inherited from SmrtObject
  seriesId = "";
  // FK to EventSeries (nullable for standalone events)
  parentEventId = "";
  // FK to Event (nullable, self-referencing for hierarchy)
  typeId = "";
  // FK to EventType
  placeId = "";
  // FK to Place (from @smrt/places)
  description = "";
  startDate = null;
  endDate = null;
  status = "scheduled";
  round = null;
  // Sequence/round number in series
  metadata = "";
  // JSON metadata (stored as text)
  externalId = "";
  // External system identifier
  source = "";
  // Source system
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.seriesId !== void 0) this.seriesId = options.seriesId;
    if (options.parentEventId !== void 0)
      this.parentEventId = options.parentEventId;
    if (options.typeId) this.typeId = options.typeId;
    if (options.placeId !== void 0) this.placeId = options.placeId;
    if (options.description !== void 0)
      this.description = options.description;
    if (options.startDate !== void 0)
      this.startDate = options.startDate || null;
    if (options.endDate !== void 0) this.endDate = options.endDate || null;
    if (options.status !== void 0) this.status = options.status;
    if (options.round !== void 0) this.round = options.round;
    if (options.externalId !== void 0) this.externalId = options.externalId;
    if (options.source !== void 0) this.source = options.source;
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
   * Update event status
   *
   * @param newStatus - New status to set
   */
  async updateStatus(newStatus) {
    this.status = newStatus;
    this.updatedAt = /* @__PURE__ */ new Date();
    await this.save();
  }
  /**
   * Get the series for this event
   *
   * @returns EventSeries instance or null
   */
  async getSeries() {
    if (!this.seriesId) return null;
    const { EventSeriesCollection: EventSeriesCollection2 } = await Promise.resolve().then(() => EventSeriesCollection$1);
    const collection = await EventSeriesCollection2.create(this.options);
    return await collection.get({ id: this.seriesId });
  }
  /**
   * Get the event type
   *
   * @returns EventType instance or null
   */
  async getType() {
    if (!this.typeId) return null;
    const { EventTypeCollection: EventTypeCollection2 } = await Promise.resolve().then(() => EventTypeCollection$1);
    const collection = await EventTypeCollection2.create(this.options);
    return await collection.get({ id: this.typeId });
  }
  /**
   * Get the place for this event
   *
   * @returns Place instance or null
   */
  async getPlace() {
    if (!this.placeId) return null;
    try {
      const { PlaceCollection } = await import("@smrt/places");
      const collection = await PlaceCollection.create(this.options);
      return await collection.get({ id: this.placeId });
    } catch {
      return null;
    }
  }
  /**
   * Get the parent event
   *
   * @returns Parent Event instance or null
   */
  async getParent() {
    if (!this.parentEventId) return null;
    const { EventCollection: EventCollection2 } = await Promise.resolve().then(() => EventCollection$1);
    const collection = await EventCollection2.create(this.options);
    return await collection.get({ id: this.parentEventId });
  }
  /**
   * Get immediate child events
   *
   * @returns Array of child Event instances
   */
  async getChildren() {
    const { EventCollection: EventCollection2 } = await Promise.resolve().then(() => EventCollection$1);
    const collection = await EventCollection2.create(this.options);
    return await collection.list({ where: { parentEventId: this.id } });
  }
  /**
   * Get all ancestor events (recursive)
   *
   * @returns Array of ancestor events from root to immediate parent
   */
  async getAncestors() {
    const ancestors = [];
    let currentEvent = this;
    while (currentEvent?.parentEventId) {
      const parent = await currentEvent.getParent();
      if (!parent) break;
      ancestors.unshift(parent);
      currentEvent = parent;
    }
    return ancestors;
  }
  /**
   * Get all descendant events (recursive)
   *
   * @returns Array of all descendant events
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
   * Get root event (top-level event with no parent)
   *
   * @returns Root event instance
   */
  async getRootEvent() {
    const ancestors = await this.getAncestors();
    return ancestors.length > 0 ? ancestors[0] : this;
  }
  /**
   * Get full hierarchy for this event
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
   * Get all participants for this event
   *
   * @returns Array of EventParticipant instances
   */
  async getParticipants() {
    const { EventParticipantCollection: EventParticipantCollection2 } = await Promise.resolve().then(() => EventParticipantCollection$1);
    const collection = await EventParticipantCollection2.create(this.options);
    return await collection.list({ where: { eventId: this.id } });
  }
  /**
   * Check if event is currently in progress
   *
   * @returns True if current time is between start and end
   */
  isInProgress() {
    if (this.status !== "in_progress") return false;
    const now = /* @__PURE__ */ new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;
    return true;
  }
  /**
   * Check if event is a root event (no parent)
   *
   * @returns True if parentEventId is empty
   */
  isRoot() {
    return !this.parentEventId;
  }
}
_init = __decoratorStart(_a);
Event = __decorateElement(_init, 0, "Event", _Event_decorators, Event);
__runInitializers(_init, 1, Event);
class EventCollection extends SmrtCollection {
  static _itemClass = Event;
  /**
   * Get events by series
   *
   * @param seriesId - EventSeries ID
   * @returns Array of Event instances
   */
  async getBySeriesId(seriesId) {
    return await this.list({ where: { seriesId } });
  }
  /**
   * Get events at a specific place
   *
   * @param placeId - Place ID
   * @returns Array of Event instances
   */
  async getByPlace(placeId) {
    return await this.list({ where: { placeId } });
  }
  /**
   * Get events by date range
   *
   * @param startDate - Start of date range
   * @param endDate - End of date range
   * @returns Array of Event instances
   */
  async getByDateRange(startDate, endDate) {
    const allEvents = await this.list({});
    return allEvents.filter((event) => {
      if (!event.startDate) return false;
      return event.startDate >= startDate && event.startDate <= endDate;
    });
  }
  /**
   * Get upcoming events
   *
   * @param limit - Maximum number of events to return
   * @returns Array of Event instances starting in the future
   */
  async getUpcoming(limit) {
    const allEvents = await this.list({});
    const now = /* @__PURE__ */ new Date();
    const upcoming = allEvents.filter((event) => event.startDate && event.startDate > now).sort((a, b) => {
      if (!a.startDate || !b.startDate) return 0;
      return a.startDate.getTime() - b.startDate.getTime();
    });
    return limit ? upcoming.slice(0, limit) : upcoming;
  }
  /**
   * Get events by status
   *
   * @param status - Event status to filter by
   * @returns Array of Event instances
   */
  async getByStatus(status) {
    return await this.list({ where: { status } });
  }
  /**
   * Get events by type
   *
   * @param typeId - EventType ID
   * @returns Array of Event instances
   */
  async getByType(typeId) {
    return await this.list({ where: { typeId } });
  }
  /**
   * Get root events (no parent)
   *
   * @returns Array of Event instances with no parent
   */
  async getRootEvents() {
    const allEvents = await this.list({});
    return allEvents.filter((event) => !event.parentEventId);
  }
  /**
   * Get children of a parent event
   *
   * @param parentEventId - Parent event ID
   * @returns Array of child Event instances
   */
  async getByParent(parentEventId) {
    return await this.list({ where: { parentEventId } });
  }
  /**
   * Get full event tree (hierarchy)
   *
   * @param eventId - Root event ID
   * @returns Object with root event and nested children
   */
  async getEventTree(eventId) {
    const event = await this.get({ id: eventId });
    if (!event) return null;
    return await event.getHierarchy().then((h) => h.current);
  }
  /**
   * Search events with filters
   *
   * @param query - Search query for name/description
   * @param filters - Additional filter criteria
   * @returns Array of matching Event instances
   */
  async search(query, filters) {
    let events = await this.list({});
    if (query) {
      const lowerQuery = query.toLowerCase();
      events = events.filter(
        (e) => e.name?.toLowerCase().includes(lowerQuery) || e.description?.toLowerCase().includes(lowerQuery)
      );
    }
    if (filters) {
      if (filters.typeId) {
        events = events.filter((e) => e.typeId === filters.typeId);
      }
      if (filters.seriesId) {
        events = events.filter((e) => e.seriesId === filters.seriesId);
      }
      if (filters.placeId) {
        events = events.filter((e) => e.placeId === filters.placeId);
      }
      if (filters.status) {
        if (Array.isArray(filters.status)) {
          events = events.filter((e) => filters.status?.includes(e.status));
        } else {
          events = events.filter((e) => e.status === filters.status);
        }
      }
      if (filters.startDate) {
        events = events.filter(
          (e) => e.startDate && e.startDate >= filters.startDate
        );
      }
      if (filters.endDate) {
        events = events.filter(
          (e) => e.startDate && e.startDate <= filters.endDate
        );
      }
      if (filters.organizerId) {
        events = events.filter(async (e) => {
          const series = await e.getSeries();
          return series && series.organizerId === filters.organizerId;
        });
      }
    }
    return events;
  }
  /**
   * Get events in progress
   *
   * @returns Array of Event instances currently in progress
   */
  async getInProgress() {
    const inProgressEvents = await this.getByStatus("in_progress");
    return inProgressEvents.filter((event) => event.isInProgress());
  }
}
const EventCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  EventCollection
}, Symbol.toStringTag, { value: "Module" }));
_EventParticipant_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class EventParticipant extends (_b = SmrtObject) {
  // id inherited from SmrtObject
  eventId = "";
  // FK to Event
  profileId = "";
  // FK to Profile (from @smrt/profiles)
  role = "";
  // Participant role (ParticipantRole or custom)
  placement = null;
  // Numeric position/placement
  groupId = "";
  // Optional grouping (e.g., team ID for individual players)
  metadata = "";
  // JSON metadata (stored as text)
  externalId = "";
  // External system identifier
  source = "";
  // Source system
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.eventId) this.eventId = options.eventId;
    if (options.profileId) this.profileId = options.profileId;
    if (options.role !== void 0) this.role = options.role;
    if (options.placement !== void 0) this.placement = options.placement;
    if (options.groupId !== void 0) this.groupId = options.groupId;
    if (options.externalId !== void 0) this.externalId = options.externalId;
    if (options.source !== void 0) this.source = options.source;
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
   * Get the event for this participant
   *
   * @returns Event instance or null
   */
  async getEvent() {
    if (!this.eventId) return null;
    const { EventCollection: EventCollection2 } = await Promise.resolve().then(() => EventCollection$1);
    const collection = await EventCollection2.create(this.options);
    return await collection.get({ id: this.eventId });
  }
  /**
   * Get the profile for this participant
   *
   * @returns Profile instance or null
   */
  async getProfile() {
    if (!this.profileId) return null;
    try {
      const { ProfileCollection } = await import("@smrt/profiles");
      const collection = await ProfileCollection.create(this.options);
      return await collection.get({ id: this.profileId });
    } catch {
      return null;
    }
  }
  /**
   * Get group participants (others with same groupId)
   *
   * @returns Array of EventParticipant instances
   */
  async getGroupParticipants() {
    if (!this.groupId) return [];
    const { EventParticipantCollection: EventParticipantCollection2 } = await Promise.resolve().then(() => EventParticipantCollection$1);
    const collection = await EventParticipantCollection2.create(this.options);
    const participants = await collection.list({
      where: { eventId: this.eventId, groupId: this.groupId }
    });
    return participants.filter((p) => p.id !== this.id);
  }
  /**
   * Check if this is a home participant (placement = 0)
   *
   * @returns True if placement is 0
   */
  isHome() {
    return this.placement === 0;
  }
  /**
   * Check if this is an away participant (placement = 1)
   *
   * @returns True if placement is 1
   */
  isAway() {
    return this.placement === 1;
  }
}
_init2 = __decoratorStart(_b);
EventParticipant = __decorateElement(_init2, 0, "EventParticipant", _EventParticipant_decorators, EventParticipant);
__runInitializers(_init2, 1, EventParticipant);
class EventParticipantCollection extends SmrtCollection {
  static _itemClass = EventParticipant;
  /**
   * Get participants for an event
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances
   */
  async getByEvent(eventId) {
    return await this.list({ where: { eventId } });
  }
  /**
   * Get events for a participant (profile)
   *
   * @param profileId - Profile ID
   * @returns Array of EventParticipant instances
   */
  async getByProfile(profileId) {
    return await this.list({ where: { profileId } });
  }
  /**
   * Get participants by role for an event
   *
   * @param eventId - Event ID
   * @param role - Participant role
   * @returns Array of EventParticipant instances
   */
  async getByRole(eventId, role) {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.role === role);
  }
  /**
   * Get participants ordered by placement
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances sorted by placement
   */
  async getByPlacement(eventId) {
    const participants = await this.getByEvent(eventId);
    return participants.sort((a, b) => {
      if (a.placement === null && b.placement === null) return 0;
      if (a.placement === null) return 1;
      if (b.placement === null) return -1;
      return a.placement - b.placement;
    });
  }
  /**
   * Get participants by group
   *
   * @param eventId - Event ID
   * @param groupId - Group ID
   * @returns Array of EventParticipant instances
   */
  async getByGroup(eventId, groupId) {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.groupId === groupId);
  }
  /**
   * Get home participant(s) (placement = 0)
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances with placement 0
   */
  async getHome(eventId) {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.placement === 0);
  }
  /**
   * Get away participant(s) (placement = 1)
   *
   * @param eventId - Event ID
   * @returns Array of EventParticipant instances with placement 1
   */
  async getAway(eventId) {
    const participants = await this.getByEvent(eventId);
    return participants.filter((p) => p.placement === 1);
  }
  /**
   * Search participants with filters
   *
   * @param filters - Filter criteria
   * @returns Array of matching EventParticipant instances
   */
  async search(filters) {
    let participants = await this.list({});
    if (filters.eventId) {
      participants = participants.filter((p) => p.eventId === filters.eventId);
    }
    if (filters.profileId) {
      participants = participants.filter(
        (p) => p.profileId === filters.profileId
      );
    }
    if (filters.role) {
      participants = participants.filter((p) => p.role === filters.role);
    }
    if (filters.groupId) {
      participants = participants.filter((p) => p.groupId === filters.groupId);
    }
    return participants;
  }
  /**
   * Get participant statistics for a profile
   *
   * @param profileId - Profile ID
   * @param eventTypeId - Optional event type filter
   * @returns Statistics object
   */
  async getParticipantStats(profileId, eventTypeId) {
    const participants = await this.getByProfile(profileId);
    let filteredParticipants = participants;
    if (eventTypeId) {
      filteredParticipants = [];
      for (const participant of participants) {
        const event = await participant.getEvent();
        if (event && event.typeId === eventTypeId) {
          filteredParticipants.push(participant);
        }
      }
    }
    const byRole = {};
    const byPlacement = {};
    for (const participant of filteredParticipants) {
      byRole[participant.role] = (byRole[participant.role] || 0) + 1;
      if (participant.placement !== null) {
        byPlacement[participant.placement] = (byPlacement[participant.placement] || 0) + 1;
      }
    }
    return {
      totalEvents: filteredParticipants.length,
      byRole,
      byPlacement
    };
  }
}
const EventParticipantCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  EventParticipantCollection
}, Symbol.toStringTag, { value: "Module" }));
_EventSeries_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create", "update"] },
  cli: true
})];
class EventSeries extends (_c = SmrtObject) {
  // id, slug, name inherited from SmrtObject
  typeId = "";
  // FK to EventType
  organizerId = "";
  // FK to Profile (from @smrt/profiles)
  description = "";
  startDate = null;
  endDate = null;
  recurrence = "";
  // JSON recurrence pattern (stored as text)
  metadata = "";
  // JSON metadata (stored as text)
  externalId = "";
  // External system identifier
  source = "";
  // Source system (e.g., 'ticketmaster', 'espn')
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.typeId) this.typeId = options.typeId;
    if (options.organizerId) this.organizerId = options.organizerId;
    if (options.description !== void 0)
      this.description = options.description;
    if (options.startDate !== void 0)
      this.startDate = options.startDate || null;
    if (options.endDate !== void 0) this.endDate = options.endDate || null;
    if (options.externalId !== void 0) this.externalId = options.externalId;
    if (options.source !== void 0) this.source = options.source;
    if (options.recurrence !== void 0) {
      if (typeof options.recurrence === "string") {
        this.recurrence = options.recurrence;
      } else {
        this.recurrence = JSON.stringify(options.recurrence);
      }
    }
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
   * Get recurrence pattern as parsed object
   *
   * @returns Parsed recurrence pattern or null
   */
  getRecurrence() {
    if (!this.recurrence) return null;
    try {
      return JSON.parse(this.recurrence);
    } catch {
      return null;
    }
  }
  /**
   * Set recurrence pattern from object
   *
   * @param pattern - Recurrence pattern to store
   */
  setRecurrence(pattern) {
    this.recurrence = JSON.stringify(pattern);
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
   * Get the event type for this series
   *
   * @returns EventType instance or null
   */
  async getType() {
    if (!this.typeId) return null;
    const { EventTypeCollection: EventTypeCollection2 } = await Promise.resolve().then(() => EventTypeCollection$1);
    const collection = await EventTypeCollection2.create(this.options);
    return await collection.get({ id: this.typeId });
  }
  /**
   * Get the organizer profile for this series
   *
   * @returns Profile instance or null
   */
  async getOrganizer() {
    if (!this.organizerId) return null;
    try {
      const { ProfileCollection } = await import("@smrt/profiles");
      const collection = await ProfileCollection.create(this.options);
      return await collection.get({ id: this.organizerId });
    } catch {
      return null;
    }
  }
  /**
   * Get all events in this series
   *
   * @returns Array of Event instances
   */
  async getEvents() {
    const { EventCollection: EventCollection2 } = await Promise.resolve().then(() => EventCollection$1);
    const collection = await EventCollection2.create(this.options);
    return await collection.list({ where: { seriesId: this.id } });
  }
  /**
   * Check if series is currently active
   *
   * @returns True if current date is between start and end
   */
  isActive() {
    const now = /* @__PURE__ */ new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;
    return true;
  }
}
_init3 = __decoratorStart(_c);
EventSeries = __decorateElement(_init3, 0, "EventSeries", _EventSeries_decorators, EventSeries);
__runInitializers(_init3, 1, EventSeries);
class EventSeriesCollection extends SmrtCollection {
  static _itemClass = EventSeries;
  /**
   * Get series by organizer
   *
   * @param organizerId - Profile ID of the organizer
   * @returns Array of EventSeries instances
   */
  async getByOrganizer(organizerId) {
    return await this.list({ where: { organizerId } });
  }
  /**
   * Get currently active series
   *
   * @returns Array of EventSeries instances active today
   */
  async getActive() {
    const allSeries = await this.list({});
    const now = /* @__PURE__ */ new Date();
    return allSeries.filter((series) => {
      if (series.startDate && now < series.startDate) return false;
      if (series.endDate && now > series.endDate) return false;
      return true;
    });
  }
  /**
   * Get upcoming series
   *
   * @param limit - Maximum number of series to return
   * @returns Array of EventSeries instances starting in the future
   */
  async getUpcoming(limit) {
    const allSeries = await this.list({});
    const now = /* @__PURE__ */ new Date();
    const upcoming = allSeries.filter((series) => series.startDate && series.startDate > now).sort((a, b) => {
      if (!a.startDate || !b.startDate) return 0;
      return a.startDate.getTime() - b.startDate.getTime();
    });
    return limit ? upcoming.slice(0, limit) : upcoming;
  }
  /**
   * Get series by type
   *
   * @param typeId - EventType ID
   * @returns Array of EventSeries instances
   */
  async getByType(typeId) {
    return await this.list({ where: { typeId } });
  }
  /**
   * Search series with filters
   *
   * @param query - Search query for name/description
   * @param filters - Additional filter criteria
   * @returns Array of matching EventSeries instances
   */
  async search(query, filters) {
    let series = await this.list({});
    if (query) {
      const lowerQuery = query.toLowerCase();
      series = series.filter(
        (s) => s.name?.toLowerCase().includes(lowerQuery) || s.description?.toLowerCase().includes(lowerQuery)
      );
    }
    if (filters) {
      if (filters.typeId) {
        series = series.filter((s) => s.typeId === filters.typeId);
      }
      if (filters.organizerId) {
        series = series.filter((s) => s.organizerId === filters.organizerId);
      }
      if (filters.startDate) {
        series = series.filter(
          (s) => s.startDate && s.startDate >= filters.startDate
        );
      }
      if (filters.endDate) {
        series = series.filter(
          (s) => s.endDate && s.endDate <= filters.endDate
        );
      }
    }
    return series;
  }
}
const EventSeriesCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  EventSeriesCollection
}, Symbol.toStringTag, { value: "Module" }));
_EventType_decorators = [smrt({
  api: { include: ["list", "get", "create", "update", "delete"] },
  mcp: { include: ["list", "get", "create"] },
  cli: true
})];
class EventType extends (_d = SmrtObject) {
  // id, slug, name inherited from SmrtObject
  description = "";
  // Optional description
  schema = "";
  // JSON schema for event metadata (stored as text)
  participantSchema = "";
  // JSON schema for participant metadata (stored as text)
  // Timestamps
  createdAt = /* @__PURE__ */ new Date();
  updatedAt = /* @__PURE__ */ new Date();
  constructor(options = {}) {
    super(options);
    if (options.description !== void 0)
      this.description = options.description;
    if (options.schema !== void 0) {
      if (typeof options.schema === "string") {
        this.schema = options.schema;
      } else {
        this.schema = JSON.stringify(options.schema);
      }
    }
    if (options.participantSchema !== void 0) {
      if (typeof options.participantSchema === "string") {
        this.participantSchema = options.participantSchema;
      } else {
        this.participantSchema = JSON.stringify(options.participantSchema);
      }
    }
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
  /**
   * Get schema as parsed object
   *
   * @returns Parsed schema object or empty object if no schema
   */
  getSchema() {
    if (!this.schema) return {};
    try {
      return JSON.parse(this.schema);
    } catch {
      return {};
    }
  }
  /**
   * Set schema from object
   *
   * @param data - Schema object to store
   */
  setSchema(data) {
    this.schema = JSON.stringify(data);
  }
  /**
   * Get participant schema as parsed object
   *
   * @returns Parsed participant schema object or empty object
   */
  getParticipantSchema() {
    if (!this.participantSchema) return {};
    try {
      return JSON.parse(this.participantSchema);
    } catch {
      return {};
    }
  }
  /**
   * Set participant schema from object
   *
   * @param data - Participant schema object to store
   */
  setParticipantSchema(data) {
    this.participantSchema = JSON.stringify(data);
  }
  /**
   * Convenience method for slug-based lookup
   *
   * @param slug - The slug to search for
   * @returns EventType instance or null if not found
   */
  static async getBySlug(_slug) {
    return null;
  }
}
_init4 = __decoratorStart(_d);
EventType = __decorateElement(_init4, 0, "EventType", _EventType_decorators, EventType);
__runInitializers(_init4, 1, EventType);
class EventTypeCollection extends SmrtCollection {
  static _itemClass = EventType;
  /**
   * Get or create an event type by slug
   *
   * @param slug - EventType slug (e.g., 'basketball-game', 'concert')
   * @param name - Optional display name (defaults to capitalized slug)
   * @returns EventType instance
   */
  async getOrCreate(slug, name) {
    const existing = await this.get({ slug });
    if (existing) {
      return existing;
    }
    const displayName = name || slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    return await this.create({
      slug,
      name: displayName
    });
  }
  /**
   * Get an event type by slug
   *
   * @param slug - EventType slug to search for
   * @returns EventType instance or null if not found
   */
  async getBySlug(slug) {
    return await this.get({ slug });
  }
  /**
   * Initialize default event types
   *
   * Creates common event types if they don't exist:
   * - Sports: game, period, goal, assist, penalty
   * - Entertainment: concert, performance, song
   * - Professional: conference, session, presentation, workshop
   * - Community: meeting, agenda-item, motion, vote
   *
   * @returns Array of created/existing event types
   */
  async initializeDefaults() {
    const defaults = [
      // Sports
      { slug: "game", name: "Game" },
      { slug: "match", name: "Match" },
      { slug: "period", name: "Period" },
      { slug: "quarter", name: "Quarter" },
      { slug: "inning", name: "Inning" },
      { slug: "goal", name: "Goal" },
      { slug: "assist", name: "Assist" },
      { slug: "penalty", name: "Penalty" },
      { slug: "substitution", name: "Substitution" },
      // Entertainment
      { slug: "concert", name: "Concert" },
      { slug: "performance", name: "Performance" },
      { slug: "set", name: "Set" },
      { slug: "song", name: "Song" },
      { slug: "theater", name: "Theater" },
      { slug: "show", name: "Show" },
      // Professional
      { slug: "conference", name: "Conference" },
      { slug: "session", name: "Session" },
      { slug: "presentation", name: "Presentation" },
      { slug: "workshop", name: "Workshop" },
      { slug: "seminar", name: "Seminar" },
      { slug: "keynote", name: "Keynote" },
      { slug: "panel", name: "Panel" },
      // Community
      { slug: "meeting", name: "Meeting" },
      { slug: "town-hall", name: "Town Hall" },
      { slug: "agenda-item", name: "Agenda Item" },
      { slug: "motion", name: "Motion" },
      { slug: "amendment", name: "Amendment" },
      { slug: "vote", name: "Vote" },
      { slug: "discussion", name: "Discussion" },
      // General
      { slug: "event", name: "Event" },
      { slug: "activity", name: "Activity" },
      { slug: "action", name: "Action" }
    ];
    const types = [];
    for (const def of defaults) {
      const type = await this.getOrCreate(def.slug, def.name);
      types.push(type);
    }
    return types;
  }
}
const EventTypeCollection$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  EventTypeCollection
}, Symbol.toStringTag, { value: "Module" }));
function validateEventStatus(currentStatus, newStatus) {
  const validTransitions = {
    scheduled: ["in_progress", "cancelled", "postponed"],
    in_progress: ["completed", "cancelled"],
    completed: [],
    // Cannot transition from completed
    cancelled: ["scheduled"],
    // Can reschedule
    postponed: ["scheduled", "cancelled"]
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
}
function formatEventDateRange(startDate, endDate) {
  const start = startDate.toLocaleDateString();
  if (!endDate) {
    return start;
  }
  if (startDate.toDateString() === endDate.toDateString()) {
    return `${start} ${startDate.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`;
  }
  return `${start} - ${endDate.toLocaleDateString()}`;
}
function generateEventSlug(name, date) {
  const namePart = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const datePart = date.toISOString().split("T")[0];
  return `${namePart}-${datePart}`;
}
function checkSchedulingConflict(event1Start, event1End, event2Start, event2End) {
  const e1End = event1End || event1Start;
  const e2End = event2End || event2Start;
  return event1Start < e2End && e1End > event2Start;
}
function parseRecurrencePattern(pattern) {
  if (!pattern) return null;
  if (typeof pattern === "string") {
    try {
      return JSON.parse(pattern);
    } catch {
      return null;
    }
  }
  return pattern;
}
function calculateNextOccurrence(pattern, fromDate) {
  const { frequency, interval = 1, until, count } = pattern;
  if (until && fromDate >= until) return null;
  const nextDate = new Date(fromDate);
  switch (frequency) {
    case "daily":
      nextDate.setDate(nextDate.getDate() + interval);
      break;
    case "weekly":
      nextDate.setDate(nextDate.getDate() + interval * 7);
      break;
    case "monthly":
      nextDate.setMonth(nextDate.getMonth() + interval);
      break;
    case "yearly":
      nextDate.setFullYear(nextDate.getFullYear() + interval);
      break;
    default:
      return null;
  }
  if (until && nextDate > until) return null;
  return nextDate;
}
function calculateDuration(startDate, endDate) {
  return endDate.getTime() - startDate.getTime();
}
function formatDuration(durationMs) {
  const seconds = Math.floor(durationMs / 1e3);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
function isEventNow(startDate, endDate) {
  const now = /* @__PURE__ */ new Date();
  if (now < startDate) return false;
  if (endDate && now > endDate) return false;
  return true;
}
function getEventStatusFromDates(startDate, endDate, currentStatus) {
  if (currentStatus === "cancelled" || currentStatus === "postponed") {
    return currentStatus;
  }
  const now = /* @__PURE__ */ new Date();
  if (now < startDate) {
    return "scheduled";
  }
  if (endDate && now > endDate) {
    return "completed";
  }
  return "in_progress";
}
function sortEventsByDate(events, ascending = true) {
  return events.sort((a, b) => {
    if (!a.startDate && !b.startDate) return 0;
    if (!a.startDate) return 1;
    if (!b.startDate) return -1;
    const diff = a.startDate.getTime() - b.startDate.getTime();
    return ascending ? diff : -diff;
  });
}
export {
  Event,
  EventCollection,
  EventParticipant,
  EventParticipantCollection,
  EventSeries,
  EventSeriesCollection,
  EventType,
  EventTypeCollection,
  calculateDuration,
  calculateNextOccurrence,
  checkSchedulingConflict,
  formatDuration,
  formatEventDateRange,
  generateEventSlug,
  getEventStatusFromDates,
  isEventNow,
  parseRecurrencePattern,
  sortEventsByDate,
  validateEventStatus
};
//# sourceMappingURL=index.js.map
