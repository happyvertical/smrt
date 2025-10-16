class PubSubAdapter {
  subscriptions = /* @__PURE__ */ new Map();
  nextSubscriptionId = 1;
  /**
   * Handle a signal and broadcast to subscribers
   *
   * @param signal - Signal to broadcast
   */
  async handle(signal) {
    const promises = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.filter && !subscription.filter(signal)) {
        continue;
      }
      const promise = (async () => {
        try {
          await subscription.callback(signal);
        } catch (error) {
          console.error(
            `PubSubAdapter: Subscriber ${subscription.id} error:`,
            error
          );
        }
      })();
      promises.push(promise);
    }
    await Promise.allSettled(promises);
  }
  /**
   * Subscribe to signals
   *
   * @param callback - Function to call with matching signals
   * @param filter - Optional filter to apply before sending
   * @returns Subscription ID for later unsubscribe
   */
  subscribe(callback, filter) {
    const id = `sub-${this.nextSubscriptionId++}`;
    this.subscriptions.set(id, {
      id,
      callback,
      filter
    });
    return id;
  }
  /**
   * Unsubscribe from signals
   *
   * @param subscriptionId - ID returned from subscribe()
   * @returns True if subscription was found and removed
   */
  unsubscribe(subscriptionId) {
    return this.subscriptions.delete(subscriptionId);
  }
  /**
   * Get count of active subscriptions
   *
   * @returns Number of active subscribers
   */
  get subscriberCount() {
    return this.subscriptions.size;
  }
  /**
   * Clear all subscriptions
   *
   * Removes all subscribers. Useful for cleanup or testing.
   */
  clearSubscriptions() {
    this.subscriptions.clear();
  }
  /**
   * Create filter for specific class
   *
   * @param className - Class name to match
   * @returns Filter function
   */
  static filterByClass(className) {
    return (signal) => signal.className === className;
  }
  /**
   * Create filter for specific method
   *
   * @param methodName - Method name to match
   * @returns Filter function
   */
  static filterByMethod(methodName) {
    return (signal) => signal.method === methodName;
  }
  /**
   * Create filter for specific signal type
   *
   * @param type - Signal type to match
   * @returns Filter function
   */
  static filterByType(type) {
    return (signal) => signal.type === type;
  }
  /**
   * Create filter for specific class and method
   *
   * @param className - Class name to match
   * @param methodName - Method name to match
   * @returns Filter function
   */
  static filterByClassAndMethod(className, methodName) {
    return (signal) => signal.className === className && signal.method === methodName;
  }
  /**
   * Combine multiple filters with AND logic
   *
   * @param filters - Filters to combine
   * @returns Combined filter function
   */
  static combineFilters(...filters) {
    return (signal) => filters.every((filter) => filter(signal));
  }
}
export {
  PubSubAdapter
};
//# sourceMappingURL=pubsub-BJ1ZU6QU.js.map
