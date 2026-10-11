/** A reactive value for tests that model a host-owned override getter. */
export function reactiveBox<T>(initial: T): { value: T } {
  let value = $state.raw(initial);
  return {
    get value() {
      return value;
    },
    set value(next: T) {
      value = next;
    },
  };
}
