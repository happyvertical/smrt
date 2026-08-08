/**
 * Per-app input renderer registry for generated ObjectForms.
 *
 * Registries are deliberately constructed by each application rather than
 * stored globally: one host can replace a type renderer without changing a
 * second app rendered in the same browser (micro-frontends and tests are both
 * common consumers). A qualified `objectRef.fieldName` registration wins over
 * its wire-type registration.
 */
import type { Component } from 'svelte';
import type { FieldInputProps } from './types.js';

export type FieldInputComponent = Component<FieldInputProps>;

export class FieldInputRegistry {
  #types = new Map<string, FieldInputComponent>();
  #fields = new Map<string, FieldInputComponent>();

  registerType(type: string, component: FieldInputComponent): () => void {
    this.#types.set(type, component);
    return () => {
      if (this.#types.get(type) === component) this.#types.delete(type);
    };
  }

  registerField(
    objectRef: string,
    fieldName: string,
    component: FieldInputComponent,
  ): () => void {
    const key = `${objectRef}.${fieldName}`;
    this.#fields.set(key, component);
    return () => {
      if (this.#fields.get(key) === component) this.#fields.delete(key);
    };
  }

  resolve(
    objectRef: string,
    fieldName: string,
    type: string,
  ): FieldInputComponent | undefined {
    return (
      this.#fields.get(`${objectRef}.${fieldName}`) ?? this.#types.get(type)
    );
  }
}

/** Create an isolated registry for one application root. */
export function createFieldInputRegistry(): FieldInputRegistry {
  return new FieldInputRegistry();
}
